/**
 * Yego Mi Auto — cuotas semanales: generación por semana, mora, cobro fleet (Yango), API conductor/admin.
 */
import { query } from '../config/database.js';
import { computeDueDateForMiAutoCuota, mondayOfWeekContainingYmd } from '../utils/miautoLimaWeekRange.js';
import {
  getCronogramaById,
  getMonedaCuotaSemanalPorVehiculo,
  getRuleForTripCount,
  resolveMonedaCuotaSemanal,
} from './miautoCronogramaService.js';
import { getContractorBalance, withdrawFromContractor } from './yangoService.js';
import { logger } from '../utils/logger.js';
import { round2 } from './miautoMoneyUtils.js';

const PARTNER_FEES_PCT = 0.8333;

function ymdFromDbDate(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    return m ? m[1] : null;
  }
  try {
    return new Date(v).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function diffDaysYmdUtc(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  const ta = Date.UTC(ya, ma - 1, da);
  const tb = Date.UTC(yb, mb - 1, db);
  return Math.round((tb - ta) / (24 * 60 * 60 * 1000));
}

/**
 * Monto base semanal antes de mora: cuota neta (plan − bono − 83,33% partner_fees) + cobro del saldo (regla)
 * + (% comisión × partner_fees_raw de Yango). pct_comision y cobro_saldo se guardan en la fila y entran aquí.
 */
function computeAmountDueSemanal({ cuotaSemanal, bonoAuto, partnerFeesRaw, pctComision, cobroSaldo }) {
  const partnerFees83 = round2(Number(partnerFeesRaw) * PARTNER_FEES_PCT);
  const cuotaNeta = round2(Math.max(0, (cuotaSemanal - bonoAuto) - partnerFees83));
  const pfRaw = round2(Number(partnerFeesRaw) || 0);
  const pct = round2(Number(pctComision) || 0);
  const cobro = round2(Number(cobroSaldo) || 0);
  const comisionSobrePartnerFees = round2(pfRaw * (pct / 100));
  return round2(Math.max(0, cuotaNeta + cobro + comisionSobrePartnerFees));
}

/**
 * Regla por tramo de viajes + montos del vehículo en el cronograma (misma base que ensureCuotaSemanalForWeek).
 * @returns {null|{ cuotaSemanal, moneda, bonoAuto, pctComision, cobroSaldo }}
 */
function planFromCronograma(cronograma, cronogramaVehiculoId, numViajes) {
  if (!cronograma?.rules?.length) return null;
  const vehicles = cronograma.vehicles || [];
  const vehicleIndex = vehicles.findIndex((v) => v.id === cronogramaVehiculoId);
  if (vehicleIndex < 0) return null;
  const n = numViajes == null || Number.isNaN(Number(numViajes)) ? 0 : Number(numViajes);
  const rule = getRuleForTripCount(cronograma.rules, n);
  if (!rule) return null;
  const cuotasPorVehiculo = rule.cuotas_por_vehiculo || [];
  const cuotaSemanal =
    cuotasPorVehiculo[vehicleIndex] != null ? round2(parseFloat(cuotasPorVehiculo[vehicleIndex]) || 0) : 0;
  return {
    cuotaSemanal,
    moneda: resolveMonedaCuotaSemanal(cronograma, rule, vehicleIndex),
    bonoAuto: round2(parseFloat(rule.bono_auto) || 0),
    pctComision: round2(Number(parseFloat(rule.pct_comision) || 0)),
    cobroSaldo: round2(parseFloat(rule.cobro_saldo) || 0),
  };
}

/** partner_fees_83 guardado o derivado de partner_fees_raw (misma lógica que al generar la cuota). */
function partnerFees83FromRow(row) {
  let pf83 = round2(parseFloat(row.partner_fees_83) || 0);
  if (pf83 > 0) return pf83;
  const raw = round2(parseFloat(row.partner_fees_raw) || 0);
  return round2(raw * PARTNER_FEES_PCT);
}

/** nº de viajes usable para reglas del cronograma, o null si no aplica. */
function tripCountForRules(numViajes) {
  if (numViajes == null) return null;
  const n = Number(numViajes);
  return Number.isNaN(n) || n < 0 ? null : n;
}

/** % comisión y cobro del saldo desde una fila de regla (cronograma). */
function pctCobroFromRule(rule) {
  return {
    pct_comision: round2(Number(parseFloat(rule.pct_comision) || 0)),
    cobro_saldo: round2(parseFloat(rule.cobro_saldo) || 0),
  };
}

/** Mora por días de retraso (misma fórmula que updateMoraDiaria). baseCuota = cuota neta antes de mora. */
function computeLateFeeDisplay(cronograma, dueDateStr, baseCuota) {
  if (!dueDateStr || baseCuota <= 0) return round2(0);
  const tasa = round2(parseFloat(cronograma?.tasa_interes_mora) || 0);
  if (tasa <= 0) return round2(0);
  const dueDate = new Date(dueDateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  dueDate.setHours(0, 0, 0, 0);
  if (dueDate >= today) return round2(0);
  const daysOverdue = Math.max(0, Math.floor((today - dueDate) / (24 * 60 * 60 * 1000)));
  return round2((baseCuota * tasa) / 7 * daysOverdue);
}

/** amount_due + late_fee alineados al cronograma (solo cuotas abiertas). */
function amountDueAndLateForOpen(cronograma, r, cuota_semanal, bono_auto, pct_comision, cobro_saldo) {
  const amount_due = computeAmountDueSemanal({
    cuotaSemanal: cuota_semanal,
    bonoAuto: bono_auto,
    partnerFeesRaw: r.partner_fees_raw,
    pctComision: pct_comision,
    cobroSaldo: cobro_saldo,
  });
  const late_fee = computeLateFeeDisplay(cronograma, r.due_date, amount_due);
  return { amount_due, late_fee };
}

/** Último lunes (`week_start_date`) con cuota en una solicitud; null si no hay filas. */
export async function getMaxWeekStartYmdForSolicitud(solicitudId) {
  const res = await query(
    `SELECT (MAX(week_start_date))::text AS m FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid`,
    [solicitudId]
  );
  const m = res.rows[0]?.m;
  if (m == null || String(m).trim() === '') return null;
  return String(m).trim().slice(0, 10);
}

/** Solicitudes listas para generar cuota semanal (job lunes). */
export async function getSolicitudesParaCobroSemanal() {
  const res = await query(
    `SELECT s.id AS solicitud_id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
            rd.id AS driver_id, rd.external_driver_id, rd.park_id, rd.first_name, rd.last_name, s.country
     FROM module_miauto_solicitud s
     INNER JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE s.status = 'aprobado'
       AND s.pago_estado = 'completo'
       AND s.cronograma_id IS NOT NULL
       AND s.cronograma_vehiculo_id IS NOT NULL
       AND s.fecha_inicio_cobro_semanal IS NOT NULL
     ORDER BY s.id`
  );
  return res.rows || [];
}

/**
 * Crea o actualiza la cuota semanal para el lunes de la semana Lun–Dom de viajes Yango (`week_start_date`).
 * `due_date` (vence): lunes siguiente salvo primera cuota = `fecha_inicio_cobro_semanal` (depósito).
 * incomeResult: { count_completed, partner_fees }.
 * @param {{ skipUpdateIfExists?: boolean }} [options] skipUpdateIfExists: si ya hay fila para ese lunes, no la modifica (útil para no pisar Excel / depósito).
 */
export async function ensureCuotaSemanalForWeek(
  solicitudId,
  cronogramaId,
  cronogramaVehiculoId,
  weekStartDate,
  incomeResult,
  options = {}
) {
  const skipUpdateIfExists = !!options.skipUpdateIfExists;
  const { count_completed: numViajes = 0, partner_fees: partnerFeesRaw = 0 } = incomeResult;
  const partnerFeesRawRounded = round2(Number(partnerFeesRaw) || 0);
  const partnerFees83 = round2(partnerFeesRawRounded * PARTNER_FEES_PCT);

  const cronograma = await getCronogramaById(cronogramaId);
  const plan = planFromCronograma(cronograma, cronogramaVehiculoId, numViajes);
  if (!plan) {
    if (!cronograma?.rules?.length) {
      logger.warn(`Cronograma ${cronogramaId} sin rules para solicitud ${solicitudId}`);
    } else {
      logger.warn(`Sin regla o vehículo para ${numViajes} viajes, cronograma ${cronogramaId}`);
    }
    return null;
  }

  const { cuotaSemanal, moneda, bonoAuto, pctComision, cobroSaldo } = plan;
  const amountDue = computeAmountDueSemanal({
    cuotaSemanal,
    bonoAuto,
    partnerFeesRaw: partnerFeesRawRounded,
    pctComision,
    cobroSaldo,
  });

  const solInicio = await query(
    `SELECT fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1`,
    [solicitudId]
  );
  const fechaInicioYmd = ymdFromDbDate(solInicio.rows[0]?.fecha_inicio_cobro_semanal);
  const dueDateForRow = computeDueDateForMiAutoCuota(String(weekStartDate).trim().slice(0, 10), fechaInicioYmd);

  const existing = await query(
    'SELECT id FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND week_start_date = $2',
    [solicitudId, weekStartDate]
  );

  if (existing.rows.length > 0) {
    if (skipUpdateIfExists) {
      return existing.rows[0].id;
    }
    const prev = await query(
      `SELECT paid_amount, late_fee, status FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND week_start_date = $2`,
      [solicitudId, weekStartDate]
    );
    const rowPrev = prev.rows[0] || {};
    const latePrev = round2(parseFloat(rowPrev.late_fee) || 0);
    const paidPrev = round2(parseFloat(rowPrev.paid_amount) || 0);
    const st = (rowPrev.status || '').toLowerCase();
    const totalDueNow = round2(amountDue + latePrev);
    let paidToStore = paidPrev;
    let statusOut = rowPrev.status || 'pending';
    if (st !== 'bonificada' && paidPrev > totalDueNow) {
      paidToStore = totalDueNow;
      if (totalDueNow > 0) statusOut = 'paid';
    }
    await query(
      `UPDATE module_miauto_cuota_semanal
       SET num_viajes = $1, partner_fees_raw = $2, partner_fees_83 = $3, bono_auto = $4, cuota_semanal = $5, amount_due = $6, moneda = $7, pct_comision = $8, cobro_saldo = $9, paid_amount = $10, status = $11, due_date = $12, updated_at = CURRENT_TIMESTAMP
       WHERE solicitud_id = $13 AND week_start_date = $14`,
      [
        numViajes,
        partnerFeesRawRounded,
        partnerFees83,
        bonoAuto,
        cuotaSemanal,
        amountDue,
        moneda,
        pctComision,
        cobroSaldo,
        paidToStore,
        statusOut,
        dueDateForRow,
        solicitudId,
        weekStartDate,
      ]
    );
    return existing.rows[0].id;
  }

  let statusInsert = 'pending';
  let paidAmountInsert = 0;
  const solVeh = await query(
    `SELECT s.fecha_inicio_cobro_semanal, s.cuotas_semanales_bonificadas, v.cuotas_semanales
     FROM module_miauto_solicitud s
     JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id
     WHERE s.id = $1`,
    [solicitudId]
  );
  if (solVeh.rows.length > 0) {
    const f = solVeh.rows[0].fecha_inicio_cobro_semanal;
    const total = parseInt(solVeh.rows[0].cuotas_semanales, 10) || 0;
    const bonif = parseInt(solVeh.rows[0].cuotas_semanales_bonificadas, 10) || 0;
    if (f && total > 0 && bonif >= 1) {
      const fYmd = ymdFromDbDate(f);
      const wYmd = String(weekStartDate).trim().slice(0, 10);
      const daysDiff =
        fYmd && /^\d{4}-\d{2}-\d{2}$/.test(wYmd)
          ? diffDaysYmdUtc(mondayOfWeekContainingYmd(fYmd), mondayOfWeekContainingYmd(wYmd))
          : 0;
      const weekIndex = Math.floor(daysDiff / 7);
      // total = semanas del plan según cronograma del vehículo (v.cuotas_semanales). Bonificación a las últimas N (N = bonif). Ej: 261 → cuota 261 bonificada.
      if (weekIndex >= total - bonif && weekIndex < total) {
        statusInsert = 'bonificada';
        paidAmountInsert = amountDue;
      }
    }
  }

  const ins = await query(
    `INSERT INTO module_miauto_cuota_semanal
     (solicitud_id, week_start_date, due_date, num_viajes, partner_fees_raw, partner_fees_83, bono_auto, cuota_semanal, amount_due, paid_amount, status, moneda, pct_comision, cobro_saldo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      solicitudId,
      weekStartDate,
      dueDateForRow,
      numViajes,
      partnerFeesRawRounded,
      partnerFees83,
      bonoAuto,
      cuotaSemanal,
      amountDue,
      paidAmountInsert,
      statusInsert,
      moneda,
      pctComision,
      cobroSaldo,
    ]
  );
  return ins.rows[0]?.id || null;
}

/** Mora y vencidas (due_date antes de hoy → overdue + late_fee). Job diario o al listar una solicitud.
 * @param {string|null} solicitudId
 * @param {{ singleCuotaId?: string }} [options] Si `singleCuotaId` está definido, solo actualiza esa fila (útil para scripts que no deben tocar otras semanas).
 */
export async function updateMoraDiaria(solicitudId = null, options = {}) {
  const singleCuotaId = options.singleCuotaId || null;
  let sql = `SELECT c.id, c.solicitud_id, c.cuota_semanal, c.amount_due, c.due_date, c.paid_amount, c.late_fee, c.status,
            s.cronograma_id
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     WHERE c.status IN ('pending', 'overdue') AND c.due_date < CURRENT_DATE`;
  const params = [];
  if (solicitudId) {
    sql += ` AND c.solicitud_id = $1`;
    params.push(solicitudId);
  }
  if (singleCuotaId) {
    sql += ` AND c.id = $${params.length + 1}::uuid`;
    params.push(singleCuotaId);
  }
  const res = await query(sql, params);

  let updated = 0;
  for (const row of res.rows || []) {
    const cronograma = await getCronogramaById(row.cronograma_id);
    const tasa = round2(parseFloat(cronograma?.tasa_interes_mora) || 0);
    const dueDate = new Date(row.due_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    dueDate.setHours(0, 0, 0, 0);
    const daysOverdue = Math.max(0, Math.floor((today - dueDate) / (24 * 60 * 60 * 1000)));
    let baseCuota;
    if (row.amount_due != null && row.amount_due !== '') {
      baseCuota = round2(parseFloat(row.amount_due));
    } else {
      baseCuota = round2(parseFloat(row.cuota_semanal) || 0);
    }
    const lateFee = round2(tasa > 0 && baseCuota > 0 ? (baseCuota * tasa) / 7 * daysOverdue : 0);

    await query(
      `UPDATE module_miauto_cuota_semanal SET late_fee = $1, status = 'overdue', updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [lateFee, row.id]
    );
    updated++;
  }
  if (updated > 0) logger.info(`Yego Mi Auto: mora actualizada en ${updated} cuota(s)`);
  return updated;
}

/**
 * Calcula la racha actual: cuántas cuotas consecutivas (desde la más antigua por due_date)
 * están pagadas o bonificadas y sin mora. Si tiene al menos una cuota vencida (overdue), racha = 0.
 */
export function calcularRacha(cuotas) {
  if (!Array.isArray(cuotas) || cuotas.length === 0) return 0;
  const tieneVencida = cuotas.some((c) => (c.status || '').toLowerCase() === 'overdue');
  if (tieneVencida) return 0;
  const porFechaAsc = [...cuotas].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  let racha = 0;
  for (const c of porFechaAsc) {
    const ok = (c.status === 'paid' || c.status === 'bonificada') && (Number(c.late_fee) || 0) === 0;
    if (!ok) break;
    racha++;
  }
  return racha;
}

/** Plan + mora para API (listados Yego Mi Auto). */
function computeCuotaDerivedForRow(r, cronograma, vehId) {
  let cuota_semanal = round2(parseFloat(r.cuota_semanal) || 0);
  let amount_due = round2(parseFloat(r.amount_due) || 0);
  let late_fee = round2(parseFloat(r.late_fee) || 0);
  let bono_auto = round2(parseFloat(r.bono_auto) || 0);
  let pct_comision = round2(Number(parseFloat(r.pct_comision) || 0));
  let cobro_saldo = round2(parseFloat(r.cobro_saldo) || 0);
  let moneda = r.moneda === 'USD' ? 'USD' : 'PEN';

  const nTrips = tripCountForRules(r.num_viajes);
  const cerrada = r.status === 'paid' || r.status === 'bonificada';
  const pf83 = partnerFees83FromRow(r);
  const vehicles = cronograma?.vehicles || [];
  const vehicleOk = vehId != null && vehicles.findIndex((v) => v.id === vehId) >= 0;

  const ruleForTrips =
    cronograma?.rules?.length && nTrips != null ? getRuleForTripCount(cronograma.rules, nTrips) : null;

  const plan =
    cronograma?.rules?.length && vehicleOk && nTrips != null
      ? planFromCronograma(cronograma, vehId, nTrips)
      : null;

  let usoCronogramaParaMontos = false;

  if (plan) {
    usoCronogramaParaMontos = true;
    cuota_semanal = plan.cuotaSemanal;
    bono_auto = plan.bonoAuto;
    pct_comision = plan.pctComision;
    cobro_saldo = plan.cobroSaldo;
    moneda = plan.moneda;
  } else if (cronograma?.rules?.length && vehicleOk) {
    moneda = getMonedaCuotaSemanalPorVehiculo(cronograma, vehId);
  }

  // Vehículo desfasado en solicitud: mismo tramo de viajes → % y cobro desde la regla (sin recalcular cuota/bono de fila).
  if (!plan && ruleForTrips) {
    usoCronogramaParaMontos = true;
    const pc = pctCobroFromRule(ruleForTrips);
    pct_comision = pc.pct_comision;
    cobro_saldo = pc.cobro_saldo;
    if (vehId != null && cronograma) moneda = getMonedaCuotaSemanalPorVehiculo(cronograma, vehId);
  }

  if (!cerrada && usoCronogramaParaMontos) {
    const m = amountDueAndLateForOpen(cronograma, r, cuota_semanal, bono_auto, pct_comision, cobro_saldo);
    amount_due = m.amount_due;
    late_fee = m.late_fee;
  }

  const cuota_neta = round2(Math.max(0, (cuota_semanal - bono_auto) - pf83));
  const cuota_final = round2(amount_due + late_fee);
  return {
    cuota_semanal,
    amount_due,
    late_fee,
    bono_auto,
    pct_comision,
    cobro_saldo,
    moneda,
    cuota_neta,
    cuota_final,
    pf83,
  };
}

function buildCuotaSemanalApiRow(r, cronograma, vehId) {
  const d = computeCuotaDerivedForRow(r, cronograma, vehId);
  let paid_amount = round2(parseFloat(r.paid_amount) || 0);
  paid_amount = round2(Math.min(paid_amount, d.cuota_final));
  /** Columna cronograma “cobro del saldo”: valor persistido en la fila (regla al generar la cuota), no el recalculado del cronograma actual. */
  const cobroSaldoDesdeFila = round2(parseFloat(r.cobro_saldo) || 0);
  return {
    id: r.id,
    solicitud_id: r.solicitud_id,
    week_start_date: r.week_start_date,
    due_date: r.due_date,
    num_viajes: r.num_viajes,
    bono_auto: d.bono_auto,
    cuota_semanal: d.cuota_semanal,
    amount_due: d.amount_due,
    paid_amount,
    late_fee: d.late_fee,
    status: r.status,
    moneda: d.moneda,
    pct_comision: d.pct_comision,
    cobro_saldo: cobroSaldoDesdeFila,
    partner_fees_raw: round2(parseFloat(r.partner_fees_raw) || 0),
    partner_fees_83: d.pf83,
    cuota_neta: d.cuota_neta,
    cuota_final: d.cuota_final,
    pending_total: round2(Math.max(0, d.cuota_final - paid_amount)),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Recorta paid_amount si supera cuota_final tras cambio de tramo de viajes (tras updateMoraDiaria). */
export async function persistPaidAmountCapsForSolicitud(solicitudId) {
  const solRes = await query(
    'SELECT cronograma_id, cronograma_vehiculo_id FROM module_miauto_solicitud WHERE id = $1',
    [solicitudId]
  );
  const solRow = solRes.rows[0];
  if (!solRow?.cronograma_id) return 0;

  const cronograma = await getCronogramaById(solRow.cronograma_id);
  const vehId = solRow.cronograma_vehiculo_id;

  const res = await query(
    `SELECT id, solicitud_id, week_start_date, due_date, num_viajes, bono_auto, cuota_semanal, amount_due, paid_amount, late_fee, status, moneda, pct_comision, cobro_saldo,
            partner_fees_raw, partner_fees_83,
            created_at, updated_at
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1 ORDER BY due_date ASC`,
    [solicitudId]
  );

  let updated = 0;
  for (const r of res.rows || []) {
    const st = (r.status || '').toLowerCase();
    if (st === 'bonificada') continue;

    const d = computeCuotaDerivedForRow(r, cronograma, vehId);
    const paidDb = round2(parseFloat(r.paid_amount) || 0);
    const cap = d.cuota_final;
    if (paidDb <= cap) continue;

    const paidNew = cap;
    let statusOut = r.status;
    if (cap <= 0) {
      statusOut = paidNew > 0 ? 'paid' : st === 'overdue' ? 'overdue' : 'pending';
    } else if (paidNew >= cap) {
      statusOut = 'paid';
    } else if (paidNew > 0) {
      statusOut = 'partial';
    } else {
      statusOut = st === 'overdue' ? 'overdue' : 'pending';
    }

    await query(
      `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [paidNew, statusOut, r.id]
    );
    updated++;
  }
  if (updated > 0) {
    logger.info(`Yego Mi Auto: paid_amount ajustado al tope en ${updated} cuota(s), solicitud ${solicitudId}`);
  }
  return updated;
}

/** Cuotas de una solicitud (conductor / admin Rent–Sale), orden por due_date. */
export async function getCuotasSemanalesBySolicitud(solicitudId) {
  const solRes = await query(
    'SELECT cronograma_id, cronograma_vehiculo_id FROM module_miauto_solicitud WHERE id = $1',
    [solicitudId]
  );
  const solRow = solRes.rows[0];
  const cronograma =
    solRow?.cronograma_id != null ? await getCronogramaById(solRow.cronograma_id) : null;

  const res = await query(
    `SELECT id, solicitud_id, week_start_date, due_date, num_viajes, bono_auto, cuota_semanal, amount_due, paid_amount, late_fee, status, moneda, pct_comision, cobro_saldo,
            partner_fees_raw, partner_fees_83,
            created_at, updated_at
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1 ORDER BY due_date ASC`,
    [solicitudId]
  );
  const vehId = solRow?.cronograma_vehiculo_id;

  return (res.rows || []).map((r) => buildCuotaSemanalApiRow(r, cronograma, vehId));
}

/** Cuotas + racha + bonificadas (app conductor). */
export async function getCuotasSemanalesConRacha(solicitudId) {
  await updateMoraDiaria(solicitudId);
  await persistPaidAmountCapsForSolicitud(solicitudId);
  const cuotas = await getCuotasSemanalesBySolicitud(solicitudId);
  const racha = calcularRacha(cuotas);
  const solRes = await query(
    'SELECT COALESCE(cuotas_semanales_bonificadas, 0)::int AS cuotas_semanales_bonificadas FROM module_miauto_solicitud WHERE id = $1',
    [solicitudId]
  );
  const fromDb = (solRes.rows[0] && parseInt(solRes.rows[0].cuotas_semanales_bonificadas, 10)) || 0;
  const fromCuotas = (cuotas || []).filter((c) => c.status === 'bonificada').length;
  const cuotasSemanalesBonificadas = Math.max(fromDb, fromCuotas);
  return { data: cuotas, racha, cuotas_semanales_bonificadas: cuotasSemanalesBonificadas };
}

/** Pending/overdue con saldo > 0 (job cobro). Orden: solicitud, due_date. */
export async function getCuotasToCharge() {
  const res = await query(
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.status,
            s.cronograma_id, rd.id AS driver_id, rd.external_driver_id, rd.park_id, rd.first_name, rd.last_name, s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     INNER JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE c.status IN ('pending', 'overdue')
       AND (c.amount_due + COALESCE(c.late_fee, 0) - COALESCE(c.paid_amount, 0)) > 0
     ORDER BY c.solicitud_id, c.due_date ASC, c.id`
  );
  return res.rows || [];
}

/** Retiro en fleet y actualización de paid_amount. */
export async function processCobroCuota(cuotaRow, cookieOverride = null, parkIdOverride = null) {
  const driverName = [cuotaRow.first_name, cuotaRow.last_name].filter(Boolean).join(' ').trim() || 'Conductor';
  const amountDue = round2(parseFloat(cuotaRow.amount_due) || 0);
  const paid = round2(parseFloat(cuotaRow.paid_amount) || 0);
  const lateFee = round2(parseFloat(cuotaRow.late_fee) || 0);
  const pendingAmount = round2(amountDue + lateFee - paid);

  if (pendingAmount <= 0) {
    return { success: true, partial: false, failed: false, reason: 'Sin saldo pendiente' };
  }

  let externalDriverId = cuotaRow.external_driver_id;
  let parkId = parkIdOverride || cuotaRow.park_id;

  if (!externalDriverId) {
    const byDni = await query(
      'SELECT driver_id, park_id FROM drivers WHERE document_number = (SELECT dni FROM module_rapidin_drivers WHERE id = $1) LIMIT 1',
      [cuotaRow.driver_id]
    );
    if (byDni.rows.length > 0) {
      externalDriverId = byDni.rows[0].driver_id;
      parkId = parkId || byDni.rows[0].park_id;
    }
  }

  if (!externalDriverId) {
    logger.warn(`Yego Mi Auto cobro: ${driverName} sin external_driver_id`);
    return { success: false, partial: false, failed: true, reason: 'Sin external_driver_id' };
  }

  const balanceResult = await getContractorBalance(externalDriverId, parkId, cookieOverride);
  if (!balanceResult.success) {
    logger.warn(`Yego Mi Auto cobro: sin saldo API ${driverName}: ${balanceResult.error}`);
    return { success: false, partial: false, failed: true, reason: balanceResult.error };
  }

  const balance = round2(Number(balanceResult.balance) || 0);
  if (balance <= 0) {
    return { success: false, partial: false, failed: true, reason: 'Sin saldo disponible' };
  }

  const amountToCharge = round2(Math.min(pendingAmount, balance));
  const withdrawResult = await withdrawFromContractor(
    externalDriverId,
    amountToCharge.toFixed(2),
    'Cuota Mi Auto',
    cookieOverride,
    parkId
  );

  if (!withdrawResult.success) {
    logger.error(`Yego Mi Auto cobro: retiro ${driverName}: ${withdrawResult.message || withdrawResult.error}`);
    return { success: false, partial: false, failed: true, reason: withdrawResult.message || withdrawResult.error };
  }

  const totalDue = round2(amountDue + lateFee);
  let newPaid = round2(paid + amountToCharge);
  newPaid = round2(Math.min(newPaid, totalDue));
  const newStatus = newPaid >= totalDue ? 'paid' : 'partial';

  await query(
    `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [newPaid, newStatus, cuotaRow.id]
  );

  if (amountToCharge >= pendingAmount) {
    logger.info(`Yego Mi Auto cobro completo: ${driverName} ${amountToCharge.toFixed(2)}`);
    return { success: true, partial: false, failed: false, amountCharged: amountToCharge };
  }
  logger.info(`Yego Mi Auto cobro parcial: ${driverName} ${amountToCharge.toFixed(2)} / ${pendingAmount.toFixed(2)}`);
  return { success: true, partial: true, failed: false, amountCharged: amountToCharge };
}

/**
 * Recalcula y persiste en BD `pct_comision`, `cobro_saldo`, `cuota_semanal`, `bono_auto`, `moneda`, `partner_fees_83`
 * y `amount_due` según el cronograma actual y los `num_viajes` / `partner_fees_raw` ya guardados en cada fila.
 * Cuotas `paid`: solo actualiza snapshot de la regla (no modifica amount_due ni paid_amount).
 * Luego aplica mora y tope de paid_amount por solicitud.
 *
 * @param {{ solicitudId?: string|null }} opts - Si viene `solicitudId`, solo cuotas de esa solicitud.
 * @returns {Promise<{ updated: number, solicitudes: number }>}
 */
export async function recalcMontosCuotasSemanalesDesdeCronograma(opts = {}) {
  const solicitudId = opts.solicitudId != null && String(opts.solicitudId).trim() ? String(opts.solicitudId).trim() : null;

  let sql = `
    SELECT c.id, c.solicitud_id, c.num_viajes, c.partner_fees_raw, c.paid_amount, c.late_fee, c.status,
           c.amount_due, s.cronograma_id, s.cronograma_vehiculo_id
    FROM module_miauto_cuota_semanal c
    INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id`;
  const params = [];
  if (solicitudId) {
    sql += ` WHERE c.solicitud_id = $1::uuid`;
    params.push(solicitudId);
  }
  sql += ` ORDER BY c.solicitud_id, c.due_date, c.id`;

  const res = await query(sql, params);
  const rows = res.rows || [];
  const cronogramaCache = new Map();
  let updated = 0;
  const solicitudesAfectadas = new Set();

  for (const row of rows) {
    const crId = String(row.cronograma_id);
    let cronograma = cronogramaCache.get(crId);
    if (!cronograma) {
      cronograma = await getCronogramaById(crId);
      cronogramaCache.set(crId, cronograma);
    }
    if (!cronograma) continue;

    const plan = planFromCronograma(cronograma, row.cronograma_vehiculo_id, row.num_viajes);
    if (!plan) continue;

    const pfRaw = round2(Number(row.partner_fees_raw) || 0);
    const pf83 = round2(pfRaw * PARTNER_FEES_PCT);
    const amountDue = computeAmountDueSemanal({
      cuotaSemanal: plan.cuotaSemanal,
      bonoAuto: plan.bonoAuto,
      partnerFeesRaw: pfRaw,
      pctComision: plan.pctComision,
      cobroSaldo: plan.cobroSaldo,
    });

    const st = (row.status || '').toLowerCase();
    solicitudesAfectadas.add(String(row.solicitud_id));

    if (st === 'paid') {
      await query(
        `UPDATE module_miauto_cuota_semanal SET
          cuota_semanal = $1, bono_auto = $2, moneda = $3, pct_comision = $4, cobro_saldo = $5, partner_fees_83 = $6, updated_at = CURRENT_TIMESTAMP
         WHERE id = $7`,
        [plan.cuotaSemanal, plan.bonoAuto, plan.moneda, plan.pctComision, plan.cobroSaldo, pf83, row.id]
      );
      updated++;
      continue;
    }

    if (st === 'bonificada') {
      await query(
        `UPDATE module_miauto_cuota_semanal SET
          cuota_semanal = $1, bono_auto = $2, amount_due = $3, paid_amount = $3, moneda = $4, pct_comision = $5, cobro_saldo = $6, partner_fees_83 = $7, late_fee = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = $8`,
        [plan.cuotaSemanal, plan.bonoAuto, amountDue, plan.moneda, plan.pctComision, plan.cobroSaldo, pf83, row.id]
      );
      updated++;
      continue;
    }

    await query(
      `UPDATE module_miauto_cuota_semanal SET
        cuota_semanal = $1, bono_auto = $2, amount_due = $3, moneda = $4, pct_comision = $5, cobro_saldo = $6, partner_fees_83 = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8`,
      [plan.cuotaSemanal, plan.bonoAuto, amountDue, plan.moneda, plan.pctComision, plan.cobroSaldo, pf83, row.id]
    );
    updated++;
  }

  await updateMoraDiaria();
  for (const sid of solicitudesAfectadas) {
    await persistPaidAmountCapsForSolicitud(sid);
  }

  logger.info(
    `Yego Mi Auto: recalcMontosCuotasSemanalesDesdeCronograma ${updated} fila(s), ${solicitudesAfectadas.size} solicitud(es)`
  );
  return { updated, solicitudes: solicitudesAfectadas.size };
}
