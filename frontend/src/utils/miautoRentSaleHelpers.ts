/** URL absoluta para previsualizar adjuntos de Mi Auto. */
export function getMiautoAdjuntoUrl(filePath: string | undefined): string {
  if (!filePath) return '';
  if (filePath.startsWith('http')) return filePath;
  return `${window.location.origin}${filePath.startsWith('/') ? '' : '/'}${filePath}`;
}

export interface SolicitudRentSaleHeader {
  dni?: string;
  phone?: string;
  email?: string;
}

export function driverDisplayRentSale(sol: SolicitudRentSaleHeader | null, driverNameFromState?: string): string {
  if (driverNameFromState) return driverNameFromState;
  if (!sol) return '—';
  if (sol.phone) return `Tel: ${sol.phone}`;
  if (sol.email) return sol.email;
  return sol.dni || '—';
}

export function formatKpiMixPenUsd(pen: number, usd: number): string {
  if (pen <= 0 && usd <= 0) return 'S/. 0.00';
  const parts: string[] = [];
  if (pen > 0) parts.push(`S/. ${pen.toFixed(2)}`);
  if (usd > 0) parts.push(`$ ${usd.toFixed(2)}`);
  return parts.join(' · ');
}

/** Normaliza montos que vienen de la API como number o string (PostgreSQL/JSON). */
export function miautoNum(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Celda de monto: `S/. 0.00` / `$ 0.00` (espacio fino no rompible entre símbolo y número). */
export function miautoFmtMonto(sym: string, monto: unknown): string {
  return `${sym}\u00A0${miautoNum(monto).toFixed(2)}`;
}

/**
 * Monto mostrado en columna "Pagado": `paid_amount` de la cuota (BD actualiza al validar comprobantes o cobrar fleet).
 * Así coincide con bono/cuota/cuota final y con el estado de la fila.
 */
export function miautoMontoPagadoCuotaSemanal(paidAmount: unknown): number {
  return miautoNum(paidAmount);
}

export const MIAUTO_CUOTA_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  overdue: 'Vencida',
  paid: 'Pagada',
  partial: 'Pago parcial',
  bonificada: 'Bonificada',
};

export const MIAUTO_CUOTA_STATUS_PILL: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  overdue: 'bg-red-100 text-red-800',
  paid: 'bg-green-100 text-green-800',
  partial: 'bg-blue-100 text-blue-800',
  bonificada: 'bg-emerald-100 text-emerald-800',
};

/** Respuesta GET .../cuotas-semanales (lista + racha + bonificadas en el mismo envelope). */
export function parseCuotasSemanalesPayload(resCuotas: { data?: unknown }): {
  cuotas: unknown[];
  racha: number | null;
  cuotasSemanalesBonificadas: number;
} {
  const bodyCuotas = resCuotas.data ?? {};
  const inner = (bodyCuotas as { data?: unknown }).data ?? bodyCuotas;
  const innerObj = inner as { data?: unknown; racha?: unknown; cuotas_semanales_bonificadas?: unknown };
  const raw = innerObj?.data ?? innerObj;
  const list = Array.isArray(raw) ? raw : ((raw as { data?: unknown[] })?.data ?? []);
  const cuotas = Array.isArray(list) ? list : [];

  const rRaw = innerObj?.racha;
  let racha: number | null = null;
  if (typeof rRaw === 'number') racha = Math.max(0, Math.floor(rRaw));
  else if (typeof rRaw === 'string') {
    const n = parseInt(rRaw, 10);
    if (Number.isFinite(n)) racha = Math.max(0, n);
  }

  const bRaw = innerObj?.cuotas_semanales_bonificadas;
  const cuotasSemanalesBonificadas =
    typeof bRaw === 'number' ? Math.max(0, Math.floor(bRaw)) : 0;

  return { cuotas, racha, cuotasSemanalesBonificadas };
}
