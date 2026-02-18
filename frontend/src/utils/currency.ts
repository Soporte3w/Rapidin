/**
 * Etiqueta de moneda para mostrar junto a montos.
 * PE: S/. (soles), CO: COP (pesos colombianos).
 */
export function getCurrencyLabel(country: string): string {
  return country === 'CO' ? 'COP' : 'S/.';
}

/**
 * Redondea un monto a 2 decimales (Colombia y Perú).
 */
export function roundToTwoDecimals(amount: number): number {
  const value = Number(amount);
  return Math.round(value * 100) / 100;
}

/**
 * Formatea un monto con separadores de miles/decimales según el país.
 * Siempre redondeado a 2 decimales. PE: es-PE (1,234.56), CO: es-CO (1.234,56).
 */
export function formatAmount(amount: number, country: string): string {
  const value = roundToTwoDecimals(Number(amount));
  if (country === 'CO') {
    return value.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Monto listo para mostrar: símbolo + número formateado (siempre 2 decimales).
 * Ej: "S/. 1,234.56" (PE) o "COP 1.234,56" (CO).
 */
export function formatCurrency(amount: number, country: string): string {
  return `${getCurrencyLabel(country)} ${formatAmount(amount, country)}`;
}
