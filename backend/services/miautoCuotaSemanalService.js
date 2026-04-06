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
import {
  convertirMontoEntreMonedas,
  partnerFeesRawDbNormalizeUsdFromYangoLocal,
  partnerFeesYangoAMonedaCuota,
  round2,
  tipoCambioUsdALocalEfectivo,
} from './miautoMoneyUtils.js';
import { MIAUTO_PARK_ID } from './miautoDriverLookup.js';

const PARTNER_FEES_PCT = 0.8333;

/** Corte legado Excel / mora: vencimiento estrictamente antes de esta fecha (sin restar bono en `cuota_neta` ya no aplica; se mantiene para filas Excel en BD). */
export const MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER = '2026-03-30';

/** Fragmento SQL: fecha civil de hoy en Lima (misma región que cronos Mi Auto). */
const SQL_LIMA_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date`;

/** Yango/Fleet a veces rechaza retiros si hay movimientos en curso; reintentar tras esperar. */
function isFleetOngoingTransactionsError(msg) {
  const s = String(msg || '').toLowerCase();
  if (!s) return false;
  if (/ongoing/.test(s) && /transaction/.test(s)) return true;
  if (/transacci(o|ó)n(es)?\s+en\s+curso/.test(s)) return true;
  return false;
}

function fleetWithdrawRetryDelayMs() {
  return Math.max(2000, Math.min(120_000, Number(process.env.MIAUTO_FLEET_ONGOING_RETRY_MS || 6000)));
}

function fleetWithdrawMaxAttempts() {
  return Math.max(1, Math.min(8, Number(process.env.MIAUTO_FLEET_WITHDRAW_RETRIES || 5)));
}

function ymdFromDbDate(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    return m ? m[1] : null;
  }
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
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

/** Fecha civil de hoy en Lima (misma región que `SQL_LIMA_TODAY` y `updateMoraDiaria`). */
function limaTodayYmdSync() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Con saldo pendiente tras el vencimiento (Lima) → `overdue`; `partial` solo si aún no vence y hubo abono. */
function miAutoOpenStatusSaldoVencimiento(dueYmd, pend, paidDb) {
  if (pend <= 0.02) return 'paid';
  const todayY = limaTodayYmdSync();
  if (dueYmd && /^\d{4}-\d{2}-\d{2}$/.test(dueYmd) && dueYmd < todayY) return 'overdue';
  return paidDb > 0.02 ? 'partial' : 'pending';
}

/**
 * Hermana misma solicitud con vencimiento **estrictamente anterior** a `miDueYmd`, **saldo pendiente** según
 * motor (`options.pendienteEconomico`) o, si no viene, fallback columnas cuota+mora − pagado.
 * **Vencida** (`overdue` o `due_date` antes de hoy Lima): el pool comisión/PF debe atender primero esa fila.
 */
function cuotaHermanaBloqueaPorDeudaMasAntigua(o, miDueYmd, todayYmd, options = {}) {
  if (!o || miDueYmd == null) return false;
  const dueO = ymdFromDbDate(o.due_date);
  if (!dueO || !/^\d{4}-\d{2}-\d{2}$/.test(dueO) || !/^\d{4}-\d{2}-\d{2}$/.test(String(miDueYmd).slice(0, 10))) {
    return false;
  }
  const miDue = String(miDueYmd).trim().slice(0, 10);
  if (dueO >= miDue) return false;
  const st = String(o.status || '').toLowerCase();
  if (st === 'bonificada') return false;
  const paid = round2(parseFloat(o.paid_amount) || 0);
  const pendCol =
    options.pendienteEconomico != null && Number.isFinite(Number(options.pendienteEconomico))
      ? round2(Math.max(0, Number(options.pendienteEconomico)))
      : round2(
          Math.max(0, round2(parseFloat(o.amount_due) || 0) + round2(parseFloat(o.late_fee) || 0) - paid)
        );
  if (pendCol <= 0.02) return false;
  const vencidaPorEstado = st === 'overdue';
  const todayOk = todayYmd && /^\d{4}-\d{2}-\d{2}$/.test(String(todayYmd).slice(0, 10));
  const vencidaPorFecha = todayOk && dueO < String(todayYmd).trim().slice(0, 10);
  return vencidaPorEstado || vencidaPorFecha;
}

/**
 * Post-corte (due ≥ `MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER`): si la cuota programada del periodo
 * (`amount_due_sched`, p. ej. tras PF + cobro saldo) es ~0 y la obligación derivada no deja saldo,
 * no forzar pendiente con `amount_due` persistido aún alto (cascada/pool ya cubrió esta semana).
 * Si `hasOlderBlockingDebt`: hay cuota más antigua vencida con saldo → no dar por pagada esta fila con pend ~0.
 * @param {{ hasOlderBlockingDebt?: boolean }} [options]
 */
function pendienteStatusCuotaAbiertaPostCorte(d, pendDerived, pendCols, options = {}) {
  const hasOlder = !!options.hasOlderBlockingDebt;
  const schedNet = round2(d.amount_due_sched);
  let pend = round2(Math.max(pendDerived, pendCols));
  if (schedNet <= 0.02 && pendDerived <= 0.02 && !hasOlder) {
    pend = pendDerived;
  }
  if (hasOlder && schedNet <= 0.02 && pendDerived <= 0.02 && pend <= 0.02) {
    pend = round2(0.03);
  }
  return pend;
}

/**
 * Monto base semanal antes de mora: cuota neta + cobro del saldo (regla) + opcional (% comisión × partner_fees_83).
 * La **cuota del plan no resta `bono_auto`**: el bono es informativo en columna, no descuenta lo a pagar.
 * Si `partnerFeesApplyToCuotaReduction` es true (por defecto), la cuota neta es plan − 83,33% PF.
 * Si es false, el 83,33% no se resta de la fila: va en cascada vía `applyPartnerFeesWaterfallToSolicitud`.
 * Si `commissionGoesToWaterfall` es true, la comisión no suma a esta fila (pool cascada).
 */
function computeAmountDueSemanal({
  cuotaSemanal,
  partnerFeesRaw,
  pctComision,
  cobroSaldo,
  partnerFeesApplyToCuotaReduction = true,
  commissionGoesToWaterfall = false,
}) {
  const partnerFees83 = round2(Number(partnerFeesRaw) * PARTNER_FEES_PCT);
  const baseCuota = round2(Math.max(0, Number(cuotaSemanal) || 0));
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
 * Inverso aproximado de `partnerFeesPlusComisionPool`: dado un pool (PEN) que quedó sin repartir en la fila,
 * devuelve un `partner_fees_raw` coherente (misma fórmula pool = 83,33% raw × (1 + %comisión/100)).
 */
export function partnerFeesRawFromRemainingPool(remainingPool, pctComision) {
  const pool = round2(Number(remainingPool) || 0);
  if (pool <= 0.005) return round2(0);
  const pct = round2(Number(pctComision) || 0);
  const denom = round2(1 + pct / 100);
  if (denom <= 0.005) return round2(0);
  const pf83 = round2(pool / denom);
  return round2(pf83 / PARTNER_FEES_PCT);
}

/**
 * Columnas a persistir en la fila **origen** tras repartir el pool PF+comisión y quedar `remainingPoolUsd` sin colocar
 * en cuotas más viejas (misma idea que el UPDATE de `ensureCuotaSemanalForWeek`).
 *
 * - `partner_fees_raw` / `83`: inverso del pool remanente; si no queda pool → 0.
 * - `partner_fees_yango_raw`: si queda remanente, el bruto coherente con ese tributo (la UI prioriza yango; así «Cobro por ingresos»
 *   muestra el 83 % **restante**, no el Yango histórico entero). Si no queda pool → null.
 * - `amount_due`: alineado con `computeAmountDueSemanal` en modo cascada (cuota + cobro saldo en fila; la cuota **a pagar** en API
 *   sigue siendo `cuota_semanal − partner_fees_83` vía `resolvedAmountDueSchedForOpenRow`).
 */
export function snapshotOrigenFilaTrasCascadaPool({
  remainingPoolUsd,
  pctComision,
  cuotaSemanal,
  cobroSaldo,
}) {
  const rem = round2(Number(remainingPoolUsd) || 0);
  const pct = round2(Number(pctComision) || 0);
  const cs = round2(Number(cuotaSemanal) || 0);
  const cobro = round2(Number(cobroSaldo) || 0);

  const partnerFeesRawStored =
    rem <= 0.005 ? round2(0) : partnerFeesRawFromRemainingPool(rem, pct);
  const partnerFees83Stored = round2(partnerFeesRawStored * PARTNER_FEES_PCT);
  const partnerFeesYangoRawStored =
    rem <= 0.005 ? null : partnerFeesRawStored;

  const amountDuePersisted = computeAmountDueSemanal({
    cuotaSemanal: cs,
    partnerFeesRaw: partnerFeesRawStored > 0.005 ? partnerFeesRawStored : 0,
    pctComision: pct,
    cobroSaldo: cobro,
    partnerFeesApplyToCuotaReduction: !(partnerFeesRawStored > 0.005),
    commissionGoesToWaterfall: partnerFeesRawStored > 0.005,
  });

  return {
    partnerFeesRaw: partnerFeesRawStored,
    partnerFees83: partnerFees83Stored,
    partnerFeesYangoRaw: partnerFeesYangoRawStored,
    amountDue: amountDuePersisted,
  };
}

/** Une listas de imputaciones cascada por `cuota_semanal_id` (suma montos). */
export function mergeCascadaAllocacionesPorCuota(allocLists) {
  const map = new Map();
  for (const list of allocLists) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!a || a.cuota_semanal_id == null) continue;
      const id = String(a.cuota_semanal_id);
      const monto = round2(Number(a.monto) || 0);
      if (monto <= 0.005) continue;
      const prev = map.get(id) || {
        cuota_semanal_id: id,
        week_start_date: a.week_start_date || null,
        monto: 0,
      };
      prev.monto = round2(prev.monto + monto);
      if (!prev.week_start_date && a.week_start_date) prev.week_start_date = a.week_start_date;
      map.set(id, prev);
    }
  }
  return [...map.values()].filter((x) => x.monto > 0.005);
}

/** Quita imputaciones a la propia fila origen (la cascada es solo a cuotas distintas; nunca «Semana N → Semana N»). */
export function cascadaDestinoExcluirCuotaOrigen(merged, excludeCuotaSemanalId) {
  const ex =
    excludeCuotaSemanalId != null && String(excludeCuotaSemanalId).trim()
      ? String(excludeCuotaSemanalId).trim()
      : null;
  if (!ex || !Array.isArray(merged)) return Array.isArray(merged) ? merged : [];
  return merged.filter((a) => a && String(a.cuota_semanal_id) !== ex);
}

/** Misma condición que `underpaidPaidSql` en mora: `paid` con cuota+mora en columnas por encima del abono. */
const SQL_WATERFALL_UNDERPAID_PAID = `(c.status = 'paid' AND COALESCE(c.amount_due,0)::numeric + COALESCE(c.late_fee,0)::numeric > COALESCE(c.paid_amount,0)::numeric + 0.02)`;

/**
 * Reparte el pool (83,33% PF + comisión %, o solo el delta de ese total) en `paid_amount` por orden **due_date ASC**
 * (deuda más antigua primero; excedente sigue con la siguiente). Incluye `partial` y **`paid` mal etiquetada** con saldo en columnas.
 * @param {{ excludeCuotaSemanalId?: string|null }} [options] — Si viene, esa fila no recibe pool (cobro al más viejo antes de generar/actualizar la semana nueva).
 */
export async function applyPartnerFeesWaterfallToSolicitud(solicitudId, poolDelta, options = {}) {
  const ex = options.excludeCuotaSemanalId;
  const excludeId = ex != null && String(ex).trim() ? String(ex).trim() : null;
  let pool = round2(Number(poolDelta) || 0);
  if (pool <= 0.005) return { applied: 0, remainingPool: 0 };

  const solRes = await query(
    `SELECT cronograma_id, cronograma_vehiculo_id, fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1::uuid`,
    [solicitudId]
  );
  const solMeta = solRes.rows?.[0];
  const cronogramaW =
    solMeta?.cronograma_id != null ? await getCronogramaById(solMeta.cronograma_id) : null;
  const vehIdW = solMeta?.cronograma_vehiculo_id;
  const fiW = solMeta?.fecha_inicio_cobro_semanal;

  let sql = `SELECT c.id, c.amount_due, c.late_fee, c.paid_amount, c.status, c.due_date, c.week_start_date,
                    c.num_viajes, c.bono_auto, c.cuota_semanal, c.partner_fees_raw, c.partner_fees_83,
                    c.cobro_saldo, c.pct_comision, c.moneda, c.partner_fees_cascada_destino
     FROM module_miauto_cuota_semanal c
     WHERE c.solicitud_id = $1::uuid
       AND (c.status IN ('pending', 'overdue', 'partial') OR ${SQL_WATERFALL_UNDERPAID_PAID})`;
  const params = [solicitudId];
  if (excludeId) {
    sql += ` AND c.id <> $2::uuid`;
    params.push(excludeId);
  }
  sql += ` ORDER BY c.due_date ASC NULLS LAST, c.week_start_date ASC, c.id ASC`;
  const res = await query(sql, params);
  let applied = 0;
  /** @type {{ cuota_semanal_id: string, week_start_date: string|null, monto: number }[]} */
  const allocations = [];
  for (const row of res.rows || []) {
    if (pool <= 0.005) break;
    const paid = round2(parseFloat(row.paid_amount) || 0);
    const amountDue = round2(parseFloat(row.amount_due) || 0);
    const lateFee = round2(parseFloat(row.late_fee) || 0);
    const totalDueCol = round2(amountDue + lateFee);
    let pending;
    if (cronogramaW && vehIdW != null) {
      const w = ymdFromDbDate(row.week_start_date);
      const isPrimera = w ? isSemanaDepositoMiAuto(w, fiW) : false;
      const stLow = (row.status || '').toLowerCase();
      const dW = computeCuotaDerivedForRow(row, cronogramaW, vehIdW, {
        isPrimeraCuotaSemanal: !!isPrimera,
        fechaInicioCobroSemanal: fiW,
        /** `paid` en SQL por columnas: recalcular como fila abierta para obtener el pendiente real. */
        ignoreClosedStatusForDerived: stLow === 'paid',
      });
      pending = round2(Math.max(0, dW.cuota_final));
    } else {
      pending = round2(totalDueCol - paid);
    }
    if (pending <= 0.005) continue;
    const applyAmt = round2(Math.min(pool, pending));
    const newPaid = round2(paid + applyAmt);
    let pendRow;
    if (cronogramaW && vehIdW != null) {
      const w2 = ymdFromDbDate(row.week_start_date);
      const isP2 = w2 ? isSemanaDepositoMiAuto(w2, fiW) : false;
      const rowAfter = { ...row, paid_amount: newPaid };
      const stAfter = (rowAfter.status || '').toLowerCase();
      const dAfter = computeCuotaDerivedForRow(rowAfter, cronogramaW, vehIdW, {
        isPrimeraCuotaSemanal: !!isP2,
        fechaInicioCobroSemanal: fiW,
        ignoreClosedStatusForDerived: stAfter === 'paid',
      });
      pendRow = round2(Math.max(0, dAfter.cuota_final));
    } else {
      pendRow = round2(Math.max(0, totalDueCol - newPaid));
    }
    const newStatus = miAutoOpenStatusSaldoVencimiento(ymdFromDbDate(row.due_date), pendRow, newPaid);
    await query(
      `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [newPaid, newStatus, row.id]
    );
    applied = round2(applied + applyAmt);
    pool = round2(pool - applyAmt);
    allocations.push({
      cuota_semanal_id: String(row.id),
      week_start_date: ymdFromDbDate(row.week_start_date),
      monto: applyAmt,
    });
  }
  if (applied > 0.005) {
    logger.info(
      `Yego Mi Auto: cascada PF+comisión solicitud ${solicitudId} aplicó ${applied.toFixed(2)} (pool ${round2(Number(poolDelta) || 0).toFixed(2)}${excludeId ? `, excl. fila ${excludeId}` : ''})`
    );
  }
  return { applied, remainingPool: pool, allocations };
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

/** Misma regla que `ensureCuotaSemanalForWeek` — para importación Excel. */
export function planCuotaFromCronogramaViajes(cronograma, cronogramaVehiculoId, numViajes) {
  return planFromCronograma(cronograma, cronogramaVehiculoId, numViajes);
}

/** `amount_due` sin PF Yango (PF=0). No resta bono del plan en la base. */
export function amountDueSemanalFromPlanForImport(
  plan,
  _dueDateYmd,
  { isPrimeraCuota: _isPrimeraCuota = false, partnerFeesRaw = 0 } = {}
) {
  if (!plan) return null;
  return computeAmountDueSemanal({
    cuotaSemanal: plan.cuotaSemanal,
    partnerFeesRaw,
    pctComision: plan.pctComision,
    cobroSaldo: plan.cobroSaldo,
    partnerFeesApplyToCuotaReduction: true,
    commissionGoesToWaterfall: false,
  });
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

/** Días civiles de retraso respecto al vencimiento (Lima). El día del vencimiento cuenta como 0; el interés empieza al día siguiente. */
function calendarDaysLateLima(dueDateStr) {
  if (!dueDateStr) return 0;
  const dueYmd = ymdFromDbDate(dueDateStr) || String(dueDateStr).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueYmd)) return 0;
  const todayYmd = limaTodayYmdSync();
  if (dueYmd >= todayYmd) return 0;
  return Math.max(0, diffDaysYmdUtc(dueYmd, todayYmd));
}

/**
 * Mora por días de retraso (Lima). Devengo **día a día** con capitalización diaria: cada día `moraDia = saldo × (tasa/7)`,
 * se suma a la mora acumulada y el saldo del día siguiente incluye esa mora (no equivale a interés simple `capital × tasa/7 × días` si hay más de un día).
 * `baseCuota` = capital pendiente sobre el que corre la mora (p. ej. tras abonos a cuota).
 */
function computeLateFeeDisplay(cronograma, dueDateStr, baseCuota) {
  if (!dueDateStr || baseCuota <= 0) return round2(0);
  const tasa = round2(parseFloat(cronograma?.tasa_interes_mora) || 0);
  if (tasa <= 0) return round2(0);
  const daysOverdue = calendarDaysLateLima(dueDateStr);
  if (daysOverdue <= 0) return round2(0);
  const factorDia = tasa / 7;
  const moraDia = round2(baseCuota * factorDia);
  return round2(moraDia * daysOverdue);
}

/**
 * Base semanal para mora, pendiente API y tope de cobro: **cuota neta** = plan − 83,33% PF (+ cobro saldo según regla); no resta bono.
 * Solo para vencimientos **estrictamente antes** de `MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER` se respeta `amount_due`
 * persistido (Excel legado). Desde el corte en adelante **siempre** la obligación viene del plan/PF, no de un neto guardado que pudiera traer bono descontado.
 */
function resolvedAmountDueSchedForOpenRow(
  r,
  cuotaSemanal,
  _bonoAuto,
  pctComision,
  cobroSaldo,
  isPrimeraCuotaSemanal
) {
  const pfRaw = round2(parseFloat(r.partner_fees_raw) || 0);
  const useWaterfallGross = !isPrimeraCuotaSemanal && pfRaw > 0.005;
  if (useWaterfallGross) {
    const baseCuota = round2(cuotaSemanal);
    const pf83 = partnerFees83FromRow(r);
    return round2(Math.max(0, baseCuota - pf83 + cobroSaldo));
  }
  const computedSched = computeAmountDueSemanal({
    cuotaSemanal: cuotaSemanal,
    partnerFeesRaw: r.partner_fees_raw,
    pctComision: pctComision,
    cobroSaldo: cobroSaldo,
    partnerFeesApplyToCuotaReduction: true,
    commissionGoesToWaterfall: false,
  });
  const storedSched = round2(parseFloat(r.amount_due) || 0);
  const dueYmd = ymdFromDbDate(r.due_date);
  const legacyUsarPersistido =
    dueYmd &&
    /^\d{4}-\d{2}-\d{2}$/.test(dueYmd) &&
    dueYmd < MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER &&
    storedSched > 0.005;
  return legacyUsarPersistido ? storedSched : computedSched;
}

/** Base `amount_due` efectiva para cola Fleet / pendiente (alinea API y retiro con cuota neta si hay PF en cascada). */
function effectiveAmountDueForMiAutoFleetRow(cuotaRow) {
  if (!cuotaRow) return 0;
  const wsCobro = ymdFromDbDate(cuotaRow.week_start_date);
  const isPrimeraCobro =
    wsCobro && cuotaRow.fecha_inicio_cobro_semanal
      ? isSemanaDepositoMiAuto(wsCobro, cuotaRow.fecha_inicio_cobro_semanal)
      : false;
  const csRaw = parseFloat(cuotaRow.cuota_semanal);
  const cuotaSemPlan =
    Number.isFinite(csRaw) && csRaw > 0.005 ? round2(csRaw) : round2(parseFloat(cuotaRow.amount_due) || 0);
  return resolvedAmountDueSchedForOpenRow(
    cuotaRow,
    cuotaSemPlan,
    round2(parseFloat(cuotaRow.bono_auto) || 0),
    round2(Number(parseFloat(cuotaRow.pct_comision) || 0)),
    round2(parseFloat(cuotaRow.cobro_saldo) || 0),
    !!isPrimeraCobro
  );
}

/** Igual que `effectiveAmountDueForMiAutoFleetRow` pero normaliza PF Yango→USD en filas con cuota en dólares (legado PEN/COP en BD). */
export async function effectiveAmountDueForMiAutoFleetRowAsync(cuotaRow) {
  const row = await cuotaRowWithPartnerFeesUsdNormalizedIfNeeded(cuotaRow.solicitud_id, cuotaRow);
  return effectiveAmountDueForMiAutoFleetRow(row);
}

/** Cuota en USD: corrige `partner_fees_raw` guardado en PEN/COP para PF83, comisión % y cobro Fleet (sin pisar filas ya en USD). */
async function cuotaRowWithPartnerFeesUsdNormalizedIfNeeded(solicitudId, r) {
  if (!r || String(r.moneda || 'PEN').toUpperCase() !== 'USD') return r;
  const pf = round2(parseFloat(r.partner_fees_raw) || 0);
  if (pf <= 0.005) return r;
  const cs = round2(parseFloat(r.cuota_semanal) || 0);
  const cuotaRef = cs > 0.005 ? cs : round2(parseFloat(r.amount_due) || 0);
  const norm = await partnerFeesRawDbNormalizeUsdFromYangoLocal(solicitudId, pf, cuotaRef);
  if (Math.abs(norm - pf) <= 0.02) return r;
  return {
    ...r,
    partner_fees_raw: norm,
    partner_fees_83: round2(norm * PARTNER_FEES_PCT),
  };
}

/**
 * Cronograma abierto: primero se imputa el pago a la **cuota del periodo** (hasta `amount_due_sched`); el remanente va a **mora**.
 * El interés diario corre sobre el **capital pendiente** (`sched − min(paid, sched)`), no sobre el sched entero si ya abonó en el vencimiento.
 */
function amountDueAndLateForOpen(
  cronograma,
  r,
  cuota_semanal,
  bono_auto,
  pct_comision,
  cobro_saldo,
  isPrimeraCuotaSemanal,
  cascadeReceived
) {
  const amount_due_sched = resolvedAmountDueSchedForOpenRow(
    r,
    cuota_semanal,
    bono_auto,
    pct_comision,
    cobro_saldo,
    isPrimeraCuotaSemanal
  );
  const paid = round2(parseFloat(r.paid_amount) || 0);

  /** Pago del conductor (sin cascada) para calcular mora sobre capital realmente pendiente durante el periodo. */
  const cascadeRcv = round2(Number(cascadeReceived) || 0);
  const paidSinCascada = round2(Math.max(0, paid - cascadeRcv));
  const aplicadoCuotaSinCascada = round2(Math.min(paidSinCascada, amount_due_sched));
  const capitalParaMora = round2(Math.max(0, amount_due_sched - aplicadoCuotaSinCascada));

  const aplicadoCuotaPrimero = round2(Math.min(paid, amount_due_sched));
  const capitalPendiente = round2(Math.max(0, amount_due_sched - aplicadoCuotaPrimero));
  const paidRemanenteTrasCuota = round2(Math.max(0, paid - aplicadoCuotaPrimero));

  const mora_sched = computeLateFeeDisplay(cronograma, r.due_date, capitalParaMora);
  const mora_full = round2(mora_sched);

  let late_fee_remaining;
  let amount_due_remaining;

  if (mora_full > 0.005) {
    /** Pagos cubren mora primero (tras cubrir cuota), luego capital restante. */
    late_fee_remaining = round2(Math.max(0, mora_full - paidRemanenteTrasCuota));
    amount_due_remaining = capitalPendiente;
  } else {
    late_fee_remaining = round2(0);
    amount_due_remaining = round2(Math.max(0, amount_due_sched - paid));
  }

  const obligacion_total_open = round2(amount_due_remaining + late_fee_remaining + paid);

  return {
    amount_due_sched,
    mora_sched: round2(mora_sched),
    mora_full,
    late_fee_remaining,
    amount_due_remaining,
    obligacion_total_open,
  };
}

/**
 * Usar siempre la mora pendiente de la cascada (`late_fee_remaining`) en filas abiertas.
 * Antes `overdue`/`partial` podían quedar fuera del `|| paid < obligación` y forzar mora a 0 en API.
 */
function debeAplicarMoraCuotaSemanal(status) {
  const st = (status || '').toLowerCase();
  if (st === 'paid' || st === 'bonificada') return false;
  return true;
}

/** Solicitudes listas para generar cuota semanal (job lunes). No filtra por pago_estado: basta Mi Auto ya generado (fecha_inicio_cobro_semanal) y datos operativos. */
export async function getSolicitudesParaCobroSemanal() {
  const res = await query(
    `SELECT s.id AS solicitud_id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
            rd.id AS driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.driver_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.external_driver_id::text, '')), '')) AS external_driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.park_id::text, '')), '')) AS park_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.first_name::text, '')), ''), rd.first_name) AS first_name,
            COALESCE(NULLIF(TRIM(COALESCE(fl.last_name::text, '')), ''), rd.last_name) AS last_name,
            s.country
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     LEFT JOIN LATERAL (
       SELECT d.driver_id, d.park_id, d.first_name, d.last_name
       FROM drivers d
       WHERE TRIM(COALESCE(d.park_id::text, '')) = $1
         AND d.work_status = 'working'
         AND (
           LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g'))
           OR (
             REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                 REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g')
             AND REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g') <> ''
           )
         )
       ORDER BY
         CASE WHEN LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g')) THEN 0 ELSE 1 END,
         d.driver_id::text
       LIMIT 1
     ) fl ON true
     WHERE s.status = 'aprobado'
       AND s.cronograma_id IS NOT NULL
       AND s.cronograma_vehiculo_id IS NOT NULL
       AND s.fecha_inicio_cobro_semanal IS NOT NULL
       AND COALESCE(NULLIF(TRIM(COALESCE(fl.driver_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.external_driver_id::text, '')), '')) IS NOT NULL
       AND COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.park_id::text, '')), '')) IS NOT NULL
     ORDER BY s.id`,
    [MIAUTO_PARK_ID]
  );
  return res.rows || [];
}

/**
 * Solicitud Mi Auto + conductor: `external_driver_id` / `park_id` / nombre — prioridad a la fila en `drivers`
 * (flota Mi Auto, `park_id` alineado con Yango) y si falta, `module_rapidin_drivers`; match por `rapidin_driver_id` o DNI.
 */
export async function loadMiAutoSolicitudConFlotaDrivers(solicitudId) {
  const res = await query(
    `SELECT s.id AS solicitud_id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
            s.status, s.pago_estado,
            rd.id AS driver_id, COALESCE(rd.dni, s.dni) AS dni,
            COALESCE(NULLIF(TRIM(COALESCE(fl.driver_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.external_driver_id::text, '')), '')) AS external_driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.park_id::text, '')), '')) AS park_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.first_name::text, '')), ''), rd.first_name) AS first_name,
            COALESCE(NULLIF(TRIM(COALESCE(fl.last_name::text, '')), ''), rd.last_name) AS last_name,
            s.country
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     LEFT JOIN LATERAL (
       SELECT d.driver_id, d.park_id, d.first_name, d.last_name
       FROM drivers d
       WHERE TRIM(COALESCE(d.park_id::text, '')) = $2
         AND d.work_status = 'working'
         AND (
           LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g'))
           OR (
             REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                 REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g')
             AND REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g') <> ''
           )
         )
       ORDER BY
         CASE WHEN LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g')) THEN 0 ELSE 1 END,
         d.driver_id::text
       LIMIT 1
     ) fl ON true
     WHERE s.id = $1::uuid`,
    [solicitudId, MIAUTO_PARK_ID]
  );
  return res.rows[0] || null;
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
  if (partnerFeesRawRounded > 0.005) {
    partnerFeesRawRounded = await partnerFeesYangoAMonedaCuota(solicitudId, partnerFeesRawRounded, moneda);
  }
  const partnerFees83 = round2(partnerFeesRawRounded * PARTNER_FEES_PCT);
  const bonoAuto = isFirstCuotaSemanal ? 0 : plan.bonoAuto;
  const dueDateForRow = computeDueDateForMiAutoCuota(
    String(weekStartDate).trim().slice(0, 10),
    fechaInicioYmd,
    isFirstCuotaSemanal
  );
  /** Con PF de semana cerrada: `amount_due` sin restar bono; PF83 + comisión % van en cascada a cuotas más viejas. */
  const useWaterfallAmountDue = !isFirstCuotaSemanal && partnerFeesRawRounded > 0;
  const amountDue = computeAmountDueSemanal({
    cuotaSemanal,
    partnerFeesRaw: partnerFeesRawRounded,
    pctComision,
    cobroSaldo,
    partnerFeesApplyToCuotaReduction: !useWaterfallAmountDue,
    commissionGoesToWaterfall: useWaterfallAmountDue,
  });
  const poolCascadaNuevo = useWaterfallAmountDue
    ? partnerFeesPlusComisionPool(partnerFees83, pctComision)
    : round2(0);

  const existing = await query(
    'SELECT id FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND week_start_date = $2',
    [solicitudId, weekStartDate]
  );

  if (existing.rows.length > 0) {
    if (skipUpdateIfExists) {
      return existing.rows[0].id;
    }
    const prev = await query(
      `SELECT paid_amount, late_fee, status, partner_fees_83, pct_comision, amount_due, partner_fees_raw, partner_fees_yango_raw, partner_fees_cascada_destino
       FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND week_start_date = $2`,
      [solicitudId, weekStartDate]
    );
    const rowPrev = prev.rows[0] || {};
    const cuotaRowId = existing.rows[0].id;
    const amountDuePrev = round2(parseFloat(rowPrev.amount_due) || 0);
    const yangoPrevRaw = round2(
      parseFloat(
        rowPrev.partner_fees_yango_raw != null && String(rowPrev.partner_fees_yango_raw).trim() !== ''
          ? rowPrev.partner_fees_yango_raw
          : rowPrev.partner_fees_raw
      ) || 0
    );
    const oldPf83 = round2(yangoPrevRaw * PARTNER_FEES_PCT);
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
    let toApplyPrimera = round2(0);
    let w1 = { remainingPool: round2(0), applied: 0, allocations: [] };
    if (!isFirstCuotaSemanal && useWaterfallAmountDue && poolCascadaNuevo > 0.005) {
      if (deltaPoolCascada > 0.005) {
        toApplyPrimera = round2(deltaPoolCascada + reduccionFila);
      } else if (reduccionFila > 0.005) {
        toApplyPrimera = reduccionFila;
      } else {
        const prevDest = rowPrev.partner_fees_cascada_destino;
        const yaHuboCascada =
          prevDest != null &&
          (Array.isArray(prevDest)
            ? prevDest.length > 0
            : String(prevDest).trim().length > 2 && String(prevDest).trim() !== '[]');
        const yangoIgual =
          round2(yangoPrevRaw) > 0.005 &&
          round2(Math.abs(yangoPrevRaw - partnerFeesRawRounded)) <= 0.02;
        if (yaHuboCascada && yangoIgual) {
          toApplyPrimera = round2(0);
        } else {
          toApplyPrimera = poolCascadaNuevo;
          logger.info(
            `Mi Auto: cascada con pool sin delta (${poolCascadaNuevo.toFixed(2)}); si esta semana se vuelve a regenerar igual, revisar paid_amount por posible doble reparto.`
          );
        }
      }
      if (toApplyPrimera > 0.005) {
        w1 = await applyPartnerFeesWaterfallToSolicitud(solicitudId, toApplyPrimera, {
          excludeCuotaSemanalId: cuotaRowId,
        });
      }
    }
    /** Sin segundo pase «sin excluir»: aplicaba el remanente al `paid` de la misma semana y guardaba imputación «Semana N → Semana N». El pool que no cabe en filas más viejas queda en `partner_fees_*` de esta fila. */
    const finalPoolRem = round2(w1.remainingPool);
    const mergedCascadaRaw =
      !isFirstCuotaSemanal && useWaterfallAmountDue && poolCascadaNuevo > 0.005
        ? mergeCascadaAllocacionesPorCuota([w1.allocations || []])
        : [];
    const mergedCascada = cascadaDestinoExcluirCuotaOrigen(mergedCascadaRaw, cuotaRowId);
    let cascadaDestinoVal =
      mergedCascada.length > 0 ? JSON.stringify(mergedCascada) : null;
    /** No pisar JSON histórico si no se re-ejecuta cascada (mismo Yango); limpiar auto-imputaciones a esta fila. */
    if (
      cascadaDestinoVal == null &&
      !isFirstCuotaSemanal &&
      useWaterfallAmountDue &&
      poolCascadaNuevo > 0.005 &&
      toApplyPrimera <= 0.005
    ) {
      const pdPrev = rowPrev.partner_fees_cascada_destino;
      if (pdPrev != null) {
        const filteredPrev = cascadaDestinoExcluirCuotaOrigen(
          parsePartnerFeesCascadaDestinoDb(pdPrev),
          cuotaRowId
        );
        if (filteredPrev.length > 0) {
          cascadaDestinoVal = JSON.stringify(filteredPrev);
        }
      }
    }
    let partnerFeesRawStored;
    let partnerFees83Stored;
    let partnerFeesYangoStored;
    let amountDuePersisted = amountDue;
    if (useWaterfallAmountDue) {
      const snap = snapshotOrigenFilaTrasCascadaPool({
        remainingPoolUsd: finalPoolRem,
        pctComision,
        cuotaSemanal,
        cobroSaldo,
      });
      partnerFeesRawStored = snap.partnerFeesRaw;
      partnerFees83Stored = snap.partnerFees83;
      partnerFeesYangoStored = snap.partnerFeesYangoRaw;
      amountDuePersisted = snap.amountDue;
    } else {
      partnerFeesRawStored = partnerFeesRawRounded;
      partnerFees83Stored = round2(partnerFeesRawStored * PARTNER_FEES_PCT);
      partnerFeesYangoStored =
        partnerFeesRawRounded > 0.005 ? partnerFeesRawRounded : null;
    }

    await query(
      `UPDATE module_miauto_cuota_semanal
       SET num_viajes = $1, partner_fees_raw = $2, partner_fees_83 = $3, partner_fees_yango_raw = $4, partner_fees_cascada_destino = $5::jsonb,
           bono_auto = $6, cuota_semanal = $7, amount_due = $8, moneda = $9, pct_comision = $10, cobro_saldo = $11, paid_amount = $12, status = $13, due_date = $14, updated_at = CURRENT_TIMESTAMP
       WHERE solicitud_id = $15 AND week_start_date = $16`,
      [
        numViajes,
        partnerFeesRawStored,
        partnerFees83Stored,
        partnerFeesYangoStored,
        cascadaDestinoVal,
        bonoAuto,
        cuotaSemanal,
        amountDuePersisted,
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

  /** Antes de crear la fila nueva: cobrar PF+comisión en cuotas más viejas (la semana nueva aún no existe en BD). Un solo pase: el remanente queda en `partner_fees_*` de la fila nueva. */
  let wIns1 = { remainingPool: round2(poolCascadaNuevo), applied: 0, allocations: [] };
  let finalPoolRemIns = round2(0);
  if (!isFirstCuotaSemanal && poolCascadaNuevo > 0.005) {
    await updateMoraDiaria(solicitudId, { includePartial: true });
    wIns1 = await applyPartnerFeesWaterfallToSolicitud(solicitudId, poolCascadaNuevo);
    finalPoolRemIns = round2(wIns1.remainingPool);
  }
  const mergedIns =
    !isFirstCuotaSemanal && poolCascadaNuevo > 0.005
      ? mergeCascadaAllocacionesPorCuota([wIns1.allocations || []])
      : [];
  const cascadaInsJson = mergedIns.length > 0 ? JSON.stringify(mergedIns) : null;
  let insPartnerFeesRaw;
  let insPartnerFees83;
  let insYangoRaw;
  let amountDueInsert = amountDue;
  if (!isFirstCuotaSemanal && poolCascadaNuevo > 0.005) {
    const insSnap = snapshotOrigenFilaTrasCascadaPool({
      remainingPoolUsd: finalPoolRemIns,
      pctComision,
      cuotaSemanal,
      cobroSaldo,
    });
    insPartnerFeesRaw = insSnap.partnerFeesRaw;
    insPartnerFees83 = insSnap.partnerFees83;
    insYangoRaw = insSnap.partnerFeesYangoRaw;
    amountDueInsert = insSnap.amountDue;
  } else {
    insPartnerFeesRaw = partnerFeesRawRounded;
    insPartnerFees83 = round2(insPartnerFeesRaw * PARTNER_FEES_PCT);
    insYangoRaw = partnerFeesRawRounded > 0.005 ? partnerFeesRawRounded : null;
  }

  const ins = await query(
    `INSERT INTO module_miauto_cuota_semanal
     (solicitud_id, week_start_date, due_date, num_viajes, partner_fees_raw, partner_fees_83, partner_fees_yango_raw, partner_fees_cascada_destino, bono_auto, cuota_semanal, amount_due, paid_amount, status, moneda, pct_comision, cobro_saldo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      solicitudId,
      weekStartDate,
      dueDateForRow,
      numViajes,
      insPartnerFeesRaw,
      insPartnerFees83,
      insYangoRaw,
      cascadaInsJson,
      bonoAuto,
      cuotaSemanal,
      amountDueInsert,
      paidAmountInsert,
      statusInsert,
      moneda,
      pctComision,
      cobroSaldo,
    ]
  );
  if (!isFirstCuotaSemanal && poolCascadaNuevo > 0.005) {
    await persistPaidAmountCapsForSolicitud(solicitudId);
  }
  return ins.rows[0]?.id || null;
}

/**
 * Vuelve a ejecutar `ensureCuotaSemanalForWeek` con la **última** fila que tiene `partner_fees_raw > 0` (mismos `num_viajes` / PF en BD).
 * Sirve si el PF quedó guardado sin repartir la cascada a cuotas más viejas. Si la cascada **ya** se aplicó, `ensure` con delta de pool 0 puede
 * volver a intentar reparto (riesgo de doble imputación): usar solo ante cuotas viejas claramente sin `paid_amount` del pool.
 */
export async function reaplicarCascadaPartnerFeesDesdeUltimaFilaConPF(solicitudId) {
  const sid = String(solicitudId || '').trim();
  if (!sid) return { ok: false, error: 'solicitud_id vacío' };

  const solRes = await query(
    `SELECT s.cronograma_id, s.cronograma_vehiculo_id,
            c.week_start_date, c.num_viajes,
            GREATEST(COALESCE(c.partner_fees_yango_raw, 0), COALESCE(c.partner_fees_raw, 0))::numeric AS partner_fees_para_ensure
     FROM module_miauto_solicitud s
     INNER JOIN module_miauto_cuota_semanal c ON c.solicitud_id = s.id
     WHERE s.id = $1::uuid
       AND GREATEST(COALESCE(c.partner_fees_yango_raw, 0), COALESCE(c.partner_fees_raw, 0))::numeric > 0.005
     ORDER BY c.week_start_date DESC NULLS LAST
     LIMIT 1`,
    [sid]
  );
  const row = solRes.rows[0];
  if (!row?.cronograma_id) {
    return { ok: false, error: 'sin_fila_con_partner_fees', solicitud_id: sid };
  }
  const ws = ymdFromDbDate(row.week_start_date);
  if (!ws || !/^\d{4}-\d{2}-\d{2}$/.test(ws)) {
    return { ok: false, error: 'week_start_invalido', solicitud_id: sid };
  }
  const ensuredId = await ensureCuotaSemanalForWeek(sid, row.cronograma_id, row.cronograma_vehiculo_id, ws, {
    count_completed: Number(row.num_viajes) || 0,
    partner_fees: round2(parseFloat(row.partner_fees_para_ensure) || 0),
  });
  return {
    ok: ensuredId != null,
    cuota_semanal_id: ensuredId,
    week_start_date: ws,
    solicitud_id: sid,
  };
}

/** Alinea semana-depósito con `fecha_inicio_cobro_semanal`; opcional `options.fecha_inicio_cobro_semanal` (YYYY-MM-DD). */
export async function realignPrimeraCuotaDepositoDesdeFechaInicio(solicitudId, options = {}) {
  const sid = String(solicitudId || '').trim();
  if (!sid) return { ok: false, error: 'solicitud_id vacío' };

  const fiOpt =
    options.fecha_inicio_cobro_semanal != null
      ? String(options.fecha_inicio_cobro_semanal).trim().slice(0, 10)
      : '';
  if (fiOpt && /^\d{4}-\d{2}-\d{2}$/.test(fiOpt)) {
    await query(
      `UPDATE module_miauto_solicitud SET fecha_inicio_cobro_semanal = $1::date, updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid`,
      [fiOpt, sid]
    );
  }

  const sol = await query(
    `SELECT fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1::uuid`,
    [sid]
  );
  const fiRaw = sol.rows[0]?.fecha_inicio_cobro_semanal;
  const fiYmd = ymdFromDbDate(fiRaw);
  if (!fiYmd) {
    return { ok: false, error: 'Sin fecha_inicio_cobro_semanal en la solicitud' };
  }

  const mon = mondayOfWeekContainingYmd(fiYmd);
  const due = computeDueDateForMiAutoCuota(mon, fiYmd, true);

  const cuotasRes = await query(
    `SELECT id, week_start_date FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid ORDER BY week_start_date ASC`,
    [sid]
  );
  const rows = cuotasRes.rows || [];
  let target = null;
  for (const r of rows) {
    const ws = ymdFromDbDate(r.week_start_date);
    if (ws && isSemanaDepositoMiAuto(ws, fiRaw)) {
      target = r;
      break;
    }
  }
  if (!target && rows.length >= 1) {
    target = rows[0];
  }
  if (!target) {
    return { ok: false, error: 'No hay cuotas semanales para esta solicitud' };
  }

  await query(
    `UPDATE module_miauto_cuota_semanal
     SET week_start_date = $1::date, due_date = $2::date, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3::uuid`,
    [mon, due, target.id]
  );

  await updateMoraDiaria(sid, { includePartial: true });
  await persistPaidAmountCapsForSolicitud(sid);

  return {
    ok: true,
    fecha_inicio: fiYmd,
    week_start_date: mon,
    due_date: due,
    cuota_id: target.id,
  };
}

/**
 * Mora y estado vencida (Lima):
 * - La **semana de cuota** (`week_start_date` = lunes) si ya pasó (`< hoy`) → entra al job; también entra si **`due_date` < hoy** aunque `week_start_date` esté erróneo (p. ej. futuro).
 * - Si no hay `week_start_date`, se usa `due_date < hoy`.
 * - El día del vencimiento canónico (`due_date` = lunes de cuota o fecha depósito en sem. 1) sigue **pendiente** ese mismo día: `week_start >= hoy` → no mora.
 * - Con saldo tras el vencimiento (Lima) → `overdue`; `partial` solo si aún no vence y hubo abono.
 */
export async function updateMoraDiaria(solicitudId = null, options = {}) {
  const singleCuotaId = options.singleCuotaId || null;
  const includePartial = options.includePartial === true;

  const scopeConds = [];
  const scopeParams = [];
  if (solicitudId) {
    scopeParams.push(solicitudId);
    scopeConds.push(`c.solicitud_id = $${scopeParams.length}`);
  }
  if (singleCuotaId) {
    scopeParams.push(singleCuotaId);
    scopeConds.push(`c.id = $${scopeParams.length}::uuid`);
  }
  const scopeSql = scopeConds.length ? ` AND ${scopeConds.join(' AND ')}` : '';

  /** Semana de cuota aún no empezó (lunes ≥ hoy) o sin lunes: se usa `due_date` ≥ hoy para revertir mora. */
  const vencimientoHoyOFuturoSql = `(
      (c.week_start_date IS NOT NULL AND c.week_start_date::date >= ${SQL_LIMA_TODAY})
      OR (c.week_start_date IS NULL AND c.due_date IS NOT NULL AND c.due_date::date >= ${SQL_LIMA_TODAY})
    )`;
  /**
   * Incluye `due_date::date < hoy` (Lima en SQL) aunque `week_start_date` esté mal en BD (p. ej. futuro):
   * si no, el job no recalcula mora ni pasa a vencido aunque el vencimiento civil ya pasó.
   */
  const vencimientoYaPasadoSql = `(
      (c.week_start_date IS NOT NULL AND c.week_start_date::date < ${SQL_LIMA_TODAY})
      OR (c.week_start_date IS NULL AND c.due_date IS NOT NULL AND c.due_date::date < ${SQL_LIMA_TODAY})
      OR (c.due_date IS NOT NULL AND c.due_date::date < ${SQL_LIMA_TODAY})
    )`;

  /** Solo corrige estado; no pisa `late_fee` (mora histórica en cuotas pagadas). */
  /** Total registrado cuota+mora en columnas vs pagado (sin SQL del cronograma). */
  const revertOverdueSql = `
    UPDATE module_miauto_cuota_semanal c
    SET status = CASE
          WHEN COALESCE(c.paid_amount, 0)::numeric <= 0.005 THEN 'pending'
          WHEN COALESCE(c.paid_amount, 0)::numeric >= COALESCE(c.amount_due, 0)::numeric + COALESCE(c.late_fee, 0)::numeric - 0.005 THEN 'paid'
          ELSE 'partial'
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE c.status = 'overdue'
      AND ${vencimientoHoyOFuturoSql}
      AND (c.due_date IS NULL OR c.due_date::date >= ${SQL_LIMA_TODAY})${scopeSql}`;
  await query(revertOverdueSql, scopeParams);

  /** Bonificada: anular mora en columna; en `paid` se conserva devengo/histórico. */
  const clearBonificadaLateFeeSql = `
    UPDATE module_miauto_cuota_semanal c
    SET late_fee = 0, updated_at = CURRENT_TIMESTAMP
    WHERE c.status = 'bonificada'
      AND COALESCE(c.late_fee, 0)::numeric > 0.005${scopeSql}`;
  await query(clearBonificadaLateFeeSql, scopeParams);

  const clearPartialSql = `
    UPDATE module_miauto_cuota_semanal c
    SET late_fee = 0, updated_at = CURRENT_TIMESTAMP
    WHERE c.status = 'partial'
      AND ${vencimientoHoyOFuturoSql}
      AND (c.due_date IS NULL OR c.due_date::date >= ${SQL_LIMA_TODAY})
      AND COALESCE(c.late_fee, 0)::numeric > 0.005${scopeSql}`;
  await query(clearPartialSql, scopeParams);

  /** Incluir `paid` mal etiquetada: aún hay saldo en columnas cuota+mora respecto al abono (p. ej. cascada vs Excel). */
  const underpaidPaidSql = `(c.status = 'paid' AND COALESCE(c.amount_due,0)::numeric + COALESCE(c.late_fee,0)::numeric > COALESCE(c.paid_amount,0)::numeric + 0.02)`;
  const statusSql = includePartial
    ? `(c.status IN ('pending', 'overdue', 'partial') OR ${underpaidPaidSql})`
    : `(c.status IN ('pending', 'overdue') OR ${underpaidPaidSql})`;
  let sql = `SELECT c.id, c.solicitud_id, c.week_start_date, c.cuota_semanal, c.amount_due, c.due_date, c.num_viajes, c.bono_auto,
            c.paid_amount, c.late_fee, c.status, c.moneda, c.pct_comision, c.cobro_saldo,
            c.partner_fees_raw, c.partner_fees_83,
            s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     WHERE ${statusSql} AND ${vencimientoYaPasadoSql}`;
  let p = 0;
  if (solicitudId) {
    p += 1;
    sql += ` AND c.solicitud_id = $${p}`;
  }
  if (singleCuotaId) {
    p += 1;
    sql += ` AND c.id = $${p}::uuid`;
  }
  const res = await query(sql, scopeParams);
  const rows = res.rows || [];

  const solIds = [...new Set(rows.map((x) => x.solicitud_id).filter(Boolean))];
  /** Por solicitud: todas las filas (para saber si hay vencida más antigua con saldo). */
  const hermanasPorSolicitud = new Map();
  if (solIds.length > 0) {
    const herRes = await query(
      `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.status, c.amount_due, c.late_fee, c.paid_amount,
              c.num_viajes, c.bono_auto, c.cuota_semanal, c.partner_fees_raw, c.partner_fees_83,
              c.cobro_saldo, c.pct_comision, c.moneda, c.partner_fees_cascada_destino,
              s.fecha_inicio_cobro_semanal
       FROM module_miauto_cuota_semanal c
       INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
       WHERE c.solicitud_id = ANY($1::uuid[])`,
      [solIds]
    );
    for (const h of herRes.rows || []) {
      const k = String(h.solicitud_id);
      if (!hermanasPorSolicitud.has(k)) hermanasPorSolicitud.set(k, []);
      hermanasPorSolicitud.get(k).push(h);
    }
  }
  const todayYForBlocking = limaTodayYmdSync();

  /** Mapa cuota_id → monto cascada recibida (para excluir del cálculo de mora). */
  const cascadeReceivedBySol = new Map();
  for (const [solKey, hRows] of hermanasPorSolicitud) {
    cascadeReceivedBySol.set(solKey, buildCascadeReceivedMap(hRows));
  }

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
    const fiYmd = ymdFromDbDate(row.fecha_inicio_cobro_semanal);
    const canonicalDueYmd =
      wsYmd && /^\d{4}-\d{2}-\d{2}$/.test(wsYmd)
        ? computeDueDateForMiAutoCuota(wsYmd, fiYmd, !!isPrimera)
        : null;
    const patchDue = canonicalDueYmd && /^\d{4}-\d{2}-\d{2}$/.test(String(canonicalDueYmd));
    const dueEffYmd = ymdFromDbDate(patchDue ? canonicalDueYmd : row.due_date);
    if (
      dueEffYmd &&
      dueEffYmd < MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER
    ) {
      if (patchDue) {
        await query(
          `UPDATE module_miauto_cuota_semanal SET due_date = $1::date, late_fee = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [canonicalDueYmd, row.id]
        );
        updated++;
      } else {
        const z = await query(
          `UPDATE module_miauto_cuota_semanal SET late_fee = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND COALESCE(late_fee, 0)::numeric > 0.005`,
          [row.id]
        );
        if (z.rowCount > 0) updated++;
      }
      continue;
    }
    const rowForDerived = patchDue ? { ...row, due_date: canonicalDueYmd } : row;
    const cascRecvMap = cascadeReceivedBySol.get(String(row.solicitud_id));
    const cascRecv = cascRecvMap ? (cascRecvMap.get(String(row.id)) || 0) : 0;
    const d = computeCuotaDerivedForRow(rowForDerived, cronograma, vehId, {
      isPrimeraCuotaSemanal: !!isPrimera,
      fechaInicioCobroSemanal: row.fecha_inicio_cobro_semanal,
      cascadeReceived: cascRecv,
    });
    const lateFeeOut = round2(d.late_fee);
    const lateFeeDb = round2(parseFloat(row.late_fee) || 0);
    const moraFullD = round2(parseFloat(d.mora_full) || 0);
    const moraSchedD = round2(parseFloat(d.mora_sched_periodo) || 0);
    const paidDb = round2(parseFloat(row.paid_amount) || 0);
    const oblig = round2(d.obligacion_total);
    const pendDerived = round2(Math.max(0, oblig - paidDb));
    /** Pendiente según motor (cuota remanente + mora pendiente), no `amount_due` persistido a secas. */
    const pendCols = round2(Math.max(0, d.cuota_final));
    const hermanas = hermanasPorSolicitud.get(String(row.solicitud_id)) || [];
    const hasOlderBlockingDebt = hermanas.some((o) => {
      if (String(o.id) === String(row.id)) return false;
      const wsH = ymdFromDbDate(o.week_start_date);
      const fiH = o.fecha_inicio_cobro_semanal ?? row.fecha_inicio_cobro_semanal;
      const isPH = wsH ? isSemanaDepositoMiAuto(wsH, fiH) : false;
      const cascRecvMapH = cascadeReceivedBySol.get(String(row.solicitud_id));
      const dH = computeCuotaDerivedForRow(o, cronograma, row.cronograma_vehiculo_id, {
        isPrimeraCuotaSemanal: !!isPH,
        fechaInicioCobroSemanal: fiH,
        cascadeReceived: cascRecvMapH ? (cascRecvMapH.get(String(o.id)) || 0) : 0,
      });
      const pendEconHermana = round2(Math.max(0, dH.cuota_final));
      return cuotaHermanaBloqueaPorDeudaMasAntigua(o, dueEffYmd, todayYForBlocking, {
        pendienteEconomico: pendEconHermana,
      });
    });
    const pend = pendienteStatusCuotaAbiertaPostCorte(d, pendDerived, pendCols, { hasOlderBlockingDebt });
    const statusOut = miAutoOpenStatusSaldoVencimiento(dueEffYmd, pend, paidDb);
    const stRow = (row.status || '').toLowerCase();
    /** Cuota pagada: conservar en columna el devengo/histórico; no dejar `late_fee` en 0 si hubo mora del periodo. */
    let lateFeePersist = lateFeeOut;
    if (statusOut === 'paid' && stRow !== 'bonificada') {
      lateFeePersist = round2(Math.max(lateFeeDb, lateFeeOut, moraFullD, moraSchedD));
    }

    await query(
      patchDue
        ? `UPDATE module_miauto_cuota_semanal SET late_fee = $1, status = $4, due_date = $3::date, updated_at = CURRENT_TIMESTAMP WHERE id = $2`
        : `UPDATE module_miauto_cuota_semanal SET late_fee = $1, status = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      patchDue ? [lateFeePersist, row.id, canonicalDueYmd, statusOut] : [lateFeePersist, row.id, statusOut]
    );
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
function calcularRacha(cuotas) {
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
  const cerradaRaw = r.status === 'paid' || r.status === 'bonificada';
  const cerrada = options.ignoreClosedStatusForDerived ? false : cerradaRaw;
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

  const dueYmdRow = ymdFromDbDate(r.due_date);
  /** Vencimiento estrictamente antes del 30-mar-2026: obligación = `amount_due` persistido (p. ej. Excel), sin mora calculada aparte. */
  const legacyExcelObligacionUnica =
    dueYmdRow && dueYmdRow < MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER;

  if (legacyExcelObligacionUnica) {
    const sched = round2(parseFloat(r.amount_due) || 0);
    const paid = round2(parseFloat(r.paid_amount) || 0);
    mora_full = 0;
    late_fee = 0;
    amount_due_sched = sched;
    if (cerrada) {
      amount_due_remaining = 0;
      mOpen = {
        amount_due_sched: sched,
        mora_full: 0,
        mora_sched: 0,
        late_fee_remaining: 0,
        amount_due_remaining: 0,
        obligacion_total_open: round2(sched),
      };
    } else {
      amount_due_remaining = round2(Math.max(0, sched - paid));
      mOpen = {
        amount_due_sched: sched,
        mora_full: 0,
        mora_sched: 0,
        late_fee_remaining: 0,
        amount_due_remaining,
        obligacion_total_open: round2(amount_due_remaining + paid),
      };
    }
  } else if (cerrada && usoCronogramaParaMontos) {
    mOpen = amountDueAndLateForOpen(
      cronograma,
      rForFees,
      cuota_semanal,
      bono_auto,
      pct_comision,
      cobro_saldo,
      isPrimera,
      options.cascadeReceived
    );
    mora_full = round2(mOpen.mora_full);
    amount_due_sched = round2(mOpen.amount_due_sched);
    amount_due_remaining = 0;
    late_fee = 0;
  } else if (!cerrada) {
    mOpen = amountDueAndLateForOpen(
      cronograma,
      rForFees,
      cuota_semanal,
      bono_auto,
      pct_comision,
      cobro_saldo,
      isPrimera,
      options.cascadeReceived
    );
    mora_full = round2(mOpen.mora_full);
    amount_due_sched = round2(mOpen.amount_due_sched);
    amount_due_remaining = mOpen.amount_due_remaining;
    late_fee = debeAplicarMoraCuotaSemanal(r.status)
      ? mOpen.late_fee_remaining
      : 0;
  }

  const cuota_neta = round2(Math.max(0, cuota_semanal - pf83));
  /** Tope de la deuda del periodo (cuota programada + mora generada), sin descontar pagos — para cap de paid_amount / persist. */
  const obligacion_total = mOpen
    ? round2(
        mOpen.obligacion_total_open != null && Number.isFinite(Number(mOpen.obligacion_total_open))
          ? mOpen.obligacion_total_open
          : mOpen.amount_due_sched + mOpen.mora_full
      )
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
    /** Interés devengado del periodo sobre capital pendiente tras abonos a cuota (días × tasa). */
    mora_sched_periodo: mOpen ? round2(parseFloat(mOpen.mora_sched) || 0) : 0,
  };
}

export function parsePartnerFeesCascadaDestinoDb(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Mapa cuota_id → monto total recibido vía cascada PF desde otras cuotas.
 * Se usa para excluir la cascada del cálculo de mora (la mora debe calcularse
 * sobre el capital pendiente según el pago real del conductor, no la cascada).
 */
function buildCascadeReceivedMap(cuotaRows) {
  const map = new Map();
  for (const r of cuotaRows) {
    const entries = parsePartnerFeesCascadaDestinoDb(r.partner_fees_cascada_destino);
    for (const e of entries) {
      const id = String(e.cuota_semanal_id);
      map.set(id, round2((map.get(id) || 0) + (Number(e.monto) || 0)));
    }
  }
  return map;
}

/**
 * Fila **origen** de cascada de cobro por ingresos: imputó el pool a otras semanas y ya no tiene PF en columna.
 * En ese caso el `paid` en BD no debe cerrar la fila como «cuota pagada» si solo se descontó/reasignó el tributo:
 * la obligación se recalcula como cuota abierta (plan sin crédito PF en esta fila).
 */
export function esOrigenCascadaCobroIngresosSinPfEnFila(r) {
  const dest = parsePartnerFeesCascadaDestinoDb(r.partner_fees_cascada_destino);
  if (!dest.length) return false;
  const raw = round2(parseFloat(r.partner_fees_raw) || 0);
  const p83 = round2(parseFloat(r.partner_fees_83) || 0);
  return raw <= 0.02 && p83 <= 0.02;
}

function buildCuotaSemanalApiRow(r, cronograma, vehId, options = {}) {
  const isPrimera = options.isPrimeraCuotaSemanal === true;
  const fi = options.fechaInicioCobroSemanal ?? r.fecha_inicio_cobro_semanal;
  const wsR = ymdFromDbDate(r.week_start_date);
  const yangoCerrada = wsR ? isWeekYangoClosedForMiAutoCuotaMetrics(wsR, fi) : false;
  const sinViajesYango = isPrimera || !yangoCerrada;
  const st = (r.status || '').toLowerCase();
  const ignoreClosedForDerived = st === 'paid' && esOrigenCascadaCobroIngresosSinPfEnFila(r);
  const d = computeCuotaDerivedForRow(r, cronograma, vehId, {
    isPrimeraCuotaSemanal: isPrimera,
    fechaInicioCobroSemanal: fi,
    ignoreClosedStatusForDerived: ignoreClosedForDerived,
    cascadeReceived: options.cascadeReceived,
  });
  let paid_amount = round2(parseFloat(r.paid_amount) || 0);
  const filaCerrada = (st === 'paid' || st === 'bonificada') && !ignoreClosedForDerived;
  /**
   * Solo en **pagada/bonificada**: acotar `paid_amount` API a la obligación del periodo derivada.
   * En **vencida / parcial / pendiente**: no recortar — la columna «Pagado» debe reflejar el abono real en BD aunque el derivado difiera.
   */
  const capPagadoApi =
    d.obligacion_total > 0.005
      ? d.obligacion_total
      : round2(parseFloat(r.amount_due) || 0) + round2(parseFloat(r.late_fee) || 0);
  if (filaCerrada && capPagadoApi > 0.005) {
    paid_amount = round2(Math.min(paid_amount, capPagadoApi));
  }
  /** Columna cronograma “cobro del saldo”: valor persistido en la fila (regla al generar la cuota), no el recalculado del cronograma actual. */
  const cobroSaldoDesdeFila = round2(parseFloat(r.cobro_saldo) || 0);
  /**
   * `amount_due` API: derivado; `paid_amount` en pagada/bonificada = BD (acotado arriba), no `obligacion_total` + mora teórica.
   * `pending_total`: saldo pendiente de esa cuota (sin mora).
   */
  const amountDueApi = round2(d.amount_due_sched);
  const lateFeeColDb = round2(parseFloat(r.late_fee) || 0);
  const moraFullDer = round2(parseFloat(d.mora_full) || 0);
  const moraSchedDer = round2(parseFloat(d.mora_sched_periodo) || 0);
  /** `paid`: mostrar mora devengada/histórica en columna aunque el saldo esté cubierto. `bonificada`: sin mora. */
  const lateFeeHistoricaPagada =
    filaCerrada && st !== 'bonificada'
      ? round2(Math.max(lateFeeColDb, moraFullDer, moraSchedDer))
      : round2(0);
  /** `mora_pendiente`: saldo mora económico. `late_fee` API: pendiente, devengo si no hay pendiente, o histórico si fila pagada. */
  const lateFeePendiente = filaCerrada ? round2(0) : round2(d.late_fee);
  const moraSchedApi = filaCerrada ? round2(0) : moraSchedDer;
  const lateFeeApi = filaCerrada
    ? lateFeeHistoricaPagada
    : lateFeePendiente > 0.005
      ? lateFeePendiente
      : moraSchedApi > 0.005
        ? moraSchedApi
        : round2(0);
  const moraInteresPeriodoApi = filaCerrada
    ? st === 'bonificada'
      ? round2(0)
      : lateFeeHistoricaPagada
    : moraSchedDer;
  const lateFeeCalendarDays = filaCerrada ? 0 : calendarDaysLateLima(r.due_date);
  const cuotaFinalApi = filaCerrada ? paid_amount : d.cuota_final;
  const pendingTotalApi = filaCerrada ? round2(0) : round2(Math.max(0, d.amount_due_remaining));
  let statusApi = r.status;
  if (!filaCerrada) {
    const pendDerived = round2(Math.max(0, d.obligacion_total - paid_amount));
    /** Pendiente según motor (`cuota_final`), no columnas `amount_due`+mora crudas. */
    const pendCols = round2(Math.max(0, d.cuota_final));
    const pendStat = pendienteStatusCuotaAbiertaPostCorte(d, pendDerived, pendCols, {
      hasOlderBlockingDebt: !!options.hasOlderBlockingDebt,
    });
    const dueYStat = ymdFromDbDate(r.due_date);
    statusApi = miAutoOpenStatusSaldoVencimiento(dueYStat, pendStat, paid_amount);
  }
  const yangoRawCol =
    r.partner_fees_yango_raw != null && String(r.partner_fees_yango_raw).trim() !== ''
      ? round2(parseFloat(r.partner_fees_yango_raw) || 0)
      : null;
  const yangoRawPara83 =
    yangoRawCol != null && yangoRawCol > 0.005
      ? yangoRawCol
      : round2(parseFloat(r.partner_fees_raw) || 0);
  const partnerFeesYango83Api = sinViajesYango ? 0 : round2(yangoRawPara83 * PARTNER_FEES_PCT);
  const partnerFeesCascadaApi = sinViajesYango
    ? []
    : cascadaDestinoExcluirCuotaOrigen(
        parsePartnerFeesCascadaDestinoDb(r.partner_fees_cascada_destino),
        r.id
      );
  const tcOpt = options.tipoCambioUsd;
  const refUsdPen =
    d.moneda === 'USD' && tcOpt?.valorUsdALocal > 0
      ? {
          tipo_cambio_ref: {
            valor_usd_a_local: tcOpt.valorUsdALocal,
            moneda_local: tcOpt.monedaLocal,
          },
          /** Con `paid_amount` en USD: equivalente aproximado en moneda local Fleet (PEN/COP). */
          paid_amount_equivalente_moneda_local: round2(paid_amount * tcOpt.valorUsdALocal),
        }
      : {};
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
    mora_pendiente: lateFeePendiente,
    late_fee_calendar_days: lateFeeCalendarDays,
    mora_interes_periodo: moraInteresPeriodoApi,
    status: statusApi,
    moneda: d.moneda,
    pct_comision: d.pct_comision,
    cobro_saldo: cobroSaldoDesdeFila,
    /** Tras cascada: remanente imputable a esta fila (0 si todo el pool fue a cuotas anteriores). */
    partner_fees_raw: sinViajesYango ? 0 : round2(parseFloat(r.partner_fees_raw) || 0),
    /** 83,33% del `partner_fees_raw` de la fila (coherente con cuota neta / Fleet). */
    partner_fees_83: d.pf83,
    /** Monto bruto reportado por Yango para esta semana (auditoría; puede ser > 0 aunque `partner_fees_raw` sea 0). */
    partner_fees_yango_raw: sinViajesYango ? null : yangoRawCol,
    /** 83,33% sobre `partner_fees_yango_raw` (o sobre raw si aún no hay columna yango). */
    partner_fees_yango_83: partnerFeesYango83Api,
    /** Imputación del pool PF+comisión a otras filas: `{ cuota_semanal_id, week_start_date, monto }[]`. */
    partner_fees_cascada_aplicado_a: partnerFeesCascadaApi,
    cuota_neta: d.cuota_neta,
    cuota_final: cuotaFinalApi,
    /** Saldo pendiente de cuota (sin mora). */
    pending_total: pendingTotalApi,
    ...refUsdPen,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Recorta paid_amount si supera la obligación del periodo (`obligacion_total`) tras cambio de tramo de viajes (tras updateMoraDiaria).
 * @param {string} solicitudId
 * @param {{ onlyCapDueBeforeYmd?: string }} [options] Si `onlyCapDueBeforeYmd` es `YYYY-MM-DD`, solo se ajustan filas con `due_date` estrictamente anterior (no toca >= esa fecha; p. ej. carga Excel pre-corte).
 */
export async function persistPaidAmountCapsForSolicitud(solicitudId, options = {}) {
  const capCutoff = options.onlyCapDueBeforeYmd;
  const capCutoffOk = capCutoff && /^\d{4}-\d{2}-\d{2}$/.test(String(capCutoff).trim().slice(0, 10));
  const capCutNorm = capCutoffOk ? String(capCutoff).trim().slice(0, 10) : null;

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
            partner_fees_raw, partner_fees_83, partner_fees_cascada_destino,
            created_at, updated_at
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1 ORDER BY due_date ASC`,
    [solicitudId]
  );

  const rowsAll = res.rows || [];
  const fiRaw = solRow.fecha_inicio_cobro_semanal;
  const todayYBlocking = limaTodayYmdSync();
  const cascRecvMap = buildCascadeReceivedMap(rowsAll);

  let updated = 0;
  let realignedOrigenCascada = false;
  for (const r of rowsAll) {
    const st = (r.status || '').toLowerCase();
    if (st === 'bonificada') continue;

    if (capCutNorm) {
      const dueY = ymdFromDbDate(r.due_date);
      if (!dueY || dueY >= capCutNorm) continue;
    }

    const w = ymdFromDbDate(r.week_start_date);
    const isPrimera = w ? isSemanaDepositoMiAuto(w, fiRaw) : false;
    const d = computeCuotaDerivedForRow(r, cronograma, vehId, {
      isPrimeraCuotaSemanal: isPrimera,
      fechaInicioCobroSemanal: fiRaw,
      cascadeReceived: cascRecvMap.get(String(r.id)) || 0,
    });
    const paidDb = round2(parseFloat(r.paid_amount) || 0);
    const rawOblig = d.obligacion_total;
    /** Igual que `buildCuotaSemanalApiRow`: si la obligación derivada ~0, usar fila BD para no borrar abonos al abrir cuotas. */
    const cap =
      rawOblig > 0.005
        ? rawOblig
        : round2(parseFloat(r.amount_due) || 0) + round2(parseFloat(r.late_fee) || 0);
    if (cap <= 0.005 && paidDb > 0.005) continue;
    if (paidDb <= cap + 0.005) continue;

    const paidNew = round2(Math.min(paidDb, cap));
    const pendCap = round2(Math.max(0, cap - paidNew));
    let statusOut = miAutoOpenStatusSaldoVencimiento(ymdFromDbDate(r.due_date), pendCap, paidNew);
    if (cap <= 0.005 && paidNew <= 0.005) {
      statusOut = 'pending';
    }

    await query(
      `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [paidNew, statusOut, r.id]
    );
    updated++;
  }

  /** Origen de cascada con PF en 0: no dejar `paid` en BD si la obligación abierta aún tiene saldo (p. ej. abono mal imputado al descontar solo el cobro por ingresos). */
  for (const r of rowsAll) {
    const st = (r.status || '').toLowerCase();
    if (st !== 'paid' || !esOrigenCascadaCobroIngresosSinPfEnFila(r)) continue;

    if (capCutNorm) {
      const dueY = ymdFromDbDate(r.due_date);
      if (!dueY || dueY >= capCutNorm) continue;
    }

    const w = ymdFromDbDate(r.week_start_date);
    const isPrimera = w ? isSemanaDepositoMiAuto(w, fiRaw) : false;
    const dueR = ymdFromDbDate(r.due_date);
    const hasOlderBlockingDebt = rowsAll.some((o) => {
      if (String(o.id) === String(r.id)) return false;
      const wO = ymdFromDbDate(o.week_start_date);
      const isPO = wO ? isSemanaDepositoMiAuto(wO, fiRaw) : false;
      const dH = computeCuotaDerivedForRow(o, cronograma, vehId, {
        isPrimeraCuotaSemanal: !!isPO,
        fechaInicioCobroSemanal: fiRaw,
        cascadeReceived: cascRecvMap.get(String(o.id)) || 0,
      });
      return cuotaHermanaBloqueaPorDeudaMasAntigua(o, dueR, todayYBlocking, {
        pendienteEconomico: round2(Math.max(0, dH.cuota_final)),
      });
    });
    const dOpen = computeCuotaDerivedForRow(r, cronograma, vehId, {
      isPrimeraCuotaSemanal: isPrimera,
      fechaInicioCobroSemanal: fiRaw,
      ignoreClosedStatusForDerived: true,
      cascadeReceived: cascRecvMap.get(String(r.id)) || 0,
    });
    const paidDb = round2(parseFloat(r.paid_amount) || 0);
    const pendDerived = round2(Math.max(0, dOpen.obligacion_total - paidDb));
    const pendCols = round2(Math.max(0, dOpen.cuota_final));
    const pendStat = pendienteStatusCuotaAbiertaPostCorte(dOpen, pendDerived, pendCols, { hasOlderBlockingDebt });
    const statusRe = miAutoOpenStatusSaldoVencimiento(ymdFromDbDate(r.due_date), pendStat, paidDb);
    if (statusRe === 'paid') continue;

    await query(
      `UPDATE module_miauto_cuota_semanal SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [statusRe, r.id]
    );
    updated++;
    realignedOrigenCascada = true;
  }
  if (realignedOrigenCascada) {
    await updateMoraDiaria(solicitudId, { includePartial: true });
  }
  if (updated > 0) {
    logger.info(`Yego Mi Auto: ${updated} ajuste(s) de tope/estado en cuota(s), solicitud ${solicitudId}`);
  }
  return updated;
}

/**
 * Cuotas API + bonificadas desde solicitud (un solo SELECT a `module_miauto_solicitud`).
 * @returns {{ cuotas: object[], bonificadas_db: number }}
 */
async function fetchCuotasSemanalesPayload(solicitudId) {
  const solRes = await query(
    `SELECT cronograma_id, cronograma_vehiculo_id, fecha_inicio_cobro_semanal, country,
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
  const countrySol = String(solRow.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
  const tipoCambioUsd = await tipoCambioUsdALocalEfectivo(countrySol);

  const res = await query(
    `SELECT id, solicitud_id, week_start_date, due_date, num_viajes, bono_auto, cuota_semanal, amount_due, paid_amount, late_fee, status, moneda, pct_comision, cobro_saldo,
            partner_fees_raw, partner_fees_83, partner_fees_yango_raw, partner_fees_cascada_destino,
            created_at, updated_at
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1
     ORDER BY week_start_date ASC NULLS LAST, due_date ASC NULLS LAST, id ASC`,
    [solicitudId]
  );
  const vehId = solRow.cronograma_vehiculo_id;
  const fiRaw = solRow.fecha_inicio_cobro_semanal;
  const bonificadas_db = parseInt(solRow.cuotas_semanales_bonificadas, 10) || 0;

  const rows = res.rows || [];
  const todayYBlocking = limaTodayYmdSync();
  const cascRecvMap = buildCascadeReceivedMap(rows);
  const cuotas = [];
  for (const r of rows) {
    const w = ymdFromDbDate(r.week_start_date);
    const isPrimera = w ? isSemanaDepositoMiAuto(w, fiRaw) : false;
    const rNorm = await cuotaRowWithPartnerFeesUsdNormalizedIfNeeded(solicitudId, r);
    const dueR = ymdFromDbDate(rNorm.due_date);
    const hasOlderBlockingDebt = rows.some((o) => {
      if (String(o.id) === String(rNorm.id)) return false;
      const wO = ymdFromDbDate(o.week_start_date);
      const isPO = wO ? isSemanaDepositoMiAuto(wO, fiRaw) : false;
      const dH = computeCuotaDerivedForRow(o, cronograma, vehId, {
        isPrimeraCuotaSemanal: !!isPO,
        fechaInicioCobroSemanal: fiRaw,
        cascadeReceived: cascRecvMap.get(String(o.id)) || 0,
      });
      return cuotaHermanaBloqueaPorDeudaMasAntigua(o, dueR, todayYBlocking, {
        pendienteEconomico: round2(Math.max(0, dH.cuota_final)),
      });
    });
    cuotas.push(
      buildCuotaSemanalApiRow(rNorm, cronograma, vehId, {
        isPrimeraCuotaSemanal: isPrimera,
        fechaInicioCobroSemanal: fiRaw,
        tipoCambioUsd,
        hasOlderBlockingDebt,
        cascadeReceived: cascRecvMap.get(String(rNorm.id)) || 0,
      })
    );
  }
  return { cuotas, bonificadas_db };
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
 * retirándose saldo Yango en orden **semana más antigua → más reciente** (`week_start_date`, luego `due_date`, `id`).
 */
export async function getCuotasToCharge() {
  const res = await query(
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.status,
            c.cuota_semanal, c.bono_auto, c.cobro_saldo, c.pct_comision, c.partner_fees_raw, c.moneda,
            s.cronograma_id, s.fecha_inicio_cobro_semanal,
            rd.id AS driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.driver_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.external_driver_id::text, '')), '')) AS external_driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.park_id::text, '')), '')) AS park_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.first_name::text, '')), ''), rd.first_name) AS first_name,
            COALESCE(NULLIF(TRIM(COALESCE(fl.last_name::text, '')), ''), rd.last_name) AS last_name,
            s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     LEFT JOIN LATERAL (
       SELECT d.driver_id, d.park_id, d.first_name, d.last_name
       FROM drivers d
       WHERE TRIM(COALESCE(d.park_id::text, '')) = $1
         AND d.work_status = 'working'
         AND (
           LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g'))
           OR (
             REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                 REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g')
             AND REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g') <> ''
           )
         )
       ORDER BY
         CASE WHEN LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g')) THEN 0 ELSE 1 END,
         d.driver_id::text
       LIMIT 1
     ) fl ON true
     WHERE c.status IN ('pending', 'overdue', 'partial')
       AND (c.amount_due + COALESCE(c.late_fee, 0) - COALESCE(c.paid_amount, 0)) > 0
       AND COALESCE(NULLIF(TRIM(COALESCE(fl.driver_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.external_driver_id::text, '')), '')) IS NOT NULL
       AND COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.park_id::text, '')), '')) IS NOT NULL
     ORDER BY c.solicitud_id, c.week_start_date ASC NULLS LAST, c.due_date ASC NULLS LAST, c.id ASC`,
    [MIAUTO_PARK_ID]
  );
  return res.rows || [];
}

/** Misma fila y orden que `getCuotasToCharge`, filtrado a una solicitud (scripts / dry-run del job lunes). */
export async function getCuotasToChargeForSolicitud(solicitudId) {
  const res = await query(
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.status,
            c.cuota_semanal, c.bono_auto, c.cobro_saldo, c.pct_comision, c.partner_fees_raw, c.moneda,
            s.cronograma_id, s.fecha_inicio_cobro_semanal,
            rd.id AS driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.driver_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.external_driver_id::text, '')), '')) AS external_driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.park_id::text, '')), '')) AS park_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.first_name::text, '')), ''), rd.first_name) AS first_name,
            COALESCE(NULLIF(TRIM(COALESCE(fl.last_name::text, '')), ''), rd.last_name) AS last_name,
            s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     LEFT JOIN LATERAL (
       SELECT d.driver_id, d.park_id, d.first_name, d.last_name
       FROM drivers d
       WHERE TRIM(COALESCE(d.park_id::text, '')) = $2
         AND d.work_status = 'working'
         AND (
           LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g'))
           OR (
             REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                 REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g')
             AND REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g') <> ''
           )
         )
       ORDER BY
         CASE WHEN LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g')) THEN 0 ELSE 1 END,
         d.driver_id::text
       LIMIT 1
     ) fl ON true
     WHERE c.solicitud_id = $1::uuid
       AND c.status IN ('pending', 'overdue', 'partial')
       AND (c.amount_due + COALESCE(c.late_fee, 0) - COALESCE(c.paid_amount, 0)) > 0
       AND COALESCE(NULLIF(TRIM(COALESCE(fl.driver_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.external_driver_id::text, '')), '')) IS NOT NULL
       AND COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.park_id::text, '')), '')) IS NOT NULL
     ORDER BY c.week_start_date ASC NULLS LAST, c.due_date ASC NULLS LAST, c.id ASC`,
    [solicitudId, MIAUTO_PARK_ID]
  );
  return res.rows || [];
}

/**
 * Retiro en fleet y actualización de paid_amount.
 * @param {{ dryRun?: boolean, skipBalanceCheck?: boolean, sharedFleetBalancePEN?: { remaining: number } }} [options]
 *   dryRun: no retira ni actualiza BD; devuelve lo que haría el job (puede consultar saldo API solo lectura).
 *   skipBalanceCheck: en dryRun, no llama a la API de saldo; solo muestra pendiente teórico.
 *   sharedFleetBalancePEN: tope mutable en moneda local Fleet (PEN/COP); una sola consulta saldo por cola — no se cobra más que `remaining` acumulado en la pasada.
 */
export async function processCobroCuota(
  cuotaRow,
  cookieOverride = null,
  parkIdOverride = null,
  options = {}
) {
  const dryRun = !!options.dryRun;
  const skipBalanceCheck = !!options.skipBalanceCheck;
  const sharedFleetCap = options.sharedFleetBalancePEN;
  const driverName = [cuotaRow.first_name, cuotaRow.last_name].filter(Boolean).join(' ').trim() || 'Conductor';
  const amountDue = await effectiveAmountDueForMiAutoFleetRowAsync(cuotaRow);
  const paid = round2(parseFloat(cuotaRow.paid_amount) || 0);
  const lateFee = round2(parseFloat(cuotaRow.late_fee) || 0);
  const pendingAmount = round2(amountDue + lateFee - paid);

  if (pendingAmount <= 0) {
    return { success: true, partial: false, failed: false, reason: 'Sin saldo pendiente', dryRun };
  }

  let externalDriverId = cuotaRow.external_driver_id;
  let parkId = parkIdOverride || cuotaRow.park_id;

  const extMissing = !externalDriverId || String(externalDriverId).trim() === '';
  const parkMissing = !parkId || String(parkId).trim() === '';

  if (extMissing || parkMissing) {
    let resolved = null;
    if (cuotaRow.driver_id) {
      const byRapidin = await query(
        `SELECT d.driver_id, d.park_id
         FROM drivers d
         INNER JOIN module_rapidin_drivers rd ON rd.id = $1::uuid
         WHERE REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
               REGEXP_REPLACE(COALESCE(TRIM(rd.dni), ''), '[^0-9]', '', 'g')
           AND REGEXP_REPLACE(COALESCE(TRIM(rd.dni), ''), '[^0-9]', '', 'g') <> ''
         ORDER BY
           CASE WHEN TRIM(COALESCE(d.park_id::text, '')) = $2 THEN 0
                WHEN TRIM(COALESCE(d.park_id::text, '')) <> '' THEN 1
                ELSE 2 END,
           d.driver_id::text
         LIMIT 1`,
        [cuotaRow.driver_id, MIAUTO_PARK_ID]
      );
      resolved = byRapidin.rows[0] || null;
    }
    if (!resolved && cuotaRow.solicitud_id) {
      const bySol = await query(
        `SELECT fl.driver_id, fl.park_id
         FROM module_miauto_solicitud s
         LEFT JOIN LATERAL (
           SELECT d.driver_id, d.park_id
           FROM drivers d
           WHERE TRIM(COALESCE(d.park_id::text, '')) = $2
             AND d.work_status = 'working'
             AND (
               LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g'))
               OR (
                 REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                     REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g')
                 AND REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g') <> ''
               )
             )
           ORDER BY CASE WHEN LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g')) THEN 0 ELSE 1 END
           LIMIT 1
         ) fl ON true
         WHERE s.id = $1::uuid`,
        [cuotaRow.solicitud_id, MIAUTO_PARK_ID]
      );
      resolved = bySol.rows[0]?.driver_id ? bySol.rows[0] : null;
    }
    if (resolved) {
      if (extMissing) externalDriverId = resolved.driver_id;
      if (parkMissing) parkId = resolved.park_id;
    }
  }

  if (!externalDriverId) {
    logger.warn(`Yego Mi Auto cobro: ${driverName} sin external_driver_id`);
    return { success: false, partial: false, failed: true, reason: 'Sin external_driver_id', dryRun };
  }

  parkId = fleetParkIdForMiAuto(parkId);
  const cookieMiAuto = fleetCookieCobroForMiAuto(cookieOverride);

  let balance = null;
  if (dryRun && skipBalanceCheck) {
    const totalDue = round2(amountDue + lateFee);
    return {
      dryRun: true,
      skipBalanceCheck: true,
      success: true,
      partial: null,
      failed: false,
      driverName,
      solicitud_id: cuotaRow.solicitud_id,
      cuota_id: cuotaRow.id,
      due_date: cuotaRow.due_date,
      week_start_date: cuotaRow.week_start_date,
      status_cuota: cuotaRow.status,
      amount_due: amountDue,
      late_fee: lateFee,
      paid_amount_actual: paid,
      pendiente_en_cuota: pendingAmount,
      balance_fleet_consultado: null,
      retiro_simulado: null,
      nota:
        'Sin consulta API: en el job real se cobraría min(pendiente, saldo_fleet). Pendiente mostrado es el de esta fila.',
      despues_paid_simulado: null,
      despues_status_simulado: null,
    };
  }

  if (
    sharedFleetCap != null &&
    typeof sharedFleetCap.remaining === 'number' &&
    !Number.isNaN(sharedFleetCap.remaining)
  ) {
    balance = round2(Math.max(0, sharedFleetCap.remaining));
    if (balance <= 0) {
      logger.warn(`Yego Mi Auto cobro: ${driverName} sin saldo Fleet (tope de cola agotado, sin nueva consulta API)`);
      return {
        success: false,
        partial: false,
        failed: true,
        reason: 'Sin saldo disponible',
        dryRun,
        balance: 0,
        driverName,
        cuota_id: cuotaRow.id,
        solicitud_id: cuotaRow.solicitud_id,
      };
    }
  } else {
    const balanceResult = await getContractorBalance(externalDriverId, parkId, cookieMiAuto);
    if (!balanceResult.success) {
      logger.warn(`Yego Mi Auto cobro: sin saldo API ${driverName}: ${balanceResult.error}`);
      return {
        success: false,
        partial: false,
        failed: true,
        reason: balanceResult.error,
        dryRun,
        driverName,
        cuota_id: cuotaRow.id,
        solicitud_id: cuotaRow.solicitud_id,
      };
    }

    balance = round2(Math.max(0, Number(balanceResult.balance) || 0));
    if (balance <= 0) {
      logger.warn(`Yego Mi Auto cobro: ${driverName} sin saldo Fleet (balance API=${balance})`);
      return {
        success: false,
        partial: false,
        failed: true,
        reason: 'Sin saldo disponible',
        dryRun,
        balance,
        driverName,
        cuota_id: cuotaRow.id,
        solicitud_id: cuotaRow.solicitud_id,
      };
    }
  }

  /** Saldo Fleet Yango (PE/CO) está en moneda local; cuota puede ser USD → convertir antes de min() y retiro. */
  const monedaCuota = cuotaRow.moneda === 'USD' ? 'USD' : 'PEN';
  const country = String(cuotaRow.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
  const tcEff = await tipoCambioUsdALocalEfectivo(country);
  const valorTc = tcEff.valorUsdALocal;
  const monedaFleetLocal = tcEff.monedaLocal;

  let pendingFleetLocal = pendingAmount;
  if (monedaCuota === 'USD') {
    const conv = convertirMontoEntreMonedas(pendingAmount, 'USD', monedaFleetLocal, valorTc);
    pendingFleetLocal = conv != null ? round2(conv) : round2(pendingAmount);
  }

  const amountToChargeFleet = round2(Math.min(pendingFleetLocal, balance));

  let creditCuotaMoneda = amountToChargeFleet;
  if (monedaCuota === 'USD') {
    const c = convertirMontoEntreMonedas(amountToChargeFleet, monedaFleetLocal, 'USD', valorTc);
    creditCuotaMoneda = c != null ? round2(c) : round2(amountToChargeFleet);
  }

  const totalDue = round2(amountDue + lateFee);
  let newPaid = round2(paid + creditCuotaMoneda);
  newPaid = round2(Math.min(newPaid, totalDue));
  const pendAfter = round2(Math.max(0, totalDue - newPaid));
  const newStatus = miAutoOpenStatusSaldoVencimiento(ymdFromDbDate(cuotaRow.due_date), pendAfter, newPaid);

  if (dryRun) {
    const cobroCompletoEnCuota = creditCuotaMoneda >= pendingAmount - 0.005;
    return {
      dryRun: true,
      success: true,
      partial: !cobroCompletoEnCuota && amountToChargeFleet > 0,
      failed: false,
      driverName,
      solicitud_id: cuotaRow.solicitud_id,
      cuota_id: cuotaRow.id,
      due_date: cuotaRow.due_date,
      week_start_date: cuotaRow.week_start_date,
      status_cuota: cuotaRow.status,
      moneda_cuota: monedaCuota,
      moneda_fleet_retiro: monedaFleetLocal,
      amount_due: amountDue,
      late_fee: lateFee,
      paid_amount_actual: paid,
      pendiente_en_cuota: pendingAmount,
      pendiente_fleet_local: pendingFleetLocal,
      balance_fleet_consultado: balance,
      retiro_simulado_fleet: amountToChargeFleet,
      acreditado_en_cuota: creditCuotaMoneda,
      despues_paid_simulado: newPaid,
      despues_status_simulado: newStatus,
      external_driver_id: externalDriverId,
      park_id_usado: parkId,
      descripcion_retiro_job: 'Cuota Mi Auto',
    };
  }

  let withdrawResult = await withdrawFromContractor(
    externalDriverId,
    amountToChargeFleet.toFixed(2),
    'Cuota Mi Auto',
    cookieMiAuto,
    parkId
  );
  const maxW = fleetWithdrawMaxAttempts();
  const delayMs = fleetWithdrawRetryDelayMs();
  let wAttempt = 0;
  while (
    !withdrawResult.success &&
    wAttempt < maxW - 1 &&
    isFleetOngoingTransactionsError(withdrawResult.message || withdrawResult.error)
  ) {
    wAttempt += 1;
    logger.warn(
      `Yego Mi Auto cobro: retiro ${driverName} transacciones en curso — reintento ${wAttempt}/${maxW - 1} en ${delayMs}ms`
    );
    await new Promise((r) => setTimeout(r, delayMs));
    withdrawResult = await withdrawFromContractor(
      externalDriverId,
      amountToChargeFleet.toFixed(2),
      'Cuota Mi Auto',
      cookieMiAuto,
      parkId
    );
  }

  if (!withdrawResult.success) {
    logger.error(`Yego Mi Auto cobro: retiro ${driverName}: ${withdrawResult.message || withdrawResult.error}`);
    return { success: false, partial: false, failed: true, reason: withdrawResult.message || withdrawResult.error };
  }

  if (sharedFleetCap != null && !dryRun) {
    sharedFleetCap.remaining = round2(Math.max(0, sharedFleetCap.remaining - amountToChargeFleet));
  }

  await query(
    `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [newPaid, newStatus, cuotaRow.id]
  );

  if (creditCuotaMoneda >= pendingAmount - 0.005) {
    logger.info(
      `Yego Mi Auto cobro completo: ${driverName} Fleet ${amountToChargeFleet.toFixed(2)} ${monedaFleetLocal} → +${creditCuotaMoneda.toFixed(2)} ${monedaCuota} pagado`
    );
    return {
      success: true,
      partial: false,
      failed: false,
      amountChargedFleet: amountToChargeFleet,
      amountCreditedCuota: creditCuotaMoneda,
    };
  }
  logger.info(
    `Yego Mi Auto cobro parcial: ${driverName} Fleet ${amountToChargeFleet.toFixed(2)} ${monedaFleetLocal} → +${creditCuotaMoneda.toFixed(2)} ${monedaCuota} (pendiente cuota ${pendingAmount.toFixed(2)} ${monedaCuota})`
  );
  return {
    success: true,
    partial: true,
    failed: false,
    amountChargedFleet: amountToChargeFleet,
    amountCreditedCuota: creditCuotaMoneda,
  };
}

/**
 * Recalcula y persiste en BD `pct_comision`, `cobro_saldo`, `cuota_semanal`, `bono_auto`, `moneda`, `partner_fees_83`
 * y `amount_due` según el cronograma actual y los `num_viajes` / `partner_fees_raw` ya guardados en cada fila.
 * La primera cuota semanal (lunes de la semana de `fecha_inicio_cobro_semanal`) fuerza `num_viajes` 0, `partner_fees_raw` 0 y `bono_auto` 0.
 * Cuotas `paid`: solo actualiza snapshot de la regla (no cambia `amount_due` para no alterar pagos cerrados).
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
    let pfRaw = isFirstCuota || !yangoCerrada ? 0 : round2(Number(row.partner_fees_raw) || 0);
    if (pfRaw > 0.005 && String(plan.moneda || 'PEN').toUpperCase() === 'USD') {
      pfRaw = await partnerFeesRawDbNormalizeUsdFromYangoLocal(
        row.solicitud_id,
        pfRaw,
        plan.cuotaSemanal
      );
    }
    const pf83 = round2(pfRaw * PARTNER_FEES_PCT);
    const useWaterfallGross = !isFirstCuota && yangoCerrada && pfRaw > 0;
    const amountDue = computeAmountDueSemanal({
      cuotaSemanal: plan.cuotaSemanal,
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
