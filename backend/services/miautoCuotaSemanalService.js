/**
 * Yego Mi Auto — cuotas semanales: generación por semana, mora, cobro fleet (Yango), API conductor/admin.
 */
import { query } from '../config/database.js';
import {
  computeDueDateForMiAutoCuota,
  isWeekYangoClosedForMiAutoCuotaMetrics,
  mondayOfWeekContainingYmd,
} from '../utils/miautoLimaWeekRange.js';
import {
  getCronogramaById,
  getMonedaCuotaSemanalPorVehiculo,
  getRuleForTripCount,
  resolveMonedaCuotaSemanal,
} from './miautoCronogramaService.js';
import {
  fleetCookieCobroForMiAuto,
  fleetParkIdForMiAuto,
  getContractorBalance,
  withdrawFromContractor,
} from './yangoService.js';
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

/**
 * Semana del depósito (sem. 1 sin viajes Yango / sin bono): `week_start_date` = lunes de la semana civil que contiene `fecha_inicio_cobro_semanal`.
 * No usar MIN(week_start) ni “sin fila anterior”: falla con filas fuera de orden o datos viejos.
 */
export function isSemanaDepositoMiAuto(weekStartYmd, fechaInicioCobroRaw) {
  const fi = ymdFromDbDate(fechaInicioCobroRaw);
  const ws = String(weekStartYmd || '').trim().slice(0, 10);
  if (!fi || !/^\d{4}-\d{2}-\d{2}$/.test(ws)) return false;
  const mondayInicio = mondayOfWeekContainingYmd(fi);
  return ws === mondayInicio;
}

function diffDaysYmdUtc(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  const ta = Date.UTC(ya, ma - 1, da);
  const tb = Date.UTC(yb, mb - 1, db);
  return Math.round((tb - ta) / (24 * 60 * 60 * 1000));
}

/**
 * Monto base semanal antes de mora: cuota neta + cobro del saldo (regla) + opcional (% comisión × partner_fees_83).
 * Si `partnerFeesApplyToCuotaReduction` es true (por defecto), la cuota neta es (plan − bono − 83,33% PF).
 * Si es false, el 83,33% no se resta de la fila: ese monto va en cascada vía `applyPartnerFeesWaterfallToSolicitud`.
 * Si `commissionGoesToWaterfall` es true (semanas con PF Yango y cascada), la comisión **no** suma a esta fila:
 * se incluye en el pool de cascada junto al PF83 para amortizar primero la cuota más vieja pendiente/overdue/partial.
 */
function computeAmountDueSemanal({
  cuotaSemanal,
  bonoAuto,
  partnerFeesRaw,
  pctComision,
  cobroSaldo,
  partnerFeesApplyToCuotaReduction = true,
  commissionGoesToWaterfall = false,
}) {
  const partnerFees83 = round2(Number(partnerFeesRaw) * PARTNER_FEES_PCT);
  const baseCuota = round2(Math.max(0, cuotaSemanal - bonoAuto));
  const cuotaNeta = partnerFeesApplyToCuotaReduction
    ? round2(Math.max(0, baseCuota - partnerFees83))
    : baseCuota;
  const pct = round2(Number(pctComision) || 0);
  const cobro = round2(Number(cobroSaldo) || 0);
  const comisionSobrePartnerFees = round2(partnerFees83 * (pct / 100));
  if (commissionGoesToWaterfall) {
    return round2(Math.max(0, cuotaNeta + cobro));
  }
  return round2(Math.max(0, cuotaNeta + cobro + comisionSobrePartnerFees));
}

/** Pool que la cascada aplica a deudas más antiguas: 83,33% PF + comisión % sobre ese tributo. */
function partnerFeesPlusComisionPool(partnerFees83, pctComision) {
  const pf = round2(Number(partnerFees83) || 0);
  const pct = round2(Number(pctComision) || 0);
  const com = round2(pf * (pct / 100));
  return round2(pf + com);
}

/**
 * Reparte el pool (83,33% PF + comisión %, o solo el delta de ese total) en `paid_amount` por orden **due_date ASC**
 * (deuda más antigua primero; excedente sigue con la siguiente). Incluye `partial`.
 * @param {{ excludeCuotaSemanalId?: string|null }} [options] — Si viene, esa fila no recibe pool (cobro al más viejo antes de generar/actualizar la semana nueva).
 */
export async function applyPartnerFeesWaterfallToSolicitud(solicitudId, poolDelta, options = {}) {
  const ex = options.excludeCuotaSemanalId;
  const excludeId = ex != null && String(ex).trim() ? String(ex).trim() : null;
  let pool = round2(Number(poolDelta) || 0);
  if (pool <= 0.005) return { applied: 0, remainingPool: 0 };

  let sql = `SELECT id, amount_due, late_fee, paid_amount, status
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1::uuid
       AND status IN ('pending', 'overdue', 'partial')`;
  const params = [solicitudId];
  if (excludeId) {
    sql += ` AND id <> $2::uuid`;
    params.push(excludeId);
  }
  sql += ` ORDER BY due_date ASC NULLS LAST, week_start_date ASC, id ASC`;
  const res = await query(sql, params);
  let applied = 0;
  for (const row of res.rows || []) {
    if (pool <= 0.005) break;
    const amountDue = round2(parseFloat(row.amount_due) || 0);
    const lateFee = round2(parseFloat(row.late_fee) || 0);
    const paid = round2(parseFloat(row.paid_amount) || 0);
    const totalDue = round2(amountDue + lateFee);
    const pending = round2(totalDue - paid);
    if (pending <= 0.005) continue;
    const applyAmt = round2(Math.min(pool, pending));
    const newPaid = round2(paid + applyAmt);
    const newStatus = newPaid >= totalDue - 0.005 ? 'paid' : 'partial';
    await query(
      `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [newPaid, newStatus, row.id]
    );
    applied = round2(applied + applyAmt);
    pool = round2(pool - applyAmt);
  }
  if (applied > 0.005) {
    logger.info(
      `Yego Mi Auto: cascada PF+comisión solicitud ${solicitudId} aplicó ${applied.toFixed(2)} (pool ${round2(Number(poolDelta) || 0).toFixed(2)}${excludeId ? `, excl. fila ${excludeId}` : ''})`
    );
  }
  return { applied, remainingPool: pool };
}

/**
 * Regla por tramo de viajes + montos del vehículo en el cronograma (misma base que ensureCuotaSemanalForWeek).
 * @returns {null|{ cuotaSemanal, moneda, bonoAuto, pctComision, cobroSaldo }}
 */
export function planFromCronograma(cronograma, cronogramaVehiculoId, numViajes) {
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

/**
 * Cronograma abierto: primero se cobra la **mora generada** (`mora_full`), después lo **pendiente de la cuota** del periodo.
 * La base de la cuota del periodo (`amount_due_sched`) es la columna **`amount_due` de la fila** (la que guardó el job al generar
 * la semana); solo si no hay valor persistido se recalcula con `computeAmountDueSemanal` (filas viejas / borde).
 * - `mora_full`: sobre esa base; `late_fee` en BD y `aplicarPagoACuota` usan la misma obligación.
 */
function amountDueAndLateForOpen(
  cronograma,
  r,
  cuota_semanal,
  bono_auto,
  pct_comision,
  cobro_saldo,
  isPrimeraCuotaSemanal
) {
  const pfRaw = round2(parseFloat(r.partner_fees_raw) || 0);
  const useWaterfallGross = !isPrimeraCuotaSemanal && pfRaw > 0.005;
  const computedSched = computeAmountDueSemanal({
    cuotaSemanal: cuota_semanal,
    bonoAuto: bono_auto,
    partnerFeesRaw: r.partner_fees_raw,
    pctComision: pct_comision,
    cobroSaldo: cobro_saldo,
    partnerFeesApplyToCuotaReduction: !useWaterfallGross,
    commissionGoesToWaterfall: useWaterfallGross,
  });
  const storedSched = round2(parseFloat(r.amount_due) || 0);
  const amount_due_sched = storedSched > 0.005 ? storedSched : computedSched;
  const paid = round2(parseFloat(r.paid_amount) || 0);
  const mora_full = computeLateFeeDisplay(cronograma, r.due_date, amount_due_sched);

  let late_fee_remaining;
  let amount_due_remaining;

  if (mora_full > 0.005) {
    late_fee_remaining = round2(Math.max(0, mora_full - paid));
    const aplicadoCuota = round2(Math.max(0, paid - mora_full));
    amount_due_remaining = round2(Math.max(0, amount_due_sched - aplicadoCuota));
  } else {
    late_fee_remaining = round2(0);
    amount_due_remaining = round2(Math.max(0, amount_due_sched - paid));
  }

  return { amount_due_sched, mora_full, late_fee_remaining, amount_due_remaining };
}

/**
 * ¿Mostrar mora pendiente en API? Obligación total = cuota programada del periodo + mora teórica (`mora_full`).
 */
function debeAplicarMoraCuotaSemanal(status, paidAmount, amountDueSched, moraFull) {
  const st = (status || '').toLowerCase();
  if (st === 'paid' || st === 'bonificada') return false;
  const paid = round2(parseFloat(paidAmount) || 0);
  const obligacionTotalIncluyeMora = round2(amountDueSched + moraFull);
  return st === 'pending' || paid < obligacionTotalIncluyeMora - 0.005;
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
 * `due_date` (vence): mismo lunes que `week_start_date`; semana depósito = `fecha_inicio_cobro_semanal`.
 * Primera cuota semanal (lunes de la semana de `fecha_inicio_cobro_semanal` / depósito): no usa ingresos Yango (`num_viajes` y `partner_fees` = 0) y `bono_auto` = 0 (solo cuota del tramo mínimo del cronograma).
 * Semanas Lun–Dom aún sin cerrar en Lima o futuras: tampoco se guardan viajes/fees (no hay cifra Yango final).
 * incomeResult: { count_completed, partner_fees }.
 * Con PF Yango: **primero** se aplica el pool PF+comisión a cuotas más viejas (`paid_amount`); **después** se INSERT/UPDATE la fila de esta semana; el remanente del pool va a la fila nueva u otras.
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
  let numViajes = Number(incomeResult?.count_completed) || 0;
  let partnerFeesRawRounded = round2(Number(incomeResult?.partner_fees) || 0);

  const solInicio = await query(
    `SELECT fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1`,
    [solicitudId]
  );
  const fechaInicioYmd = ymdFromDbDate(solInicio.rows[0]?.fecha_inicio_cobro_semanal);
  const weekYmd = String(weekStartDate).trim().slice(0, 10);
  const isFirstCuotaSemanal = isSemanaDepositoMiAuto(weekYmd, solInicio.rows[0]?.fecha_inicio_cobro_semanal);
  if (isFirstCuotaSemanal) {
    numViajes = 0;
    partnerFeesRawRounded = 0;
  } else if (!isWeekYangoClosedForMiAutoCuotaMetrics(weekYmd, solInicio.rows[0]?.fecha_inicio_cobro_semanal)) {
    numViajes = 0;
    partnerFeesRawRounded = 0;
  }
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

  const { cuotaSemanal, moneda, pctComision, cobroSaldo } = plan;
  const bonoAuto = isFirstCuotaSemanal ? 0 : plan.bonoAuto;
  /** Con PF de semana cerrada: `amount_due` = plan−bono+cobro (sin comisión en fila); PF83 + comisión % van en cascada a cuotas más viejas. */
  const useWaterfallAmountDue = !isFirstCuotaSemanal && partnerFeesRawRounded > 0;
  const amountDue = computeAmountDueSemanal({
    cuotaSemanal,
    bonoAuto,
    partnerFeesRaw: partnerFeesRawRounded,
    pctComision,
    cobroSaldo,
    partnerFeesApplyToCuotaReduction: !useWaterfallAmountDue,
    commissionGoesToWaterfall: useWaterfallAmountDue,
  });
  const poolCascadaNuevo = useWaterfallAmountDue
    ? partnerFeesPlusComisionPool(partnerFees83, pctComision)
    : round2(0);

  const dueDateForRow = computeDueDateForMiAutoCuota(
    String(weekStartDate).trim().slice(0, 10),
    fechaInicioYmd,
    isFirstCuotaSemanal
  );

  const existing = await query(
    'SELECT id FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND week_start_date = $2',
    [solicitudId, weekStartDate]
  );

  if (existing.rows.length > 0) {
    if (skipUpdateIfExists) {
      return existing.rows[0].id;
    }
    const prev = await query(
      `SELECT paid_amount, late_fee, status, partner_fees_83, pct_comision, amount_due
       FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND week_start_date = $2`,
      [solicitudId, weekStartDate]
    );
    const rowPrev = prev.rows[0] || {};
    const cuotaRowId = existing.rows[0].id;
    const amountDuePrev = round2(parseFloat(rowPrev.amount_due) || 0);
    const oldPf83 = round2(parseFloat(rowPrev.partner_fees_83) || 0);
    const oldPct = round2(Number(parseFloat(rowPrev.pct_comision) || 0));
    const poolAnterior = useWaterfallAmountDue ? partnerFeesPlusComisionPool(oldPf83, oldPct) : round2(0);
    const deltaPoolCascada = round2(poolCascadaNuevo - poolAnterior);
    const reduccionFila = round2(Math.max(0, amountDuePrev - amountDue));

    await updateMoraDiaria(solicitudId, { includePartial: true });
    const freshRow = await query(
      `SELECT late_fee, paid_amount, status FROM module_miauto_cuota_semanal WHERE id = $1::uuid`,
      [cuotaRowId]
    );
    const fr = freshRow.rows[0] || {};
    const lateFresh = round2(parseFloat(fr.late_fee) || 0);
    const paidFresh = round2(parseFloat(fr.paid_amount) || 0);
    const st = (fr.status || rowPrev.status || '').toLowerCase();
    const totalDueNow = round2(amountDue + lateFresh);
    let paidToStore = paidFresh;
    let statusOut = fr.status || rowPrev.status || 'pending';
    if (st !== 'bonificada' && paidFresh > totalDueNow) {
      paidToStore = totalDueNow;
      if (totalDueNow > 0) statusOut = 'paid';
    }

    /**
     * Cobrar PF+comisión en filas más viejas (excl. esta semana) antes del UPDATE.
     * - delta > 0: solo el incremento de pool (+ reducción de fila si aplica).
     * - delta ≈ 0 y hubo reducción de amount_due: solo esa reducción.
     * - delta ≈ 0 sin reducción: reintenta con el pool completo de la semana (desbloquea “pagado” en vencidas/parciales).
     *   Sin columna de “ya distribuido”, repetir ensure con los mismos tributos y deuda pendiente puede imputar de más; evitar re-ejecuciones redundantes.
     */
    let remPoolCascada = round2(0);
    let toApplyPrimera = round2(0);
    if (!isFirstCuotaSemanal && useWaterfallAmountDue && poolCascadaNuevo > 0.005) {
      if (deltaPoolCascada > 0.005) {
        toApplyPrimera = round2(deltaPoolCascada + reduccionFila);
      } else if (reduccionFila > 0.005) {
        toApplyPrimera = reduccionFila;
      } else {
        toApplyPrimera = poolCascadaNuevo;
        logger.info(
          `Mi Auto: cascada con pool sin delta (${poolCascadaNuevo.toFixed(2)}); si esta semana se vuelve a regenerar igual, revisar paid_amount por posible doble reparto.`
        );
      }
      if (toApplyPrimera > 0.005) {
        const w = await applyPartnerFeesWaterfallToSolicitud(solicitudId, toApplyPrimera, {
          excludeCuotaSemanalId: cuotaRowId,
        });
        remPoolCascada = round2(w.remainingPool);
      }
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
    if (remPoolCascada > 0.005) {
      await applyPartnerFeesWaterfallToSolicitud(solicitudId, remPoolCascada);
    }
    await persistPaidAmountCapsForSolicitud(solicitudId);
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

  /** Antes de crear la fila nueva: cobrar PF+comisión en cuotas más viejas (la semana nueva aún no existe en BD). */
  let remPoolTrasSemanasViejas = round2(0);
  if (!isFirstCuotaSemanal && poolCascadaNuevo > 0.005) {
    await updateMoraDiaria(solicitudId, { includePartial: true });
    const w = await applyPartnerFeesWaterfallToSolicitud(solicitudId, poolCascadaNuevo);
    remPoolTrasSemanasViejas = round2(w.remainingPool);
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

  if (!isFirstCuotaSemanal && remPoolTrasSemanasViejas > 0.005) {
    await applyPartnerFeesWaterfallToSolicitud(solicitudId, remPoolTrasSemanasViejas);
  }
  if (!isFirstCuotaSemanal && poolCascadaNuevo > 0.005) {
    await persistPaidAmountCapsForSolicitud(solicitudId);
  }
  return ins.rows[0]?.id || null;
}

/** Mora y vencidas (due_date antes de hoy → overdue + late_fee). Job diario o al listar una solicitud.
 * @param {string|null} solicitudId
 * @param {{ singleCuotaId?: string, includePartial?: boolean }} [options]
 * - `singleCuotaId`: solo actualiza esa fila (scripts).
 * - `includePartial`: incluye cuotas en estado `partial` (solo actualiza `late_fee`, conserva el estado).
 */
export async function updateMoraDiaria(solicitudId = null, options = {}) {
  const singleCuotaId = options.singleCuotaId || null;
  const includePartial = options.includePartial === true;
  const statusSql = includePartial
    ? `c.status IN ('pending', 'overdue', 'partial')`
    : `c.status IN ('pending', 'overdue')`;
  let sql = `SELECT c.id, c.solicitud_id, c.week_start_date, c.cuota_semanal, c.amount_due, c.due_date, c.num_viajes, c.bono_auto,
            c.paid_amount, c.late_fee, c.status, c.moneda, c.pct_comision, c.cobro_saldo,
            c.partner_fees_raw, c.partner_fees_83,
            s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     WHERE ${statusSql} AND c.due_date < CURRENT_DATE`;
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
  const rows = res.rows || [];

  const cronogramaById = new Map();
  const cronogramaFor = async (cronoId) => {
    if (cronoId == null) return null;
    const key = String(cronoId);
    if (cronogramaById.has(key)) return cronogramaById.get(key);
    const c = await getCronogramaById(cronoId);
    cronogramaById.set(key, c);
    return c;
  };

  let updated = 0;
  for (const row of rows) {
    const cronograma = await cronogramaFor(row.cronograma_id);
    const vehId = row.cronograma_vehiculo_id;
    const wsYmd = ymdFromDbDate(row.week_start_date);
    const isPrimera = wsYmd ? isSemanaDepositoMiAuto(wsYmd, row.fecha_inicio_cobro_semanal) : false;
    const d = computeCuotaDerivedForRow(row, cronograma, vehId, {
      isPrimeraCuotaSemanal: !!isPrimera,
      fechaInicioCobroSemanal: row.fecha_inicio_cobro_semanal,
    });
    const lateFeeOut = round2(d.mora_full);

    const st = (row.status || '').toLowerCase();
    if (st === 'partial') {
      await query(
        `UPDATE module_miauto_cuota_semanal SET late_fee = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [lateFeeOut, row.id]
      );
    } else {
      await query(
        `UPDATE module_miauto_cuota_semanal SET late_fee = $1, status = 'overdue', updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [lateFeeOut, row.id]
      );
    }
    updated++;
  }
  if (updated > 0) logger.info(`Yego Mi Auto: mora actualizada en ${updated} cuota(s)`);
  return updated;
}

/**
 * Recalcula mora en BD para todas las cuotas vencidas (incl. parciales), para alinear conductores tras validar tarde, etc.
 */
export async function recalcularMoraGlobal() {
  const updated = await updateMoraDiaria(null, { includePartial: true });
  return { updated };
}

/**
 * Calcula la racha actual: cuántas cuotas consecutivas (desde la más antigua por due_date)
 * están pagadas o bonificadas y sin cuota pendiente (`pending_total` = 0). Si hay alguna vencida (overdue), racha = 0.
 */
export function calcularRacha(cuotas) {
  if (!Array.isArray(cuotas) || cuotas.length === 0) return 0;
  const tieneVencida = cuotas.some((c) => (c.status || '').toLowerCase() === 'overdue');
  if (tieneVencida) return 0;
  const porFechaAsc = [...cuotas].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  let racha = 0;
  for (const c of porFechaAsc) {
    const pend = Number(c.pending_total) || 0;
    const ok = (c.status === 'paid' || c.status === 'bonificada') && pend === 0;
    if (!ok) break;
    racha++;
  }
  return racha;
}

/** Plan + mora para API (listados Yego Mi Auto). Depósito o semana Yango no cerrada (Lima) → sin viajes/fees en cálculo. */
function computeCuotaDerivedForRow(r, cronograma, vehId, options = {}) {
  const isPrimera = options.isPrimeraCuotaSemanal === true;
  const fi = options.fechaInicioCobroSemanal ?? r.fecha_inicio_cobro_semanal;
  const wsRow = ymdFromDbDate(r.week_start_date);
  const yangoSemanaCerrada = wsRow ? isWeekYangoClosedForMiAutoCuotaMetrics(wsRow, fi) : false;
  const sinViajesYango = isPrimera || !yangoSemanaCerrada;
  const rForFees = sinViajesYango ? { ...r, partner_fees_raw: 0, partner_fees_83: 0 } : r;

  let cuota_semanal = round2(parseFloat(r.cuota_semanal) || 0);
  let amount_due_remaining = round2(parseFloat(r.amount_due) || 0);
  let late_fee = round2(parseFloat(r.late_fee) || 0);
  let amount_due_sched = amount_due_remaining;
  let bono_auto = round2(parseFloat(r.bono_auto) || 0);
  let pct_comision = round2(Number(parseFloat(r.pct_comision) || 0));
  let cobro_saldo = round2(parseFloat(r.cobro_saldo) || 0);
  let moneda = r.moneda === 'USD' ? 'USD' : 'PEN';

  const nTrips = sinViajesYango ? 0 : tripCountForRules(r.num_viajes);
  const cerrada = r.status === 'paid' || r.status === 'bonificada';
  const pf83 = sinViajesYango ? 0 : partnerFees83FromRow(rForFees);
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
    bono_auto = isPrimera ? 0 : plan.bonoAuto;
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

  if (isPrimera) {
    bono_auto = 0;
  }

  /** Mora teórica (para persistir en `late_fee` en BD). */
  let mora_full = round2(parseFloat(r.late_fee) || 0);
  let mOpen = null;

  if (cerrada && usoCronogramaParaMontos) {
    mOpen = amountDueAndLateForOpen(
      cronograma,
      rForFees,
      cuota_semanal,
      bono_auto,
      pct_comision,
      cobro_saldo,
      isPrimera
    );
    mora_full = round2(mOpen.mora_full);
    amount_due_sched = round2(mOpen.amount_due_sched);
    amount_due_remaining = 0;
    late_fee = 0;
  } else if (!cerrada && usoCronogramaParaMontos) {
    mOpen = amountDueAndLateForOpen(
      cronograma,
      rForFees,
      cuota_semanal,
      bono_auto,
      pct_comision,
      cobro_saldo,
      isPrimera
    );
    mora_full = round2(mOpen.mora_full);
    amount_due_sched = round2(mOpen.amount_due_sched);
    amount_due_remaining = mOpen.amount_due_remaining;
    late_fee = debeAplicarMoraCuotaSemanal(r.status, r.paid_amount, mOpen.amount_due_sched, mOpen.mora_full)
      ? mOpen.late_fee_remaining
      : 0;
  }

  const cuota_neta = round2(Math.max(0, (cuota_semanal - bono_auto) - pf83));
  /** Tope de la deuda del periodo (cuota programada + mora generada), sin descontar pagos — para cap de paid_amount / persist. */
  const obligacion_total = mOpen
    ? round2(mOpen.amount_due_sched + mOpen.mora_full)
    : round2(amount_due_remaining + late_fee);
  /** Saldo aún por cubrir: cuota pendiente + mora pendiente. */
  const cuota_final = round2(amount_due_remaining + late_fee);
  return {
    cuota_semanal,
    /** Cuota del periodo: preferentemente columna `amount_due` de la fila (persistida al generar la semana). */
    amount_due_sched,
    /** Saldo pendiente de cuota (sin mora). */
    amount_due_remaining,
    late_fee,
    bono_auto,
    pct_comision,
    cobro_saldo,
    moneda,
    cuota_neta,
    cuota_final,
    obligacion_total,
    pf83,
    mora_full,
  };
}

function buildCuotaSemanalApiRow(r, cronograma, vehId, options = {}) {
  const isPrimera = options.isPrimeraCuotaSemanal === true;
  const fi = options.fechaInicioCobroSemanal ?? r.fecha_inicio_cobro_semanal;
  const wsR = ymdFromDbDate(r.week_start_date);
  const yangoCerrada = wsR ? isWeekYangoClosedForMiAutoCuotaMetrics(wsR, fi) : false;
  const sinViajesYango = isPrimera || !yangoCerrada;
  const d = computeCuotaDerivedForRow(r, cronograma, vehId, {
    isPrimeraCuotaSemanal: isPrimera,
    fechaInicioCobroSemanal: fi,
  });
  let paid_amount = round2(parseFloat(r.paid_amount) || 0);
  paid_amount = round2(Math.min(paid_amount, d.obligacion_total));
  /** Columna cronograma “cobro del saldo”: valor persistido en la fila (regla al generar la cuota), no el recalculado del cronograma actual. */
  const cobroSaldoDesdeFila = round2(parseFloat(r.cobro_saldo) || 0);
  const st = (r.status || '').toLowerCase();
  const filaCerrada = st === 'paid' || st === 'bonificada';
  const obligacionTotal = round2(d.obligacion_total);
  /** Pagada: total semana (`cuota_final`) y columna Pagado = misma obligación del periodo. */
  if (st === 'paid') {
    paid_amount = obligacionTotal;
  }
  /**
   * `amount_due`: mismo criterio que la columna `amount_due` en BD (generada al crear/actualizar la fila semanal).
   * `pending_total`: saldo pendiente de esa cuota (sin mora).
   */
  const amountDueApi = round2(d.amount_due_sched);
  /** Mora del periodo (intacta), mismo criterio que `amount_due`: no es mora pendiente; el saldo va en `cuota_final`. */
  const lateFeeApi = round2(d.mora_full);
  const cuotaFinalApi = filaCerrada ? obligacionTotal : d.cuota_final;
  const pendingTotalApi = filaCerrada ? round2(0) : round2(Math.max(0, d.amount_due_remaining));
  return {
    id: r.id,
    solicitud_id: r.solicitud_id,
    week_start_date: r.week_start_date,
    due_date: r.due_date,
    num_viajes: sinViajesYango ? 0 : r.num_viajes,
    bono_auto: d.bono_auto,
    cuota_semanal: d.cuota_semanal,
    amount_due: amountDueApi,
    paid_amount,
    late_fee: lateFeeApi,
    status: r.status,
    moneda: d.moneda,
    pct_comision: d.pct_comision,
    cobro_saldo: cobroSaldoDesdeFila,
    partner_fees_raw: sinViajesYango ? 0 : round2(parseFloat(r.partner_fees_raw) || 0),
    partner_fees_83: d.pf83,
    cuota_neta: d.cuota_neta,
    cuota_final: cuotaFinalApi,
    /** Saldo pendiente de cuota (sin mora). */
    pending_total: pendingTotalApi,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Recorta paid_amount si supera la obligación del periodo (`obligacion_total`) tras cambio de tramo de viajes (tras updateMoraDiaria). */
export async function persistPaidAmountCapsForSolicitud(solicitudId) {
  const solRes = await query(
    'SELECT cronograma_id, cronograma_vehiculo_id, fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1',
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

  const rowsAll = res.rows || [];
  const fiRaw = solRow.fecha_inicio_cobro_semanal;

  let updated = 0;
  for (const r of rowsAll) {
    const st = (r.status || '').toLowerCase();
    if (st === 'bonificada') continue;

    const w = ymdFromDbDate(r.week_start_date);
    const isPrimera = w ? isSemanaDepositoMiAuto(w, fiRaw) : false;
    const d = computeCuotaDerivedForRow(r, cronograma, vehId, {
      isPrimeraCuotaSemanal: isPrimera,
      fechaInicioCobroSemanal: fiRaw,
    });
    const paidDb = round2(parseFloat(r.paid_amount) || 0);
    const cap = d.obligacion_total;
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

/**
 * Cuotas API + bonificadas desde solicitud (un solo SELECT a `module_miauto_solicitud`).
 * @returns {{ cuotas: object[], bonificadas_db: number }}
 */
async function fetchCuotasSemanalesPayload(solicitudId) {
  const solRes = await query(
    `SELECT cronograma_id, cronograma_vehiculo_id, fecha_inicio_cobro_semanal,
            COALESCE(cuotas_semanales_bonificadas, 0)::int AS cuotas_semanales_bonificadas
     FROM module_miauto_solicitud WHERE id = $1`,
    [solicitudId]
  );
  const solRow = solRes.rows[0];
  if (!solRow) {
    return { cuotas: [], bonificadas_db: 0 };
  }
  const cronograma =
    solRow.cronograma_id != null ? await getCronogramaById(solRow.cronograma_id) : null;

  const res = await query(
    `SELECT id, solicitud_id, week_start_date, due_date, num_viajes, bono_auto, cuota_semanal, amount_due, paid_amount, late_fee, status, moneda, pct_comision, cobro_saldo,
            partner_fees_raw, partner_fees_83,
            created_at, updated_at
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1 ORDER BY due_date ASC`,
    [solicitudId]
  );
  const vehId = solRow.cronograma_vehiculo_id;
  const fiRaw = solRow.fecha_inicio_cobro_semanal;
  const bonificadas_db = parseInt(solRow.cuotas_semanales_bonificadas, 10) || 0;

  const rows = res.rows || [];
  const cuotas = rows.map((r) => {
    const w = ymdFromDbDate(r.week_start_date);
    const isPrimera = w ? isSemanaDepositoMiAuto(w, fiRaw) : false;
    return buildCuotaSemanalApiRow(r, cronograma, vehId, {
      isPrimeraCuotaSemanal: isPrimera,
      fechaInicioCobroSemanal: fiRaw,
    });
  });
  return { cuotas, bonificadas_db };
}

/** Cuotas de una solicitud (conductor / admin Rent–Sale), orden por due_date. */
export async function getCuotasSemanalesBySolicitud(solicitudId) {
  const { cuotas } = await fetchCuotasSemanalesPayload(solicitudId);
  return cuotas;
}

/** Cuotas + racha + bonificadas (app conductor). */
export async function getCuotasSemanalesConRacha(solicitudId) {
  await updateMoraDiaria(solicitudId, { includePartial: true });
  await persistPaidAmountCapsForSolicitud(solicitudId);
  const { cuotas, bonificadas_db: fromDb } = await fetchCuotasSemanalesPayload(solicitudId);
  const racha = calcularRacha(cuotas);
  const fromCuotas = (cuotas || []).filter((c) => c.status === 'bonificada').length;
  const cuotasSemanalesBonificadas = Math.max(fromDb, fromCuotas);
  return { data: cuotas, racha, cuotas_semanales_bonificadas: cuotasSemanalesBonificadas };
}

/**
 * Cuotas con saldo por cobrar en Fleet (job lunes).
 * Incluye `partial`: tras la cascada de partner_fees la fila puede quedar parcialmente pagada y debe seguir
 * retirándose saldo Yango en orden cronológico (due_date ASC por solicitud).
 */
export async function getCuotasToCharge() {
  const res = await query(
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.status,
            s.cronograma_id, rd.id AS driver_id, rd.external_driver_id, rd.park_id, rd.first_name, rd.last_name, s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     INNER JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE c.status IN ('pending', 'overdue', 'partial')
       AND (c.amount_due + COALESCE(c.late_fee, 0) - COALESCE(c.paid_amount, 0)) > 0
     ORDER BY c.solicitud_id, c.due_date ASC, c.week_start_date ASC, c.id`
  );
  return res.rows || [];
}

/** Misma fila y orden que `getCuotasToCharge`, filtrado a una solicitud (scripts / dry-run del job lunes). */
export async function getCuotasToChargeForSolicitud(solicitudId) {
  const res = await query(
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.status,
            s.cronograma_id, rd.id AS driver_id, rd.external_driver_id, rd.park_id, rd.first_name, rd.last_name, s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     INNER JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE c.solicitud_id = $1::uuid
       AND c.status IN ('pending', 'overdue', 'partial')
       AND (c.amount_due + COALESCE(c.late_fee, 0) - COALESCE(c.paid_amount, 0)) > 0
     ORDER BY c.due_date ASC, c.week_start_date ASC, c.id`,
    [solicitudId]
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

  parkId = fleetParkIdForMiAuto(parkId);
  const cookieMiAuto = fleetCookieCobroForMiAuto(cookieOverride);

  const balanceResult = await getContractorBalance(externalDriverId, parkId, cookieMiAuto);
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
    cookieMiAuto,
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
 * La primera cuota semanal (lunes de la semana de `fecha_inicio_cobro_semanal`) fuerza `num_viajes` 0, `partner_fees_raw` 0 y `bono_auto` 0.
 * Cuotas `paid`: solo actualiza snapshot de la regla (no modifica amount_due ni paid_amount).
 * Luego aplica mora y tope de paid_amount por solicitud.
 *
 * @param {{ solicitudId?: string|null }} opts - Si viene `solicitudId`, solo cuotas de esa solicitud.
 * @returns {Promise<{ updated: number, solicitudes: number }>}
 */
export async function recalcMontosCuotasSemanalesDesdeCronograma(opts = {}) {
  const solicitudId = opts.solicitudId != null && String(opts.solicitudId).trim() ? String(opts.solicitudId).trim() : null;

  let sql = `
    SELECT c.id, c.solicitud_id, c.week_start_date, c.num_viajes, c.partner_fees_raw, c.paid_amount, c.late_fee, c.status,
           c.amount_due, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal
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

    const wsYmd = ymdFromDbDate(row.week_start_date);
    const fiYmd = ymdFromDbDate(row.fecha_inicio_cobro_semanal);
    const isFirstCuota = wsYmd ? isSemanaDepositoMiAuto(wsYmd, row.fecha_inicio_cobro_semanal) : false;
    const dueRecalc = computeDueDateForMiAutoCuota(wsYmd, fiYmd, !!isFirstCuota);

    const yangoCerrada = wsYmd ? isWeekYangoClosedForMiAutoCuotaMetrics(wsYmd, row.fecha_inicio_cobro_semanal) : false;
    const numViajesPlan = isFirstCuota || !yangoCerrada ? 0 : Number(row.num_viajes) || 0;
    const plan = planFromCronograma(cronograma, row.cronograma_vehiculo_id, numViajesPlan);
    if (!plan) continue;

    const bonoStored = isFirstCuota ? 0 : plan.bonoAuto;
    const pfRaw = isFirstCuota || !yangoCerrada ? 0 : round2(Number(row.partner_fees_raw) || 0);
    const pf83 = round2(pfRaw * PARTNER_FEES_PCT);
    const useWaterfallGross = !isFirstCuota && yangoCerrada && pfRaw > 0;
    const amountDue = computeAmountDueSemanal({
      cuotaSemanal: plan.cuotaSemanal,
      bonoAuto: bonoStored,
      partnerFeesRaw: pfRaw,
      pctComision: plan.pctComision,
      cobroSaldo: plan.cobroSaldo,
      partnerFeesApplyToCuotaReduction: !useWaterfallGross,
      commissionGoesToWaterfall: useWaterfallGross,
    });

    const st = (row.status || '').toLowerCase();
    solicitudesAfectadas.add(String(row.solicitud_id));

    const numViajesOut =
      isFirstCuota || !yangoCerrada ? 0 : Math.round(Number(row.num_viajes) || 0);

    if (st === 'paid') {
      await query(
        `UPDATE module_miauto_cuota_semanal SET
          cuota_semanal = $1, bono_auto = $2, moneda = $3, pct_comision = $4, cobro_saldo = $5, partner_fees_83 = $6, due_date = $7,
          num_viajes = $8, partner_fees_raw = $9, updated_at = CURRENT_TIMESTAMP
         WHERE id = $10`,
        [plan.cuotaSemanal, bonoStored, plan.moneda, plan.pctComision, plan.cobroSaldo, pf83, dueRecalc, numViajesOut, pfRaw, row.id]
      );
      updated++;
      continue;
    }

    if (st === 'bonificada') {
      await query(
        `UPDATE module_miauto_cuota_semanal SET
          cuota_semanal = $1, bono_auto = $2, amount_due = $3, paid_amount = $3, moneda = $4, pct_comision = $5, cobro_saldo = $6, partner_fees_83 = $7, due_date = $8,
          num_viajes = $9, partner_fees_raw = $10, late_fee = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = $11`,
        [plan.cuotaSemanal, bonoStored, amountDue, plan.moneda, plan.pctComision, plan.cobroSaldo, pf83, dueRecalc, numViajesOut, pfRaw, row.id]
      );
      updated++;
      continue;
    }

    await query(
      `UPDATE module_miauto_cuota_semanal SET
        cuota_semanal = $1, bono_auto = $2, amount_due = $3, moneda = $4, pct_comision = $5, cobro_saldo = $6, partner_fees_83 = $7, due_date = $8,
        num_viajes = $9, partner_fees_raw = $10, updated_at = CURRENT_TIMESTAMP
       WHERE id = $11`,
      [plan.cuotaSemanal, bonoStored, amountDue, plan.moneda, plan.pctComision, plan.cobroSaldo, pf83, dueRecalc, numViajesOut, pfRaw, row.id]
    );
    updated++;
  }

  await updateMoraDiaria(null, { includePartial: true });
  for (const sid of solicitudesAfectadas) {
    await persistPaidAmountCapsForSolicitud(sid);
  }

  logger.info(
    `Yego Mi Auto: recalcMontosCuotasSemanalesDesdeCronograma ${updated} fila(s), ${solicitudesAfectadas.size} solicitud(es)`
  );
  return { updated, solicitudes: solicitudesAfectadas.size };
}
