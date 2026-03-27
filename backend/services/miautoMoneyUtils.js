import { query } from '../config/database.js';
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
  const tc = await getTipoCambioByCountry(country);
  const valor = tc?.valor_usd_a_local ?? 0;
  if (!valor || valor <= 0) return round2(num);
  return round2(num / valor);
}
