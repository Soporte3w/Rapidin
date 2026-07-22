import axios from 'axios';
import api from '../../services/api';

export type MimotoCurrency = 'COP' | 'USD';
export type MimotoRuleMode = 'viajes' | 'viajes_horas';

export type MimotoCoverageKey =
  | 'soat'
  | 'impuesto_vehicular'
  | 'gps'
  | 'src'
  | 'todo_riesgo_mas_gps'
  | 'inicial_parcial';

export type MimotoCoverage = {
  amount: number;
  currency: MimotoCurrency;
  months_before?: number;
  start_month?: number;
  installments?: number;
  years?: number;
  weeks?: number;
  frequency?: 'monthly';
};

export type MimotoVehicleCoverages = {
  mode: 'grouped' | 'separate';
  soat: MimotoCoverage;
  impuesto_vehicular: MimotoCoverage;
  gps: MimotoCoverage;
  src: MimotoCoverage;
  todo_riesgo_mas_gps: MimotoCoverage;
  inicial_parcial: MimotoCoverage;
};

export type MimotoPublicConfig = {
  product: 'mimoto';
  country: 'CO';
  timezone: string;
  default_currency: 'COP';
  enabled: boolean;
  automation_enabled: boolean;
  billing_enabled: boolean;
};

export type MimotoFleet = {
  id: string;
  park_id: string;
  name: string;
  timezone: string;
  currency: MimotoCurrency;
  active: boolean;
};

export type MimotoVehicle = {
  id: string;
  name: string;
  inicial: number | string;
  inicial_moneda: MimotoCurrency;
  cuotas_semanales: number;
  precio_total?: number | string | null;
  moneda: MimotoCurrency;
  metadata?: {
    cuota_base?: number;
    bono_40?: number;
    bono_75?: number;
    image?: string;
    coverages?: Partial<MimotoVehicleCoverages>;
    [key: string]: unknown;
  };
};

export type MimotoRule = {
  id: string;
  viajes: string;
  horas_minimas?: number | string | null;
  bono_moto: number | string;
  pct_recaudo: number | string;
  cuotas_por_vehiculo: Array<{
    vehiculo_id: string;
    cuota: number | string;
  }>;
};

export type MimotoCronograma = {
  id: string;
  fleet_id?: string | null;
  name: string;
  active: boolean;
  solicitudes_count?: number;
  tasa_interes_mora: number | string;
  modo_evaluacion: MimotoRuleMode;
  bono_tiempo_activo: boolean;
  cuotas_otros_gastos?: number;
  requisitos_vehiculo?: {
    modalidades_pago_inicial?: { completo?: boolean; parcial?: boolean };
    [key: string]: unknown;
  };
  vehiculos: MimotoVehicle[];
  rules: MimotoRule[];
};

export type MimotoSolicitud = {
  id: string;
  fleet_id: string;
  fleet_name?: string;
  park_id?: string;
  country: 'CO';
  document_type: 'CC' | 'CE' | 'PPT';
  document_number: string;
  first_name: string;
  last_name: string;
  phone: string;
  email?: string | null;
  license_number?: string | null;
  driver_id_fleet?: string | null;
  cronograma_id?: string | null;
  cronograma_name?: string | null;
  cronograma_vehiculo_id?: string | null;
  vehiculo_name?: string | null;
  vehiculo_image?: string | null;
  vehiculo_inicial?: number | string | null;
  vehiculo_inicial_moneda?: MimotoCurrency | null;
  cuotas_semanales_plan?: number | null;
  cuotas_semanales?: number | null;
  tasa_interes_mora?: number | string | null;
  vehiculo_moneda?: MimotoCurrency | null;
  placa_asignada?: string | null;
  pago_tipo?: 'completo' | 'parcial' | null;
  pago_estado?: string;
  fecha_inicio_cobro_semanal?: string | null;
  fecha_entrega_vehiculo?: string | null;
  observations?: string | null;
  status: string;
  total_cuotas?: number;
  cuotas_pagadas?: number;
  cuotas_vencidas?: number;
  saldo_total?: number | string;
  total_pagado?: number | string;
  created_at?: string;
};

export type MimotoQuota = {
  id: string;
  week_number: number;
  week_start_date: string;
  due_date: string;
  viajes: number;
  horas_conectadas?: number | string | null;
  cuota_semanal: number | string;
  bono_moto: number | string;
  partner_fees_raw: number | string;
  pct_recaudo: number | string;
  recaudo_pool?: number | string;
  recaudo_aplicado: number | string;
  recaudo_cascada_destino?: Array<{
    cuota_id: string;
    semana?: number | null;
    vencimiento?: string | null;
    monto: number | string;
    mora_normal?: number | string;
    mora_extra?: number | string;
    capital?: number | string;
  }>;
  saldo_favor_conductor?: number | string;
  cobro_saldo: number | string;
  amount_due: number | string;
  capital_paid: number | string;
  late_fee_total: number | string;
  late_fee_paid: number | string;
  mora_extra_total: number | string;
  mora_extra_paid: number | string;
  saldo_capital: number | string;
  saldo_mora: number | string;
  saldo_mora_extra: number | string;
  saldo_total: number | string;
  paid_amount: number | string;
  pago_puntual: boolean;
  moneda: MimotoCurrency;
  status: string;
};

export type MimotoDetail = MimotoSolicitud & {
  timezone: string;
  modo_evaluacion: MimotoRuleMode;
  cuotas: MimotoQuota[];
  otros_gastos: MimotoExpense[];
  contratos: Array<{ id: string; version: number; file_name: string; file_path: string; created_at: string }>;
  comprobantes_cuota: MimotoQuotaVoucher[];
  evidencias_fleet: MimotoFleetEvidence[];
};

export type MimotoQuotaVoucher = {
  id: string;
  cuota_semanal_id: string;
  monto: number | string;
  moneda: MimotoCurrency;
  file_name?: string | null;
  file_path?: string | null;
  estado: string;
  origen: string;
  rechazo_razon?: string | null;
  created_at: string;
};

export type MimotoFleetEvidence = {
  id: string;
  cuota_semanal_id?: string | null;
  monto: number | string;
  moneda: MimotoCurrency;
  external_reference?: string | null;
  simulated: boolean;
  created_at: string;
};

export type MimotoExpense = {
  id: string;
  tipo: string;
  numero_cuota: number;
  total_cuotas: number;
  periodo_anio?: number;
  due_date: string;
  amount_due: number | string;
  paid_amount: number | string;
  moneda: MimotoCurrency;
  status: string;
};

export type MimotoVoucher = {
  id: string;
  comprobante_tipo: 'cuota_semanal' | 'otro_gasto';
  solicitud_id: string;
  referencia_id: string;
  referencia: string;
  monto: number | string;
  moneda: MimotoCurrency;
  file_name: string;
  file_path: string;
  estado: string;
  origen: string;
  rechazo_razon?: string | null;
  first_name: string;
  last_name: string;
  document_type: string;
  document_number: string;
  fleet_name: string;
  created_at: string;
};

export function unwrap<T>(response: { data?: { data?: T } }): T {
  return response.data?.data as T;
}

export function mimotoApiErrorMessage(error: unknown, fallback: string) {
  if (axios.isAxiosError<{ message?: string }>(error)) {
    return error.response?.data?.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function fetchMimotoConfig() {
  return unwrap<MimotoPublicConfig>(await api.get('/mimoto/config/public'));
}

export async function fetchMimotoFleets(active?: boolean) {
  return unwrap<MimotoFleet[]>(await api.get('/mimoto/fleets', { params: active == null ? {} : { active } }));
}

export async function fetchMimotoCronogramas(includeInactive = false) {
  return unwrap<MimotoCronograma[]>(await api.get('/mimoto/cronogramas', {
    params: includeInactive ? {} : { active: true },
  }));
}

export function formatMimotoMoney(value: unknown, currency: MimotoCurrency = 'COP') {
  const amount = Number(value) || 0;
  const formatted = new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: currency === 'COP' ? 0 : 2,
    maximumFractionDigits: currency === 'COP' ? 0 : 2,
  }).format(amount);
  return currency === 'COP' ? `$ ${formatted}` : `US$ ${formatted}`;
}

export const MIMOTO_STATUS_LABEL: Record<string, string> = {
  pendiente: 'Pendiente',
  citado: 'Citado',
  en_revision: 'En revisión',
  aprobado: 'Aprobado',
  activo: 'Activo',
  rechazado: 'Rechazado',
  retirado: 'Retirado',
  cancelado: 'Cancelada',
  cancelled: 'Cancelada',
  pending: 'Pendiente',
  partial: 'Pago parcial',
  overdue: 'Vencida',
  paid: 'Pagada',
  bonificada: 'Bonificada',
  validado: 'Validado',
  anulado: 'Anulado',
};
