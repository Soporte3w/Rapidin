import { query } from '../config/database.js';
import { getCronogramasByIds, getMonedaCuotaSemanalPorVehiculo } from './miautoCronogramaService.js';
import { normalizePhoneForDb, phoneDigitsForRapidinMatch } from '../utils/helpers.js';
import { ensureCuotaSemanalForWeek } from './miautoCuotaSemanalService.js';
import { getLimaYmd, mondayOfWeekContainingYmd } from '../utils/miautoLimaWeekRange.js';
import { getTotalValidado } from './miautoComprobantePagoService.js';
import { ensureOtroGastoForWeek, listBySolicitud as listOtrosGastosBySolicitud, listBySolicitudIds as listOtrosGastosBySolicitudIds } from './miautoOtrosGastosService.js';
import { logger } from '../utils/logger.js';
import {
  MIAUTO_PARK_ID,
  getDriverInfoByPhones,
  normalizePhoneForDriversMatch,
} from './miautoDriverLookup.js';

const MINIMO_USD_PARCIAL = 500;

const MAX_REAGENDOS = 2;

function trimOrUndefined(x) {
  if (x == null) return undefined;
  const s = String(x).trim();
  return s === '' ? undefined : s;
}

/** Normaliza placa para almacenamiento (mayúsculas, sin espacios internos). */
function normalizePlacaAsignada(value) {
  if (value == null) return '';
  return String(value).trim().toUpperCase().replace(/\s+/g, '');
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
  const { status, country, date_from, date_to, page = 1, limit = 20, driver_phone, driver_country, park_id, rapidin_driver_id, forDriver } = filters;
  const params = [];
  let n = 1;
  let fromJoin = ' FROM module_miauto_solicitud s LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id ';
  if (forDriver) {
    fromJoin += ' LEFT JOIN module_miauto_cronograma c ON c.id = s.cronograma_id LEFT JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id ';
  }
  let where = ' WHERE 1=1 ';
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
  const rid = trimOrUndefined(rapidin_driver_id);
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
      where += ` AND (${phoneMatch} OR s.rapidin_driver_id = $${n})`;
      params.push(rid);
      n += 1;
    } else {
      where += ` AND ${phoneMatch}`;
    }
  } else if (rid) {
    where += ` AND s.rapidin_driver_id = $${n}`;
    params.push(rid);
    n += 1;
  }

  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limitNum;

  const countResult = await query(
    `SELECT COUNT(*)::int AS total ${fromJoin} ${where}`,
    params
  );
  const total = countResult.rows[0]?.total ?? 0;

  const selectFields = forDriver
    ? `SELECT s.id, s.dni, s.phone, s.email, s.license_number, s.status, s.created_at, s.country, s.pago_tipo, s.pago_estado, s.fecha_inicio_cobro_semanal,
            s.placa_asignada, s.appointment_date, s.reagendo_count, s.observations, s.rejection_reason, s.withdrawn_at, s.withdrawal_reason,
            rd.first_name AS driver_first_name, rd.last_name AS driver_last_name,
            c.name AS cronograma_name, c.tasa_interes_mora AS cronograma_tasa_interes_mora, c.bono_tiempo_activo AS cronograma_bono_tiempo_activo,
            v.name AS vehiculo_name, v.inicial AS vehiculo_inicial, v.inicial_moneda AS vehiculo_inicial_moneda, v.cuotas_semanales AS vehiculo_cuotas_semanales, v.image AS vehiculo_image`
    : `SELECT s.id, s.dni, s.phone, s.email, s.license_number, s.status, s.created_at,
            rd.first_name AS driver_first_name, rd.last_name AS driver_last_name`;
  const dataResult = await query(
    `${selectFields}
     ${fromJoin}
     ${where}
     ORDER BY s.created_at DESC
     LIMIT $${n} OFFSET $${n + 1}`,
    [...params, limitNum, offset]
  );

  let comprobantesBySolicitud = {};
  let citasBySolicitud = {};
  let otrosGastosBySolicitud = {};
  let totalValidadoBySolicitud = {};
  if (forDriver && dataResult.rows.length > 0) {
    const ids = dataResult.rows.map((r) => r.id);
    const [compRes, citasRes, otrosGastosMap, ...totalsList] = await Promise.all([
      query(
        'SELECT solicitud_id, id, monto, file_name, file_path, created_at, estado, validated_at, validated_by, rechazado_at, rechazo_razon, rechazado_by FROM module_miauto_comprobante_pago WHERE solicitud_id = ANY($1::uuid[]) ORDER BY created_at ASC',
        [ids]
      ),
      query(
        'SELECT solicitud_id, id, tipo, appointment_date, created_at, resultado FROM module_miauto_solicitud_cita WHERE solicitud_id = ANY($1::uuid[]) ORDER BY created_at ASC',
        [ids]
      ),
      listOtrosGastosBySolicitudIds(ids),
      ...ids.map((id) => getTotalValidado(id)),
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
    ids.forEach((id, i) => {
      const t = totalsList[i];
      if (t) totalValidadoBySolicitud[id] = { total: t.total, totalUsd: t.totalUsd };
    });
  }

  const nameFromRapidinList = (r) => [r.driver_first_name, r.driver_last_name].filter(Boolean).map(String).join(' ').trim() || null;
  const licenseOnSolicitud = (r) => {
    const lic = r.license_number;
    return lic != null && String(lic).trim() !== '' ? String(lic).trim() : null;
  };
  const phonesForLookupList = dataResult.rows
    .filter((r) => r.phone && (!nameFromRapidinList(r) || !licenseOnSolicitud(r)))
    .map((r) => r.phone);
  const driverInfoList = await getDriverInfoByPhones(MIAUTO_PARK_ID, phonesForLookupList);

  const rows = dataResult.rows.map((r) => {
    let driverName = nameFromRapidinList(r);
    if (!driverName && r.phone) {
      const { digits, last9 } = normalizePhoneForDriversMatch(r.phone);
      driverName = driverInfoList.names[digits] || driverInfoList.names[last9] || null;
    }
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
      status: r.status,
      created_at: r.created_at,
      driver_name: driverName || undefined,
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
        ? { name: r.cronograma_name, tasa_interes_mora: r.cronograma_tasa_interes_mora != null ? parseFloat(r.cronograma_tasa_interes_mora) : 0, bono_tiempo_activo: !!r.cronograma_bono_tiempo_activo }
        : undefined;
      out.cronograma_vehiculo = r.vehiculo_name != null || r.vehiculo_inicial != null
        ? { name: r.vehiculo_name, inicial: r.vehiculo_inicial != null ? parseFloat(r.vehiculo_inicial) : 0, inicial_moneda: r.vehiculo_inicial_moneda || 'USD', cuotas_semanales: r.vehiculo_cuotas_semanales != null ? parseInt(r.vehiculo_cuotas_semanales, 10) || 0 : 0, image: r.vehiculo_image }
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
  const { country, page = 1, limit = 20, q: qFilter, cronograma_id: cronogramaIdFilter } = filters;
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
    const qLower = qRaw.toLowerCase();
    where += ` AND (
      position($${n}::text in lower(coalesce(s.placa_asignada, ''))) > 0
      OR position($${n}::text in lower(coalesce(s.license_number, ''))) > 0
      OR position($${n}::text in lower(coalesce(s.dni, ''))) > 0
      OR position($${n}::text in lower(coalesce(rd.dni, ''))) > 0
      OR position($${n}::text in lower(coalesce(rd.first_name, ''))) > 0
      OR position($${n}::text in lower(coalesce(rd.last_name, ''))) > 0
      OR position($${n}::text in lower(trim(coalesce(rd.first_name, '')) || ' ' || trim(coalesce(rd.last_name, '')))) > 0
    )`;
    params.push(qLower);
    n += 1;
  }
  const cronogramaId = trimOrUndefined(cronogramaIdFilter);
  if (cronogramaId && UUID_RE.test(cronogramaId)) {
    where += ` AND s.cronograma_id = $${n}::uuid`;
    params.push(cronogramaId);
    n += 1;
  }
  const cuotaEstado = trimOrUndefined(filters.cuota_estado);
  if (cuotaEstado) {
    const ce = String(cuotaEstado).toLowerCase();
    if (ce === 'vencido') {
      where += ` AND EXISTS (SELECT 1 FROM module_miauto_cuota_semanal cs WHERE cs.solicitud_id = s.id AND cs.status = 'overdue')`;
    } else if (ce === 'pendiente') {
      where += ` AND EXISTS (SELECT 1 FROM module_miauto_cuota_semanal cs WHERE cs.solicitud_id = s.id AND cs.status = 'pending')`;
    } else if (ce === 'al_dia') {
      where += ` AND EXISTS (SELECT 1 FROM module_miauto_cuota_semanal cs WHERE cs.solicitud_id = s.id)
                AND NOT EXISTS (SELECT 1 FROM module_miauto_cuota_semanal cs2 WHERE cs2.solicitud_id = s.id AND cs2.status = 'overdue')`;
    } else if (ce === 'sin_cuotas') {
      where += ` AND NOT EXISTS (SELECT 1 FROM module_miauto_cuota_semanal cs WHERE cs.solicitud_id = s.id)`;
    }
  }
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limitNum;

  const fromBase = `
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     LEFT JOIN module_miauto_cronograma c ON c.id = s.cronograma_id
     LEFT JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id`;

  const listSql = `SELECT s.id, s.cronograma_id, s.cronograma_vehiculo_id, s.dni, s.phone, s.email, s.license_number, s.status, s.created_at, s.fecha_inicio_cobro_semanal, s.placa_asignada,
            rd.first_name AS driver_first_name, rd.last_name AS driver_last_name,
            c.name AS cronograma_name, v.name AS vehiculo_name, v.cuotas_semanales AS vehiculo_cuotas_semanales
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
  const cronogramaIds = [...new Set(rows.map((row) => row.cronograma_id).filter(Boolean))];

  const cuotaSummaryBySolicitud = {};
  const [summaryRes, cronogramaCache] = await Promise.all([
    solicitudIds.length > 0
      ? query(
          `SELECT c.solicitud_id,
                  COUNT(*)::int AS total_cuotas,
                  COUNT(*) FILTER (WHERE c.status IN ('paid', 'bonificada'))::int AS cuotas_pagadas,
                  COUNT(*) FILTER (WHERE c.status = 'overdue')::int AS cuotas_vencidas,
                  COALESCE(SUM(c.paid_amount), 0)::decimal AS total_pagado
           FROM module_miauto_cuota_semanal c
           WHERE c.solicitud_id = ANY($1::uuid[])
           GROUP BY c.solicitud_id`,
          [solicitudIds]
        )
      : Promise.resolve({ rows: [] }),
    getCronogramasByIds(cronogramaIds),
  ]);
  for (const r of summaryRes.rows || []) {
    cuotaSummaryBySolicitud[r.solicitud_id] = {
      total_cuotas: r.total_cuotas,
      cuotas_pagadas: r.cuotas_pagadas,
      cuotas_vencidas: r.cuotas_vencidas,
      total_pagado: parseFloat(r.total_pagado) || 0,
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
  const driverInfoAv = await getDriverInfoByPhones(MIAUTO_PARK_ID, phonesForLookup);

  const data = rows.map((r) => {
    let driverName = nameFromRapidin(r);
    if (!driverName && r.phone) {
      const { digits, last9 } = normalizePhoneForDriversMatch(r.phone);
      driverName = driverInfoAv.names[digits] || driverInfoAv.names[last9] || null;
    }
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
    };
    const cuotasPlan = r.vehiculo_cuotas_semanales != null ? parseInt(r.vehiculo_cuotas_semanales, 10) || 0 : 0;
    const crono = r.cronograma_id ? cronogramaCache.get(String(r.cronograma_id)) : null;
    const moneda =
      crono && r.cronograma_vehiculo_id
        ? getMonedaCuotaSemanalPorVehiculo(crono, r.cronograma_vehiculo_id)
        : 'PEN';
    return {
      id: r.id,
      dni: r.dni,
      phone: r.phone || undefined,
      email: r.email || undefined,
      license_number: licenseNum || undefined,
      status: r.status,
      created_at: r.created_at,
      fecha_inicio_cobro_semanal: r.fecha_inicio_cobro_semanal,
      placa_asignada: r.placa_asignada != null && String(r.placa_asignada).trim() !== '' ? String(r.placa_asignada).trim() : undefined,
      driver_name: driverName || undefined,
      cronograma_name: r.cronograma_name || undefined,
      vehiculo_name: r.vehiculo_name || undefined,
      cuotas_semanales_plan: cuotasPlan,
      total_cuotas: summary.total_cuotas,
      cuotas_pagadas: summary.cuotas_pagadas,
      cuotas_vencidas: summary.cuotas_vencidas,
      total_pagado: summary.total_pagado,
      moneda,
    };
  });
  return { data, total };
};

export const getSolicitudById = async (id, options = {}) => {
  const skipYangoLicenseLookup = options.skipYangoLicenseLookup === true;
  const result = await query(
    `SELECT id, country, dni, phone, email, license_number, description,
            status, rejection_reason, cited_at, cited_by, appointment_date, reagendo_count,
            reviewed_at, reviewed_by, withdrawn_at, withdrawal_reason, observations, created_at, updated_at, rapidin_driver_id,
            cronograma_id, cronograma_vehiculo_id, pago_tipo, pago_estado, fecha_inicio_cobro_semanal, placa_asignada,
            COALESCE(apps_trabajadas, '[]'::jsonb) AS apps_trabajadas
     FROM module_miauto_solicitud WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  const [citasRes, cronoRes, vehRes, compRes, otrosGastos, validadoPack] = await Promise.all([
    query(
      'SELECT id, tipo, appointment_date, created_at, created_by, resultado FROM module_miauto_solicitud_cita WHERE solicitud_id = $1 ORDER BY created_at ASC',
      [id]
    ),
    row.cronograma_id
      ? query(
          'SELECT id, name, country, active, tasa_interes_mora, bono_tiempo_activo FROM module_miauto_cronograma WHERE id = $1',
          [row.cronograma_id]
        )
      : Promise.resolve({ rows: [] }),
    row.cronograma_vehiculo_id
      ? query(
          'SELECT id, name, inicial, inicial_moneda, cuotas_semanales, image FROM module_miauto_cronograma_vehiculo WHERE id = $1',
          [row.cronograma_vehiculo_id]
        )
      : Promise.resolve({ rows: [] }),
    query(
      'SELECT id, monto, file_name, file_path, created_at, estado, validated_at, validated_by, rechazado_at, rechazo_razon, rechazado_by FROM module_miauto_comprobante_pago WHERE solicitud_id = $1 ORDER BY created_at ASC',
      [id]
    ),
    listOtrosGastosBySolicitud(id),
    getTotalValidado(id),
  ]);

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
        image: v.image,
      }
    : null;

  row.comprobantes_pago = compRes.rows || [];
  row.otros_gastos = otrosGastos;
  row.total_validado = validadoPack.total;
  row.total_validado_usd = validadoPack.totalUsd;

  let licenseNumber = row.license_number;
  if (
    !skipYangoLicenseLookup &&
    (!licenseNumber || String(licenseNumber).trim() === '') &&
    row.phone
  ) {
    const { licenses } = await getDriverInfoByPhones(MIAUTO_PARK_ID, [row.phone]);
    const { digits, last9 } = normalizePhoneForDriversMatch(row.phone);
    const fromDrv = licenses[digits] || licenses[last9];
    if (fromDrv) licenseNumber = fromDrv;
  }

  // Devolver objeto plano para que cronograma y cronograma_vehiculo se serialicen correctamente en la respuesta API
  return {
    ...row,
    license_number: licenseNumber,
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
  const fromJoin = ' FROM module_miauto_solicitud s LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id ';
  let where = " WHERE s.status IN ('pendiente', 'citado', 'aprobado') ";
  if (phone && driverCountry) {
    const phoneForDb = normalizePhoneForDb(phone, driverCountry);
    const digitsOnly = (phone || '').toString().replace(/\D/g, '');
    const last9 = phoneDigitsForRapidinMatch(phone, driverCountry);
    where += ` AND (s.phone = $${n} OR s.phone = $${n + 1} OR REGEXP_REPLACE(COALESCE(s.phone,''), '[^0-9]', '', 'g') = $${n + 2} OR REGEXP_REPLACE(COALESCE(s.phone,''), '[^0-9]', '', 'g') = $${n + 3})`;
    params.push(phoneForDb, phone, digitsOnly, last9);
    n += 4;
  } else if (rapidinDriverId) {
    where += ` AND s.rapidin_driver_id = $${n}`;
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

export const createSolicitud = async (data) => {
  const { country, dni, phone, email, license_number, description, apps = [], rapidin_driver_id } = data;
  const rapidinDriverIdVal = trimOrUndefined(rapidin_driver_id) ?? null;
  const driverCountry = country || 'PE';
  const activeInfo = await getActiveSolicitudInfo(phone, driverCountry, rapidinDriverIdVal);
  if (activeInfo) throw new ActiveSolicitudError(activeInfo.status, activeInfo.park_id);

  const appsArr = normalizeAppsToCodes(apps);
  const result = await query(
    `INSERT INTO module_miauto_solicitud (country, dni, phone, email, license_number, description, apps_trabajadas, rapidin_driver_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING *`,
    [country || 'PE', dni || null, phone || null, email || null, license_number || null, description || null, JSON.stringify(appsArr), rapidinDriverIdVal]
  );
  return getSolicitudById(result.rows[0].id);
};

export const updateSolicitud = async (id, data, userId = null) => {
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
  if (data.observations !== undefined) {
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
  if (data.placa_asignada !== undefined) {
    const p = data.placa_asignada == null || String(data.placa_asignada).trim() === ''
      ? null
      : normalizePlacaAsignada(data.placa_asignada);
    updates.push(`placa_asignada = $${n}`);
    params.push(p);
    n += 1;
  }
  if (data.otros_gastos_saldo_total !== undefined) {
    updates.push(`otros_gastos_saldo_total = $${n}`);
    params.push(data.otros_gastos_saldo_total);
    n += 1;
  }
  if (data.otros_gastos_num_cuotas !== undefined) {
    updates.push(`otros_gastos_num_cuotas = $${n}`);
    params.push(data.otros_gastos_num_cuotas);
    n += 1;
  }
  if (updates.length === 0) return getSolicitudById(id);
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
 * Generar Yego Mi Auto: setea fecha_inicio_cobro_semanal (día del depósito / inicio cobro) y crea la primera cuota.
 * Opciones: `fecha_inicio_cobro_semanal` (YYYY-MM-DD) = fecha real del depósito; si no viene, se usa **hoy en Lima** (`getLimaYmd`).
 * La fila semanal usa `week_start_date` = lunes de la semana civil que contiene esa fecha (puede coincidir con el depósito si cae lunes).
 * Permitido si: aprobado, cronograma/vehículo asignados, y (pago_estado completo O pago parcial con al menos 500 USD validados).
 * Con pago parcial: crea 26 cuotas "otros gastos" (saldo pendiente); vencimientos en lunes desde semana 2 del plan.
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

  // Primera cuota semanal (depósito): due_date = fecha_inicio (computeDueDateForMiAutoCuota).
  // Sin esta fila no debe crearse "otros gastos" (pago parcial): antes el catch tragaba el error y
  // ensureCuotaSemanalForWeek podía devolver null sin lanzar → quedaba solo otros gastos y sin cronograma semanal.
  let primeraCuotaId;
  try {
    primeraCuotaId = await ensureCuotaSemanalForWeek(
      id,
      s.cronograma_id,
      s.cronograma_vehiculo_id,
      weekStartFirstCuota,
      { count_completed: 0, partner_fees: 0 }
    );
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

  // Pago parcial: guardar saldo y N en solicitud; crear solo la fila de semana 2 (resto se crea lazy al listar).
  if (!pagoCompleto && s.pago_tipo === 'parcial') {
    const veh = await query(
      'SELECT inicial FROM module_miauto_cronograma_vehiculo WHERE id = $1',
      [s.cronograma_vehiculo_id]
    );
    const inicial = veh.rows[0] ? parseFloat(veh.rows[0].inicial) || 0 : 0;
    const { total } = await getTotalValidado(id);
    const saldo = Math.max(0, inicial - total);
    if (saldo > 0) {
      try {
        const crono = await query(
          'SELECT COALESCE(NULLIF(cuotas_otros_gastos, 0), 26) AS n FROM module_miauto_cronograma WHERE id = $1',
          [s.cronograma_id]
        );
        const numCuotas = crono.rows[0] ? parseInt(crono.rows[0].n, 10) || 26 : 26;
        await updateSolicitud(id, {
          otros_gastos_saldo_total: saldo,
          otros_gastos_num_cuotas: numCuotas,
        });
        await ensureOtroGastoForWeek(id, 2);
      } catch (err) {
        logger.warn('Mi Auto: no se pudieron configurar/crear cuota de otros gastos:', err.message);
      }
    }
  }

  return updated;
};
