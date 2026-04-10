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

/** Normaliza montos que vienen de la API como number o string (PostgreSQL/JSON). */
export function miautoNum(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Columna «Cuota sem. (plan)» / cuota de referencia en tabla: siempre **`cuota_semanal`** del cronograma en la fila.
 * El abono real va en la columna «Pagado» (`paid_amount`).
 */
export function miautoCuotaSemanalOAbonoDisplay(c: { cuota_semanal?: unknown }): number {
  return miautoNum(c.cuota_semanal);
}

/** Celda de monto: `S/. 0.00` / `$ 0.00` (espacio fino no rompible entre símbolo y número). */
export function miautoFmtMonto(sym: string, monto: unknown): string {
  return `${sym}\u00A0${miautoNum(monto).toFixed(2)}`;
}

/**
 * Columna «Cobro por ingresos»: el **tributo 83% de la semana según Yango** (`partner_fees_yango_83`) para que el monto siga visible
 * aunque tras cascada en BD quede `partner_fees_83` = 0. Si no hay Yango (sem. depósito / semana abierta en API), se usa `partner_fees_83`.
 * «Cuota a pagar» sigue alineada con la API (`cuota_neta`); el bloque «Imputación del cobro» indica a qué semanas se aplicó el pool.
 */
export function miautoCobroPorIngresosTributoDisplay(c: {
  partner_fees_83?: unknown;
  partner_fees_yango_83?: unknown;
}): number {
  const y83 = miautoNum(c.partner_fees_yango_83);
  if (y83 > 0.005) return y83;
  return miautoNum(c.partner_fees_83);
}

/** Columna «Cobro saldo»: siempre magnitud positiva en UI (en BD puede guardarse negativo por la cascada). */
export function miautoCobroSaldoDisplay(c: { cobro_saldo?: unknown }): number {
  return Math.abs(miautoNum(c.cobro_saldo));
}

/**
 * Cuando el plan está en USD, el cobro en Fleet sigue en moneda local: `partner_fees_yango_83` (USD) × TC de la solicitud.
 * No hace falta columna extra en BD; mismo dato que ya usa el backend al convertir antes de descontar la cuota.
 */
export function miautoCobroPorIngresosFleetLocalEquivalente(c: {
  moneda?: unknown;
  partner_fees_yango_83?: unknown;
  tipo_cambio_ref?: { valor_usd_a_local?: unknown; moneda_local?: string | null } | null;
}): { monto: number; sym: string } | null {
  if (String(c.moneda || '').toUpperCase() !== 'USD') return null;
  const tc = miautoNum(c.tipo_cambio_ref?.valor_usd_a_local);
  const y83 = miautoNum(c.partner_fees_yango_83);
  if (tc <= 0 || y83 <= 0.005) return null;
  const ml = String(c.tipo_cambio_ref?.moneda_local || 'PEN').toUpperCase();
  const sym = ml === 'COP' ? 'COP' : 'S/.';
  return { monto: Math.round(y83 * tc * 100) / 100, sym };
}

/** Tooltip columna «Cobro por ingresos»: Yango reportado vs imputación tras cascada a cuotas anteriores. */
export function miautoTooltipCobroPorIngresos(
  sym: string,
  c: {
    id?: string;
    moneda?: unknown;
    partner_fees_83?: unknown;
    partner_fees_yango_83?: unknown;
    tipo_cambio_ref?: { valor_usd_a_local?: unknown; moneda_local?: string | null } | null;
    partner_fees_cascada_aplicado_a?: {
      cuota_semanal_id?: string;
      week_start_date?: string | null;
      monto?: unknown;
    }[] | null;
  },
  cuotas?: { id?: string; week_start_date?: string | null; due_date?: string | null }[]
): string | undefined {
  const parts: string[] = [];
  const y83 = miautoNum(c.partner_fees_yango_83);
  const p83 = miautoNum(c.partner_fees_83);
  if (y83 > p83 + 0.02) {
    parts.push(
      `Yango (83,33%): ${miautoFmtMonto(sym, y83)}. Tras cascada en esta fila queda ${miautoFmtMonto(sym, p83)}.`
    );
  }
  const dest = c.partner_fees_cascada_aplicado_a;
  const origenId = c.id != null && String(c.id).trim() !== '' ? String(c.id).trim() : null;
  const destOtros =
    Array.isArray(dest) && origenId
      ? dest.filter((x) => String(x.cuota_semanal_id || '').trim() !== origenId)
      : Array.isArray(dest)
        ? [...dest]
        : [];
  if (destOtros.length > 0) {
    if (cuotas && cuotas.length > 0) {
      const filas = miautoCascadaCobroIngresosFilasParaUi(cuotas, c);
      if (filas.length > 0) {
        parts.push(
          'Imputado a: ' +
            filas
              .map((f) =>
                f.semana != null
                  ? `Semana ${f.semana} (${miautoFmtMonto(sym, f.monto)})`
                  : `${f.week_start_ymd || '—'} · ${miautoFmtMonto(sym, f.monto)}`
              )
              .join(' · ')
        );
      }
    } else {
      parts.push(
        'Imputado a cuotas anteriores: ' +
          destOtros
            .map((x) => `${x.week_start_date || '—'} · ${miautoFmtMonto(sym, miautoNum(x.monto))}`)
            .join(' · ')
      );
    }
  }
  const fleetEq = miautoCobroPorIngresosFleetLocalEquivalente(c);
  if (fleetEq) {
    parts.push(
      `Referencia Yango/Fleet (moneda local): ${miautoFmtMonto(fleetEq.sym, fleetEq.monto)}.`
    );
  }
  return parts.length ? parts.join(' ') : undefined;
}

export type MiautoCascadaCobroFilaUi = {
  semana: number | null;
  monto: number;
  /** YYYY-MM-DD del lunes de cuota (para desempate / fallback). */
  week_start_ymd: string | null;
};

/**
 * Misma numeración «Semana N» que la tabla del cronograma: busca la fila destino por `cuota_semanal_id` si viene en la API.
 */
export function miautoCascadaCobroIngresosFilasParaUi(
  cuotas: { id?: string; week_start_date?: string | null; due_date?: string | null }[],
  c: {
    id?: string;
    partner_fees_cascada_aplicado_a?: {
      cuota_semanal_id?: string;
      week_start_date?: string | null;
      monto?: unknown;
    }[] | null;
  }
): MiautoCascadaCobroFilaUi[] {
  const dest = c.partner_fees_cascada_aplicado_a;
  if (!Array.isArray(dest) || dest.length === 0) return [];
  const out: MiautoCascadaCobroFilaUi[] = [];
  const origenId = c.id != null && String(c.id).trim() !== '' ? String(c.id).trim() : null;
  for (const x of dest) {
    const monto = miautoNum(x.monto);
    if (monto <= 0.005) continue;
    if (
      origenId &&
      x.cuota_semanal_id != null &&
      String(x.cuota_semanal_id).trim() === origenId
    ) {
      continue;
    }
    const byId =
      x.cuota_semanal_id != null && String(x.cuota_semanal_id).trim() !== ''
        ? cuotas.find((q) => String(q.id) === String(x.cuota_semanal_id).trim())
        : undefined;
    const wsYmd = ymdPrefix(byId?.week_start_date ?? x.week_start_date);
    const dueYmd = ymdPrefix(byId?.due_date);
    const semana =
      miautoSemanaLista(cuotas, wsYmd || undefined) ??
      (dueYmd && wsYmd ? miautoSemanaOrdinalPorVencimiento(cuotas, dueYmd, wsYmd) : null) ??
      miautoSemanaLista(cuotas, x.week_start_date);
    out.push({ semana, monto, week_start_ymd: wsYmd });
  }
  return out;
}

/**
 * Suma real abonada (BD / API). Para totales contables y comprobantes.
 */
export function miautoMontoPagadoCuotaSemanal(paidAmount: unknown): number {
  return miautoNum(paidAmount);
}

/**
 * Columna «Pagado» en la tabla del cronograma semanal.
 * Incluye `abono_comprobante_en_revision` (staff): monto declarado en comprobante aún no validado, ya reflejado en saldos API.
 */
export function miautoMontoPagadoColumnaCronograma(c: {
  paid_amount?: unknown;
  abono_comprobante_en_revision?: unknown;
}): number {
  return Math.round((miautoNum(c.paid_amount) + miautoNum(c.abono_comprobante_en_revision)) * 100) / 100;
}

/**
 * Cuota neta **del plan** (periodo): `cuota_neta` del API (incluye cobro saldo y regla de comisión como el backend) o fallback local.
 * El bono no resta aquí. Para el **saldo de capital** tras pagos usar `miautoCuotaCapitalPendienteColumna` (`cuota_pendiente`).
 *
 * Modelo rent sale (backend `amountDueAndLateForOpen`): cada abono cubre **primero** toda la mora posible; el remanente baja el capital cuota.
 */
export function miautoCuotaAPagarCronogramaSemanal(c: {
  cuota_semanal?: unknown;
  bono_auto?: unknown;
  partner_fees_83?: unknown;
  cuota_neta?: unknown;
  /** Monto programado del periodo (si viene del API, alineado con cobro saldo). */
  amount_due?: unknown;
  cobro_saldo?: unknown;
  due_date?: unknown;
}): number {
  if (c.cuota_neta != null && c.cuota_neta !== '') {
    return miautoNum(c.cuota_neta);
  }
  if (c.amount_due != null && c.amount_due !== '' && Number.isFinite(Number(c.amount_due))) {
    const ad = miautoNum(c.amount_due);
    if (ad > 0.005) return ad;
  }
  const cs = miautoNum(c.cuota_semanal);
  const pf = miautoNum(c.partner_fees_83);
  const cobro = miautoNum(c.cobro_saldo);
  return Math.max(0, Math.round((cs - pf + cobro) * 100) / 100);
}

/**
 * Columna «Cuota final»: saldo total pendiente del periodo.
 * Preferir `pending_total` / `cuota_final` del API; si no vienen pero sí `mora_pendiente` + `cuota_pendiente`, usar su suma
 * (identidad: total = mora remanente + capital cuota remanente, tras imputar mora primero).
 * Si faltan ambos, se aproxima con cuota neta, mora y `paid_amount`.
 * Si el API envía saldo pendiente > 0, no anular por `status === 'paid'` en BD (pago parcial mal etiquetado).
 */
export function miautoCuotaFinalCronogramaSemanal(c: {
  cuota_semanal?: unknown;
  bono_auto?: unknown;
  partner_fees_83?: unknown;
  cuota_neta?: unknown;
  due_date?: unknown;
  late_fee?: unknown;
  mora_interes_periodo?: unknown;
  mora_pendiente?: unknown;
  cuota_pendiente?: unknown;
  paid_amount?: unknown;
  status?: string;
  cuota_final?: unknown;
  pending_total?: unknown;
}): number {
  const saldoApi = c.pending_total ?? c.cuota_final;
  if (saldoApi != null && saldoApi !== '' && Number.isFinite(Number(saldoApi))) {
    const v = Math.max(0, Math.round(miautoNum(saldoApi) * 100) / 100);
    if (v > 0.005) return v;
  }

  if (
    c.mora_pendiente != null &&
    c.mora_pendiente !== '' &&
    c.cuota_pendiente != null &&
    c.cuota_pendiente !== '' &&
    Number.isFinite(Number(c.cuota_pendiente))
  ) {
    const sum = Math.max(
      0,
      Math.round((miautoNum(c.mora_pendiente) + miautoNum(c.cuota_pendiente)) * 100) / 100
    );
    if (sum > 0.005) return sum;
  }

  const st = (c.status || '').toLowerCase();
  if (st === 'paid' || st === 'bonificada') return 0;

  const cuotaNet = miautoCuotaAPagarCronogramaSemanal(c);
  const mora =
    c.mora_pendiente != null && c.mora_pendiente !== ''
      ? miautoNum(c.mora_pendiente)
      : miautoNum(c.late_fee);
  const paid = miautoNum(c.paid_amount);

  if (mora > 0.005) {
    const moraRest = Math.max(0, mora - paid);
    const aplicadoCuota = Math.max(0, paid - mora);
    const cuotaRest = Math.max(0, cuotaNet - aplicadoCuota);
    return Math.round((moraRest + cuotaRest) * 100) / 100;
  }
  return Math.max(0, Math.round((cuotaNet - paid) * 100) / 100);
}

/**
 * Remanente del capital «cuota del plan» tras abonos (mora primero, luego cuota).
 * Prioridad: `cuota_pendiente` del API; si no, **total pendiente − mora** (mismas cifras que columnas Mora + Cuota final).
 * Si faltan totales en el payload, se estima el total con `miautoCuotaFinalCronogramaSemanal` antes de restar mora.
 */
export function miautoCuotaPendienteSinMora(c: {
  cuota_pendiente?: unknown;
  pending_total?: unknown;
  cuota_final?: unknown;
  mora_pendiente?: unknown;
  late_fee?: unknown;
  status?: string;
  cuota_semanal?: unknown;
  bono_auto?: unknown;
  partner_fees_83?: unknown;
  cuota_neta?: unknown;
  due_date?: unknown;
  paid_amount?: unknown;
}): number | null {
  /** Total API primero: evita `cuota_pendiente: 0` con deuda real en `pending_total`. */
  const totalRawPrimero = c.pending_total ?? c.cuota_final;
  if (totalRawPrimero != null && totalRawPrimero !== '' && Number.isFinite(Number(totalRawPrimero))) {
    const total = Math.max(0, Math.round(miautoNum(totalRawPrimero) * 100) / 100);
    if (total > 0.005) {
      const mora =
        c.mora_pendiente != null && c.mora_pendiente !== ''
          ? miautoNum(c.mora_pendiente)
          : miautoNum(c.late_fee);
      return Math.max(0, Math.round((total - mora) * 100) / 100);
    }
  }
  if (c.cuota_pendiente != null && c.cuota_pendiente !== '' && Number.isFinite(Number(c.cuota_pendiente))) {
    return Math.max(0, Math.round(miautoNum(c.cuota_pendiente) * 100) / 100);
  }
  const mora =
    c.mora_pendiente != null && c.mora_pendiente !== ''
      ? miautoNum(c.mora_pendiente)
      : miautoNum(c.late_fee);
  const totalRaw = c.pending_total ?? c.cuota_final;
  let total: number;
  if (totalRaw != null && totalRaw !== '' && Number.isFinite(Number(totalRaw))) {
    total = Math.max(0, Math.round(miautoNum(totalRaw) * 100) / 100);
  } else {
    total = Math.max(0, Math.round(miautoCuotaFinalCronogramaSemanal(c) * 100) / 100);
  }
  if (total > 0.005 || mora > 0.005) {
    return Math.max(0, Math.round((total - mora) * 100) / 100);
  }
  const st = (c.status || '').toLowerCase();
  if (st === 'paid' || st === 'bonificada') {
    return 0;
  }
  return null;
}

/**
 * Columna «Cuota a pagar»: saldo pendiente del capital cuota del plan (sin incluir mora).
 * Los abonos cubren primero toda la mora posible; el resto reduce este saldo. Coincide con `cuota_pendiente` del API.
 */
export function miautoCuotaCapitalPendienteColumna(c: {
  cuota_pendiente?: unknown;
  pending_total?: unknown;
  cuota_final?: unknown;
  mora_pendiente?: unknown;
  late_fee?: unknown;
  cuota_semanal?: unknown;
  bono_auto?: unknown;
  partner_fees_83?: unknown;
  cuota_neta?: unknown;
  due_date?: unknown;
}): number {
  const pend = miautoCuotaPendienteSinMora(c);
  if (pend != null) return pend;
  return miautoCuotaAPagarCronogramaSemanal(c);
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
