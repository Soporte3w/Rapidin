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

/**
 * Aplica un pool a un conjunto de cuotas (en memoria).
 * Devuelve las imputaciones sin modificar la base de datos.
 *
 * @param {object} params
 * @param {number} params.poolAmount - Monto total del pool a distribuir
 * @param {Array} params.cuotas - Array de cuotas con { id, due_date, amount_due, late_fee, paid_amount, status, pending }
 * @param {string} [params.excludeCuotaId] - ID de la fila origen (no recibe pool)
 * @returns {{ applied: number, remainingPool: number, allocations: Array<{cuotaId, pendingAntes, montoAplicado, pendingDespues, statusDespues}> }}
 */
export function applyWaterfallPool({ poolAmount, cuotas, excludeCuotaId = null }) {
  let pool = round2(Number(poolAmount) || 0);
  const allocations = [];
  let applied = 0;

  if (pool <= 0.005) {
    return { applied: 0, remainingPool: 0, allocations: [] };
  }

  const eligible = cuotas
    .filter((c) => {
      if (excludeCuotaId && String(c.id) === String(excludeCuotaId)) return false;
      const pending = c.pending != null ? round2(c.pending) : round2(
        round2(Number(c.amount_due) || 0) + round2(Number(c.late_fee) || 0) - round2(Number(c.paid_amount) || 0)
      );
      return pending > 0.005;
    })
    .sort((a, b) => {
      // Normalizar due_date a YYYY-MM-DD (viene como objeto Date de pg)
      const na = a.due_date ? new Date(a.due_date).toISOString().slice(0, 10) : '';
      const nb = b.due_date ? new Date(b.due_date).toISOString().slice(0, 10) : '';
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
    let pending = cuota.pending != null
      ? round2(cuota.pending)
      : round2(amountDue + lateFee - paid);

    if (pending <= 0.005) continue;

    const applyAmt = round2(Math.min(pool, pending));
    const newPaid = round2(paid + applyAmt);
    const newPending = round2(Math.max(0, amountDue + lateFee - newPaid));
    const newStatus = newPending <= 0.005 ? 'paid' : (newPaid > 0.005 ? 'partial' : cuota.status);

    allocations.push({
      cuotaId: String(cuota.id),
      weekStartDate: cuota.week_start_date || null,
      dueDate: cuota.due_date,
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

/**
 * Calcula el snap de la fila origen tras aplicar cascada.
 * El remanente del pool que no cupo en cuotas más antiguas se refleja en las columnas de la fila origen.
 *
 * @returns {{ partnerFeesRaw, partnerFees83, partnerFeesYangoRaw, amountDue, saldoFavorConductor }}
 */
export function snapshotOrigenTrasCascada({ remainingPool, pctComision, cuotaSemanal, cobroSaldo }) {
  const rem = round2(Number(remainingPool) || 0);
  const pct = round2(Number(pctComision) || 0);
  const cs = round2(Number(cuotaSemanal) || 0);
  const cobro = round2(Number(cobroSaldo) || 0);
  const obligacionSemana = round2(cs + cobro);

  const remCubreCuota = rem > 0.005 && rem >= obligacionSemana - 0.005;
  const remEfectivo = remCubreCuota ? round2(Math.max(0, rem - obligacionSemana)) : rem;

  const partnerFees83 = round2(remEfectivo);
  const partnerFeesRaw = partnerFees83 > 0.005
    ? round2(partnerFees83 / 0.8333)
    : 0;

  const amountDue = round2(Math.max(0, obligacionSemana - rem));

  return {
    partnerFeesRaw,
    partnerFees83,
    partnerFeesYangoRaw: partnerFeesRaw > 0.005 ? partnerFeesRaw : null,
    amountDue,
    saldoFavorConductor: remCubreCuota ? round2(rem - obligacionSemana) : 0,
    remCubreCuota,
    breakdown: {
      remainingPool: rem,
      obligacionSemana,
      remCubreCuota,
      remEfectivo,
    },
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
      } else {
        map.set(a.cuotaId, {
          cuota_semanal_id: a.cuotaId,
          week_start_date: a.weekStartDate || null,
          monto: a.montoAplicado || 0,
        });
      }
    }
  }
  return [...map.values()].filter((x) => x.monto > 0.005);
}
