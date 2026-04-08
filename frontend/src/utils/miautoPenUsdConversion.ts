import { roundToTwoDecimals } from './currency';

/** Filas de API que pueden traer `tipo_cambio_ref` (p. ej. cuota en USD). */
export type MiautoRowConTcRef = { tipo_cambio_ref?: { valor_usd_a_local?: number } };

/**
 * 1 USD = N unidades de moneda local (PEN/COP), alineado con backend Mi Auto.
 * Si ninguna fila trae TC, usa fallback por país (mismos defaults que el servidor).
 */
export function resolveTipoCambioUsdALocalFromRows(rows: MiautoRowConTcRef[], country?: string): number {
  for (const row of rows) {
    const v = row.tipo_cambio_ref?.valor_usd_a_local;
    if (v != null && Number(v) > 0) return Number(v);
  }
  const co = (country || 'PE').toUpperCase();
  return co === 'CO' ? 4100 : 3.75;
}

export function convertMontoPenUsd(
  amount: number,
  from: 'PEN' | 'USD',
  to: 'PEN' | 'USD',
  valorUsdALocal: number
): number {
  if (!Number.isFinite(amount) || valorUsdALocal <= 0) return amount;
  if (from === to) return amount;
  if (from === 'PEN' && to === 'USD') return amount / valorUsdALocal;
  if (from === 'USD' && to === 'PEN') return amount * valorUsdALocal;
  return amount;
}

export function montoConvertidoPenUsdFormatted(
  amount: number,
  from: 'PEN' | 'USD',
  to: 'PEN' | 'USD',
  valorUsdALocal: number
): string {
  const c = convertMontoPenUsd(amount, from, to, valorUsdALocal);
  return roundToTwoDecimals(c).toFixed(2);
}
