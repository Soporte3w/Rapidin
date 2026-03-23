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
  phone?: string;
  email?: string;
  cronograma_name?: string;
  vehiculo_name?: string;
  placa_asignada?: string;
  license_number?: string;
  cuotas_semanales_plan?: number;
  total_cuotas: number;
  cuotas_pagadas: number;
  cuotas_vencidas: number;
  total_pagado: number;
  /** Moneda de las cuotas semanales (regla cronograma). */
  moneda?: 'USD' | 'PEN';
}

export function conductorDisplay(row: AlquilerVentaListItem): string {
  if (row.driver_name) return row.driver_name;
  if (row.phone) return `Tel: ${row.phone}`;
  if (row.email) return row.email;
  return '—';
}

/** Normaliza moneda de cuota (BD / API) a PEN o USD. */
export function monedaCuotasLabel(moneda?: string | null): 'USD' | 'PEN' {
  return moneda === 'USD' ? 'USD' : 'PEN';
}

/** Símbolo $ o S/. según moneda de la cuota (misma regla que `monedaCuotasLabel`). */
export function symMoneda(moneda?: string | null): string {
  return moneda === 'USD' ? '$' : 'S/.';
}

/** Total pagado en cuotas semanales con prefijo de moneda. */
export function formatTotalPagadoList(row: AlquilerVentaListItem): string {
  const n = row.total_pagado ?? 0;
  return `${symMoneda(row.moneda)} ${n.toFixed(2)}`;
}
