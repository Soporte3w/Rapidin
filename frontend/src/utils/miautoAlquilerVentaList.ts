/** Filtro `cuota_estado` en GET /miauto/alquiler-venta (subconsulta agregada de cuotas semanales). */
export const ALQUILER_VENTA_CUOTA_ESTADO_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Todos' },
  { value: 'vencido', label: 'Con mora (cuotas vencidas)' },
  { value: 'pendiente', label: 'Con cuota pendiente (aún no vencida)' },
  { value: 'al_dia', label: 'Al día (sin vencidas, con cuotas)' },
  { value: 'sin_cuotas', label: 'Sin cuotas en sistema' },
];

/** Respuesta de GET /miauto/alquiler-venta (listado Alquiler/Venta). */
export interface AlquilerVentaListItem {
  id: string;
  dni: string;
  status: string;
  created_at: string;
  fecha_inicio_cobro_semanal: string;
  driver_name?: string;
  working_driver_name?: string;
  fired_driver_name?: string;
  yango_work_status?: string;
  phone?: string;
  email?: string;
  cronograma_name?: string;
  vehiculo_name?: string;
  vehiculo_inicial?: number;
  vehiculo_inicial_moneda?: 'USD' | 'PEN' | 'COP' | string;
  placa_asignada?: string;
  license_number?: string;
  cuotas_semanales_plan?: number;
  total_cuotas: number;
  cuotas_pagadas: number;
  cuotas_vencidas: number;
  total_pagado: number;
  total_pagado_pen?: number;
  total_pagado_usd?: number;
  /** Moneda dominante de las cuotas reales (o cronograma si no hay cuotas). */
  moneda?: 'USD' | 'PEN' | 'COP';
}

export function conductorDisplay(row: AlquilerVentaListItem): string {
  if (row.yango_work_status === 'fired' && row.working_driver_name) return row.working_driver_name;
  if (row.driver_name) return row.driver_name;
  if (row.phone) return `Tel: ${row.phone}`;
  if (row.email) return row.email;
  return '—';
}

/** Normaliza moneda de cuota (BD / API) a moneda soportada por Mi Auto. */
export function monedaCuotasLabel(moneda?: string | null): 'USD' | 'PEN' | 'COP' {
  const u = String(moneda ?? '')
    .trim()
    .toUpperCase();
  if (u === 'USD' || u === 'COP') return u;
  return 'PEN';
}

/** Símbolo según moneda de la cuota (misma regla que `monedaCuotasLabel`). */
export function symMoneda(moneda?: string | null): string {
  const m = monedaCuotasLabel(moneda);
  if (m === 'USD') return '$';
  if (m === 'COP') return 'COP';
  return 'S/.';
}

/** Total pagado en cuotas semanales con prefijo de moneda dominante. */
export function formatTotalPagadoList(row: AlquilerVentaListItem): string {
  const pen = row.total_pagado_pen ?? 0;
  const usd = row.total_pagado_usd ?? 0;
  const moneda = row.moneda ?? 'PEN';
  if (moneda === 'USD' && usd > 0) return `$ ${usd.toFixed(2)}`;
  if (moneda === 'PEN' && pen > 0) return `S/. ${pen.toFixed(2)}`;
  if (usd > 0) return `$ ${usd.toFixed(2)}`;
  return `S/. ${pen.toFixed(2)}`;
}

export function formatInicialList(row: AlquilerVentaListItem): string {
  const inicial = Number(row.vehiculo_inicial ?? 0);
  if (!Number.isFinite(inicial) || inicial <= 0) return '—';
  return `${symMoneda(row.vehiculo_inicial_moneda)} ${inicial.toFixed(2)}`;
}
