/** Fila de cuota “otros gastos” (pago parcial inicial) */
export type MiautoOtrosGastoRow = {
  id: string;
  week_index: number;
  due_date: string;
  amount_due: number;
  paid_amount: number;
  status: string;
};

/** Comprobante de pago subido por el conductor para una cuota de otros gastos */
export interface ComprobanteOtrosGastos {
  id: string;
  solicitud_id: string;
  otros_gastos_id: string;
  monto: number | null;
  moneda: string;
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
