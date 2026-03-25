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

/** Misma aritmética que backend/utils/miautoLimaWeekRange.js (semanas Lun–Dom civil UTC). */
function addDaysYmd(yyyyMmDd: string, deltaDays: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function weekdaysSinceMondayMon0(yyyyMmDd: string): number {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dowSun0 = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (dowSun0 + 6) % 7;
}

/** Lunes de la semana civil que contiene la fecha YYYY-MM-DD. */
function mondayOfWeekContainingYmd(yyyyMmDd: string): string {
  const sinceMon = weekdaysSinceMondayMon0(yyyyMmDd);
  return addDaysYmd(yyyyMmDd, -sinceMon);
}

function ymdPrefix(s: unknown): string | null {
  if (s == null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s).trim());
  return m ? m[1] : null;
}

/**
 * Número de cuota semanal (1-based) alineado al job Yango: ambas fechas se normalizan al lunes de su semana civil.
 * Preferir {@link miautoSemanaLista} en UI: la primera fila del listado es siempre "Semana 1".
 */
export function miautoSemanaContrato(
  fechaInicioCobro: string | null | undefined,
  weekStartDate: string | null | undefined
): number | null {
  const rawA = ymdPrefix(fechaInicioCobro);
  const rawB = ymdPrefix(weekStartDate);
  if (!rawA || !rawB) return null;
  const mondayA = mondayOfWeekContainingYmd(rawA);
  const mondayB = mondayOfWeekContainingYmd(rawB);
  const ta = Date.UTC(
    +mondayA.slice(0, 4),
    +mondayA.slice(5, 7) - 1,
    +mondayA.slice(8, 10)
  );
  const tb = Date.UTC(
    +mondayB.slice(0, 4),
    +mondayB.slice(5, 7) - 1,
    +mondayB.slice(8, 10)
  );
  const diffDays = Math.round((tb - ta) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return null;
  const n = Math.floor(diffDays / 7) + 1;
  return n >= 1 ? n : null;
}

/**
 * Número de semana para mostrar: 1 = primera fila del contrato (orden por `week_start_date` ASC).
 */
export function miautoSemanaLista(
  cuotas: { week_start_date?: string | null }[],
  weekStartDate: string | null | undefined
): number | null {
  const target = ymdPrefix(weekStartDate);
  if (!target || !Array.isArray(cuotas) || cuotas.length === 0) return null;
  const sorted = [...cuotas].sort((a, b) => {
    const da = ymdPrefix(a.week_start_date) || '';
    const db = ymdPrefix(b.week_start_date) || '';
    return da.localeCompare(db);
  });
  const idx = sorted.findIndex((c) => ymdPrefix(c.week_start_date) === target);
  return idx >= 0 ? idx + 1 : null;
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

/** Total de la fila: cuota neta (`amount_due`) + mora (`late_fee`). Misma suma que columna Cuota a pagar + Mora. */
export function miautoCuotaFinalSemana(c: {
  amount_due?: unknown;
  late_fee?: unknown;
}): number {
  return miautoNum(c.amount_due) + miautoNum(c.late_fee);
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
