/** URL absoluta para previsualizar adjuntos de Mi Auto. */
export function getMiautoAdjuntoUrl(filePath: string | undefined): string {
  if (!filePath) return '';
  if (filePath.startsWith('http')) return filePath;
  return `${window.location.origin}${filePath.startsWith('/') ? '' : '/'}${filePath}`;
}

interface SolicitudRentSaleHeader {
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

function ymdPrefix(s: unknown): string | null {
  if (s == null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s).trim());
  return m ? m[1] : null;
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

/**
 * Número de semana en UI (1…N): orden por **vencimiento** (`due_date` ASC), desempate `week_start_date` ASC.
 * Evita que la primera cuota del plan (p. ej. vence el mismo día que el depósito) quede como "Semana 5"
 * cuando el orden por `week_start_date` no coincide con el orden de cobro.
 */
export function miautoSemanaOrdinalPorVencimiento(
  cuotas: { due_date?: string | null; week_start_date?: string | null }[],
  dueDate: string | null | undefined,
  weekStartDate: string | null | undefined
): number | null {
  const targetDue = ymdPrefix(dueDate);
  const targetWs = ymdPrefix(weekStartDate);
  if (!targetDue || !Array.isArray(cuotas) || cuotas.length === 0) return null;
  const sorted = [...cuotas].sort((a, b) => {
    const da = ymdPrefix(a.due_date) || '';
    const db = ymdPrefix(b.due_date) || '';
    const c0 = da.localeCompare(db);
    if (c0 !== 0) return c0;
    const wa = ymdPrefix(a.week_start_date) || '';
    const wb = ymdPrefix(b.week_start_date) || '';
    return wa.localeCompare(wb);
  });
  const idx = sorted.findIndex(
    (c) =>
      ymdPrefix(c.due_date) === targetDue &&
      (!targetWs || ymdPrefix(c.week_start_date) === targetWs)
  );
  return idx >= 0 ? idx + 1 : null;
}

/** Sincronizar con backend `miautoCuotaSemanalService.js` (`MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER`). */
const MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER = '2026-03-30';

function miautoSkipBonoReductionForDueYmd(dueYmd: string | null): boolean {
  if (!dueYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dueYmd)) return false;
  return dueYmd >= MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER;
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
 * Suma real abonada (BD / API). Para totales contables y comprobantes.
 */
export function miautoMontoPagadoCuotaSemanal(paidAmount: unknown): number {
  return miautoNum(paidAmount);
}

/**
 * Columna «Pagado» en cronograma semanal: si `due_date` es **antes** del mismo corte que bono (`2026-03-30`),
 * muestra neto tipo Excel: `max(0, paid_amount − late_fee)`. Desde esa fecha en adelante, solo `paid_amount`.
 */
export function miautoMontoPagadoColumnaMiAuto(c: {
  paid_amount?: unknown;
  late_fee?: unknown;
  due_date?: unknown;
}): number {
  const paid = miautoNum(c.paid_amount);
  const mora = miautoNum(c.late_fee);
  const due = ymdPrefix(c.due_date);
  if (due && due < MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER) {
    return Math.max(0, Math.round((paid - mora) * 100) / 100);
  }
  return paid;
}

/** Texto auxiliar «Excel» bajo Pagado cuando había mora y el neto aplica solo antes del corte. */
export function miautoPagadoMuestraEtiquetaExcel(c: { late_fee?: unknown; due_date?: unknown }): boolean {
  const due = ymdPrefix(c.due_date);
  if (!due || due >= MIAUTO_SKIP_BONO_IN_CUOTA_BASE_DUE_ON_OR_AFTER) return false;
  return miautoNum(c.late_fee) > 0.005;
}

/**
 * Cronograma semanal — columna «Cuota a pagar»: (cuota del plan − bono auto) − tributo 83% Yango (`partner_fees_83`),
 * salvo vencimiento ≥ corte sin bono: cuota del plan − solo `partner_fees_83`.
 * Misma base que `cuota_neta` en la API (`miautoCuotaSemanalService.computeCuotaDerivedForRow`).
 */
export function miautoCuotaAPagarCronogramaSemanal(c: {
  cuota_semanal?: unknown;
  bono_auto?: unknown;
  partner_fees_83?: unknown;
  cuota_neta?: unknown;
  due_date?: unknown;
}): number {
  if (c.cuota_neta != null && c.cuota_neta !== '') {
    return miautoNum(c.cuota_neta);
  }
  const due = ymdPrefix(c.due_date);
  if (due && miautoSkipBonoReductionForDueYmd(due)) {
    return Math.max(0, miautoNum(c.cuota_semanal) - miautoNum(c.partner_fees_83));
  }
  return Math.max(0, miautoNum(c.cuota_semanal) - miautoNum(c.bono_auto) - miautoNum(c.partner_fees_83));
}

/**
 * Columna «Cuota final»: saldo pendiente del periodo alineado con «Cuota a pagar» + «Mora».
 * Obligación teórica = neto + mora; se resta `paid_amount` aplicando primero a mora y luego al neto (misma cascada que el backend).
 */
export function miautoCuotaFinalCronogramaSemanal(c: {
  cuota_semanal?: unknown;
  bono_auto?: unknown;
  partner_fees_83?: unknown;
  cuota_neta?: unknown;
  due_date?: unknown;
  late_fee?: unknown;
  paid_amount?: unknown;
  status?: string;
}): number {
  const st = (c.status || '').toLowerCase();
  if (st === 'paid' || st === 'bonificada') return 0;

  const cuotaNet = miautoCuotaAPagarCronogramaSemanal(c);
  const mora = miautoNum(c.late_fee);
  const paid = miautoNum(c.paid_amount);

  if (mora > 0.005) {
    const moraRest = Math.max(0, mora - paid);
    const aplicadoCuota = Math.max(0, paid - mora);
    const cuotaRest = Math.max(0, cuotaNet - aplicadoCuota);
    return Math.round((moraRest + cuotaRest) * 100) / 100;
  }
  return Math.max(0, Math.round((cuotaNet - paid) * 100) / 100);
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
