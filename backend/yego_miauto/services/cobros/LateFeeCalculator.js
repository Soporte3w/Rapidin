/**
 * Yego Rapidín 4.0 — LateFeeCalculator
 *
 * Cálculo de mora (late fee) para cuotas Mi Auto.
 * Funciones PURAS — no hacen UPDATE.
 *
 * Reglas:
 *   - Tasa anual de mora definida en cronograma (tasa_interes_mora)
 *   - Tasa diaria = tasa_anual / 7  (semanal / 7 días)
 *   - Mora diaria = capital_moroso * tasa_diaria
 *   - Total mora = mora_diaria * días_atraso
 *   - Días de atraso: días civiles desde vencimiento hasta hoy (Lima)
 *   - El día de vencimiento cuenta como 0 días
 *   - Tope configurable: MORA_MAX_DIAS_ACUMULACION
 *   - Imputación de pagos: primero se cubre la mora, luego el capital
 */

import { round2 } from './CuotaCalculator.js';

const MORA_MAX_DIAS_ACUMULACION = null;

/**
 * Calcula los días civiles de atraso (Lima).
 * @param {string} dueYmd - Fecha de vencimiento YYYY-MM-DD
 * @param {string} todayYmd - Fecha de hoy YYYY-MM-DD (Lima)
 * @returns {number} Días de atraso (0 si no ha vencido)
 */
export function calendarDaysLate(dueYmd, todayYmd) {
  if (!dueYmd || !todayYmd) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(todayYmd)) return 0;
  if (dueYmd >= todayYmd) return 0;

  const [dy, dm, dd] = dueYmd.split('-').map(Number);
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const due = Date.UTC(dy, dm - 1, dd);
  const today = Date.UTC(ty, tm - 1, td);
  return Math.max(0, Math.round((today - due) / (24 * 60 * 60 * 1000)));
}

/**
 * Calcula la mora para una cuota.
 *
 * @param {object} params
 * @param {number} params.tasaInteresMora - Tasa de interés de mora del cronograma (ej. 0.15 = 15%)
 * @param {string} params.dueDateYmd - Fecha de vencimiento YYYY-MM-DD
 * @param {string} params.todayYmd - Fecha de hoy YYYY-MM-DD (Lima)
 * @param {number} params.capitalMoroso - Capital sobre el que corre la mora (cuota bruta del plan)
 * @param {number} [params.maxDays] - Tope máximo de días de acumulación
 * @returns {{ moraTotal, tasaDiaria, diasAtraso, moraDiaria, breakdown }}
 */
export function computeLateFee({ tasaInteresMora, dueDateYmd, todayYmd, capitalMoroso, maxDays = null }) {
  const tasa = round2(Number(tasaInteresMora) || 0);
  const capital = round2(Math.max(0, Number(capitalMoroso) || 0));

  if (tasa <= 0 || capital <= 0) {
    return {
      moraTotal: 0,
      tasaDiaria: 0,
      diasAtraso: 0,
      moraDiaria: 0,
      breakdown: { motivo: 'sin_mora', tasa, capital },
    };
  }

  let diasAtraso = calendarDaysLate(dueDateYmd, todayYmd);
  if (maxDays != null && Number.isFinite(maxDays) && maxDays > 0) {
    diasAtraso = Math.min(diasAtraso, maxDays);
  }
  if (diasAtraso <= 0) {
    return {
      moraTotal: 0,
      tasaDiaria: 0,
      diasAtraso: 0,
      moraDiaria: 0,
      breakdown: { motivo: 'no_vencida_o_hoy', dueDateYmd, todayYmd },
    };
  }

  const tasaDiaria = round2(tasa / 7);
  const moraDiaria = round2(capital * tasaDiaria);
  const moraTotal = round2(moraDiaria * diasAtraso);

  return {
    moraTotal,
    tasaDiaria,
    diasAtraso,
    moraDiaria,
    breakdown: {
      formula: `${capital} * (${tasa} / 7) * ${diasAtraso}`,
      capital,
      tasaAnual: tasa,
      tasaDiaria,
      moraDiaria,
      diasAtraso,
      maxDays: maxDays || 'sin_tope',
    },
  };
}

/**
 * Imputa un pago/abono según la regla: primero mora, luego capital.
 *
 * @param {number} paidAmount - Monto abonado total
 * @param {number} moraFull - Mora devengada total del periodo
 * @param {number} amountDueSched - Cuota programada (capital)
 * @returns {{ lateFeeRemaining, amountDueRemaining, appliedToMora, appliedToCapital }}
 */
export function imputarPagoMoraPrimero(paidAmount, moraFull, amountDueSched) {
  const paid = round2(Number(paidAmount) || 0);
  const mf = round2(Number(moraFull) || 0);
  const sched = round2(Number(amountDueSched) || 0);

  if (mf > 0.005) {
    const appliedToMora = round2(Math.min(paid, mf));
    const appliedToCapital = round2(Math.max(0, paid - appliedToMora));
    return {
      lateFeeRemaining: round2(Math.max(0, mf - appliedToMora)),
      amountDueRemaining: round2(Math.max(0, sched - appliedToCapital)),
      appliedToMora,
      appliedToCapital,
      breakdown: {
        regla: 'mora_primero',
        paid,
        moraFull: mf,
        amountDueSched: sched,
        aplicado_mora: appliedToMora,
        aplicado_capital: appliedToCapital,
      },
    };
  }

  return {
    lateFeeRemaining: 0,
    amountDueRemaining: round2(Math.max(0, sched - paid)),
    appliedToMora: 0,
    appliedToCapital: round2(Math.min(paid, sched)),
    breakdown: {
      regla: 'solo_capital_sin_mora',
      paid,
      moraFull: mf,
      amountDueSched: sched,
    },
  };
}

/**
 * Calcula la mora sobre saldo de capital pendiente (segunda fase).
 * Se aplica cuando ya se cubrió la mora sobre la cuota bruta y hubo abono parcial a capital.
 *
 * @param {object} params
 * @param {number} params.capitalPendiente - Saldo de capital aún pendiente tras abono
 * @param {string} params.fechaReferenciaYmd - Fecha del último abono o primer comprobante (Lima)
 * @param {string} params.todayYmd - Hoy Lima
 * @param {number} params.tasaInteresMora - Tasa de mora del cronograma
 * @returns {{ moraSaldoTotal, diasDesdeReferencia, breakdown }}
 */
export function computeLateFeeOnRemainingCapital({ capitalPendiente, fechaReferenciaYmd, todayYmd, tasaInteresMora }) {
  const capital = round2(Number(capitalPendiente) || 0);
  if (capital <= 0.005) return { moraSaldoTotal: 0, diasDesdeReferencia: 0, breakdown: { motivo: 'sin_capital_pendiente' } };

  if (!fechaReferenciaYmd || !/^\d{4}-\d{2}-\d{2}$/.test(fechaReferenciaYmd)) {
    return { moraSaldoTotal: 0, diasDesdeReferencia: 0, breakdown: { motivo: 'sin_fecha_referencia' } };
  }

  const startYmd = addOneDay(fechaReferenciaYmd);
  if (startYmd > todayYmd) {
    return { moraSaldoTotal: 0, diasDesdeReferencia: 0, breakdown: { motivo: 'referencia_futura', startYmd, todayYmd } };
  }

  const diasDesdeReferencia = calendarDaysLate(startYmd, todayYmd);
  if (diasDesdeReferencia <= 0) return { moraSaldoTotal: 0, diasDesdeReferencia: 0, breakdown: { motivo: 'sin_atraso_desde_referencia' } };

  const result = computeLateFee({
    tasaInteresMora,
    dueDateYmd: startYmd,
    todayYmd,
    capitalMoroso: capital,
  });

  return {
    moraSaldoTotal: result.moraTotal,
    diasDesdeReferencia: result.diasAtraso,
    breakdown: {
      ...result.breakdown,
      tipo: 'mora_sobre_saldo_capital_pendiente',
      fechaReferencia: fechaReferenciaYmd,
      startYmd,
    },
  };
}

function addOneDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
