import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { getTipoCambioByCountry } from './miautoTipoCambioService.js';

/** Redondeo a 2 decimales (montos Mi Auto). */
export function round2(n) {
  const x = Number(n);
  return Number.isNaN(x) ? 0 : Math.round(x * 100) / 100;
}

export function normalizePenUsd(moneda) {
  return moneda && String(moneda).toUpperCase() === 'PEN' ? 'PEN' : 'USD';
}

/**
 * Convierte monto entre PEN/COP y USD (1 USD = valorUsdALocal en moneda local).
 * Usado para cuota inicial y totales validados.
 */
export function convertirMontoEntreMonedas(monto, monedaOrigen, monedaDestino, valorUsdALocal) {
  const num = parseFloat(monto);
  if (Number.isNaN(num) || num <= 0) return null;
  if (monedaOrigen === monedaDestino) return num;
  if (monedaOrigen === 'USD' && (monedaDestino === 'PEN' || monedaDestino === 'COP')) {
    return num * (valorUsdALocal || 0);
  }
  if ((monedaOrigen === 'PEN' || monedaOrigen === 'COP') && monedaDestino === 'USD') {
    const rate = valorUsdALocal && valorUsdALocal > 0 ? valorUsdALocal : 1;
    return num / rate;
  }
  return num;
}

/**
 * 1 USD = valorUsdALocal en moneda local (PE/CO). Si no hay fila en BD o valor ≤ 0, usa env o default seguro
 * para no acreditar soles retirados en Fleet como si fueran dólares en `paid_amount`.
 */
export async function tipoCambioUsdALocalEfectivo(country) {
  const c = String(country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
  const tc = await getTipoCambioByCountry(c);
  const monedaLocal =
    tc?.moneda_local && String(tc.moneda_local).toUpperCase() === 'COP' ? 'COP' : 'PEN';
  let valor = tc?.valor_usd_a_local ?? 0;
  let fromFallback = false;
  if (!valor || valor <= 0) {
    fromFallback = true;
    valor =
      monedaLocal === 'COP'
        ? Math.max(1, Number(process.env.MIAUTO_FALLBACK_VALOR_USD_A_LOCAL_COP || 4100))
        : Math.max(0.01, Number(process.env.MIAUTO_FALLBACK_VALOR_USD_A_LOCAL_PEN || 3.75));
    logger.warn(
      `Mi Auto: tipo de cambio ausente o inválido país=${c}; usando fallback 1 USD = ${valor} ${monedaLocal}`
    );
  }
  return { valorUsdALocal: valor, monedaLocal, country: c, fromFallback };
}

/**
 * Convierte monto a PEN usando tipo de cambio del país de la solicitud (USD → PEN).
 */
export async function montoEnPEN(solicitudId, monto, moneda) {
  const num = parseFloat(monto);
  if (Number.isNaN(num) || num <= 0) return null;
  const monedaIngreso = normalizePenUsd(moneda);
  if (monedaIngreso === 'PEN') return round2(num);
  const sol = await query('SELECT country FROM module_miauto_solicitud WHERE id = $1', [solicitudId]);
  const country = sol.rows[0]?.country;
  if (!country) return round2(num);
  const tc = await getTipoCambioByCountry(country);
  const valor = tc?.valor_usd_a_local ?? 0;
  return round2(num * valor);
}

/**
 * Convierte monto a USD (PEN → USD dividiendo por tipo de cambio).
 */
export async function montoEnUSD(solicitudId, monto, moneda) {
  const num = parseFloat(monto);
  if (Number.isNaN(num) || num <= 0) return null;
  const monedaIngreso = normalizePenUsd(moneda);
  if (monedaIngreso === 'USD') return round2(num);
  const sol = await query('SELECT country FROM module_miauto_solicitud WHERE id = $1', [solicitudId]);
  const country = sol.rows[0]?.country;
  if (!country) return round2(num);
  const { valorUsdALocal } = await tipoCambioUsdALocalEfectivo(country);
  return round2(num / valorUsdALocal);
}

/**
 * El tributo `partner_fees` de Yango driver/income viene en moneda local del país (PEN en PE, COP en CO).
 * Si la cuota del cronograma está en USD, hay que pasar ese monto a USD (tipo de cambio de la solicitud)
 * antes del 83,33 % y del descuento sobre la cuota; si no, se restan “soles como si fueran dólares”.
 */
export async function partnerFeesYangoAMonedaCuota(solicitudId, partnerFeesPositive, monedaCuotaPlan) {
  const pf = round2(Math.max(0, Number(partnerFeesPositive) || 0));
  if (pf <= 0) return 0;

  const cuotaMon = String(monedaCuotaPlan || 'PEN').toUpperCase() === 'USD' ? 'USD' : 'PEN';

  const sol = await query('SELECT country FROM module_miauto_solicitud WHERE id = $1', [solicitudId]);
  const country = String(sol.rows[0]?.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';

  const { valorUsdALocal, monedaLocal: monedaYango } = await tipoCambioUsdALocalEfectivo(country);

  if (cuotaMon === monedaYango) {
    return pf;
  }

  if (cuotaMon === 'USD' && (monedaYango === 'PEN' || monedaYango === 'COP')) {
    const converted = convertirMontoEntreMonedas(pf, monedaYango, 'USD', valorUsdALocal);
    if (converted == null || Number.isNaN(converted)) {
      return pf;
    }
    return round2(converted);
  }

  logger.warn(
    `Mi Auto: partner_fees conversión no cubierta Yango=${monedaYango} cuota=${cuotaMon} (solicitud ${solicitudId})`
  );
  return pf;
}

/** Mismo factor que en miautoCuotaSemanalService (83,33 % del tributo). */
const PARTNER_FEES_PCT_LEGACY_CHECK = 0.8333;

/**
 * `partner_fees_raw` en BD para cuota en USD: puede estar ya en USD (post-ensure) o en PEN/COP sin convertir (legado).
 * Se interpreta como moneda Yango del país y se pasa a USD solo si hay señal de legado, para no dividir de nuevo
 * filas que ya están en USD (evita tratar 90 USD como 90 PEN).
 */
export async function partnerFeesRawDbNormalizeUsdFromYangoLocal(
  solicitudId,
  partnerFeesRaw,
  cuotaSemanalPlan
) {
  const pf = round2(Math.max(0, Number(partnerFeesRaw) || 0));
  if (pf <= 0.005) return pf;
  const cuota = round2(Number(cuotaSemanalPlan) || 0);
  if (cuota <= 0.005) return pf;

  const converted = await partnerFeesYangoAMonedaCuota(solicitudId, pf, 'USD');
  if (converted + 0.01 >= pf) return pf;

  const pf83 = round2(pf * PARTNER_FEES_PCT_LEGACY_CHECK);
  const looksLikeYangoLocalStillInNumber =
    pf83 > round2(cuota * 0.85) + 0.005 || pf > round2(cuota * 1.12) + 0.005;

  if (looksLikeYangoLocalStillInNumber) return round2(converted);

  return pf;
}
