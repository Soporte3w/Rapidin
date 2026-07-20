/**
 * Yego Rapidín 4.0 — CascadaPoolManager
 *
 * Gestiona la distribución del pool Partner Fees + Comisión
 * (cascada de cobro por ingresos) hacia cuotas más antiguas.
 *
 * Reglas:
 *   1. El pool se aplica a cuotas con saldo pendiente (pending, overdue, partial)
 *   2. Orden estricto: due_date ASC (deuda más antigua primero)
 *   3. También aplica a cuotas 'paid' mal etiquetadas (underpaid)
 *   4. La fila origen (semana actual) se excluye del reparto
 *   5. Cada imputación tiene trazabilidad completa
 */

import { round2 } from './CuotaCalculator.js';

function limaTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function ymdFromDateLike(v) {
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

function statusTrasCascada(cuota, pendingDespues, paidDespues, todayYmd) {
  if (pendingDespues <= 0.005) return 'paid';
  const dueYmd = ymdFromDateLike(cuota?.due_date);
  if (dueYmd && dueYmd < todayYmd) return 'overdue';
  return paidDespues > 0.005 ? 'partial' : (cuota?.status || 'pending');
}

/** Distribuye un pago sin mezclar el saldo de mora con el capital. */
export function allocatePaymentByPriority({
  payment,
  pendingTotal,
  moraNormal = 0,
  moraExtra = 0,
}) {
  const pending = round2(Math.max(0, Number(pendingTotal) || 0));
  const applied = round2(Math.min(Math.max(0, Number(payment) || 0), pending));
  const normalBefore = round2(Math.min(Math.max(0, Number(moraNormal) || 0), pending));
  const extraBefore = round2(Math.min(
    Math.max(0, Number(moraExtra) || 0),
    Math.max(0, pending - normalBefore)
  ));
  const capitalBefore = round2(Math.max(0, pending - normalBefore - extraBefore));

  const normalApplied = round2(Math.min(applied, normalBefore));
  const afterNormal = round2(Math.max(0, applied - normalApplied));
  const extraApplied = round2(Math.min(afterNormal, extraBefore));
  const capitalApplied = round2(Math.min(
    Math.max(0, afterNormal - extraApplied),
    capitalBefore
  ));

  return {
    applied,
    pendingAfter: round2(Math.max(0, pending - applied)),
    moraNormalApplied: normalApplied,
    moraNormalAfter: round2(Math.max(0, normalBefore - normalApplied)),
    moraExtraApplied: extraApplied,
    moraExtraAfter: round2(Math.max(0, extraBefore - extraApplied)),
    capitalApplied,
    capitalAfter: round2(Math.max(0, capitalBefore - capitalApplied)),
  };
}

/** Evita volver a imputar contra capital la parte del pago que ya cubrio mora extra. */
export function paymentApplicableToBaseAfterSettledExtra({
  paidAmount,
  moraExtra,
  moraExtraTotal,
}) {
  const paid = round2(Math.max(0, Number(paidAmount) || 0));
  const extraPending = round2(Math.max(0, Number(moraExtra) || 0));
  const extraHistorical = round2(Math.max(
    extraPending,
    Number(moraExtraTotal) || 0
  ));
  const extraSettled = round2(Math.max(0, extraHistorical - extraPending));
  return round2(Math.max(0, paid - extraSettled));
}

/**
 * Aplica un pool a un conjunto de cuotas (en memoria).
 * Devuelve las imputaciones sin modificar la base de datos.
 *
 * @param {object} params
 * @param {number} params.poolAmount - Monto total del pool a distribuir
 * @param {Array} params.cuotas - Array de cuotas con { id, due_date, amount_due, late_fee, mora_extra, mora_extra_total, paid_amount, status, pending, montos_fuente }
 * @param {string} [params.excludeCuotaId] - ID de la fila origen (no recibe pool)
 * @returns {{ applied: number, remainingPool: number, allocations: Array<{cuotaId, pendingAntes, montoAplicado, pendingDespues, statusDespues}> }}
 */
export function applyWaterfallPool({ poolAmount, cuotas, excludeCuotaId = null }) {
  let pool = round2(Number(poolAmount) || 0);
  const allocations = [];
  let applied = 0;
  const todayYmd = limaTodayYmd();

  if (pool <= 0.005) {
    return { applied: 0, remainingPool: 0, allocations: [] };
  }

  const eligible = cuotas
    .filter((c) => {
      if (excludeCuotaId && String(c.id) === String(excludeCuotaId)) return false;
      const pending = c.pending != null ? round2(c.pending) : round2(
        round2(Number(c.amount_due) || 0)
          + round2(Number(c.late_fee) || 0)
          + round2(Number(c.mora_extra) || 0)
          - round2(Number(c.paid_amount) || 0)
      );
      return pending > 0.005;
    })
    .sort((a, b) => {
      // Normalizar due_date a YYYY-MM-DD (viene como objeto Date de pg)
      const na = ymdFromDateLike(a.due_date) || '';
      const nb = ymdFromDateLike(b.due_date) || '';
      if (na && nb) return na.localeCompare(nb);
      if (na) return -1;
      if (nb) return 1;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });

  for (const cuota of eligible) {
    if (pool <= 0.005) break;

    const paid = round2(Number(cuota.paid_amount) || 0);
    const amountDue = round2(Number(cuota.amount_due) || 0);
    const lateFee = round2(Number(cuota.late_fee) || 0);
    const moraExtra = round2(Number(cuota.mora_extra) || 0);
    let pending = cuota.pending != null
      ? round2(cuota.pending)
      : round2(amountDue + lateFee + moraExtra - paid);

    if (pending <= 0.005) continue;

    const allocation = allocatePaymentByPriority({
      payment: pool,
      pendingTotal: pending,
      moraNormal: lateFee,
      moraExtra,
    });
    const applyAmt = allocation.applied;
    const newPaid = round2(paid + applyAmt);
    const newPending = allocation.pendingAfter;
    const newStatus = statusTrasCascada(cuota, newPending, newPaid, todayYmd);
    const montosFuenteExcel = String(cuota.montos_fuente || '').trim().toLowerCase() === 'excel';
    const moraExtraDespues = montosFuenteExcel
      ? allocation.moraExtraAfter
      : moraExtra;
    const moraExtraAplicada = montosFuenteExcel
      ? allocation.moraExtraApplied
      : 0;
    const moraExtraTotal = round2(Math.max(
      Number(cuota.mora_extra_total) || 0,
      moraExtra
    ));

    allocations.push({
      cuotaId: String(cuota.id),
      weekStartDate: cuota.week_start_date || null,
      dueDate: cuota.due_date,
      amountDue,
      lateFee,
      moraExtra,
      moraExtraTotal,
      moraNormalBase: lateFee,
      moraExtraBase: moraExtra,
      moraNormalAplicada: allocation.moraNormalApplied,
      moraExtraAplicada,
      moraExtraDespues,
      capitalAplicado: allocation.capitalApplied,
      montosFuenteExcel,
      pendingAntes: pending,
      montoAplicado: applyAmt,
      pendingDespues: newPending,
      paidAntes: paid,
      paidDespues: newPaid,
      statusAntes: cuota.status,
      statusDespues: newStatus,
    });

    applied = round2(applied + applyAmt);
    pool = round2(pool - applyAmt);
  }

  return {
    applied,
    remainingPool: pool,
    allocations,
  };
}

/** Reserva el remanente del recaudo para la cuota actual y devuelve el excedente. */
export function applyPoolToCurrentWeeklyCharge({ poolAmount, cuotaSemanal, cobroSaldo }) {
  const pool = round2(Math.max(0, Number(poolAmount) || 0));
  const obligation = round2(
    Math.max(0, Number(cuotaSemanal) || 0) + Math.max(0, Number(cobroSaldo) || 0)
  );
  const applied = round2(Math.min(pool, obligation));

  return {
    applied,
    amountDue: round2(Math.max(0, obligation - applied)),
    remainingPool: round2(Math.max(0, pool - applied)),
    obligation,
  };
}

/**
 * Fusiona múltiples listas de imputaciones por cuota_semanal_id.
 */
export function mergeCascadaAllocations(allocLists) {
  const map = new Map();
  for (const list of allocLists) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!a || !a.cuotaId) continue;
      const existing = map.get(a.cuotaId);
      if (existing) {
        existing.montoAplicado = round2(existing.montoAplicado + (a.montoAplicado || 0));
        existing.mora_extra_aplicada = round2(
          existing.mora_extra_aplicada + (a.moraExtraAplicada || 0)
        );
        existing.mora_normal_aplicada = round2(
          existing.mora_normal_aplicada + (a.moraNormalAplicada || 0)
        );
        existing.capital_aplicado = round2(
          existing.capital_aplicado + (a.capitalAplicado || 0)
        );
        if (a.montosFuenteExcel) {
          existing.mora_extra_pendiente_despues = round2(a.moraExtraDespues || 0);
        }
      } else {
        map.set(a.cuotaId, {
          cuota_semanal_id: a.cuotaId,
          week_start_date: a.weekStartDate || null,
          monto: a.montoAplicado || 0,
          mora_normal_base: a.moraNormalBase || 0,
          mora_extra_base: a.moraExtraBase || 0,
          mora_normal_aplicada: a.moraNormalAplicada || 0,
          mora_extra_aplicada: a.moraExtraAplicada || 0,
          capital_aplicado: a.capitalAplicado || 0,
          ...(a.montosFuenteExcel
            ? { mora_extra_pendiente_despues: round2(a.moraExtraDespues || 0) }
            : {}),
        });
      }
    }
  }
  return [...map.values()].filter((x) => x.monto > 0.005);
}
