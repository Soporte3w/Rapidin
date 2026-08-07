import { query, withTransaction } from '../../../config/database.js';
import {
  assertCronogramaPermitePagoInicial,
  getCuotaMonedasByAssignments,
} from '../cronograma/miautoCronogramaService.js';
import { normalizePhoneForDb, phoneDigitsForRapidinMatch } from '../../../utils/helpers.js';
import { generateWeeklyCharge } from '../cobros/CobroEngine.js';
import { getLimaYmd, mondayOfWeekContainingYmd, addDaysYmd, limaWeekStartToMiAutoIncomeRange } from '../../../utils/miautoLimaWeekRange.js';
import { getTotalValidado, getTotalsValidadosBySolicitudIds } from '../comprobantes/miautoComprobantePagoService.js';
import {
  generateExpenseCycles,
  listBySolicitud as listOtrosGastosBySolicitud,
  listBySolicitudIds as listOtrosGastosBySolicitudIds,
  updateExpenseConfiguration,
} from '../gastos/miautoOtrosGastosService.js';
import { logger } from '../../../utils/logger.js';
import { getDriverIncome } from '../../../services/yangoService.js';
import {
  MIAUTO_PARK_ID,
  getDriverInfoByPhones,
  normalizePhoneForDriversMatch,
  resolveFleetDriverIdFromDni,
} from '../utils/miautoDriverLookup.js';
import { buildDriverNameSearchSql } from '../../../utils/driverNameSearch.js';
import { enqueueMiautoLicenseValidation } from '../licencia/miautoLicenseValidationService.js';
import { enqueueMiautoSoatValidation } from '../soat/miautoSoatValidationService.js';
import { normalizeMiautoPlate } from '../utils/miautoPlateIdentity.js';
import { resolveWorkingMiautoDriverForPlate } from '../utils/miautoPlateDriverLookup.js';
import {
  MiautoStartDateCorrectionError,
  assertBootstrapWeeklyQuotaForStartDateCorrection,
  buildMiautoStartDateCorrection,
  normalizeMiautoStoredStartDate,
} from '../utils/miautoStartDateCorrection.js';

const MINIMO_USD_PARCIAL = 500;

const MAX_REAGENDOS = 2;

const cuotaSaldoPendienteSql = (alias) =>
  `(CASE
      WHEN LOWER(COALESCE(${alias}.montos_fuente, '')) = 'excel'
        THEN COALESCE(${alias}.paid_amount, 0)::numeric < COALESCE(${alias}.amount_due, 0)::numeric - 0.005
      ELSE COALESCE(${alias}.paid_amount, 0)::numeric < COALESCE(${alias}.amount_due, 0)::numeric + COALESCE(${alias}.late_fee, 0)::numeric + COALESCE(${alias}.mora_extra, 0)::numeric - 0.005
    END)`;

export const cuotaCubiertaSql = (alias) =>
  `(CASE
      WHEN LOWER(COALESCE(${alias}.montos_fuente, '')) = 'excel'
        THEN COALESCE(${alias}.paid_amount, 0)::numeric >= COALESCE(${alias}.amount_due, 0)::numeric - 0.005
      ELSE COALESCE(${alias}.paid_amount, 0)::numeric >= COALESCE(${alias}.amount_due, 0)::numeric + COALESCE(${alias}.late_fee, 0)::numeric + COALESCE(${alias}.mora_extra, 0)::numeric - 0.005
    END)`;

const cuotaVencidaConSaldoSql = (alias) =>
  `${cuotaSaldoPendienteSql(alias)} AND (LOWER(COALESCE(${alias}.status, '')) = 'overdue' OR COALESCE(${alias}.due_date, ${alias}.week_start_date)::date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date)`;

function trimOrUndefined(x) {
  if (x == null) return undefined;
  const s = String(x).trim();
  return s === '' ? undefined : s;
}

/** Normaliza placa para almacenamiento y comparación (mayúsculas, solo alfanuméricos). */
export function normalizePlacaAsignada(value) {
  return normalizeMiautoPlate(value);
}

export function normalizeMiautoDocument(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
  return digits || null;
}

async function ensureMiautoConductor(country, dni) {
  const normalized = normalizeMiautoDocument(dni);
  if (!normalized) throw new Error('No se pudo identificar al conductor por su documento');
  const result = await query(
    `INSERT INTO module_miauto_conductor (country, document_number, document_normalized)
     VALUES ($1, $2, $3)
     ON CONFLICT (country, document_normalized)
     DO UPDATE SET document_number = COALESCE(EXCLUDED.document_number, module_miauto_conductor.document_number),
                   updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [country || 'PE', dni || null, normalized]
  );
  return result.rows[0].id;
}

async function assertActivePlateAvailable(placa, excludeSolicitudId = null) {
  const normalized = normalizePlacaAsignada(placa);
  if (!normalized) return;
  const result = await query(
    `SELECT id FROM module_miauto_solicitud
     WHERE status = 'aprobado' AND deleted_at IS NULL
       AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(placa_asignada, '')), '[^A-Z0-9]', '', 'g')) = $1
       AND ($2::uuid IS NULL OR id <> $2::uuid)
     LIMIT 1`,
    [normalized, excludeSolicitudId]
  );
  if (result.rows.length > 0) throw new Error('La placa ya pertenece a otro contrato activo');
}

function normalizeAppsToCodes(apps) {
  if (!Array.isArray(apps)) return [];
  return apps.map((a) => (typeof a === 'string' ? a : a?.code ?? a?.name ?? a));
}

async function insertCitaHistorial(solicitudId, tipo, appointmentDate, userId) {
  const params = [solicitudId, tipo, appointmentDate];
  const sql = userId
    ? 'INSERT INTO module_miauto_solicitud_cita (solicitud_id, tipo, appointment_date, created_by) VALUES ($1, $2, $3, $4)'
    : 'INSERT INTO module_miauto_solicitud_cita (solicitud_id, tipo, appointment_date) VALUES ($1, $2, $3)';
  if (userId) params.push(userId);
  await query(sql, params);
}

async function updateLastCitaResultado(solicitudId, resultado) {
  await query(
    `UPDATE module_miauto_solicitud_cita SET resultado = $2
     WHERE id = (SELECT id FROM module_miauto_solicitud_cita WHERE solicitud_id = $1 ORDER BY created_at DESC LIMIT 1)`,
    [solicitudId, resultado]
  );
}

export class ActiveSolicitudError extends Error {
  constructor(status, park_id) {
    super('Ya tienes una solicitud activa en otra flota.');
    this.name = 'ActiveSolicitudError';
    this.code = 'ACTIVE_SOLICITUD';
    this.status = status;
    this.park_id = park_id;
  }
}

export const listSolicitudes = async (filters = {}) => {
  const { status, country, date_from, date_to, page = 1, limit = 20, driver_phone, driver_country, park_id, driver_id_fleet, forDriver, driver: driverNameFilter, q: qNameFilter } = filters;
  const params = [];
  let n = 1;
  let fromJoin = ` FROM module_miauto_solicitud s
    LEFT JOIN module_rapidin_drivers rd ON rd.id::text = s.driver_id_fleet
    LEFT JOIN module_miauto_cronograma c ON c.id = s.cronograma_id
    LEFT JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id `;
  let where = ' WHERE 1=1 ';
  // Los contratos anexados no son solicitudes nuevas y no deben aparecer en la bandeja administrativa.
  // El conductor sí recibe todos sus contratos mediante este listado.
  if (!forDriver) {
    where += " AND COALESCE(s.origen_registro, 'solicitud') = 'solicitud' ";
  }
  if (status) {
    where += ` AND s.status = $${n}`;
    params.push(status);
    n += 1;
  }
  if (country) {
    where += ` AND s.country = $${n}`;
    params.push(country);
    n += 1;
  }
  if (date_from) {
    where += ` AND s.created_at::date >= $${n}`;
    params.push(date_from);
    n += 1;
  }
  if (date_to) {
    where += ` AND s.created_at::date <= $${n}`;
    params.push(date_to);
    n += 1;
  }
  const adminDriverName = trimOrUndefined(driverNameFilter ?? qNameFilter);
  if (adminDriverName && !forDriver) {
    const dSearch = buildDriverNameSearchSql('rd', adminDriverName, n);
    if (dSearch.sql) {
      where += dSearch.sql;
      params.push(...dSearch.params);
      n = dSearch.nextParam;
    }
  }
  const rid = trimOrUndefined(driver_id_fleet);
  const pid = trimOrUndefined(park_id);
  if (pid) {
    where += ` AND COALESCE(TRIM(rd.park_id), '') = $${n}`;
    params.push(pid);
    n += 1;
  }
  if (driver_phone && driver_country) {
    const phoneForDb = normalizePhoneForDb(driver_phone, driver_country);
    const digitsOnly = (driver_phone || '').toString().replace(/\D/g, '');
    const last9 = phoneDigitsForRapidinMatch(driver_phone, driver_country);
    const phoneMatch = `(s.phone = $${n} OR s.phone = $${n + 1} OR REGEXP_REPLACE(COALESCE(s.phone,''), '[^0-9]', '', 'g') = $${n + 2} OR REGEXP_REPLACE(COALESCE(s.phone,''), '[^0-9]', '', 'g') = $${n + 3})`;
    params.push(phoneForDb, driver_phone, digitsOnly, last9);
    n += 4;
    if (rid) {
      where += ` AND (${phoneMatch} OR s.driver_id_fleet = $${n})`;
      params.push(rid);
      n += 1;
    } else {
      where += ` AND ${phoneMatch}`;
    }
  } else if (rid) {
    where += ` AND s.driver_id_fleet = $${n}`;
    params.push(rid);
    n += 1;
  }

  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limitNum;

  const selectFields = forDriver
    ? `SELECT s.id, s.dni, s.phone, s.email, s.license_number, s.license_category, s.license_factiliza_status,
            s.license_issued_date, s.license_expiration_date, s.license_restrictions, s.license_validation_status,
            s.license_validation_attempts, s.license_validation_checked_at,
            s.status, s.created_at, s.country, s.pago_tipo, s.pago_estado, s.fecha_inicio_cobro_semanal,
            s.conductor_id, s.origen_registro,
            s.placa_asignada, s.appointment_date, s.reagendo_count, s.observations, s.rejection_reason, s.withdrawn_at, s.withdrawal_reason,
            rd.first_name AS driver_first_name, rd.last_name AS driver_last_name,
            c.id AS cronograma_id, c.name AS cronograma_name, c.tasa_interes_mora AS cronograma_tasa_interes_mora, c.bono_tiempo_activo AS cronograma_bono_tiempo_activo,
            v.id AS vehiculo_id,
            v.name AS vehiculo_name, v.inicial AS vehiculo_inicial, v.inicial_moneda AS vehiculo_inicial_moneda, v.cuotas_semanales AS vehiculo_cuotas_semanales, v.image AS vehiculo_image`
    : `SELECT s.id, s.dni, s.phone, s.email, s.license_number, s.license_category, s.license_factiliza_status,
            s.license_issued_date, s.license_expiration_date, s.license_restrictions, s.license_validation_status,
            s.license_validation_attempts, s.license_validation_checked_at,
            s.status, s.created_at, s.driver_id_fleet, s.conductor_id, s.origen_registro,
            s.placa_asignada, s.cronograma_id, s.cronograma_vehiculo_id,
            rd.first_name AS driver_first_name, rd.last_name AS driver_last_name,
            c.name AS cronograma_name,
            v.name AS vehiculo_name`;
  const [countResult, dataResult] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total ${fromJoin} ${where}`, params),
    query(
      `${selectFields}
       ${fromJoin}
       ${where}
       ORDER BY s.created_at DESC
       LIMIT $${n} OFFSET $${n + 1}`,
      [...params, limitNum, offset]
    ),
  ]);
  const total = countResult.rows[0]?.total ?? 0;

  let comprobantesBySolicitud = {};
  let citasBySolicitud = {};
  let otrosGastosBySolicitud = {};
  let totalValidadoBySolicitud = {};
  if (forDriver && dataResult.rows.length > 0) {
    const ids = dataResult.rows.map((r) => r.id);
    const [compRes, citasRes, otrosGastosMap, totalsMap] = await Promise.all([
      query(
        'SELECT solicitud_id, id, monto, file_name, file_path, created_at, estado, validated_at, validated_by, rechazado_at, rechazo_razon, rechazado_by FROM module_miauto_comprobante_pago WHERE solicitud_id = ANY($1::uuid[]) ORDER BY created_at ASC',
        [ids]
      ),
      query(
        'SELECT solicitud_id, id, tipo, appointment_date, created_at, resultado FROM module_miauto_solicitud_cita WHERE solicitud_id = ANY($1::uuid[]) ORDER BY created_at ASC',
        [ids]
      ),
      listOtrosGastosBySolicitudIds(ids),
      getTotalsValidadosBySolicitudIds(ids),
    ]);
    for (const row of compRes.rows || []) {
      if (!comprobantesBySolicitud[row.solicitud_id]) comprobantesBySolicitud[row.solicitud_id] = [];
      comprobantesBySolicitud[row.solicitud_id].push(row);
    }
    for (const row of citasRes.rows || []) {
      if (!citasBySolicitud[row.solicitud_id]) citasBySolicitud[row.solicitud_id] = [];
      citasBySolicitud[row.solicitud_id].push(row);
    }
    otrosGastosBySolicitud = otrosGastosMap;
    for (const id of ids) {
      const t = totalsMap.get(String(id));
      if (t) totalValidadoBySolicitud[id] = { total: t.total, totalUsd: t.totalUsd };
    }
  }

  const nameFromRapidinList = (r) => [r.driver_first_name, r.driver_last_name].filter(Boolean).map(String).join(' ').trim() || null;
  const licenseOnSolicitud = (r) => {
    const lic = r.license_number;
    return lic != null && String(lic).trim() !== '' ? String(lic).trim() : null;
  };
  const phonesForLookupList = dataResult.rows
    .filter((r) => r.phone && (!nameFromRapidinList(r) || !licenseOnSolicitud(r)))
    .map((r) => r.phone);
  const placas = [...new Set(dataResult.rows.map((r) => r.placa_asignada).filter(Boolean))];
  const fleetIds = [...new Set(dataResult.rows.map((r) => r.driver_id_fleet).filter(Boolean))];
  const [driverInfoList, workingResult, statusResult] = await Promise.all([
    getDriverInfoByPhones(MIAUTO_PARK_ID, phonesForLookupList),
    placas.length > 0
      ? query(
          `SELECT UPPER(REGEXP_REPLACE(TRIM(COALESCE(car_number, '')), ' ', '', 'g')) AS placa_norm,
                  first_name, last_name
           FROM drivers
           WHERE TRIM(COALESCE(park_id::text, '')) = $1
             AND work_status = 'working'
             AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(car_number, '')), ' ', '', 'g')) = ANY($2::text[])`,
          [MIAUTO_PARK_ID, placas.map((p) => p.toUpperCase().replace(/\s/g, ''))]
        )
      : Promise.resolve({ rows: [] }),
    fleetIds.length > 0
      ? query(
          'SELECT driver_id, work_status, first_name, last_name FROM drivers WHERE driver_id = ANY($1::text[])',
          [fleetIds]
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const workingByPlaca = new Map();
  for (const w of workingResult.rows || []) {
    workingByPlaca.set(w.placa_norm, [w.first_name, w.last_name].filter(Boolean).join(' ').trim());
  }
  const statusByDriverIdList = new Map();
  for (const s of statusResult.rows || []) {
    statusByDriverIdList.set(s.driver_id, { status: s.work_status, name: [s.first_name, s.last_name].filter(Boolean).join(' ').trim() });
  }

  const rows = dataResult.rows.map((r) => {
    let driverName = nameFromRapidinList(r);
    if (!driverName && r.driver_id_fleet) {
      const drvInfo = statusByDriverIdList.get(r.driver_id_fleet);
      if (drvInfo?.name) driverName = drvInfo.name;
    }
    if (!driverName && r.phone) {
      const { digits, last9 } = normalizePhoneForDriversMatch(r.phone);
      driverName = driverInfoList.names[digits] || driverInfoList.names[last9] || null;
    }
    const workingName = (r.placa_asignada && workingByPlaca.get(r.placa_asignada.toUpperCase().replace(/\s/g, ''))) || null;
    const driverStatus = (r.driver_id_fleet && statusByDriverIdList.get(r.driver_id_fleet)?.status) || null;
    const isFired = driverStatus === 'fired';
    let licenseNum = r.license_number != null && String(r.license_number).trim() !== '' ? String(r.license_number).trim() : null;
    if (!licenseNum && r.phone) {
      const { digits, last9 } = normalizePhoneForDriversMatch(r.phone);
      licenseNum = driverInfoList.licenses[digits] || driverInfoList.licenses[last9] || null;
    }
    const out = {
      id: r.id,
      dni: r.dni,
      phone: r.phone || undefined,
      email: r.email || undefined,
      license_number: licenseNum || undefined,
      license_category: r.license_category || undefined,
      license_factiliza_status: r.license_factiliza_status || undefined,
      license_issued_date: r.license_issued_date || undefined,
      license_expiration_date: r.license_expiration_date || undefined,
      license_restrictions: r.license_restrictions || undefined,
      license_validation_status: r.license_validation_status || 'pending',
      license_validation_attempts: Number(r.license_validation_attempts) || 0,
      license_validation_checked_at: r.license_validation_checked_at || undefined,
      status: r.status,
      created_at: r.created_at,
      conductor_id: r.conductor_id || undefined,
      origen_registro: r.origen_registro || 'solicitud',
      driver_name: driverName || undefined,
      working_driver_name: workingName || undefined,
      fired_driver_name: isFired ? driverName : undefined,
      yango_work_status: driverStatus || undefined,
      cronograma_id: r.cronograma_id || undefined,
      cronograma_name: r.cronograma_name || undefined,
      cronograma_vehiculo_id: r.vehiculo_id || r.cronograma_vehiculo_id || undefined,
      vehiculo_name: r.vehiculo_name || undefined,
    };
    if (forDriver) {
      out.country = r.country || undefined;
      out.pago_tipo = r.pago_tipo || undefined;
      out.pago_estado = r.pago_estado || undefined;
      out.fecha_inicio_cobro_semanal = r.fecha_inicio_cobro_semanal || undefined;
      out.placa_asignada = r.placa_asignada != null && String(r.placa_asignada).trim() !== '' ? String(r.placa_asignada).trim() : undefined;
      out.appointment_date = r.appointment_date || undefined;
      out.reagendo_count = r.reagendo_count != null ? parseInt(r.reagendo_count, 10) : 0;
      out.observations = r.observations != null ? String(r.observations).trim() || undefined : undefined;
      out.rejection_reason = r.rejection_reason != null ? String(r.rejection_reason).trim() || undefined : undefined;
      out.withdrawn_at = r.withdrawn_at || undefined;
      out.withdrawal_reason = r.withdrawal_reason != null ? String(r.withdrawal_reason).trim() || undefined : undefined;
      out.citas_historial = citasBySolicitud[r.id] || [];
      out.cronograma = r.cronograma_name != null
        ? { id: r.cronograma_id, name: r.cronograma_name, tasa_interes_mora: r.cronograma_tasa_interes_mora != null ? parseFloat(r.cronograma_tasa_interes_mora) : 0, bono_tiempo_activo: !!r.cronograma_bono_tiempo_activo }
        : undefined;
      out.cronograma_vehiculo = r.vehiculo_name != null || r.vehiculo_inicial != null
        ? { id: r.vehiculo_id, name: r.vehiculo_name, inicial: r.vehiculo_inicial != null ? parseFloat(r.vehiculo_inicial) : 0, inicial_moneda: r.vehiculo_inicial_moneda || 'USD', cuotas_semanales: r.vehiculo_cuotas_semanales != null ? parseInt(r.vehiculo_cuotas_semanales, 10) || 0 : 0, image: r.vehiculo_image }
        : undefined;
      out.comprobantes_pago = comprobantesBySolicitud[r.id] || [];
      out.otros_gastos = otrosGastosBySolicitud[r.id] || [];
      const tv = totalValidadoBySolicitud[r.id];
      if (tv) {
        out.total_validado = tv.total;
        out.total_validado_usd = tv.totalUsd;
      }
    }
    return out;
  });
  return { data: rows, total };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Listado Alquiler/Venta con resumen de cuotas y moneda de cuotas según cronograma. */
export const listAlquilerVenta = async (filters = {}) => {
  const {
    country,
    page = 1,
    limit = 20,
    q: qFilter,
    cronograma_id: cronogramaIdFilter,
    conductor_id: conductorIdFilter,
    solicitud_id: solicitudIdFilter,
  } = filters;
  const params = [];
  let n = 1;
  // Solo solicitudes aprobadas (con Yego Mi Auto generado)
  let where = ` WHERE s.status = 'aprobado' `;
  if (country) {
    where += ` AND s.country = $${n}`;
    params.push(country);
    n += 1;
  }
  const qRaw = (qFilter != null ? String(qFilter) : '').trim();
  if (qRaw) {
    const tokens = qRaw
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[%_]/g, ''))
      .filter(Boolean);
    for (const tok of tokens) {
      where += ` AND (
      position($${n}::text in lower(coalesce(s.placa_asignada, ''))) > 0
      OR position($${n}::text in lower(coalesce(s.license_number, ''))) > 0
      OR position($${n}::text in lower(coalesce(s.dni, ''))) > 0
      OR position($${n}::text in lower(coalesce(rd.dni, ''))) > 0
      OR position($${n}::text in lower(coalesce(rd.first_name, ''))) > 0
      OR position($${n}::text in lower(coalesce(rd.last_name, ''))) > 0
      OR position($${n}::text in lower(trim(coalesce(rd.first_name, '')) || ' ' || trim(coalesce(rd.last_name, '')))) > 0
    )`;
      params.push(tok);
      n += 1;
    }
  }
  const cronogramaId = trimOrUndefined(cronogramaIdFilter);
  if (cronogramaId && UUID_RE.test(cronogramaId)) {
    where += ` AND s.cronograma_id = $${n}::uuid`;
    params.push(cronogramaId);
    n += 1;
  }
  const conductorId = trimOrUndefined(conductorIdFilter);
  if (conductorId && UUID_RE.test(conductorId)) {
    where += ` AND s.conductor_id = $${n}::uuid`;
    params.push(conductorId);
    n += 1;
  }
  const solicitudId = trimOrUndefined(solicitudIdFilter);
  if (solicitudId && UUID_RE.test(solicitudId)) {
    where += ` AND s.id = $${n}::uuid`;
    params.push(solicitudId);
    n += 1;
  }
  const cuotaEstado = trimOrUndefined(filters.cuota_estado);
  if (cuotaEstado) {
    const ce = String(cuotaEstado).toLowerCase();
    if (ce === 'vencido') {
      where += ` AND EXISTS (SELECT 1 FROM module_miauto_cuota_semanal cs WHERE cs.solicitud_id = s.id AND ${cuotaVencidaConSaldoSql('cs')})`;
    } else if (ce === 'pendiente') {
      where += ` AND EXISTS (SELECT 1 FROM module_miauto_cuota_semanal cs WHERE cs.solicitud_id = s.id AND cs.status = 'pending' AND ${cuotaSaldoPendienteSql('cs')})`;
    } else if (ce === 'al_dia') {
      where += ` AND EXISTS (SELECT 1 FROM module_miauto_cuota_semanal cs WHERE cs.solicitud_id = s.id)
                AND NOT EXISTS (SELECT 1 FROM module_miauto_cuota_semanal cs2 WHERE cs2.solicitud_id = s.id AND ${cuotaVencidaConSaldoSql('cs2')})`;
    } else if (ce === 'sin_cuotas') {
      where += ` AND NOT EXISTS (SELECT 1 FROM module_miauto_cuota_semanal cs WHERE cs.solicitud_id = s.id)`;
    }
  }
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limitNum;

  const fromBase = `
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id::text = s.driver_id_fleet
     LEFT JOIN module_miauto_cronograma c ON c.id = s.cronograma_id
     LEFT JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id`;

  const listSql = `SELECT s.id, s.conductor_id, s.origen_registro, s.cronograma_id, s.cronograma_vehiculo_id, s.dni, s.phone, s.email, s.license_number, s.status, s.created_at, s.fecha_inicio_cobro_semanal, s.placa_asignada, s.driver_id_fleet,
            rd.first_name AS driver_first_name, rd.last_name AS driver_last_name,
            c.name AS cronograma_name, COALESCE(c.bono_tiempo_activo, false) AS bono_tiempo_activo,
            v.name AS vehiculo_name, v.inicial AS vehiculo_inicial, v.inicial_moneda AS vehiculo_inicial_moneda, v.cuotas_semanales AS vehiculo_cuotas_semanales
     ${fromBase}
     ${where}
     ORDER BY s.fecha_inicio_cobro_semanal DESC NULLS LAST, s.created_at DESC
     LIMIT $${n} OFFSET $${n + 1}`;

  const [countResult, dataResult] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total ${fromBase} ${where}`, params),
    query(listSql, [...params, limitNum, offset]),
  ]);
  const total = countResult.rows[0]?.total ?? 0;
  const rows = dataResult.rows || [];
  const solicitudIds = rows.map((r) => r.id);

  const cuotaSummaryBySolicitud = {};
  const [summaryRes, monedaByAssignment] = await Promise.all([
    solicitudIds.length > 0
      ? query(
          `SELECT c.solicitud_id,
                  COUNT(*)::int AS total_cuotas,
                  COUNT(*) FILTER (WHERE c.status IN ('paid', 'bonificada') OR ${cuotaCubiertaSql('c')})::int AS cuotas_pagadas,
                  COUNT(*) FILTER (WHERE ${cuotaVencidaConSaldoSql('c')})::int AS cuotas_vencidas,
                  COALESCE(SUM(c.paid_amount) FILTER (WHERE UPPER(COALESCE(c.moneda,'PEN')) = 'PEN'), 0)::decimal AS total_pagado_pen,
                  COALESCE(SUM(c.paid_amount) FILTER (WHERE UPPER(COALESCE(c.moneda,'PEN')) = 'USD'), 0)::decimal AS total_pagado_usd,
                  MODE() WITHIN GROUP (ORDER BY UPPER(COALESCE(c.moneda,'PEN'))) AS moneda_dominante
           FROM module_miauto_cuota_semanal c
           WHERE c.solicitud_id = ANY($1::uuid[])
           GROUP BY c.solicitud_id`,
          [solicitudIds]
        )
      : Promise.resolve({ rows: [] }),
    getCuotaMonedasByAssignments(rows),
  ]);
  for (const r of summaryRes.rows || []) {
    cuotaSummaryBySolicitud[r.solicitud_id] = {
      total_cuotas: r.total_cuotas,
      cuotas_pagadas: r.cuotas_pagadas,
      cuotas_vencidas: r.cuotas_vencidas,
      total_pagado: parseFloat(r.total_pagado) || 0,
      total_pagado_pen: parseFloat(r.total_pagado_pen) || 0,
      total_pagado_usd: parseFloat(r.total_pagado_usd) || 0,
      moneda_dominante: r.moneda_dominante === 'USD' ? 'USD' : 'PEN',
    };
  }

  const nameFromRapidin = (r) => [r.driver_first_name, r.driver_last_name].filter(Boolean).map(String).join(' ').trim() || null;
  const licenseFromSolicitud = (r) => {
    const lic = r.license_number;
    return lic != null && String(lic).trim() !== '' ? String(lic).trim() : null;
  };
  // Solo consultar tabla drivers (Yango) si falta nombre o licencia en solicitud/rapidin
  const phonesForLookup = rows
    .filter((r) => r.phone && (!nameFromRapidin(r) || !licenseFromSolicitud(r)))
    .map((r) => r.phone);
  const placasAv = [...new Set(rows.map((r) => r.placa_asignada).filter(Boolean))];
  const fleetIds = [...new Set(rows.map((r) => r.driver_id_fleet).filter(Boolean))];
  const [driverInfoAv, workingResult, statusResult] = await Promise.all([
    getDriverInfoByPhones(MIAUTO_PARK_ID, phonesForLookup),
    placasAv.length > 0
      ? query(
          `SELECT UPPER(REGEXP_REPLACE(TRIM(COALESCE(car_number, '')), ' ', '', 'g')) AS placa_norm,
                  first_name, last_name
           FROM drivers
           WHERE TRIM(COALESCE(park_id::text, '')) = $1
             AND work_status = 'working'
             AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(car_number, '')), ' ', '', 'g')) = ANY($2::text[])`,
          [MIAUTO_PARK_ID, placasAv.map((p) => p.toUpperCase().replace(/\s/g, ''))]
        )
      : Promise.resolve({ rows: [] }),
    fleetIds.length > 0
      ? query(
          'SELECT driver_id, work_status, first_name, last_name FROM drivers WHERE driver_id = ANY($1::text[])',
          [fleetIds]
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const workingByPlacaAv = new Map();
  for (const w of workingResult.rows || []) {
    workingByPlacaAv.set(w.placa_norm, [w.first_name, w.last_name].filter(Boolean).join(' ').trim());
  }
  const statusByDriverId = new Map();
  for (const s of statusResult.rows || []) {
    statusByDriverId.set(s.driver_id, { status: s.work_status, name: [s.first_name, s.last_name].filter(Boolean).join(' ').trim() });
  }

  const data = rows.map((r) => {
    let driverName = nameFromRapidin(r);
    if (!driverName && r.driver_id_fleet) {
      const drvInfo = statusByDriverId.get(r.driver_id_fleet);
      if (drvInfo?.name) driverName = drvInfo.name;
    }
    if (!driverName && r.phone) {
      const { digits, last9 } = normalizePhoneForDriversMatch(r.phone);
      driverName = driverInfoAv.names[digits] || driverInfoAv.names[last9] || null;
    }
    const workingName = (r.placa_asignada && workingByPlacaAv.get(r.placa_asignada.toUpperCase().replace(/\s/g, ''))) || null;
    const driverStatus = (r.driver_id_fleet && statusByDriverId.get(r.driver_id_fleet)?.status) || null;
    const isFired = driverStatus === 'fired';
    let licenseNum = licenseFromSolicitud(r);
    if (!licenseNum && r.phone) {
      const { digits, last9 } = normalizePhoneForDriversMatch(r.phone);
      licenseNum = driverInfoAv.licenses[digits] || driverInfoAv.licenses[last9] || null;
    }
    const summary = cuotaSummaryBySolicitud[r.id] || {
      total_cuotas: 0,
      cuotas_pagadas: 0,
      cuotas_vencidas: 0,
      total_pagado: 0,
      total_pagado_pen: 0,
      total_pagado_usd: 0,
      moneda_dominante: 'PEN',
    };
    const cuotasPlan = r.vehiculo_cuotas_semanales != null ? parseInt(r.vehiculo_cuotas_semanales, 10) || 0 : 0;
    const assignmentKey = `${r.cronograma_id || ''}:${r.cronograma_vehiculo_id || ''}`;
    const monedaCronograma = monedaByAssignment.get(assignmentKey) || 'PEN';
    const moneda =
      summary.total_cuotas > 0 && summary.moneda_dominante
        ? summary.moneda_dominante
        : monedaCronograma;
    return {
      id: r.id,
      conductor_id: r.conductor_id || undefined,
      origen_registro: r.origen_registro || 'solicitud',
      dni: r.dni,
      phone: r.phone || undefined,
      email: r.email || undefined,
      license_number: licenseNum || undefined,
      status: r.status,
      created_at: r.created_at,
      fecha_inicio_cobro_semanal: r.fecha_inicio_cobro_semanal,
      placa_asignada: r.placa_asignada != null && String(r.placa_asignada).trim() !== '' ? String(r.placa_asignada).trim() : undefined,
      driver_name: driverName || undefined,
      working_driver_name: workingName || undefined,
      fired_driver_name: isFired ? driverName : undefined,
      yango_work_status: driverStatus || undefined,
      cronograma_name: r.cronograma_name || undefined,
      cronograma_id: r.cronograma_id || undefined,
      bono_tiempo_activo: r.bono_tiempo_activo === true,
      vehiculo_name: r.vehiculo_name || undefined,
      vehiculo_inicial: r.vehiculo_inicial != null ? parseFloat(r.vehiculo_inicial) || 0 : undefined,
      vehiculo_inicial_moneda: r.vehiculo_inicial_moneda || undefined,
      cuotas_semanales_plan: cuotasPlan,
      total_cuotas: summary.total_cuotas,
      cuotas_pagadas: summary.cuotas_pagadas,
      cuotas_vencidas: summary.cuotas_vencidas,
      total_pagado: summary.total_pagado,
      total_pagado_pen: summary.total_pagado_pen,
      total_pagado_usd: summary.total_pagado_usd,
      moneda,
    };
  });
  return { data, total };
};

export const getSolicitudById = async (id, options = {}) => {
  const skipYangoLicenseLookup = options.skipYangoLicenseLookup === true;
  const vehicleImageExpression = options.includeVehicleImage === false ? 'NULL::text AS image' : 'image';
  const result = await query(
    `SELECT id, country, dni, phone, email, license_number, license_category, license_factiliza_status,
            license_issued_date, license_expiration_date, license_restrictions, license_validation_status,
            license_validation_attempts, license_validation_checked_at,
            description,
            status, rejection_reason, cited_at, cited_by, appointment_date, reagendo_count,
            reviewed_at, reviewed_by, withdrawn_at, withdrawal_reason, observations, created_at, updated_at, driver_id_fleet,
            conductor_id, origen_registro, recaudo_driver_id,
            cronograma_id, cronograma_vehiculo_id, pago_tipo, pago_estado, fecha_inicio_cobro_semanal, placa_asignada,
            facturador_customer_id,
            (SELECT cv.inicial_moneda
             FROM module_miauto_cronograma_vehiculo cv
             WHERE cv.id = module_miauto_solicitud.cronograma_vehiculo_id) AS cronograma_vehiculo_inicial_moneda,
            COALESCE(apps_trabajadas, '[]'::jsonb) AS apps_trabajadas
     FROM module_miauto_solicitud WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  const [
    citasRes,
    cronoRes,
    vehRes,
    compRes,
    otrosGastos,
    validadoPack,
    workingRes,
    rapidinDriverRes,
    fleetDriverRes,
    phoneDriverInfo,
  ] = await Promise.all([
    query(
      'SELECT id, tipo, appointment_date, created_at, created_by, resultado FROM module_miauto_solicitud_cita WHERE solicitud_id = $1 ORDER BY created_at ASC',
      [id]
    ),
    row.cronograma_id
      ? query(
          `SELECT id, name, country, active, tasa_interes_mora, bono_tiempo_activo,
                  requisitos_vehiculo
           FROM module_miauto_cronograma WHERE id = $1`,
          [row.cronograma_id]
        )
      : Promise.resolve({ rows: [] }),
    row.cronograma_vehiculo_id
      ? query(
          `SELECT id, name, inicial, inicial_moneda, cuotas_semanales, requisitos_gastos,
                  ${vehicleImageExpression}
           FROM module_miauto_cronograma_vehiculo WHERE id = $1`,
          [row.cronograma_vehiculo_id]
        )
      : Promise.resolve({ rows: [] }),
    query(
      'SELECT id, monto, file_name, file_path, created_at, estado, validated_at, validated_by, rechazado_at, rechazo_razon, rechazado_by FROM module_miauto_comprobante_pago WHERE solicitud_id = $1 ORDER BY created_at ASC',
      [id]
    ),
    listOtrosGastosBySolicitud(id),
    getTotalValidado(id, {
      country: row.country,
      cronogramaVehiculoId: row.cronograma_vehiculo_id,
      inicialMonedaRaw: row.cronograma_vehiculo_inicial_moneda,
    }),
    row.placa_asignada
      ? query(
          `SELECT first_name, last_name FROM drivers
           WHERE TRIM(COALESCE(park_id::text, '')) = $1
             AND work_status = 'working'
             AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(car_number, '')), ' ', '', 'g')) =
                 UPPER(REGEXP_REPLACE(TRIM($2), ' ', '', 'g'))
           LIMIT 1`,
          [MIAUTO_PARK_ID, row.placa_asignada]
        )
      : Promise.resolve({ rows: [] }),
    row.driver_id_fleet
      ? query(
          `SELECT first_name, last_name
             FROM module_rapidin_drivers
            WHERE id::text = $1
            LIMIT 1`,
          [row.driver_id_fleet]
        )
      : Promise.resolve({ rows: [] }),
    row.driver_id_fleet
      ? query(
          `SELECT first_name, last_name, work_status
             FROM drivers
            WHERE driver_id = $1
            ORDER BY (TRIM(COALESCE(park_id::text, '')) = $2) DESC
            LIMIT 1`,
          [row.driver_id_fleet, MIAUTO_PARK_ID]
        )
      : Promise.resolve({ rows: [] }),
    row.phone
      ? getDriverInfoByPhones(MIAUTO_PARK_ID, [row.phone])
      : Promise.resolve({ names: {}, licenses: {} }),
  ]);
  delete row.cronograma_vehiculo_inicial_moneda;

  row.citas_historial = citasRes.rows || [];

  const crono = cronoRes.rows[0];
  row.cronograma = crono
    ? {
        id: crono.id,
        name: crono.name,
        country: crono.country,
        active: crono.active,
        tasa_interes_mora: crono.tasa_interes_mora != null ? parseFloat(crono.tasa_interes_mora) : 0,
        bono_tiempo_activo: !!crono.bono_tiempo_activo,
        requisitos_vehiculo: crono.requisitos_vehiculo || null,
      }
    : null;

  const v = vehRes.rows[0];
  row.cronograma_vehiculo = v
    ? {
        id: v.id,
        name: v.name,
        inicial: parseFloat(v.inicial) || 0,
        inicial_moneda: v.inicial_moneda || 'USD',
        cuotas_semanales: parseInt(v.cuotas_semanales, 10) || 0,
        requisitos_gastos: v.requisitos_gastos || null,
        image: v.image,
      }
    : null;

  row.comprobantes_pago = compRes.rows || [];
  row.otros_gastos = otrosGastos;
  row.total_validado = validadoPack.total;
  row.total_validado_usd = validadoPack.totalUsd;

  // Datos del conductor desde Yango
  if (row.driver_id_fleet && !skipYangoLicenseLookup) {
    try {
      const { getContractorProfile } = await import('../../../services/yangoService.js');
      const profile = await getContractorProfile(row.driver_id_fleet);
      if (profile.success) {
        row.yango_license = profile.license_number;
        if (!row.license_number || String(row.license_number).trim() === '') {
          row.license_number = profile.license_number;
        }
      }
    } catch { /* no bloquear */ }
  }
  if (workingRes.rows.length > 0) {
    row.working_driver_name = [workingRes.rows[0].first_name, workingRes.rows[0].last_name].filter(Boolean).join(' ').trim();
  }
  const rapidinDriverName = rapidinDriverRes.rows[0]
    ? [rapidinDriverRes.rows[0].first_name, rapidinDriverRes.rows[0].last_name].filter(Boolean).join(' ').trim()
    : '';
  const fleetDriverName = fleetDriverRes.rows[0]
    ? [fleetDriverRes.rows[0].first_name, fleetDriverRes.rows[0].last_name].filter(Boolean).join(' ').trim()
    : '';
  const { digits: phoneDigits, last9: phoneLast9 } = normalizePhoneForDriversMatch(row.phone);
  row.driver_name = rapidinDriverName
    || fleetDriverName
    || phoneDriverInfo.names[phoneDigits]
    || phoneDriverInfo.names[phoneLast9]
    || null;
  row.yango_work_status = fleetDriverRes.rows[0]?.work_status || null;

  // Devolver objeto plano para que cronograma y cronograma_vehiculo se serialicen correctamente en la respuesta API
  return {
    ...row,
    working_driver_name: row.working_driver_name || null,
    cronograma: row.cronograma,
    cronograma_vehiculo: row.cronograma_vehiculo,
    citas_historial: row.citas_historial,
    comprobantes_pago: row.comprobantes_pago,
    otros_gastos: row.otros_gastos,
    total_validado: row.total_validado,
    total_validado_usd: row.total_validado_usd,
  };
};

export async function getActiveSolicitudInfo(phone, driverCountry, rapidinDriverId) {
  const params = [];
  let n = 1;
  const fromJoin = ' FROM module_miauto_solicitud s LEFT JOIN module_rapidin_drivers rd ON rd.id::text = s.driver_id_fleet ';
  let where = " WHERE s.status IN ('pendiente', 'citado', 'aprobado') ";
  if (phone && driverCountry) {
    const phoneForDb = normalizePhoneForDb(phone, driverCountry);
    const digitsOnly = (phone || '').toString().replace(/\D/g, '');
    const last9 = phoneDigitsForRapidinMatch(phone, driverCountry);
    where += ` AND (s.phone = $${n} OR s.phone = $${n + 1} OR REGEXP_REPLACE(COALESCE(s.phone,''), '[^0-9]', '', 'g') = $${n + 2} OR REGEXP_REPLACE(COALESCE(s.phone,''), '[^0-9]', '', 'g') = $${n + 3})`;
    params.push(phoneForDb, phone, digitsOnly, last9);
    n += 4;
  } else if (rapidinDriverId) {
    where += ` AND s.driver_id_fleet = $${n}`;
    params.push(rapidinDriverId);
    n += 1;
  } else {
    return null;
  }
  const result = await query(
    `SELECT s.status, rd.park_id ${fromJoin} ${where} LIMIT 1`,
    params
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { status: row.status, park_id: row.park_id || null };
}

export const createSolicitud = async (data, userId = null) => {
  const {
    country,
    dni,
    phone,
    email,
    license_number,
    description,
    apps = [],
    driver_id_fleet,
    cronograma_id = null,
    cronograma_vehiculo_id = null,
    pago_tipo = null,
    pago_estado = 'pendiente',
    fecha_inicio_cobro_semanal = null,
    placa_asignada = null,
    status = 'pendiente',
  } = data;
  let rapidinDriverIdVal = trimOrUndefined(driver_id_fleet) ?? null;
  if (!rapidinDriverIdVal && dni) {
    rapidinDriverIdVal = await resolveFleetDriverIdFromDni(dni);
  }
  const driverCountry = country || 'PE';
  const activeInfo = await getActiveSolicitudInfo(phone, driverCountry, rapidinDriverIdVal);
  if (activeInfo) throw new ActiveSolicitudError(activeInfo.status, activeInfo.park_id);

  await assertCronogramaPermitePagoInicial(cronograma_id, pago_tipo);
  const conductorId = await ensureMiautoConductor(driverCountry, dni);
  const appsArr = normalizeAppsToCodes(apps);
  const normalizedAssignedPlate = placa_asignada ? normalizePlacaAsignada(placa_asignada) : null;
  if ((status || 'pendiente') === 'aprobado') {
    await assertActivePlateAvailable(normalizedAssignedPlate);
  }
  const result = await query(
    `INSERT INTO module_miauto_solicitud
       (country, dni, phone, email, license_number, description, apps_trabajadas,
        driver_id_fleet, cronograma_id, cronograma_vehiculo_id, pago_tipo, pago_estado,
        fecha_inicio_cobro_semanal, placa_asignada, status, updated_by, soat_validation_status,
        conductor_id, origen_registro)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'solicitud')
     RETURNING *`,
    [
      country || 'PE',
      dni || null,
      phone || null,
      email || null,
      license_number || null,
      description || null,
      JSON.stringify(appsArr),
      rapidinDriverIdVal,
      cronograma_id,
      cronograma_vehiculo_id,
      pago_tipo,
      pago_estado || 'pendiente',
      fecha_inicio_cobro_semanal,
      normalizedAssignedPlate,
      status || 'pendiente',
      userId,
      normalizedAssignedPlate ? 'pending' : 'not_applicable',
      conductorId,
    ]
  );
  enqueueMiautoLicenseValidation({
    solicitudId: result.rows[0].id,
    dni,
    country: country || 'PE',
  });
  enqueueMiautoSoatValidation({
    solicitudId: result.rows[0].id,
    placa: normalizedAssignedPlate,
  });
  return getSolicitudById(result.rows[0].id);
};

export async function listContratosRelacionados(solicitudId) {
  const source = await query(
    'SELECT conductor_id FROM module_miauto_solicitud WHERE id = $1 AND deleted_at IS NULL',
    [solicitudId]
  );
  const conductorId = source.rows[0]?.conductor_id;
  if (!conductorId) return [];
  const result = await query(
    `SELECT s.id, s.conductor_id, s.origen_registro, s.status, s.placa_asignada,
            s.fecha_inicio_cobro_semanal, s.created_at, s.cronograma_id,
            s.cronograma_vehiculo_id, c.name AS cronograma_name, v.name AS vehiculo_name,
            COUNT(cs.id)::int AS total_cuotas,
            COUNT(cs.id) FILTER (
              WHERE cs.status IN ('paid', 'bonificada')
                 OR COALESCE(cs.paid_amount, 0) >= COALESCE(cs.amount_due, 0) + COALESCE(cs.late_fee, 0) + COALESCE(cs.mora_extra, 0) - 0.005
            )::int AS cuotas_pagadas,
            COUNT(cs.id) FILTER (
              WHERE cs.status = 'overdue'
                AND COALESCE(cs.paid_amount, 0) < COALESCE(cs.amount_due, 0) + COALESCE(cs.late_fee, 0) + COALESCE(cs.mora_extra, 0) - 0.005
            )::int AS cuotas_vencidas
     FROM module_miauto_solicitud s
     LEFT JOIN module_miauto_cronograma c ON c.id = s.cronograma_id
     LEFT JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id
     LEFT JOIN module_miauto_cuota_semanal cs ON cs.solicitud_id = s.id AND cs.deleted_at IS NULL
     WHERE s.conductor_id = $1 AND s.status = 'aprobado' AND s.deleted_at IS NULL
     GROUP BY s.id, c.name, v.name
     ORDER BY s.created_at ASC, s.id ASC`,
    [conductorId]
  );
  return result.rows.map((row, index) => ({
    ...row,
    contrato_numero: index + 1,
    etapa: row.fecha_inicio_cobro_semanal ? 'activo' : 'por_activar',
  }));
}

export async function anexarContratoAdicional(sourceSolicitudId, data, userId = null) {
  const placa = normalizePlacaAsignada(data?.placa_asignada);
  const cronogramaId = trimOrUndefined(data?.cronograma_id);
  const cronogramaVehiculoId = trimOrUndefined(data?.cronograma_vehiculo_id);
  const pagoTipo = trimOrUndefined(data?.pago_tipo) || 'completo';
  if (!placa) throw new Error('La placa del nuevo contrato es requerida');
  if (!cronogramaId || !cronogramaVehiculoId) throw new Error('Debe seleccionar el cronograma y el vehículo');

  const created = await withTransaction(async () => {
    const sourceResult = await query(
      `SELECT id, conductor_id, country, dni, phone, email, license_number, description,
              apps_trabajadas, driver_id_fleet, status, facturador_customer_id
       FROM module_miauto_solicitud
       WHERE id = $1 AND deleted_at IS NULL
       FOR UPDATE`,
      [sourceSolicitudId]
    );
    const source = sourceResult.rows[0];
    if (!source) throw new Error('Contrato de origen no encontrado');
    if (source.status !== 'aprobado') throw new Error('Solo se puede anexar un contrato a un conductor con contrato aprobado');

    await assertCronogramaPermitePagoInicial(cronogramaId, pagoTipo);
    const vehicleResult = await query(
      `SELECT 1
       FROM module_miauto_cronograma_vehiculo v
       INNER JOIN module_miauto_cronograma c ON c.id = v.cronograma_id
       WHERE v.id = $1 AND v.cronograma_id = $2 AND c.active = true`,
      [cronogramaVehiculoId, cronogramaId]
    );
    if (vehicleResult.rows.length === 0) throw new Error('El vehículo no pertenece al cronograma seleccionado o está inactivo');

    const duplicatePlate = await query(
      `SELECT id FROM module_miauto_solicitud
       WHERE status = 'aprobado' AND deleted_at IS NULL
         AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(placa_asignada, '')), '[^A-Z0-9]', '', 'g')) = $1
       LIMIT 1`,
      [placa]
    );
    if (duplicatePlate.rows.length > 0) throw new Error('La placa ya pertenece a otro contrato activo');

    const plateDriver = await resolveWorkingMiautoDriverForPlate(placa, source.driver_id_fleet);
    const conductorId = source.conductor_id || await ensureMiautoConductor(source.country, source.dni);
    const inserted = await query(
      `INSERT INTO module_miauto_solicitud
         (conductor_id, origen_registro, country, dni, phone, email, license_number,
          description, apps_trabajadas, driver_id_fleet, recaudo_driver_id,
          cronograma_id, cronograma_vehiculo_id, pago_tipo, pago_estado,
          fecha_inicio_cobro_semanal, placa_asignada, status, facturador_customer_id,
          updated_by, soat_validation_status)
       VALUES ($1, 'contrato_adicional', $2, $3, $4, $5, $6,
               $7, $8::jsonb, $9, $9, $10, $11, $12, 'pendiente',
               NULL, $13, 'aprobado', $14, $15, 'pending')
       RETURNING id, country, dni, placa_asignada`,
      [
        conductorId,
        source.country,
        source.dni,
        source.phone,
        source.email,
        source.license_number,
        source.description,
        JSON.stringify(source.apps_trabajadas || []),
        plateDriver.driver_id,
        cronogramaId,
        cronogramaVehiculoId,
        pagoTipo,
        placa,
        source.facturador_customer_id,
        userId,
      ]
    );
    return inserted.rows[0];
  });

  enqueueMiautoLicenseValidation({
    solicitudId: created.id,
    dni: created.dni,
    country: created.country,
  });
  enqueueMiautoSoatValidation({ solicitudId: created.id, placa: created.placa_asignada });
  return getSolicitudById(created.id, { skipYangoLicenseLookup: true });
}

export const updateSolicitud = async (id, data, userId = null) => {
  let currentSolicitud = null;
  if (
    data.cronograma_id !== undefined
    || data.pago_tipo !== undefined
    || data.placa_asignada !== undefined
    || data.status !== undefined
  ) {
    const currentResult = await query(
      'SELECT cronograma_id, pago_tipo, placa_asignada, status FROM module_miauto_solicitud WHERE id = $1',
      [id]
    );
    if (currentResult.rows.length === 0) return null;
    currentSolicitud = currentResult.rows[0];
    if (data.cronograma_id !== undefined || data.pago_tipo !== undefined) {
      const cronogramaId = data.cronograma_id !== undefined
        ? data.cronograma_id
        : currentSolicitud.cronograma_id;
      const pagoTipo = data.pago_tipo !== undefined ? data.pago_tipo : currentSolicitud.pago_tipo;
      await assertCronogramaPermitePagoInicial(cronogramaId, pagoTipo);
    }
    const targetStatus = data.status !== undefined ? data.status : currentSolicitud.status;
    const targetPlate = data.placa_asignada !== undefined ? data.placa_asignada : currentSolicitud.placa_asignada;
    if (targetStatus === 'aprobado') await assertActivePlateAvailable(targetPlate, id);
  }

  const updates = [];
  const params = [];
  let n = 1;
  if (data.status !== undefined) {
    updates.push(`status = $${n}`);
    params.push(data.status);
    n += 1;
  }
  if (data.rejection_reason !== undefined) {
    updates.push(`rejection_reason = $${n}`);
    params.push(data.rejection_reason);
    n += 1;
  }
  if (data.appointment_date !== undefined) {
    updates.push(`appointment_date = $${n}`);
    params.push(data.appointment_date);
    n += 1;
  }
  if (data.status === 'desactivado') {
    const motivo = data.observations && String(data.observations).trim() ? ' Motivo: ' + String(data.observations).trim() : '';
    updates.push(`observations = $${n}`);
    params.push('Solicitud desactivada por administración.' + motivo);
    n += 1;
  } else if (data.status !== 'desistido' && data.observations !== undefined) {
    updates.push(`observations = $${n}`);
    params.push(data.observations);
    n += 1;
  }
  if (data.status === 'citado') {
    updates.push('cited_at = COALESCE(cited_at, CURRENT_TIMESTAMP)');
    if (userId) {
      updates.push(`cited_by = $${n}`);
      params.push(userId);
      n += 1;
    }
  }
  if (data.status === 'aprobado' || data.status === 'rechazado') {
    updates.push('reviewed_at = CURRENT_TIMESTAMP');
    if (userId) {
      updates.push(`reviewed_by = $${n}`);
      params.push(userId);
      n += 1;
    }
  }
  if (data.status === 'desistido') {
    updates.push('withdrawn_at = CURRENT_TIMESTAMP');
    if (data.withdrawal_reason !== undefined && data.withdrawal_reason !== null) {
      updates.push(`withdrawal_reason = $${n}`);
      params.push(String(data.withdrawal_reason).trim() || null);
      n += 1;
    }
    const obsDesistido = 'El conductor desistió.' + (data.withdrawal_reason && String(data.withdrawal_reason).trim() ? ' Motivo: ' + String(data.withdrawal_reason).trim() : '');
    updates.push(`observations = $${n}`);
    params.push(obsDesistido);
    n += 1;
  }
  if (data.apps !== undefined) {
    updates.push(`apps_trabajadas = $${n}::jsonb`);
    params.push(JSON.stringify(normalizeAppsToCodes(data.apps)));
    n += 1;
  }
  if (data.cronograma_id !== undefined) {
    updates.push(`cronograma_id = $${n}`);
    params.push(data.cronograma_id);
    n += 1;
  }
  if (data.cronograma_vehiculo_id !== undefined) {
    updates.push(`cronograma_vehiculo_id = $${n}`);
    params.push(data.cronograma_vehiculo_id);
    n += 1;
  }
  if (data.pago_tipo !== undefined) {
    updates.push(`pago_tipo = $${n}`);
    params.push(data.pago_tipo);
    n += 1;
  }
  if (data.pago_estado !== undefined) {
    updates.push(`pago_estado = $${n}`);
    params.push(data.pago_estado);
    n += 1;
  }
  if (data.fecha_inicio_cobro_semanal !== undefined) {
    updates.push(`fecha_inicio_cobro_semanal = $${n}`);
    params.push(data.fecha_inicio_cobro_semanal);
    n += 1;
  }
  let changedPlate = null;
  let plateWasChanged = false;
  if (data.placa_asignada !== undefined) {
    changedPlate = data.placa_asignada == null || String(data.placa_asignada).trim() === ''
      ? null
      : normalizePlacaAsignada(data.placa_asignada);
    updates.push(`placa_asignada = $${n}`);
    params.push(changedPlate);
    n += 1;
    const currentPlate = currentSolicitud?.placa_asignada
      ? normalizePlacaAsignada(currentSolicitud.placa_asignada)
      : null;
    plateWasChanged = changedPlate !== currentPlate;
    if (plateWasChanged) {
      updates.push(`soat_validation_status = $${n}`);
      params.push(changedPlate ? 'pending' : 'not_applicable');
      n += 1;
      updates.push('soat_validation_attempts = 0');
      updates.push('soat_validation_checked_at = NULL');
      updates.push('soat_validation_error = NULL');
      updates.push('soat_fecha_inicio = NULL');
      updates.push('soat_fecha_vencimiento = NULL');
      updates.push('soat_compania = NULL');
      updates.push('soat_estado = NULL');
      updates.push('soat_numero_poliza = NULL');
      updates.push('soat_codigo_sbs_aseguradora = NULL');
      updates.push('soat_codigo_unico_poliza = NULL');
    }
  }
  if (updates.length === 0) return getSolicitudById(id);
  if (userId) {
    updates.push(`updated_by = $${n}`);
    params.push(userId);
    n += 1;
  }
  params.push(id);
  await query(
    `UPDATE module_miauto_solicitud SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${n}`,
    params
  );
  if (data.appointment_date !== undefined) {
    await query(
      `UPDATE module_miauto_solicitud_cita SET appointment_date = $1 WHERE solicitud_id = $2 AND id = (SELECT id FROM module_miauto_solicitud_cita WHERE solicitud_id = $2 ORDER BY created_at DESC LIMIT 1)`,
      [data.appointment_date, id]
    );
  }
  if (data.status === 'citado' && data.appointment_date) {
    await query(
      'UPDATE module_miauto_solicitud SET reagendo_count = 1 WHERE id = $1 AND reagendo_count = 0',
      [id]
    );
    const countRes = await query('SELECT COUNT(*)::int AS n FROM module_miauto_solicitud_cita WHERE solicitud_id = $1', [id]);
    if (countRes.rows[0].n === 0) {
      await insertCitaHistorial(id, 'citado', data.appointment_date, userId);
    }
  }
  if (data.status === 'aprobado') {
    await updateLastCitaResultado(id, 'llego');
    await query(
      `UPDATE module_miauto_solicitud SET observations = COALESCE(NULLIF(TRIM(observations), ''), 'Solicitud aprobada.')
       WHERE id = $1 AND (observations IS NULL OR TRIM(observations) = '')`,
      [id]
    );
  }
  if (plateWasChanged && changedPlate) {
    enqueueMiautoSoatValidation({ solicitudId: id, placa: changedPlate });
  }
  return getSolicitudById(id);
};

export const reagendarSolicitud = async (id, newAppointmentDate, userId = null) => {
  const current = await query(
    'SELECT id, status, reagendo_count FROM module_miauto_solicitud WHERE id = $1',
    [id]
  );
  if (current.rows.length === 0) return null;
  const row = current.rows[0];
  if (row.status !== 'citado') {
    throw new Error('Solo se puede reprogramar una solicitud en estado citado');
  }
  if (row.reagendo_count >= MAX_REAGENDOS) {
    throw new Error(`Ya se reprogramó ${MAX_REAGENDOS} veces; debe rechazarse`);
  }
  const params = [newAppointmentDate, row.reagendo_count + 1, id];
  let sql = 'UPDATE module_miauto_solicitud SET appointment_date = $1, reagendo_count = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3';
  if (userId) {
    sql = 'UPDATE module_miauto_solicitud SET appointment_date = $1, reagendo_count = $2, cited_by = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $3';
    params.push(userId);
  }
  await query(sql, params);
  await updateLastCitaResultado(id, 'no_llego');
  await insertCitaHistorial(id, 'cita_reagendada', newAppointmentDate, userId);
  return getSolicitudById(id);
};

export const marcarLlegada = async (id) => {
  const current = await query(
    'SELECT id, status FROM module_miauto_solicitud WHERE id = $1',
    [id]
  );
  if (current.rows.length === 0) return null;
  if (current.rows[0].status !== 'citado') {
    throw new Error('Solo se puede marcar llegada en solicitudes citadas');
  }
  await updateLastCitaResultado(id, 'llego');
  return getSolicitudById(id);
};

export const noVinoRechazar = async (id, userId = null) => {
  const current = await query(
    'SELECT id, status, reagendo_count FROM module_miauto_solicitud WHERE id = $1',
    [id]
  );
  if (current.rows.length === 0) return null;
  const row = current.rows[0];
  if (row.status !== 'citado') {
    throw new Error('Solo aplica a solicitudes en estado citado');
  }
  await updateLastCitaResultado(id, 'no_llego');
  let sql = "UPDATE module_miauto_solicitud SET status = 'rechazado', rejection_reason = COALESCE(rejection_reason, 'No asistió tras reprogramaciones'), reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1";
  const params = [id];
  if (userId) {
    sql = "UPDATE module_miauto_solicitud SET status = 'rechazado', rejection_reason = COALESCE(rejection_reason, 'No asistió tras reprogramaciones'), reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1";
    params.push(userId);
  }
  await query(sql, params);
  return getSolicitudById(id);
};

/**
 * Corrige el inicio de cobro de un contrato recién activado.
 *
 * La fecha participa en la identificación de la semana de depósito, los bonos y
 * el vencimiento inicial. Por eso solo se reprograma automáticamente mientras
 * exista únicamente la cuota bootstrap, sin movimientos ni documentos asociados.
 * Los gastos adicionales conservan su fecha de entrega independiente; solo se
 * sincroniza cuando todavía no existen ciclos ni cuotas de gasto generadas.
 */
export const corregirFechaInicioCobro = async (id, nextValue, userId = null) => {
  return withTransaction(async () => {
    const solicitudResult = await query(
      `SELECT id, status, fecha_inicio_cobro_semanal, fecha_entrega_vehiculo,
              COALESCE(cuotas_semanales_bonificadas, 0)::int AS cuotas_bonificadas
       FROM module_miauto_solicitud
       WHERE id = $1::uuid AND deleted_at IS NULL
       FOR UPDATE`,
      [id]
    );
    const solicitud = solicitudResult.rows[0];
    if (!solicitud) return null;
    if (solicitud.status !== 'aprobado' || !solicitud.fecha_inicio_cobro_semanal) {
      throw new MiautoStartDateCorrectionError(
        'Solo se puede modificar el inicio de cobro de un contrato aprobado y ya activado',
        400,
        'contract_not_active',
      );
    }

    const correction = buildMiautoStartDateCorrection(
      solicitud.fecha_inicio_cobro_semanal,
      nextValue,
    );
    if (!correction.changed) {
      return {
        correction,
        fecha_entrega_actualizada: false,
      };
    }
    if (solicitud.cuotas_bonificadas > 0) {
      throw new MiautoStartDateCorrectionError(
        'No se puede modificar automáticamente porque el contrato ya tiene bonos aplicados. La fecha se mantuvo sin cambios.',
      );
    }

    const cuotasResult = await query(
      `SELECT id, week_start_date::text, due_date::text, status,
              amount_due, paid_amount, num_viajes, partner_fees_raw,
              partner_fees_83, bono_auto, cobro_saldo, cobro_desde_saldo_conductor,
              saldo_favor_conductor, late_fee, mora_extra, mora_extra_total,
              pago_puntual, fecha_ultimo_abono, fecha_primer_comprobante
       FROM module_miauto_cuota_semanal
       WHERE solicitud_id = $1::uuid AND deleted_at IS NULL
       ORDER BY week_start_date, created_at, id
       FOR UPDATE`,
      [id]
    );
    const firstCuota = assertBootstrapWeeklyQuotaForStartDateCorrection(
      cuotasResult.rows,
      correction.currentWeekStart,
    );
    if (
      Math.abs(Number(firstCuota.cobro_desde_saldo_conductor || 0)) > 0.005
      || Math.abs(Number(firstCuota.saldo_favor_conductor || 0)) > 0.005
      || Math.abs(Number(firstCuota.mora_extra_total || 0)) > 0.005
      || firstCuota.fecha_ultimo_abono
      || firstCuota.fecha_primer_comprobante
    ) {
      throw new MiautoStartDateCorrectionError(
        'No se puede modificar automáticamente porque la cuota inicial ya tiene movimientos registrados. La fecha se mantuvo sin cambios.',
      );
    }

    const linkedActivityResult = await query(
      `SELECT
         EXISTS (
           SELECT 1 FROM module_miauto_comprobante_cuota_semanal
           WHERE cuota_semanal_id = $1::uuid
         ) AS has_receipts,
         EXISTS (
           SELECT 1 FROM module_miauto_evidencia_cobro_fleet
           WHERE cuota_semanal_id = $1::uuid
         ) AS has_evidence,
         EXISTS (
           SELECT 1 FROM module_miauto_nota_venta_cuota
           WHERE cuota_semanal_id = $1::uuid
         ) AS has_sale_notes,
         EXISTS (
           SELECT 1 FROM module_miauto_paid_adjustment_log
           WHERE cuota_semanal_id = $1::uuid
         ) AS has_paid_adjustments,
         EXISTS (
           SELECT 1 FROM module_miauto_fleet_charge_attempt
           WHERE cuota_semanal_id = $1::uuid
         ) AS has_fleet_attempts,
         EXISTS (
           SELECT 1 FROM module_miauto_bono_tiempo
           WHERE target_cuota_semanal_id = $1::uuid
              OR source_cuota_ids @> jsonb_build_array($1::text)
         ) AS has_time_bonus`,
      [firstCuota.id]
    );
    if (Object.values(linkedActivityResult.rows[0] || {}).some(Boolean)) {
      throw new MiautoStartDateCorrectionError(
        'No se puede modificar automáticamente porque la cuota inicial tiene comprobantes, cobros o documentos asociados. La fecha se mantuvo sin cambios.',
      );
    }

    const expenseStateResult = await query(
      `SELECT
         EXISTS (
           SELECT 1 FROM module_miauto_otros_gastos
           WHERE solicitud_id = $1::uuid AND deleted_at IS NULL
         ) AS has_expenses,
         EXISTS (
           SELECT 1 FROM module_miauto_gasto_ciclo
           WHERE solicitud_id = $1::uuid
         ) AS has_expense_cycles`,
      [id]
    );
    const expenseState = expenseStateResult.rows[0] || {};
    const currentDeliveryDate = solicitud.fecha_entrega_vehiculo
      ? normalizeMiautoStoredStartDate(solicitud.fecha_entrega_vehiculo)
      : null;
    const updateDeliveryDate = currentDeliveryDate === correction.currentDate
      && !expenseState.has_expenses
      && !expenseState.has_expense_cycles;

    await query(
      `UPDATE module_miauto_solicitud
       SET fecha_inicio_cobro_semanal = $2::date,
           fecha_entrega_vehiculo = CASE WHEN $3::boolean THEN $2::date ELSE fecha_entrega_vehiculo END,
           updated_by = COALESCE($4::uuid, updated_by),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid`,
      [id, correction.nextDate, updateDeliveryDate, userId]
    );
    await query(
      `UPDATE module_miauto_cuota_semanal
       SET week_start_date = $2::date,
           due_date = $3::date,
           updated_by = COALESCE($4::uuid, updated_by),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid`,
      [firstCuota.id, correction.nextWeekStart, correction.nextDate, userId]
    );

    await query(
      `INSERT INTO module_miauto_billing_audit_trail
         (cuota_semanal_id, solicitud_id, week_start_date, semana_ordinal,
          event_type, billing_context, generated_by, actor_id)
       VALUES ($1::uuid, $2::uuid, $3::date, 1,
               'start_date_corrected', $4::jsonb, 'admin_start_date_correction', $5::uuid)`,
      [
        firstCuota.id,
        id,
        correction.nextWeekStart,
        JSON.stringify({
          correction: {
            previous_start_date: correction.currentDate,
            new_start_date: correction.nextDate,
            previous_week_start: correction.currentWeekStart,
            new_week_start: correction.nextWeekStart,
            delivery_date_updated: updateDeliveryDate,
          },
        }),
        userId,
      ]
    );

    return {
      correction,
      fecha_entrega_actualizada: updateDeliveryDate,
    };
  });
};

/**
 * Generar Yego Mi Auto: setea fecha_inicio_cobro_semanal (día del depósito / inicio cobro) y crea la primera cuota.
 * Opciones: `fecha_inicio_cobro_semanal` (YYYY-MM-DD) = fecha real del depósito; si no viene, se usa **hoy en Lima** (`getLimaYmd`).
 * La fila semanal usa `week_start_date` = lunes de la semana civil que contiene esa fecha (puede coincidir con el depósito si cae lunes).
 * Permitido si: aprobado, cronograma/vehículo asignados, y (pago_estado completo O pago parcial con al menos 500 USD validados).
 * Con pago parcial: activa el ciclo de inicial parcial configurado en el cronograma del vehiculo.
 */
export const generarYegoMiAuto = async (id, options = {}) => {
  const row = await query(
    'SELECT id, status, pago_estado, pago_tipo, cronograma_id, cronograma_vehiculo_id, fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1',
    [id]
  );
  if (row.rows.length === 0) return null;
  const s = row.rows[0];
  if (s.fecha_inicio_cobro_semanal) {
    throw new Error('Yego Mi Auto ya fue generado para esta solicitud');
  }
  if (s.status !== 'aprobado' || !s.cronograma_id || !s.cronograma_vehiculo_id) {
    throw new Error('Solo se puede generar Yego Mi Auto cuando la solicitud está aprobada y tiene cronograma/vehículo asignados');
  }

  const placaRaw = options.placa_asignada != null ? options.placa_asignada : '';
  const placa = normalizePlacaAsignada(placaRaw);
  if (!placa) {
    throw new Error('Debe indicar la placa asignada del vehículo para generar Yego Mi Auto');
  }

  const pagoCompleto = s.pago_estado === 'completo';
  if (!pagoCompleto) {
    if (s.pago_tipo !== 'parcial') {
      throw new Error('Se requiere pago completo o pago parcial con al menos 500 USD validados para generar Yego Mi Auto');
    }
    const { totalUsd } = await getTotalValidado(id);
    if (totalUsd < MINIMO_USD_PARCIAL) {
      throw new Error(`Con pago parcial se requieren al menos ${MINIMO_USD_PARCIAL} USD validados para generar Yego Mi Auto`);
    }
  }

  const optFi =
    options.fecha_inicio_cobro_semanal != null
      ? String(options.fecha_inicio_cobro_semanal).trim().slice(0, 10)
      : '';
  let fechaInicioStored;
  let weekStartFirstCuota;
  if (optFi && /^\d{4}-\d{2}-\d{2}$/.test(optFi)) {
    fechaInicioStored = optFi;
    weekStartFirstCuota = mondayOfWeekContainingYmd(optFi);
  } else {
    /** Día civil actual en Lima = inicio de cobro / depósito (no forzar al lunes: el vencimiento de la 1.ª cuota es esta fecha). */
    fechaInicioStored = getLimaYmd(new Date());
    weekStartFirstCuota = mondayOfWeekContainingYmd(fechaInicioStored);
  }

  const updated = await updateSolicitud(id, { fecha_inicio_cobro_semanal: fechaInicioStored, placa_asignada: placa });

  // Primera cuota semanal (depósito): usa BillingEngine centralizado.
  let primeraCuotaId;
  try {
    const result = await generateWeeklyCharge({
      solicitudId: id,
      weekStartDate: weekStartFirstCuota,
      incomeResult: { count_completed: 0, partner_fees: 0 },
      options: { generatedBy: 'generar_yego_miauto' },
    });
    if (result?.error) throw new Error(result.error);
    primeraCuotaId = result?.cuotaId;
  } catch (err) {
    await updateSolicitud(id, { fecha_inicio_cobro_semanal: null });
    logger.error('Mi Auto: no se pudo crear la primera cuota al generar Yego Mi Auto:', err);
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (!primeraCuotaId) {
    await updateSolicitud(id, { fecha_inicio_cobro_semanal: null });
    throw new Error(
      'No se pudo crear la primera cuota semanal. Revise que el vehículo asignado exista en el cronograma y que las reglas de viajes sean válidas.'
    );
  }

  // Semana 1 (depósito) → paid
  await query(
    `UPDATE module_miauto_cuota_semanal 
     SET status = 'paid', paid_amount = amount_due, updated_at = CURRENT_TIMESTAMP 
     WHERE id = $1`,
    [primeraCuotaId]
  );

  // Generar cuotas para semanas entre depósito y el lunes de hoy
  const todayMonday = mondayOfWeekContainingYmd(getLimaYmd(new Date()));
  if (todayMonday > weekStartFirstCuota) {
    // La identidad Yango de cada contrato se resuelve exclusivamente por su placa.
    const solDrv = await query(
      `SELECT s.driver_id_fleet, s.placa_asignada
       FROM module_miauto_solicitud s WHERE s.id = $1`,
      [id]
    );
    const solData = solDrv.rows[0];
    let plateDriver = null;
    try {
      plateDriver = await resolveWorkingMiautoDriverForPlate(
        solData?.placa_asignada,
        solData?.driver_id_fleet
      );
    } catch (error) {
      logger.warn(
        `Mi Auto generarYegoMiAuto: no se generan cuotas intermedias para ${id}: ${error.message}`
      );
    }

    if (plateDriver) {
      for (let monday = addDaysYmd(weekStartFirstCuota, 7); monday <= todayMonday; monday = addDaysYmd(monday, 7)) {
        const { dateFrom, dateTo } = limaWeekStartToMiAutoIncomeRange(monday);
        let incomeResult = { count_completed: 0, partner_fees: 0 };
        try {
          const income = await getDriverIncome(
            dateFrom,
            dateTo,
            plateDriver.driver_id,
            plateDriver.park_id
          );
          if (income.success) {
            incomeResult = { count_completed: income.count_completed || 0, partner_fees: income.partner_fees || 0 };
          }
        } catch (e) {
          logger.warn(`Mi Auto generarYegoMiAuto: income Yango falló para ${id} semana ${monday}: ${e.message}`);
        }

        try {
          await generateWeeklyCharge({
            solicitudId: id,
            weekStartDate: monday,
            incomeResult,
            options: { generatedBy: 'generar_yego_miauto', forceUseYangoData: true },
          });
        } catch (e) {
          logger.warn(`Mi Auto generarYegoMiAuto: falló cuota semana ${monday} para ${id}: ${e.message}`);
        }
      }
    }
  }

  try {
    await updateExpenseConfiguration(id, {
      fecha_entrega_vehiculo: fechaInicioStored,
      inicial_parcial_activa: !pagoCompleto && s.pago_tipo === 'parcial',
      gastos_automaticos_activos: true,
    }, options.userId || null);
    await generateExpenseCycles(id, {
      periodYear: Number(fechaInicioStored.slice(0, 4)),
      userId: options.userId || null,
    });
  } catch (err) {
    logger.warn('Mi Auto: no se pudieron generar los ciclos de gastos adicionales:', err.message);
  }

  return updated;
};
