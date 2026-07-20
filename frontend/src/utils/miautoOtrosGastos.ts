/** Cuota de un ciclo de gastos adicionales de Mi Auto. */
export type MiautoOtrosGastoRow = {
  id: string;
  ciclo_id?: string | null;
  tipo?: string;
  periodo_anio?: number | null;
  ciclo_numero?: number;
  numero_cuota?: number;
  total_cuotas?: number | null;
  week_index: number;
  due_date: string;
  amount_due: number;
  paid_amount: number;
  pending_amount?: number;
  status: string;
  moneda?: string;
  origen?: string;
  pending_fleet_application_id?: string | null;
  pending_fleet_original_amount?: number | null;
  pending_fleet_original_currency?: string | null;
};

/** Comprobante de pago subido por el conductor para una cuota de otros gastos */
export interface ComprobanteOtrosGastos {
  id: string;
  solicitud_id: string;
  otros_gastos_id: string;
  monto: number | null;
  moneda: string;
  monto_aplicado?: number | null;
  moneda_aplicada?: string | null;
  pago_aplicado?: boolean;
  file_name: string;
  file_path: string;
  estado: string;
  validated_at: string | null;
  validated_by: string | null;
  rechazado_at: string | null;
  rechazo_razon: string | null;
  rechazado_by: string | null;
  created_at: string;
}

const OTROS_GASTOS_TYPE_LABELS: Record<string, string> = {
  gps: 'GPS',
  src: 'Seguro RC (SRC)',
  soat: 'SOAT',
  impuesto_vehicular: 'Impuesto vehicular',
  str_gps: 'STR + GPS',
  inicial_parcial: 'Inicial parcial',
  generico: 'Otros gastos',
};

export function canonicalOtrosGastoType(type?: string | null): string {
  const normalized = type || 'generico';
  return normalized === 'todo_riesgo_mas_gps_agrupado' ? 'str_gps' : normalized;
}

export function labelOtrosGastoType(type?: string | null): string {
  const canonicalType = canonicalOtrosGastoType(type);
  return OTROS_GASTOS_TYPE_LABELS[canonicalType] || canonicalType;
}

/** Etiqueta UI para filas de `module_miauto_otros_gastos` */
export function labelOtrosGastoStatus(status: string): string {
  switch (status) {
    case 'paid':
      return 'Pagado';
    case 'overdue':
      return 'Vencido';
    case 'partial':
      return 'Parcial';
    default:
      return 'Pendiente';
  }
}
