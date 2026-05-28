/**
 * Yego Rapidín 4.0 — CuotaCalculator
 *
 * Funciones PURAS para calcular cuotas semanales Mi Auto.
 * No realizan escritura a base de datos.
 * Cada función devuelve sus inputs y resultados para trazabilidad.
 */

import { parseViajesInterval, resolveMonedaCuotaSemanal } from '../cronograma/miautoCronogramaService.js';

export const PARTNER_FEES_PCT = 0.8333;

/**
 * Redondea a 2 decimales.
 */
export function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/**
 * Calcula el amount_due semanal (cuota neta del plan).
 *
 * Fórmula:
 *   baseCuota = max(0, cuotaSemanal)
 *   partnerFees83 = partnerFeesRaw * PARTNER_FEES_PCT
 *   cuotaNeta = max(0, baseCuota - partnerFees83)
 *   comisionSobrePF = partnerFees83 * (pctComision / 100)
 *
 *   Si partnerFeesApplyToCuotaReduction:
 *     amount_due = max(0, cuotaNeta + cobroSaldo + comisionSobrePF)
 *   Si commissionGoesToWaterfall:
 *     amount_due = max(0, cuotaNeta + cobroSaldo)
 *     (la comisión va al pool cascada aparte)
 *
 * @returns {{ amountDue, partnerFees83, cuotaNeta, comisionSobrePF, inputs, formula }}
 */
export function computeAmountDueSemanal({
  cuotaSemanal,
  partnerFeesRaw,
  pctComision,
  cobroSaldo,
  partnerFeesApplyToCuotaReduction = true,
  commissionGoesToWaterfall = false,
}) {
  const pfRaw = round2(Number(partnerFeesRaw) || 0);
  const pf83 = round2(pfRaw * PARTNER_FEES_PCT);
  const baseCs = round2(Math.max(0, Number(cuotaSemanal) || 0));
  const cuotaNeta = partnerFeesApplyToCuotaReduction
    ? round2(Math.max(0, baseCs - pf83))
    : baseCs;
  const pct = round2(Number(pctComision) || 0);
  const cobro = round2(Number(cobroSaldo) || 0);
  const comisionSobrePF = round2(pf83 * (pct / 100));

  let amountDue;
  if (commissionGoesToWaterfall) {
    amountDue = round2(Math.max(0, cuotaNeta + cobro));
  } else {
    amountDue = round2(Math.max(0, cuotaNeta + cobro + comisionSobrePF));
  }

  return {
    amountDue,
    partnerFees83: pf83,
    cuotaNeta,
    comisionSobrePF,
    inputs: {
      cuotaSemanal: baseCs,
      partnerFeesRaw: pfRaw,
      partnerFees83: pf83,
      pctComision: pct,
      cobroSaldo: cobro,
      partnerFeesApplyToCuotaReduction,
      commissionGoesToWaterfall,
    },
    formula: commissionGoesToWaterfall
      ? `max(0, ${cuotaNeta} + ${cobro}) = ${amountDue}`
      : `max(0, ${cuotaNeta} + ${cobro} + ${comisionSobrePF}) = ${amountDue}`,
  };
}

/**
 * Pool total para cascada: partner_fees_83 + comisión % sobre ese tributo.
 */
export function partnerFeesPlusComisionPool(partnerFees83, pctComision) {
  const pf = round2(Number(partnerFees83) || 0);
  const pct = round2(Number(pctComision) || 0);
  const comision = round2(pf * (pct / 100));
  return {
    pool: round2(pf + comision),
    breakdown: { partnerFees83: pf, comisionSobrePF: comision },
  };
}

/**
 * Resuelve la regla del cronograma según número de viajes y vehículo.
 *
 * @param {object} cronograma - Objeto con .rules[] y .vehicles[]
 * @param {string|number} cronogramaVehiculoId
 * @param {number} numViajes
 * @returns {{ cuotaSemanal, moneda, bonoAuto, pctComision, cobroSaldo, reglaAplicada }}
 */
export function resolvePlan(cronograma, cronogramaVehiculoId, numViajes) {
  if (!cronograma?.rules?.length) {
    return { error: 'cronograma_sin_reglas' };
  }

  const vehicles = cronograma.vehicles || [];
  const vehicleIndex = vehicles.findIndex((v) => v.id === cronogramaVehiculoId);
  if (vehicleIndex < 0) {
    return { error: 'vehiculo_no_encontrado', cronogramaVehiculoId };
  }

  const n = numViajes == null || Number.isNaN(Number(numViajes)) ? 0 : Number(numViajes);
  const rule = getRuleForTripCount(cronograma.rules, n);
  if (!rule) {
    return { error: 'sin_regla_para_viajes', numViajes: n };
  }

  const cuotasPorVehiculo = rule.cuotas_por_vehiculo || [];
  const cuotaSemanal = cuotasPorVehiculo[vehicleIndex] != null
    ? round2(parseFloat(cuotasPorVehiculo[vehicleIndex]) || 0)
    : 0;

  const moneda = resolveMonedaCuotaSemanal(cronograma, rule, vehicleIndex);

  return {
    cuotaSemanal,
    moneda,
    bonoAuto: round2(parseFloat(rule.bono_auto) || 0),
    pctComision: round2(Number(parseFloat(rule.pct_comision) || 0)),
    cobroSaldo: round2(parseFloat(rule.cobro_saldo) || 0),
    reglaAplicada: {
      viajes: rule.viajes,
      numViajes: n,
      vehicleIndex,
    },
  };
}

/**
 * Mayor cuota_semanal entre todas las reglas para un vehículo.
 * Usado cuando hay mora abierta: se cobra el tramo más alto sin bono.
 */
export function resolveMaxCuotaPorVehiculo(cronograma, cronogramaVehiculoId) {
  if (!cronograma?.rules?.length) return { error: 'cronograma_sin_reglas' };

  const vehicles = cronograma.vehicles || [];
  const vehicleIndex = vehicles.findIndex((v) => v.id === cronogramaVehiculoId);
  if (vehicleIndex < 0) return { error: 'vehiculo_no_encontrado' };

  let best = null;
  let bestCuota = -1;

  for (const rule of cronograma.rules) {
    const cuotasPorVehiculo = rule.cuotas_por_vehiculo || [];
    const cuota = cuotasPorVehiculo[vehicleIndex] != null
      ? round2(parseFloat(cuotasPorVehiculo[vehicleIndex]) || 0)
      : 0;
    if (cuota > bestCuota + 1e-6) {
      bestCuota = cuota;
      best = {
        cuotaSemanal: cuota,
        moneda: resolveMonedaCuotaSemanal(cronograma, rule, vehicleIndex),
        bonoAuto: round2(parseFloat(rule.bono_auto) || 0),
        pctComision: round2(Number(parseFloat(rule.pct_comision) || 0)),
        cobroSaldo: round2(parseFloat(rule.cobro_saldo) || 0),
        reglaAplicada: { viajes: rule.viajes, motivo: 'mora_abierta_max_cuota' },
      };
    }
  }

  return best || { error: 'sin_cuota_maxima' };
}

/**
 * Determina si procede forzar la cuota máxima (sin bono) por mora abierta.
 */
export function debeAplicarMaxCuotaSinBonoPorMora(hayCuotaOverdueEnSolicitud, esPrimeraSemanaDeposito, statusFila) {
  const st = String(statusFila || '').toLowerCase();
  return (
    hayCuotaOverdueEnSolicitud === true &&
    !esPrimeraSemanaDeposito &&
    st !== 'paid'
  );
}

// --- Helpers ---

function getRuleForTripCount(rules, numViajes) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const n = Number(numViajes) || 0;

  let best = null;
  let bestMin = -1;
  let thresholdRule = null;
  let thresholdMin = Infinity;

  for (const rule of rules) {
    const interval = parseViajesInterval(rule.viajes);
    if (!interval) continue;
    if (n >= interval.min && n <= interval.max) {
      if (interval.min > bestMin) {
        best = rule;
        bestMin = interval.min;
      }
    }
    if (interval.min <= n && interval.min < thresholdMin) {
      thresholdRule = rule;
      thresholdMin = interval.min;
    }
  }

  if (best) return best;
  if (thresholdRule && thresholdMin <= n) return thresholdRule;
  if (rules.length > 0) return rules[rules.length - 1];
  return null;
}
