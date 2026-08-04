import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import api from '../../services/api';
import { ArrowLeft, FileText, Banknote, Calendar, User, Car, Tag, TrendingUp, ExternalLink, X, ChevronDown, ChevronRight, AlertCircle, Award, Upload, Trash2, Plus, ReceiptText, Download, RefreshCw, Settings2, CheckCircle2, Pencil } from 'lucide-react';
import { FaWhatsapp } from 'react-icons/fa';
import toast from 'react-hot-toast';
import { formatDate, formatDateTime, formatDateUTC } from '../../utils/date';
import { buildMiAutoMessage } from '../../utils/miautoWhatsAppMessageBuilder';
import { TablePaginationBar } from '../../components/TablePaginationBar';
import { useTablePagination } from '../../hooks/useTablePagination';
import {
  canonicalOtrosGastoType,
  labelOtrosGastoType,
  labelOtrosGastoStatus,
  type ComprobanteOtrosGastos,
  type MiautoOtrosGastoRow,
} from '../../utils/miautoOtrosGastos';
import { monedaCuotasLabel, symMoneda } from '../../utils/miautoAlquilerVentaList';
import { MIAUTO_NO_CACHE_HEADERS, isAxiosAbortError, unwrapApiData } from '../../utils/miautoApiUtils';
import {
  driverDisplayRentSale,
  getMiautoAdjuntoUrl,
  miautoFmtMonto,
  miautoMontoPagadoCuotaSemanal,
  miautoMontoPagadoColumnaCronograma,
  miautoNum,
  miautoSemanaLista,
  miautoSemanaOrdinalPorVencimiento,
  miautoCuotaFinalCronogramaSemanal,
  miautoCuotaCapitalPendienteColumna,
  miautoCuotaSemanalOAbonoDisplay,
  miautoTooltipCobroPorIngresos,
  miautoCobroPorIngresosTributoDisplay,
  miautoCobroSaldoDisplay,
  miautoCascadaCobroIngresosFilasParaUi,
  miautoTotalCuotasPlanVehiculo,
  MIAUTO_CUOTA_STATUS_LABELS,
  MIAUTO_CUOTA_STATUS_PILL,
  parseCuotasSemanalesPayload,
} from '../../utils/miautoRentSaleHelpers';
import { MiautoComprobantesResumenSemana } from '../../components/yegoMiAuto/MiautoComprobantesResumenSemana';
import { MiautoGenerarCuotaModal } from '../../components/yegoMiAuto/MiautoGenerarCuotaModal';
import { MiautoAttachContractModal } from '../../components/yegoMiAuto/MiautoAttachContractModal';
import {
  MiautoGastosConfigurationModal,
  type MiautoGastoConfigFocus,
  type MiautoGastoConfiguration,
  type MiautoGastoGenerationInput,
} from '../../components/yegoMiAuto/MiautoGastosConfigurationModal';
import { useAuth } from '../../contexts/AuthContext';
import { roundToTwoDecimals } from '../../utils/currency';
import {
  montoConvertidoPenUsdFormatted,
  resolveTipoCambioUsdALocalFromRows,
} from '../../utils/miautoPenUsdConversion';
import {
  configuredExpenseKeys,
  mergeRequisitosFromApi,
  mergeRequisitosGastosFromApi,
  type RequisitosGastosVehiculo,
  type RequisitosVehiculo,
} from './miautoCronogramaConfigDomain';

const TIPO_OTROS_GASTOS_ACCENT: Record<string, string> = {
  gps: 'border-l-blue-500',
  src: 'border-l-amber-500',
  soat: 'border-l-green-500',
  impuesto_vehicular: 'border-l-orange-500',
  str_gps: 'border-l-purple-500',
  inicial_parcial: 'border-l-teal-500',
  generico: 'border-l-gray-400',
};

const TIPO_OTROS_GASTOS_BAR: Record<string, string> = {
  gps: 'bg-blue-500',
  src: 'bg-amber-500',
  soat: 'bg-green-500',
  impuesto_vehicular: 'bg-orange-500',
  str_gps: 'bg-purple-500',
  inicial_parcial: 'bg-teal-500',
  generico: 'bg-gray-400',
};

const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function formatOtrosGastoDueDate(dueDate: string): string {
  const [year, month, day] = String(dueDate || '').slice(0, 10).split('-');
  const monthLabel = MONTHS_SHORT[Number(month) - 1];
  return year && monthLabel && day ? `${year} · ${day}-${monthLabel}` : '—';
}

function saldoPendienteOtroGasto(expense: MiautoOtrosGastoRow): number {
  return roundToTwoDecimals(Math.max(
    0,
    Number(expense.pending_amount ?? Number(expense.amount_due) - Number(expense.paid_amount || 0))
  ));
}

interface CuotaSemanal {
  id: string;
  week_start_date: string;
  due_date: string;
  num_viajes?: number | null;
  bono_auto?: number;
  cuota_semanal?: number;
  amount_due: number;
  paid_amount: number;
  pago_puntual?: boolean;
  late_fee: number;
  /** Días civiles tras el vencimiento (Lima); el día de vencimiento es 0. */
  late_fee_calendar_days?: number;
  /** Interés devengado del periodo (misma cifra que `late_fee` en API cuando la pendiente es 0). */
  mora_interes_periodo?: number;
  /** Mora total acumulada en este periodo (valor BD). Aunque ya pagada, muestra cuánto se acumuló. */
  mora_acumulada?: number;
  /** Mora extra: generada sobre el pendiente cuando hay pagos parciales en cuotas vencidas. Empieza en 0. */
  mora_extra?: number;
  /** Total histórico de mora_extra generada (incluye la ya pagada/cristalizada). */
  mora_extra_total?: number;
  /** Mora extra ya cobrada/pagada (total − actual). */
  mora_extra_cobrada?: number;
  /** Saldo mora pendiente tras pagos (API); para neto Excel. */
  mora_pendiente?: number;
  status: string;
  pending_total?: number;
  moneda?: string;
  cobro_saldo?: number;
  cobro_desde_saldo_conductor?: number;
  saldo_favor_conductor?: number;
  cobro_saldo_referencia?: {
    cuota_semanal_id?: string;
    semana?: number;
    week_start_date?: string;
    due_date?: string;
    monto: number;
    source?: string;
  }[];
  /** Alícuota regla cronograma (si la API la envía). */
  cobro_saldo_regla?: number;
  cuota_neta?: number;
  /** Saldo pendiente solo de la cuota del plan (sin mora), tras imputar abonos mora → cuota. */
  cuota_pendiente?: number;
  cuota_final?: number;
  partner_fees_83?: number;
  partner_fees_yango_raw?: number | null;
  partner_fees_yango_83?: number;
  tipo_cambio_ref?: { valor_usd_a_local?: number; moneda_local?: string };
  partner_fees_cascada_aplicado_a?: {
    cuota_semanal_id?: string;
    week_start_date?: string | null;
    monto: number;
  }[];
  pct_comision?: number;
}

interface SolicitudSummary {
  id: string;
  dni: string;
  phone?: string;
  email?: string;
  driver_name?: string;
  working_driver_name?: string;
  yango_work_status?: string;
  country?: string;
  status: string;
  origen_registro?: 'solicitud' | 'contrato_adicional';
  conductor_id?: string;
  pago_tipo?: string;
  pago_estado?: string;
  fecha_inicio_cobro_semanal?: string;
  placa_asignada?: string;
  facturador_customer_id?: number | string | null;
  cronograma?: {
    id: string;
    name: string;
    tasa_interes_mora?: number;
    bono_tiempo_activo?: boolean;
    requisitos_vehiculo?: Partial<RequisitosVehiculo> | null;
  } | null;
  cronograma_vehiculo?: {
    id: string;
    name: string;
    cuotas_semanales?: number;
    inicial_moneda?: string;
    requisitos_gastos?: Partial<RequisitosGastosVehiculo> | null;
  } | null;
  otros_gastos?: MiautoOtrosGastoRow[];
}

interface ContratoRelacionadoMiAuto {
  id: string;
  conductor_id: string;
  origen_registro?: 'solicitud' | 'contrato_adicional';
  status: string;
  placa_asignada?: string | null;
  fecha_inicio_cobro_semanal?: string | null;
  cronograma_name?: string | null;
  vehiculo_name?: string | null;
  contrato_numero: number;
  etapa: 'activo' | 'por_activar';
  total_cuotas?: number;
  cuotas_pagadas?: number;
  cuotas_vencidas?: number;
}

function miautoMontoFacturableNotaVentaCuota(cuota: CuotaSemanal) {
  const pagoDirecto = miautoNum(cuota.paid_amount);
  const recaudo = Math.max(0, miautoNum(cuota.partner_fees_83));
  const cobroSaldoRaw = miautoNum(cuota.cobro_saldo);
  const cobroDesdeSaldoConductor = Math.max(0, miautoNum(cuota.cobro_desde_saldo_conductor));
  const cobroSaldoInterno = Math.max(0, Math.abs(cobroSaldoRaw) - cobroDesdeSaldoConductor);
  return roundToTwoDecimals(pagoDirecto + recaudo + cobroSaldoInterno);
}

type MiautoMoneda = 'PEN' | 'COP' | 'USD';

interface ComprobanteCuotaSemanal {
  id: string;
  solicitud_id: string;
  cuota_semanal_id: string;
  monto?: number | string | null;
  monto_declarado?: number | string | null;
  declared_amount?: number | string | null;
  amount?: number | string | null;
  moneda?: string | null;
  file_name?: string | null;
  file_path?: string | null;
  estado: string;
  validated_at?: string | null;
  rechazado_at?: string | null;
  rechazo_razon?: string | null;
  created_at?: string;
  /** conductor: pago a validar; admin_confirmacion: documento oficial subido por admin (cuota ya pagada); pago_manual: registro interno */
  origen?: string | null;
}

function montoComprobanteCuotaNumber(comp: ComprobanteCuotaSemanal): number | null {
  const raw = comp.monto ?? comp.monto_declarado ?? comp.declared_amount ?? comp.amount;
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

interface NotaVentaMiAuto {
  id: string;
  facturador_sale_note_id: number;
  number_full?: string | null;
  print_a4?: string | null;
  customer_id: number;
  currency_type_id?: string | null;
  total: number | string;
  created_at?: string;
  download_name?: string | null;
  cuotas?: { cuota_semanal_id: string; amount: number | string; semana?: number | null }[];
  warnings?: { step?: string; message?: string }[];
}

function fileNameFromDisposition(disposition: string | undefined, fallback: string): string {
  const value = String(disposition || '');
  const match = value.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return decodeURIComponent(match?.[1] || fallback);
}

function downloadBlob(blob: Blob, fileName: string) {
  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(blobUrl);
}

interface ContratoDocumentoMiAuto {
  id: string;
  solicitud_id: string;
  file_name: string;
  file_path: string;
  mime_type?: string | null;
  file_size?: number | null;
  created_by?: string | null;
  created_by_name?: string | null;
  created_at?: string | null;
  deleted_by?: string | null;
  deleted_by_name?: string | null;
  deleted_at?: string | null;
  activo?: boolean;
}

interface OtroGastoCobroFleetRow {
  id: string;
  tipo: string;
  numero_cuota?: number | null;
  total_cuotas?: number | null;
  periodo_anio?: number | null;
  due_date?: string | null;
  amount_due: number;
  paid_amount: number;
  pending_amount: number;
  currency: string;
  status: string;
  pending_receipt_id?: string | null;
  pending_receipt_amount?: number | null;
  pending_receipt_currency?: string | null;
  pending_receipt_file_name?: string | null;
  pending_receipt_file_path?: string | null;
  pending_receipt_applied?: boolean;
  pending_fleet_application_id?: string | null;
  pending_fleet_original_amount?: number | null;
  pending_fleet_original_currency?: string | null;
}

interface OtroGastoCobroFleetPreview {
  balance: number | null;
  balance_currency: string | null;
  driver_name: string | null;
  expenses: OtroGastoCobroFleetRow[];
}

/** Saldo pendiente numérico para conformidad admin: usa el saldo final del API/helper único de cuota semanal. */
function pendienteRestanteConformidadCuota(c: CuotaSemanal): number {
  return roundToTwoDecimals(Math.max(0, miautoCuotaFinalCronogramaSemanal(c)));
}

/** Monto pendiente sugerido para etiquetar el comprobante de conformidad (admin). */
function defaultMontoConformidadCuota(c: CuotaSemanal): string {
  return pendienteRestanteConformidadCuota(c).toFixed(2);
}

export default function YegoMiAutoRentSaleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  type AlquilerVentaNavigationItem = {
    id: string;
    driver_name?: string;
  };

  type AlquilerVentaListState = {
    fromList?: boolean;
    driver_name?: string;
    country?: string;
    driverSearchInput?: string;
    cronogramaId?: string;
    cuotaEstado?: string;
    page?: number;
    pageSize?: number;
    navigationItems?: AlquilerVentaNavigationItem[];
  };

  type AlquilerVentaBackState = AlquilerVentaListState & { fromDetail?: boolean };

  const listState = location.state as AlquilerVentaListState | null;
  const driverNameFromState = listState?.driver_name;
  const navigationItems = Array.isArray(listState?.navigationItems) ? listState.navigationItems : [];
  const currentNavigationIndex = navigationItems.findIndex((item) => item.id === id);
  const nextNavigationItem = currentNavigationIndex >= 0
    ? navigationItems[currentNavigationIndex + 1] ?? null
    : null;
  const detailPageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    detailPageRef.current?.scrollIntoView({ block: 'start' });
  }, [id]);

  const getBackToListState = (): AlquilerVentaBackState | undefined => {
    const s = listState;
    if (!s?.fromList) return undefined;
    return {
      fromDetail: true,
      country: s.country ?? '',
      driverSearchInput: s.driverSearchInput ?? '',
      cronogramaId: s.cronogramaId ?? '',
      cuotaEstado: s.cuotaEstado ?? '',
      page: s.page ?? 1,
      pageSize: s.pageSize ?? 20,
    };
  };

  const goToNextDriver = () => {
    if (!nextNavigationItem) return;
    const pageSize = Math.max(1, Number(listState?.pageSize) || 20);
    navigate(`/admin/yego-mi-auto/rent-sale/${nextNavigationItem.id}`, {
      state: {
        ...listState,
        driver_name: nextNavigationItem.driver_name,
        page: Math.floor((currentNavigationIndex + 1) / pageSize) + 1,
      },
    });
  };

  const [solicitud, setSolicitud] = useState<SolicitudSummary | null>(null);
  const [cuotas, setCuotas] = useState<CuotaSemanal[]>([]);
  const [comprobantesPagos, setComprobantesPagos] = useState<ComprobanteCuotaSemanal[]>([]);
  const [comprobantesOtrosGastos, setComprobantesOtrosGastos] = useState<ComprobanteOtrosGastos[]>([]);
  const [comprobantePreview, setComprobantePreview] = useState<{ url: string; fileName: string; isImage: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  /** Recarga tras validar/rechazar: solo overlay en cronograma (no pantalla entera). */
  const [refreshingDetail, setRefreshingDetail] = useState(false);
  const [error, setError] = useState('');
  const [comprobantesSemanaAbierta, setComprobantesSemanaAbierta] = useState<Record<string, boolean>>({});
  const [otrosTiposAbiertos, setOtrosTiposAbiertos] = useState<Record<string, boolean>>({});
  const [subiendoConformidadCuotaId, setSubiendoConformidadCuotaId] = useState<string | null>(null);
  const [guardandoPagoPuntualId, setGuardandoPagoPuntualId] = useState<string | null>(null);
  /** Archivo elegido por cuota; la subida es explícita con el botón «Subir». */
  const [conformidadArchivoPendiente, setConformidadArchivoPendiente] = useState<Record<string, File | null>>({});
  /** Sobrescritura opcional de monto/moneda mostrados al subir conformidad (por defecto = pendiente de la cuota). */
  const [conformidadMontoInput, setConformidadMontoInput] = useState<Record<string, string>>({});
  const [conformidadMonedaInput, setConformidadMonedaInput] = useState<Record<string, MiautoMoneda>>({});
  const conformidadFileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [conformidadEliminarModal, setConformidadEliminarModal] = useState<{ comprobanteId: string } | null>(null);
  const [eliminandoConformidadId, setEliminandoConformidadId] = useState<string | null>(null);
  const [bonoAplicado, setBonoAplicado] = useState<number>(0);
  const [tabCronograma, setTabCronograma] = useState<'semanales' | 'otros_gastos'>('semanales');
  const [ogTipoFilterAdmin, setOgTipoFilterAdmin] = useState<string | null>(null);
  const [gastoConfig, setGastoConfig] = useState<MiautoGastoConfiguration | null>(null);
  const [loadingGastoConfig, setLoadingGastoConfig] = useState(false);
  const [savingGastoConfig, setSavingGastoConfig] = useState(false);
  const [generatingGastos, setGeneratingGastos] = useState(false);
  const [showGastoConfigModal, setShowGastoConfigModal] = useState(false);
  const [gastoConfigFocus, setGastoConfigFocus] = useState<MiautoGastoConfigFocus | null>(null);
  const [gastoConfigContextMenu, setGastoConfigContextMenu] = useState<{
    type: string | null;
    label: string;
    x: number;
    y: number;
  } | null>(null);
  const [showStartDateCorrectionModal, setShowStartDateCorrectionModal] = useState(false);
  const [startDateCorrection, setStartDateCorrection] = useState('');
  const [savingStartDateCorrection, setSavingStartDateCorrection] = useState(false);
  const [showGastoFleetChargeModal, setShowGastoFleetChargeModal] = useState(false);
  const [gastoManualPagoTarget, setGastoManualPagoTarget] = useState<MiautoOtrosGastoRow | null>(null);
  const [pagandoGastoManualId, setPagandoGastoManualId] = useState<string | null>(null);
  const [loadingGastoFleetCharge, setLoadingGastoFleetCharge] = useState(false);
  const [chargingGastoFleet, setChargingGastoFleet] = useState(false);
  const [gastoFleetPreview, setGastoFleetPreview] = useState<OtroGastoCobroFleetPreview | null>(null);
  const [gastosFleetSeleccionados, setGastosFleetSeleccionados] = useState<Record<string, boolean>>({});
  const [gastoFleetTipoActivo, setGastoFleetTipoActivo] = useState<string | null>(null);
  const [gastoComprobanteTarget, setGastoComprobanteTarget] = useState<MiautoOtrosGastoRow | null>(null);
  const [gastoComprobanteMonto, setGastoComprobanteMonto] = useState('');
  const [gastoComprobanteMoneda, setGastoComprobanteMoneda] = useState('PEN');
  const [gastoComprobanteArchivo, setGastoComprobanteArchivo] = useState<File | null>(null);
  const [gastoComprobanteFleetApplicationId, setGastoComprobanteFleetApplicationId] = useState<string | null>(null);
  const [subiendoGastoComprobante, setSubiendoGastoComprobante] = useState(false);
  const [subTabCuota, setSubTabCuota] = useState<Record<string, 'comprobantes' | 'evidencias'>>({});
  const [evidenciasFleet, setEvidenciasFleet] = useState<{ id: string; cuota_semanal_id: string; file_name: string; file_path: string; created_at: string }[]>([]);
  const [subiendoEvidenciaCuotaId, setSubiendoEvidenciaCuotaId] = useState<string | null>(null);
  const [eliminandoEvidenciaId, setEliminandoEvidenciaId] = useState<string | null>(null);

  const openGastoConfigModal = (focus: MiautoGastoConfigFocus | null = null) => {
    setGastoConfigFocus(focus);
    setShowGastoConfigModal(true);
  };

  const gastoConfigFocusForType = (type: string | null): MiautoGastoConfigFocus | null => {
    const canonicalType = canonicalOtrosGastoType(type);
    if (
      canonicalType === 'soat'
      || canonicalType === 'impuesto_vehicular'
      || canonicalType === 'inicial_parcial'
      || canonicalType === 'str_gps'
    ) {
      return canonicalType;
    }
    return null;
  };

  const openGastoConfigContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    type: string | null,
    label: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setGastoConfigContextMenu({
      type,
      label,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 96)),
    });
  };

  useEffect(() => {
    if (!gastoConfigContextMenu) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setGastoConfigContextMenu(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [gastoConfigContextMenu]);

  useEffect(() => {
    setGastoConfig(null);
    setGastoConfigFocus(null);
    setGastoConfigContextMenu(null);
    setShowGastoConfigModal(false);
    setShowStartDateCorrectionModal(false);
    setStartDateCorrection('');
  }, [id]);
  const evidenciaFleetFileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [showGenerarCuotaModal, setShowGenerarCuotaModal] = useState(false);
  const [showNotasVentaModal, setShowNotasVentaModal] = useState(false);
  const [notasVenta, setNotasVenta] = useState<NotaVentaMiAuto[]>([]);
  const [contratos, setContratos] = useState<ContratoDocumentoMiAuto[]>([]);
  const [contratosRelacionados, setContratosRelacionados] = useState<ContratoRelacionadoMiAuto[]>([]);
  const [showAttachContractModal, setShowAttachContractModal] = useState(false);
  const [subiendoContrato, setSubiendoContrato] = useState(false);
  const [eliminandoContratoId, setEliminandoContratoId] = useState<string | null>(null);
  const [showContratoMenu, setShowContratoMenu] = useState(false);
  const contratoFileRef = useRef<HTMLInputElement | null>(null);
  const [notaVentaCuotasSeleccionadas, setNotaVentaCuotasSeleccionadas] = useState<Record<string, boolean>>({});
  const [generandoNotaVenta, setGenerandoNotaVenta] = useState(false);
  const [descargandoNotaVentaId, setDescargandoNotaVentaId] = useState<string | null>(null);
  const [anulandoNotaVentaId, setAnulandoNotaVentaId] = useState<string | null>(null);
  const [notaVentaAnularModal, setNotaVentaAnularModal] = useState<NotaVentaMiAuto | null>(null);
  const [whatsAppMessage, setWhatsAppMessage] = useState('');
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);
  const [refreshingWhatsAppPhone, setRefreshingWhatsAppPhone] = useState(false);
  const [whatsAppTab, setWhatsAppTab] = useState<'cuotas' | 'metricas' | 'comprobante'>('cuotas');
  const [whatsAppCuotasMsg, setWhatsAppCuotasMsg] = useState('');
  const [whatsAppNotaVentaId, setWhatsAppNotaVentaId] = useState<string>('');
  const [metricasData, setMetricasData] = useState<any>(null);
  const [loadingMetricas, setLoadingMetricas] = useState(false);
  const [metricasError, setMetricasError] = useState('');
  const whatsAppCuotaReciente = useMemo(() => {
    return [...cuotas].sort((a: any, b: any) => {
      const wa = a.week_start_date || '';
      const wb = b.week_start_date || '';
      if (wa > wb) return -1;
      if (wa < wb) return 1;
      return 0;
    })[0] || null;
  }, [cuotas]);

  const toggleComprobantesSemana = useCallback((cuotaId: string) => {
    setComprobantesSemanaAbierta((prev) => ({ ...prev, [cuotaId]: !prev[cuotaId] }));
  }, []);

  /** Tope al validar un comprobante: el backend reparte el excedente en otras cuotas (misma solicitud). */
  const tipoCambioUsdLocal = useMemo(
    () => resolveTipoCambioUsdALocalFromRows(cuotas, solicitud?.country),
    [cuotas, solicitud?.country]
  );

  const overdueCuotas = useMemo(() => cuotas.filter((c) => c.status === 'overdue'), [cuotas]);
  const pendingCuotasHoy = useMemo(() => {
    const hoy = new Date().toISOString().slice(0, 10);
    return cuotas.filter((c) => c.status === 'pending' && c.due_date?.slice(0, 10) === hoy);
  }, [cuotas]);

  /** Misma regla que en la vista conductor: si la fila no trae `moneda`, se usa la del vehículo en cronograma. */
  const monedaCuotaRow = (c: Pick<CuotaSemanal, 'moneda'>) =>
    monedaCuotasLabel(c.moneda ?? solicitud?.cronograma_vehiculo?.inicial_moneda);

  function getWhatsAppPhone(phone: string | undefined, country: string): string {
    if (!phone) return '';
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 10 && (digits.startsWith('51') || digits.startsWith('57'))) return digits;
    if (country === 'PE' && digits.length === 9) return '51' + digits;
    if (country === 'CO' && digits.length === 10) return '57' + digits;
    return digits;
  }

  const whatsAppPhone = solicitud ? getWhatsAppPhone(solicitud.phone, solicitud.country || 'PE') : '';
  const notasVentaConPdf = useMemo(() => notasVenta.filter((nota) => !!nota.print_a4), [notasVenta]);
  const whatsAppNotaSeleccionada = useMemo(() => {
    if (notasVentaConPdf.length === 0) return null;
    return notasVentaConPdf.find((nota) => nota.id === whatsAppNotaVentaId) || notasVentaConPdf[0];
  }, [notasVentaConPdf, whatsAppNotaVentaId]);
  const whatsAppComprobanteMsg = useMemo(() => {
    if (!whatsAppNotaSeleccionada) {
      return 'Hola, te compartimos tu comprobante de pago de Yego Mi Auto.';
    }
    const name = driverNameFromState || 'Conductor';
    const moneda = whatsAppNotaSeleccionada.currency_type_id || 'PEN';
    const sym = symMoneda(moneda);
    const semanas = (whatsAppNotaSeleccionada.cuotas || [])
      .map((c) => c.semana)
      .filter((semana): semana is number => semana != null)
      .sort((a, b) => a - b);
    const cuotasLine = semanas.length > 0
      ? `\nCuota(s): ${semanas.map((s) => `#${s}`).join(', ')}`
      : '';
    return [
      `Hola, ${name}.`,
      '',
      `Te compartimos tu comprobante de pago ${whatsAppNotaSeleccionada.number_full || ''}.`.trim(),
      `Monto: ${sym} ${miautoNum(whatsAppNotaSeleccionada.total).toFixed(2)}${cuotasLine}`,
      '',
      'Por favor conserva este archivo como constancia.',
    ].join('\n');
  }, [driverNameFromState, whatsAppNotaSeleccionada]);
  const whatsAppCanSend = Boolean(
    whatsAppPhone
    && whatsAppMessage.trim()
    && !sendingWhatsApp
    && (whatsAppTab !== 'comprobante' || whatsAppNotaSeleccionada?.print_a4)
  );

  const openWhatsAppModal = () => {
    setWhatsAppTab('cuotas');
    setWhatsAppNotaVentaId(notasVentaConPdf[0]?.id || '');
    setMetricasData(null);
    setMetricasError('');

    const result = buildMiAutoMessage({ driverName: driverNameFromState || 'Conductor', cuotas: cuotas as any });
    setWhatsAppMessage(result.fullMessage);
    setWhatsAppCuotasMsg(result.cuotasMsg);
    setShowWhatsAppModal(true);
  };

  const handleRefreshWhatsAppPhone = async () => {
    if (!id || refreshingWhatsAppPhone) return;
    setRefreshingWhatsAppPhone(true);
    try {
      const res = await api.post(`/miauto/solicitudes/${id}/whatsapp-phone/refresh`);
      const data = res.data?.data || {};
      const nextPhone = data.phone_after || solicitud?.phone || '';
      if (nextPhone) {
        setSolicitud((prev) => (prev ? { ...prev, phone: nextPhone } : prev));
      }
      if (data.miauto_updated && data.rapidin_updated) {
        toast.success('Número actualizado en Mi Auto y Rapidín');
      } else if (data.miauto_updated) {
        toast.success('Número actualizado desde Fleet');
      } else if (data.rapidin_updated) {
        toast.success('Número actualizado en Rapidín');
      } else if (data.phone_after) {
        toast('El número ya estaba actualizado');
      } else {
        toast.error(data.warnings?.[0] || 'No se encontró un teléfono Fleet válido');
      }
      if (Array.isArray(data.warnings) && data.warnings.length > 0 && data.phone_after) {
        toast(data.warnings[0]);
      }
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al actualizar teléfono');
    } finally {
      setRefreshingWhatsAppPhone(false);
    }
  };

  const handleSendWhatsApp = async () => {
    if (!id || !whatsAppMessage.trim() || !whatsAppPhone) return;
    if (whatsAppTab === 'comprobante' && !whatsAppNotaSeleccionada?.print_a4) {
      toast.error('Selecciona una nota de venta con PDF disponible');
      return;
    }
    setSendingWhatsApp(true);
    try {
      const payload: Record<string, string> = { message: whatsAppMessage };
      if (whatsAppTab === 'comprobante' && whatsAppNotaSeleccionada?.print_a4) {
        payload.nota_venta_id = whatsAppNotaSeleccionada.id;
      }
      const res = await api.post(`/miauto/solicitudes/${id}/send-whatsapp`, payload);
      const sentAsAttachment = res.data?.data?.attachment_sent;
      const sentAsLink = res.data?.data?.fallback_link_sent;
      if (whatsAppTab === 'comprobante' && sentAsLink) {
        toast('El proveedor no aceptó el adjunto; se envió el enlace del PDF por WhatsApp.');
      } else {
        toast.success(sentAsAttachment ? 'Comprobante enviado por WhatsApp' : 'Mensaje enviado por WhatsApp');
      }
      setShowWhatsAppModal(false);
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al enviar el mensaje');
    } finally {
      setSendingWhatsApp(false);
    }
  };

  const fetchMetricas = useCallback(async () => {
    if (!id) return;
    setLoadingMetricas(true);
    setMetricasError('');
    try {
      const res = await api.get(`/miauto/solicitudes/${id}/metricas-yango`);
      const data = res.data?.data ?? res.data;
      setMetricasData(data);
    } catch (err: any) {
      setMetricasError(err.response?.data?.message || 'Error al cargar metricas');
    } finally {
      setLoadingMetricas(false);
    }
  }, [id]);

  const handleWhatsAppTabChange = useCallback((tab: 'cuotas' | 'metricas' | 'comprobante') => {
    setWhatsAppTab(tab);
    if (tab === 'metricas' && !loadingMetricas) {
      fetchMetricas();
    }
  }, [loadingMetricas, fetchMetricas]);

  const metricasMessages = useMemo(() => {
    if (!metricasData?.active_goals?.length) return [];
    const goal = metricasData.active_goals[0];
    const step = goal.steps?.[0];
    if (!step) return [];
    const name = metricasData.driver_name || 'Conductor';
    const meta = step.nrides || 0;
    const completados = goal.total_rides || 0;
    const pct = meta > 0 ? Math.round((completados / meta) * 100) : 0;
    const restantes = Math.max(0, meta - completados);

    const prevGoal = metricasData.previous_goals?.[0];
    const prevMeta = prevGoal?.steps?.[0]?.nrides || 0;
    const prevTotal = prevGoal?.total_rides || 0;
    const prevPct = prevMeta > 0 ? Math.round((prevTotal / prevMeta) * 100) : 0;

    const prevLine = prevGoal?.steps?.[0]?.is_completed && prevMeta > 0
      ? `La semana pasada completaste ${prevMeta} viajes (${prevPct}%). Sigue asi!\n\n`
      : '';

    const messages: string[] = [];

    const partnerFees = metricasData?.currentIncome?.partner_fees || 0;
    const comision = partnerFees > 0 ? Math.round(partnerFees * 0.8333 * 100) / 100 : 0;
    const comisionLine = comision > 0 ? `\n\u2022 Comision acumulada: S/ ${comision.toFixed(2)}` : '';
    const closing = pct >= 100
      ? '\nSigue asi campeon! \uD83D\uDCAA'
      : '\nSigue sumando viajes para acercarte a tu proximo BONO AUTO. Aun estas a tiempo de alcanzar tu meta! \uD83D\uDCAA';

    let title: string;
    if (pct === 0) title = 'Empecemos esta semana con todo!';
    else if (pct <= 25) title = 'Vamos, tu puedes lograrlo!';
    else if (pct <= 50) title = 'Buen ritmo, sigue asi!';
    else if (pct <= 75) title = 'Vas por buen camino!';
    else if (pct < 100) title = 'Casi lo logras!';
    else title = 'Felicitaciones, objetivo cumplido!';

    const msg =
      `${prevLine}Hola, ${name}\n\n` +
      `${title} \uD83D\uDE97\uD83D\uDCA8\n\n` +
      `\uD83D\uDCCA Tu avance semanal:\n` +
      `\u2022 Viajes realizados: ${completados} de ${meta} (${pct}% de la meta)\n` +
      `\u2022 Viajes restantes: ${restantes}` +
      `${comisionLine}\n\n` +
      `${closing}`;

    messages.push(msg);

    return messages;
  }, [metricasData]);

  useEffect(() => {
    if (whatsAppTab === 'metricas' && metricasMessages.length > 0) {
      setWhatsAppMessage(metricasMessages[0]);
    } else if (whatsAppTab === 'comprobante') {
      setWhatsAppMessage(whatsAppComprobanteMsg);
    } else if (whatsAppTab === 'cuotas' && whatsAppCuotasMsg) {
      setWhatsAppMessage(whatsAppCuotasMsg);
    }
  }, [whatsAppTab, metricasMessages, whatsAppCuotasMsg, whatsAppComprobanteMsg]);

  const fetchDetail = useCallback(async (signal?: AbortSignal, opts?: { refresh?: boolean }) => {
    if (!id) return;
    const isRefresh = !!opts?.refresh;
    try {
      if (isRefresh) setRefreshingDetail(true);
      else setLoading(true);
      setError('');
      const req = { signal, headers: MIAUTO_NO_CACHE_HEADERS };
      const response = await api.get(`/miauto/solicitudes/${id}/dashboard`, req);
      const dashboard = response.data?.data ?? response.data ?? {};
      const sol = dashboard.solicitud;
      const cuotasEnvelope = dashboard.cuotas ?? {};
      const { cuotas: rawCuotas, cuotasSemanalesBonificadas: bonoNum } = parseCuotasSemanalesPayload({
        data: cuotasEnvelope,
      });
      const comp = dashboard.comprobantes_cuota_semanal ?? [];
      const compOtros = dashboard.comprobantes_otros_gastos ?? [];
      const evFleet = dashboard.evidencias_fleet ?? [];
      const notas = dashboard.notas_venta ?? [];
      const contratosData = dashboard.contratos ?? [];
      const relatedContractsData = dashboard.contratos_relacionados ?? [];
      setSolicitud(sol || null);
      setCuotas(rawCuotas as CuotaSemanal[]);
      setComprobantesPagos(Array.isArray(comp) ? comp : []);
      setComprobantesOtrosGastos(Array.isArray(compOtros) ? compOtros : []);
      setNotasVenta(Array.isArray(notas) ? notas : []);
      setContratos(Array.isArray(contratosData) ? contratosData : []);
      setContratosRelacionados(Array.isArray(relatedContractsData) ? relatedContractsData : []);

      setEvidenciasFleet(Array.isArray(evFleet) ? evFleet : []);
      setBonoAplicado(bonoNum);
    } catch (e: any) {
      if (isAxiosAbortError(e)) return;
      const msg = e.response?.data?.message || 'Error al cargar el detalle';
      if (isRefresh) {
        toast.error(msg);
      } else {
        setError(msg);
        setSolicitud(null);
        setCuotas([]);
        setComprobantesPagos([]);
        setComprobantesOtrosGastos([]);
        setNotasVenta([]);
        setContratos([]);
        setContratosRelacionados([]);
  
        setEvidenciasFleet([]);
        setBonoAplicado(0);
      }
    } finally {
      if (signal?.aborted) return;
      if (isRefresh) setRefreshingDetail(false);
      else setLoading(false);
    }
  }, [id]);

  const openStartDateCorrectionModal = useCallback(() => {
    setStartDateCorrection(String(solicitud?.fecha_inicio_cobro_semanal || '').slice(0, 10));
    setShowStartDateCorrectionModal(true);
  }, [solicitud?.fecha_inicio_cobro_semanal]);

  const saveStartDateCorrection = useCallback(async () => {
    if (!id || !startDateCorrection) return;
    try {
      setSavingStartDateCorrection(true);
      const response = await api.patch(`/miauto/solicitudes/${id}/fecha-inicio-cobro`, {
        fecha_inicio_cobro_semanal: startDateCorrection,
      });
      toast.success(response.data?.message || 'Inicio de cobro modificado correctamente');
      setShowStartDateCorrectionModal(false);
      await fetchDetail(undefined, { refresh: true });
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo modificar el inicio de cobro');
    } finally {
      setSavingStartDateCorrection(false);
    }
  }, [fetchDetail, id, startDateCorrection]);

  const notasVentaByCuotaId = useMemo(() => {
    const by: Record<string, NotaVentaMiAuto> = {};
    for (const nota of notasVenta) {
      for (const c of nota.cuotas || []) {
        if (c.cuota_semanal_id) by[c.cuota_semanal_id] = nota;
      }
    }
    return by;
  }, [notasVenta]);

  const contratoActivo = useMemo(
    () => contratos.find((contrato) => !contrato.deleted_at) || null,
    [contratos]
  );

  const handleContratoFileChange = useCallback(async (file?: File | null) => {
    if (!id || !file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      setSubiendoContrato(true);
      await api.post(`/miauto/solicitudes/${id}/contratos`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Contrato subido correctamente');
      await fetchDetail(undefined, { refresh: true });
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al subir contrato');
    } finally {
      setSubiendoContrato(false);
      if (contratoFileRef.current) contratoFileRef.current.value = '';
    }
  }, [id, fetchDetail]);

  const handleEliminarContrato = useCallback(async (contratoId: string) => {
    if (!id) return;
    try {
      setEliminandoContratoId(contratoId);
      await api.delete(`/miauto/solicitudes/${id}/contratos/${contratoId}`);
      toast.success('Contrato eliminado');
      await fetchDetail(undefined, { refresh: true });
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al eliminar contrato');
    } finally {
      setEliminandoContratoId(null);
    }
  }, [id, fetchDetail]);

  const togglePagoPuntualCuota = useCallback(async (cuotaId: string, checked: boolean) => {
    if (!id) return;
    const prevCuotas = cuotas;
    setGuardandoPagoPuntualId(cuotaId);
    setCuotas((current) => current.map((c) => (c.id === cuotaId ? { ...c, pago_puntual: checked } : c)));
    try {
      const response = await api.patch(`/miauto/solicitudes/${id}/cuotas-semanales/${cuotaId}/pago-puntual`, {
        pago_puntual: checked,
      });
      const result = unwrapApiData<{
        bono_tiempo?: { enabled?: boolean };
        cuotas_semanales_bonificadas?: number;
      }>(response);
      const nextBonusSummary = result?.bono_tiempo;
      const nextBonusCount = Math.max(0, Number(result?.cuotas_semanales_bonificadas) || 0);
      if (nextBonusSummary?.enabled) {
        setBonoAplicado(nextBonusCount);
      }
      toast.success(checked ? 'Pago puntual marcado' : 'Pago puntual desmarcado');
      if (nextBonusCount > bonoAplicado) {
        await fetchDetail(undefined, { refresh: true });
      }
    } catch (err: any) {
      setCuotas(prevCuotas);
      toast.error(err.response?.data?.message || 'No se pudo actualizar el pago puntual');
    } finally {
      setGuardandoPagoPuntualId(null);
    }
  }, [bonoAplicado, cuotas, fetchDetail, id]);

  const cuotasNotaVentaDisponibles = useMemo(() => {
    return cuotas.filter((c) => {
      const moneda = monedaCuotaRow(c);
      return c.status === 'paid'
        && miautoMontoFacturableNotaVentaCuota(c) > 0.005
        && (moneda === 'PEN' || moneda === 'USD')
        && !notasVentaByCuotaId[c.id];
    });
  }, [cuotas, notasVentaByCuotaId, solicitud?.cronograma_vehiculo?.inicial_moneda]);

  const notaVentaCuotasIds = useMemo(
    () => Object.entries(notaVentaCuotasSeleccionadas).filter(([, checked]) => checked).map(([cuotaId]) => cuotaId),
    [notaVentaCuotasSeleccionadas]
  );

  const notaVentaTotalSeleccionado = useMemo(() => {
    const selected = new Set(notaVentaCuotasIds);
    return roundToTwoDecimals(cuotas.reduce((sum, c) => (
      selected.has(c.id) ? sum + miautoMontoFacturableNotaVentaCuota(c) : sum
    ), 0));
  }, [cuotas, notaVentaCuotasIds]);

  const notaVentaMonedasSeleccionadas = useMemo(() => {
    const selected = new Set(notaVentaCuotasIds);
    return [...new Set(cuotas.filter((c) => selected.has(c.id)).map((c) => monedaCuotaRow(c)))];
  }, [cuotas, notaVentaCuotasIds, solicitud?.cronograma_vehiculo?.inicial_moneda]);
  const notaVentaMonedaSeleccionada = notaVentaMonedasSeleccionadas[0] || 'PEN';
  const notaVentaSeleccionMixta = notaVentaMonedasSeleccionadas.length > 1;
  const facturadorCustomerId = useMemo(() => {
    const n = Number(solicitud?.facturador_customer_id);
    return Number.isInteger(n) && n > 0 ? n : null;
  }, [solicitud?.facturador_customer_id]);
  const [syncingFacturadorCustomer, setSyncingFacturadorCustomer] = useState(false);

  const openNotasVentaModal = useCallback(() => {
    const open = () => {
      const preselected: Record<string, boolean> = {};
      cuotasNotaVentaDisponibles.forEach((c) => { preselected[c.id] = true; });
      setNotaVentaCuotasSeleccionadas(preselected);
      setShowNotasVentaModal(true);
    };
    if (facturadorCustomerId) {
      open();
      return;
    }
    if (!id || syncingFacturadorCustomer) return;
    setSyncingFacturadorCustomer(true);
    api.post(`/miauto/solicitudes/${id}/facturador-customer/sync`)
      .then((response) => {
        const customerId = Number(response.data?.data?.customer_id);
        if (!Number.isInteger(customerId) || customerId <= 0) {
          throw new Error('El facturador no devolvió un customer ID válido');
        }
        setSolicitud((prev) => prev ? { ...prev, facturador_customer_id: customerId } : prev);
        open();
      })
      .catch((error) => {
        toast.error(error.response?.data?.message || error.message || 'No se pudo vincular el cliente del facturador');
      })
      .finally(() => setSyncingFacturadorCustomer(false));
  }, [cuotasNotaVentaDisponibles, facturadorCustomerId, id, syncingFacturadorCustomer]);

  const toggleNotaVentaCuota = useCallback((cuotaId: string) => {
    setNotaVentaCuotasSeleccionadas((prev) => ({ ...prev, [cuotaId]: !prev[cuotaId] }));
  }, []);

  const handleDescargarNotaVenta = useCallback(async (nota: NotaVentaMiAuto, opts?: { fromGeneration?: boolean }) => {
    if (!id || !nota?.id) return;
    try {
      setDescargandoNotaVentaId(nota.id);
      const res = await api.get(`/miauto/solicitudes/${id}/notas-venta/${nota.id}/pdf`, {
        responseType: 'blob',
      });
      const fallbackName = nota.download_name || `${nota.number_full || 'nota-venta'}.pdf`;
      const fileName = fileNameFromDisposition(res.headers['content-disposition'], fallbackName);
      downloadBlob(new Blob([res.data], { type: res.headers['content-type'] || 'application/pdf' }), fileName);
      await fetchDetail(undefined, { refresh: true });
    } catch (e: any) {
      if (opts?.fromGeneration) {
        toast('Nota creada y guardada en Yego Mi Auto, pero no se pudo descargar el PDF automáticamente.');
      } else {
        toast.error(e.response?.data?.message || 'No se pudo descargar la nota de venta');
      }
      if (nota.print_a4) window.open(nota.print_a4, '_blank', 'noopener,noreferrer');
    } finally {
      setDescargandoNotaVentaId(null);
    }
  }, [id, fetchDetail]);

  const handleGenerarNotaVenta = useCallback(async () => {
    if (!id) return;
    if (!facturadorCustomerId) {
      toast.error('Este conductor no tiene customer ID del facturador vinculado');
      return;
    }
    if (notaVentaCuotasIds.length === 0) {
      toast.error('Selecciona al menos una cuota pagada');
      return;
    }
    if (notaVentaSeleccionMixta) {
      toast.error('No puedes mezclar cuotas en soles y dólares en una misma nota de venta');
      return;
    }
    try {
      setGenerandoNotaVenta(true);
      const res = await api.post(`/miauto/solicitudes/${id}/notas-venta/generar`, {
        customer_id: facturadorCustomerId,
        cuota_ids: notaVentaCuotasIds,
      });
      const nota = res.data?.data;
      toast.success(`Nota de venta generada${nota?.number_full ? `: ${nota.number_full}` : ''}`);
      if (Array.isArray(nota?.warnings) && nota.warnings.length > 0) {
        toast('Nota guardada en Yego Mi Auto. Algunos pasos secundarios del facturador quedaron con advertencia.');
      }
      setShowNotasVentaModal(false);
      setNotaVentaCuotasSeleccionadas({});
      await fetchDetail(undefined, { refresh: true });
      if (nota?.id) {
        await handleDescargarNotaVenta(nota, { fromGeneration: true });
      } else if (nota?.print_a4) {
        window.open(nota.print_a4, '_blank', 'noopener,noreferrer');
      }
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al generar la nota de venta');
    } finally {
      setGenerandoNotaVenta(false);
    }
  }, [facturadorCustomerId, id, notaVentaCuotasIds, notaVentaSeleccionMixta, fetchDetail, handleDescargarNotaVenta]);

  const handleConfirmarAnularNotaVenta = useCallback(async () => {
    if (!id || !notaVentaAnularModal?.id) return;
    try {
      setAnulandoNotaVentaId(notaVentaAnularModal.id);
      await api.patch(`/miauto/solicitudes/${id}/notas-venta/${notaVentaAnularModal.id}/anular`);
      toast.success(`Nota de venta anulada${notaVentaAnularModal.number_full ? `: ${notaVentaAnularModal.number_full}` : ''}`);
      setNotaVentaAnularModal(null);
      setNotaVentaCuotasSeleccionadas({});
      await fetchDetail(undefined, { refresh: true });
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al anular la nota de venta');
    } finally {
      setAnulandoNotaVentaId(null);
    }
  }, [id, notaVentaAnularModal, fetchDetail]);

  const handleSubirConformidadAdmin = async (
    cuotaSemanalId: string,
    file: File,
    monto: number,
    moneda: MiautoMoneda
  ) => {
    if (!id) return;
    if (!file || !(file instanceof File)) {
      toast.error('Selecciona un archivo válido');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('monto', String(monto));
    fd.append('moneda', moneda);
    try {
      setSubiendoConformidadCuotaId(cuotaSemanalId);
      await api.post(`/miauto/solicitudes/${id}/cuotas-semanales/${cuotaSemanalId}/comprobantes-conformidad-admin`, fd, {
        headers: { 'Content-Type': undefined as any },
      });
      toast.success('Comprobante de pago (documento para el conductor) subido');
      setConformidadArchivoPendiente((prev) => ({ ...prev, [cuotaSemanalId]: null }));
      setConformidadMontoInput((prev) => {
        const next = { ...prev };
        delete next[cuotaSemanalId];
        return next;
      });
      setConformidadMonedaInput((prev) => {
        const next = { ...prev };
        delete next[cuotaSemanalId];
        return next;
      });
      await fetchDetail(undefined, { refresh: true });
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      toast.error(err.response?.data?.message || 'Error al subir conformidad');
    } finally {
      setSubiendoConformidadCuotaId(null);
    }
  };

  const handleConfirmarEliminarConformidadAdmin = async () => {
    if (!id || !conformidadEliminarModal) return;
    const { comprobanteId } = conformidadEliminarModal;
    try {
      setEliminandoConformidadId(comprobanteId);
      await api.delete(`/miauto/solicitudes/${id}/comprobantes-cuota-semanal/${comprobanteId}/conformidad-admin`);
      toast.success('Comprobante de conformidad eliminado');
      setConformidadEliminarModal(null);
      await fetchDetail(undefined, { refresh: true });
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      toast.error(err.response?.data?.message || 'Error al eliminar el comprobante');
    } finally {
      setEliminandoConformidadId(null);
    }
  };

  useEffect(() => {
    if (!id || tabCronograma !== 'otros_gastos' || gastoConfig) return;
    let active = true;
    setLoadingGastoConfig(true);
    api.get(`/miauto/solicitudes/${id}/otros-gastos/configuracion`)
      .then((response) => {
        if (active) setGastoConfig(response.data?.data ?? response.data);
      })
      .catch((err) => {
        if (active) toast.error(err.response?.data?.message || 'No se pudo cargar la configuracion de gastos');
      })
      .finally(() => {
        if (active) setLoadingGastoConfig(false);
      });
    return () => { active = false; };
  }, [id, tabCronograma, gastoConfig]);

  const saveGastoConfiguration = useCallback(async (config: MiautoGastoConfiguration) => {
    if (!id) return;
    try {
      setSavingGastoConfig(true);
      const payload = { ...config };
      if (
        gastoConfig?.str_gps_heredado
        && Number(config.str_gps_monto_semanal) === Number(gastoConfig.str_gps_monto_semanal)
        && config.str_gps_moneda === gastoConfig.str_gps_moneda
      ) {
        delete payload.str_gps_monto_semanal;
        delete payload.str_gps_moneda;
      }
      const response = await api.patch(`/miauto/solicitudes/${id}/otros-gastos/configuracion`, payload);
      setGastoConfig(response.data?.data ?? response.data);
      toast.success('Configuracion guardada');
      setShowGastoConfigModal(false);
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo guardar la configuracion');
    } finally {
      setSavingGastoConfig(false);
    }
  }, [gastoConfig, id]);

  const saveAndGenerateAdditionalExpenses = useCallback(async (
    config: MiautoGastoConfiguration,
    generation: MiautoGastoGenerationInput,
  ) => {
    if (!id) return;
    try {
      setGeneratingGastos(true);
      const payload = { ...config };
      if (
        gastoConfig?.str_gps_heredado
        && Number(config.str_gps_monto_semanal) === Number(gastoConfig.str_gps_monto_semanal)
        && config.str_gps_moneda === gastoConfig.str_gps_moneda
      ) {
        delete payload.str_gps_monto_semanal;
        delete payload.str_gps_moneda;
      }
      const configResponse = await api.patch(
        `/miauto/solicitudes/${id}/otros-gastos/configuracion`,
        payload,
      );
      setGastoConfig(configResponse.data?.data ?? configResponse.data);
      await api.post(`/miauto/solicitudes/${id}/otros-gastos/generar`, {
        periodo_anio: generation.periodoAnio,
        impuesto_vehicular_monto_total: generation.impuestoVehicularMontoTotal,
      });
      toast.success('Configuracion guardada y periodo generado');
      setShowGastoConfigModal(false);
      await fetchDetail(undefined, { refresh: true });
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudieron generar los gastos');
    } finally {
      setGeneratingGastos(false);
    }
  }, [gastoConfig, id, fetchDetail]);

  const loadAdditionalExpenseFleetCharge = useCallback(async (preferredType?: string | null) => {
    if (!id) return;
    try {
      setLoadingGastoFleetCharge(true);
      const response = await api.get(`/miauto/solicitudes/${id}/otros-gastos/cobrar/preview`);
      const preview = (response.data?.data ?? response.data) as OtroGastoCobroFleetPreview;
      setGastoFleetPreview(preview);
      setGastosFleetSeleccionados({});
      setGastoFleetTipoActivo(canonicalOtrosGastoType(preferredType || preview.expenses[0]?.tipo));
    } catch (err: any) {
      setGastoFleetPreview(null);
      toast.error(err.response?.data?.message || 'No se pudo consultar el saldo Fleet');
    } finally {
      setLoadingGastoFleetCharge(false);
    }
  }, [id]);

  const openAdditionalExpenseFleetCharge = useCallback(() => {
    setGastoComprobanteTarget(null);
    setGastoComprobanteArchivo(null);
    setGastoComprobanteFleetApplicationId(null);
    setShowGastoFleetChargeModal(true);
    void loadAdditionalExpenseFleetCharge();
  }, [loadAdditionalExpenseFleetCharge]);

  const closeAdditionalExpenseFleetCharge = useCallback(() => {
    if (chargingGastoFleet || subiendoGastoComprobante) return;
    setShowGastoFleetChargeModal(false);
    setGastoComprobanteTarget(null);
    setGastoComprobanteArchivo(null);
    setGastoComprobanteFleetApplicationId(null);
  }, [chargingGastoFleet, subiendoGastoComprobante]);

  const selectedAdditionalExpenseFleetIds = useMemo(
    () => Object.entries(gastosFleetSeleccionados)
      .filter(([, selected]) => selected)
      .map(([expenseId]) => expenseId),
    [gastosFleetSeleccionados]
  );

  const selectedAdditionalExpenseFleetTotals = useMemo(() => {
    const selectedIds = new Set(selectedAdditionalExpenseFleetIds);
    return (gastoFleetPreview?.expenses || []).reduce((totals, expense) => {
      if (selectedIds.has(expense.id)) {
        const currency = expense.currency || 'PEN';
        const amount = Number(expense.pending_amount || 0);
        totals[currency] = roundToTwoDecimals((totals[currency] || 0) + amount);
      }
      return totals;
    }, {} as Record<string, number>);
  }, [gastoFleetPreview, selectedAdditionalExpenseFleetIds]);

  const additionalExpenseFleetGroups = useMemo(() => {
    const groups = new Map<string, {
      type: string;
      label: string;
      expenses: OtroGastoCobroFleetRow[];
      totals: Record<string, number>;
    }>();
    for (const expense of gastoFleetPreview?.expenses || []) {
      const type = canonicalOtrosGastoType(expense.tipo);
      const current = groups.get(type) || {
        type,
        label: labelOtrosGastoType(type),
        expenses: [],
        totals: {},
      };
      current.expenses.push(expense);
      const currency = expense.currency || 'PEN';
      current.totals[currency] = roundToTwoDecimals(
        (current.totals[currency] || 0) + Number(expense.pending_amount || 0)
      );
      groups.set(type, current);
    }
    return Array.from(groups.values());
  }, [gastoFleetPreview]);

  const activeAdditionalExpenseFleetGroup = useMemo(
    () => additionalExpenseFleetGroups.find((group) => group.type === gastoFleetTipoActivo)
      || additionalExpenseFleetGroups[0]
      || null,
    [additionalExpenseFleetGroups, gastoFleetTipoActivo]
  );

  const chargeSelectedAdditionalExpenses = useCallback(async () => {
    if (!id || selectedAdditionalExpenseFleetIds.length === 0) return;
    const selectedIds = new Set(selectedAdditionalExpenseFleetIds);
    const hasUnresolvedFleetCharge = (gastoFleetPreview?.expenses || []).some(
      (expense) => selectedIds.has(expense.id) && expense.pending_fleet_application_id
    );
    if (hasUnresolvedFleetCharge) {
      toast.error('Primero sube el comprobante del cobro Fleet anterior');
      return;
    }
    try {
      setChargingGastoFleet(true);
      const response = await api.post(`/miauto/solicitudes/${id}/otros-gastos/cobrar`, {
        otros_gastos_ids: selectedAdditionalExpenseFleetIds,
      });
      const result = response.data?.data ?? response.data;
      const successCount = Number(result?.success || 0);
      const partialCount = Number(result?.partial || 0);
      const failedCount = Number(result?.failed || 0);
      const fleetCount = Number(result?.fleet || 0);
      if (failedCount > 0) {
        toast.error(`Cobro procesado: ${successCount} aplicados y ${failedCount} no realizados`);
      } else if (partialCount > 0) {
        toast.success(`Cobro aplicado parcialmente en ${partialCount} cuota${partialCount === 1 ? '' : 's'}`);
      } else {
        const detail = fleetCount > 0 ? `${fleetCount} desde Fleet` : '';
        toast.success(`${successCount} cuota${successCount === 1 ? '' : 's'} cobrada${successCount === 1 ? '' : 's'}${detail ? `: ${detail}` : ''}`);
      }
      setGastosFleetSeleccionados({});
      await fetchDetail(undefined, { refresh: true });
      await loadAdditionalExpenseFleetCharge();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo realizar el cobro Fleet');
      await loadAdditionalExpenseFleetCharge();
    } finally {
      setChargingGastoFleet(false);
    }
  }, [fetchDetail, gastoFleetPreview, id, loadAdditionalExpenseFleetCharge, selectedAdditionalExpenseFleetIds]);

  const confirmManualAdditionalExpensePayment = useCallback(async () => {
    if (!id || !gastoManualPagoTarget) return;
    try {
      setPagandoGastoManualId(gastoManualPagoTarget.id);
      const response = await api.post(
        `/miauto/solicitudes/${id}/otros-gastos/${gastoManualPagoTarget.id}/marcar-pagado`
      );
      const result = response.data?.data ?? response.data;
      toast.success(result?.alreadyPaid ? 'La cuota ya estaba pagada' : 'Cuota marcada como pagada');
      setGastoManualPagoTarget(null);
      await fetchDetail(undefined, { refresh: true });
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo marcar la cuota como pagada');
    } finally {
      setPagandoGastoManualId(null);
    }
  }, [fetchDetail, gastoManualPagoTarget, id]);

  const openAdditionalExpenseReceiptFromCard = useCallback((expense: MiautoOtrosGastoRow) => {
    if (!expense.pending_fleet_application_id) return;
    setGastoComprobanteTarget(expense);
    setGastoComprobanteMonto(Number(expense.pending_fleet_original_amount || 0).toFixed(2));
    setGastoComprobanteMoneda(expense.pending_fleet_original_currency || expense.moneda || 'PEN');
    setGastoComprobanteArchivo(null);
    setGastoComprobanteFleetApplicationId(expense.pending_fleet_application_id);
    setShowGastoFleetChargeModal(true);
    void loadAdditionalExpenseFleetCharge(expense.tipo);
  }, [loadAdditionalExpenseFleetCharge]);

  const openFleetChargeReceipt = useCallback((expense: OtroGastoCobroFleetRow) => {
    if (!expense.pending_fleet_application_id) return;
    setGastosFleetSeleccionados((current) => {
      const next = { ...current };
      delete next[expense.id];
      return next;
    });
    setGastoComprobanteTarget({
      id: expense.id,
      tipo: expense.tipo,
      periodo_anio: expense.periodo_anio,
      numero_cuota: expense.numero_cuota ?? undefined,
      total_cuotas: expense.total_cuotas,
      week_index: expense.numero_cuota || 1,
      due_date: expense.due_date || '',
      amount_due: expense.amount_due,
      paid_amount: expense.paid_amount,
      pending_amount: expense.pending_amount,
      status: expense.status,
      moneda: expense.currency,
    });
    setGastoComprobanteMonto(Number(expense.pending_fleet_original_amount || 0).toFixed(2));
    setGastoComprobanteMoneda(expense.pending_fleet_original_currency || expense.currency || 'PEN');
    setGastoComprobanteArchivo(null);
    setGastoComprobanteFleetApplicationId(expense.pending_fleet_application_id);
  }, []);

  const openFleetExpenseReceiptPreview = useCallback((expense: OtroGastoCobroFleetRow) => {
    if (!expense.pending_receipt_file_path) return;
    const url = expense.pending_receipt_file_path.startsWith('http')
      ? expense.pending_receipt_file_path
      : getMiautoAdjuntoUrl(expense.pending_receipt_file_path);
    const fileName = expense.pending_receipt_file_name || 'Comprobante de otros gastos';
    setComprobantePreview({
      url,
      fileName,
      isImage: !/\.pdf$/i.test(fileName) && /\.(jpe?g|png|gif|webp)$/i.test(fileName),
    });
  }, []);

  const uploadAdditionalExpenseReceipt = useCallback(async () => {
    if (!id || !gastoComprobanteTarget || !gastoComprobanteArchivo) return;
    const amount = Number(gastoComprobanteMonto.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Ingresa un monto valido');
      return;
    }
    try {
      setSubiendoGastoComprobante(true);
      const formData = new FormData();
      formData.append('file', gastoComprobanteArchivo);
      if (gastoComprobanteFleetApplicationId) {
        formData.append('fleet_application_id', gastoComprobanteFleetApplicationId);
      } else {
        formData.append('monto', amount.toFixed(2));
        formData.append('moneda', gastoComprobanteMoneda);
      }
      await api.post(
        `/miauto/solicitudes/${id}/otros-gastos/${gastoComprobanteTarget.id}/comprobantes`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      toast.success(gastoComprobanteFleetApplicationId
        ? 'Comprobante enviado a validacion'
        : 'Comprobante subido y aplicado al gasto');
      setGastoComprobanteTarget(null);
      setGastoComprobanteArchivo(null);
      setGastoComprobanteFleetApplicationId(null);
      await fetchDetail(undefined, { refresh: true });
      await loadAdditionalExpenseFleetCharge();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo subir el comprobante');
    } finally {
      setSubiendoGastoComprobante(false);
    }
  }, [
    id,
    gastoComprobanteTarget,
    gastoComprobanteArchivo,
    gastoComprobanteMonto,
    gastoComprobanteMoneda,
    gastoComprobanteFleetApplicationId,
    fetchDetail,
    loadAdditionalExpenseFleetCharge,
  ]);

  const handleSubirEvidenciasFleetCuota = async (cuotaId: string) => {
    if (!id) return;
    const inputEl = evidenciaFleetFileRefs.current[cuotaId];
    if (!inputEl?.files?.length) return;
    setSubiendoEvidenciaCuotaId(cuotaId);
    const formData = new FormData();
    formData.append('cuota_semanal_id', cuotaId);
    const files = inputEl.files;
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }
    try {
      const resp = await api.post(`/miauto/solicitudes/${id}/evidencias-fleet`, formData, {
        headers: { 'Content-Type': undefined as any },
      });
      toast.success(resp.data?.message || 'Evidencias subidas correctamente');
      await fetchDetail(undefined, { refresh: true });
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al subir evidencias');
    } finally {
      setSubiendoEvidenciaCuotaId(null);
      if (inputEl) inputEl.value = '';
    }
  };

  const handleEliminarEvidenciaFleet = async (evId: string) => {
    if (!id) return;
    setEliminandoEvidenciaId(evId);
    try {
      await api.delete(`/miauto/solicitudes/${id}/evidencias-fleet/${evId}`);
      setEvidenciasFleet((prev) => prev.filter((e) => e.id !== evId));
      toast.success('Evidencia eliminada');
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al eliminar');
    } finally {
      setEliminandoEvidenciaId(null);
    }
  };

  useEffect(() => {
    const ac = new AbortController();
    fetchDetail(ac.signal);
    return () => ac.abort();
  }, [fetchDetail]);

  const planCuotasTotal = miautoTotalCuotasPlanVehiculo(
    solicitud?.cronograma_vehiculo?.cuotas_semanales,
    cuotas.length
  );
  const cuotasPagadas = cuotas.filter((c) => c.status === 'paid' || c.status === 'bonificada').length;
  const cuotasVencidas = cuotas.filter((c) => c.status === 'overdue').length;

  const cronPg = useTablePagination(cuotas, {
    initialLimit: 20,
    pageSizes: [10, 20, 50],
  });
  const otrosGastosRows = useMemo(
    () => (Array.isArray(solicitud?.otros_gastos) ? solicitud.otros_gastos : []),
    [solicitud?.otros_gastos]
  );
  const activeOtrosGastoTypes = useMemo(() => {
    const rawRequirements = solicitud?.cronograma_vehiculo?.requisitos_gastos;
    if (!rawRequirements) return [];
    const requirements = mergeRequisitosGastosFromApi(rawRequirements);
    const vehicleType = mergeRequisitosFromApi(
      solicitud?.cronograma?.requisitos_vehiculo,
    ).tipo_vehiculo;
    return configuredExpenseKeys(requirements, vehicleType).map(canonicalOtrosGastoType);
  }, [
    solicitud?.cronograma?.requisitos_vehiculo,
    solicitud?.cronograma_vehiculo?.requisitos_gastos,
  ]);
  const activeOtrosGastoTypeSet = useMemo(
    () => new Set(activeOtrosGastoTypes),
    [activeOtrosGastoTypes],
  );
  const otrosGastosSummary = useMemo(() => otrosGastosRows.reduce((summary, expense) => {
    const currency = expense.moneda || 'PEN';
    summary.totals[currency] = roundToTwoDecimals(
      (summary.totals[currency] || 0) + Number(expense.amount_due || 0)
    );
    if (expense.status === 'paid') summary.paid += 1;
    else if (expense.status === 'overdue') summary.overdue += 1;
    else if (expense.status === 'pending') summary.pending += 1;
    return summary;
  }, {
    totals: {} as Record<string, number>,
    paid: 0,
    pending: 0,
    overdue: 0,
  }), [otrosGastosRows]);
  const otrosGastosGroups = useMemo(() => {
    const grouped = new Map<string, MiautoOtrosGastoRow[]>();
    for (const type of activeOtrosGastoTypes) grouped.set(type, []);
    for (const expense of otrosGastosRows) {
      const type = canonicalOtrosGastoType(expense.tipo);
      const expenses = grouped.get(type) || [];
      expenses.push(expense);
      grouped.set(type, expenses);
    }
    return Array.from(grouped, ([type, expenses]) => ({
      type,
      expenses,
      paid: expenses.filter((expense) => expense.status === 'paid').length,
      periods: Array.from(new Set(expenses.map(
        (expense) => expense.periodo_anio || String(expense.due_date || '').slice(0, 4) || 'Sin periodo'
      ))),
      totals: expenses.reduce((totals, expense) => {
        const currency = expense.moneda || 'PEN';
        totals[currency] = roundToTwoDecimals(
          (totals[currency] || 0) + Number(expense.amount_due || 0)
        );
        return totals;
      }, {} as Record<string, number>),
    }));
  }, [activeOtrosGastoTypes, otrosGastosRows]);

  const comprobantesByCuotaId = useMemo(() => {
    const by: Record<string, ComprobanteCuotaSemanal[]> = {};
    for (const comp of comprobantesPagos) {
      const cid = comp.cuota_semanal_id;
      if (!by[cid]) by[cid] = [];
      by[cid].push(comp);
    }
    return by;
  }, [comprobantesPagos]);

  const evidenciasByCuotaId = useMemo(() => {
    const by: Record<string, typeof evidenciasFleet> = {};
    for (const ev of evidenciasFleet) {
      const cid = ev.cuota_semanal_id;
      if (!cid) continue;
      if (!by[cid]) by[cid] = [];
      by[cid].push(ev);
    }
    return by;
  }, [evidenciasFleet]);

  const kpiTotalesPorMoneda = useMemo(() => {
    let totalPagadoPEN = 0;
    let totalPagadoUSD = 0;
    let totalVencidoPEN = 0;
    let totalVencidoUSD = 0;
    for (const c of cuotas) {
      const pagado = miautoMontoPagadoCuotaSemanal(c.paid_amount);
      const pendienteMostrar = Math.max(0, miautoCuotaFinalCronogramaSemanal(c));
      const m = monedaCuotaRow(c);
      if (m === 'USD') {
        totalPagadoUSD += pagado;
        if (c.status === 'overdue') totalVencidoUSD += pendienteMostrar;
      } else {
        totalPagadoPEN += pagado;
        if (c.status === 'overdue') totalVencidoPEN += pendienteMostrar;
      }
    }
    return { totalPagadoPEN, totalPagadoUSD, totalVencidoPEN, totalVencidoUSD };
  }, [cuotas, solicitud?.cronograma_vehiculo?.inicial_moneda]);

  const monedaSolicitud = cuotas.length > 0
    ? monedaCuotaRow(cuotas[0])
    : (solicitud?.cronograma_vehiculo?.inicial_moneda === 'USD' ? 'USD' : 'PEN');

  const comprobantesOtrosGastosPorGasto = useMemo(() => {
    const grouped = new Map<string, ComprobanteOtrosGastos[]>();
    for (const receipt of comprobantesOtrosGastos) {
      const current = grouped.get(receipt.otros_gastos_id) || [];
      current.push(receipt);
      grouped.set(receipt.otros_gastos_id, current);
    }
    for (const receipts of grouped.values()) {
      receipts.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
    }
    return grouped;
  }, [comprobantesOtrosGastos]);

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[320px]">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
      </div>
    );
  }

  if (error || !solicitud) {
    return (
      <div className="space-y-4">
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error || 'Solicitud no encontrada'}
        </div>
        <button
          type="button"
          onClick={() => navigate('/admin/yego-mi-auto/rent-sale', { state: getBackToListState() })}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#8B1A1A] hover:bg-red-50 rounded-lg border border-[#8B1A1A]"
        >
          <ArrowLeft className="w-4 h-4" />
          Volver a Alquiler / Venta
        </button>
      </div>
    );
  }

  const bonoTiempoActivo = solicitud.cronograma?.bono_tiempo_activo === true;
  const driverDisplayName = driverDisplayRentSale(solicitud, driverNameFromState);

  return (
    <div ref={detailPageRef} className="space-y-6">
      {nextNavigationItem && (
        <div className="flex shrink-0 justify-end">
          <button
            type="button"
            onClick={goToNextDriver}
            className="inline-flex max-w-full items-center gap-2 rounded-lg border border-[#8B1A1A]/30 bg-white px-4 py-2 text-sm font-semibold text-[#8B1A1A] shadow-sm transition-colors hover:border-[#8B1A1A] hover:bg-red-50"
            title="Ir al siguiente conductor"
          >
            <span className="max-w-[18rem] truncate">{nextNavigationItem.driver_name || 'Conductor sin nombre'}</span>
            <ChevronRight className="h-4 w-4 shrink-0" />
          </button>
        </div>
      )}
      <header className="rounded-lg bg-[#8B1A1A] p-4 lg:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
                <Banknote className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
                  {driverDisplayName}
                </h1>
                <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                  Cronograma y métricas del contrato
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAttachContractModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-[#8B1A1A] transition-colors hover:bg-red-50"
              title="Anexar otro contrato al mismo conductor"
            >
              <Plus className="h-4 w-4" />
              Anexar contrato
            </button>
            {solicitud?.status === 'aprobado' && solicitud?.fecha_inicio_cobro_semanal && (
              <>
                <button
                  type="button"
                  onClick={() => setShowGenerarCuotaModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white text-sm font-medium transition-colors"
                  title="Generar cuota semanal manual"
                >
                  <Plus className="w-4 h-4" />
                  Cuota
                </button>
                <button
                  type="button"
                  onClick={openNotasVentaModal}
                  disabled={syncingFacturadorCustomer}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white text-sm font-medium transition-colors disabled:opacity-60"
                  title="Generar nota de venta para cuotas pagadas"
                >
                  <ReceiptText className="w-4 h-4" />
                  {syncingFacturadorCustomer ? 'Vinculando…' : 'Generar boletas'}
                </button>
                <div className="w-px h-6 bg-white/20" />
              </>
            )}
            <button
              type="button"
              onClick={openWhatsAppModal}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#25D366]/20 hover:bg-[#25D366]/40 text-white text-sm font-medium transition-colors"
              title="Enviar mensaje por WhatsApp"
            >
              <FaWhatsapp className="w-4 h-4" />
              WhatsApp
            </button>
            <input
              ref={contratoFileRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              className="hidden"
              onChange={(e) => handleContratoFileChange(e.target.files?.[0] || null)}
            />
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowContratoMenu((prev) => !prev)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white text-sm font-medium transition-colors"
                title="Opciones del documento contractual"
              >
                <FileText className="w-4 h-4" />
                Documento contractual
                <ChevronDown className={`w-4 h-4 transition-transform ${showContratoMenu ? 'rotate-180' : ''}`} />
              </button>

              {showContratoMenu && (
                <div className="absolute right-0 top-full z-30 mt-2 w-64 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl">
                  <div className="border-b border-gray-100 px-3 py-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Documento contractual</p>
                    <p className="mt-0.5 truncate text-sm font-medium text-gray-900">
                      {contratoActivo?.file_name || 'Sin contrato activo'}
                    </p>
                  </div>

                  <div className="py-1">
                    {contratoActivo?.file_path && (
                      <a
                        href={getMiautoAdjuntoUrl(contratoActivo.file_path)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setShowContratoMenu(false)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <ExternalLink className="h-4 w-4 text-gray-500" />
                        Ver contrato
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setShowContratoMenu(false);
                        contratoFileRef.current?.click();
                      }}
                      disabled={subiendoContrato}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Upload className="h-4 w-4 text-gray-500" />
                      {subiendoContrato ? 'Subiendo...' : contratoActivo ? 'Volver a subir' : 'Subir contrato'}
                    </button>
                    {contratoActivo && (
                      <>
                        <div className="my-1 h-px bg-gray-100" />
                        <button
                          type="button"
                          onClick={() => {
                            setShowContratoMenu(false);
                            handleEliminarContrato(contratoActivo.id);
                          }}
                          disabled={eliminandoContratoId === contratoActivo.id}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" />
                          {eliminandoContratoId === contratoActivo.id ? 'Eliminando...' : 'Eliminar contrato'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[#8B1A1A]">Contratos del conductor</h2>
            <p className="text-xs text-gray-500">Selecciona un contrato para ver y administrar sus procesos independientes.</p>
          </div>
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
            {contratosRelacionados.length} contrato{contratosRelacionados.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {contratosRelacionados.map((contract) => {
            const selected = contract.id === id;
            return (
              <button
                key={contract.id}
                type="button"
                onClick={() => {
                  if (selected) return;
                  navigate(`/admin/yego-mi-auto/rent-sale/${contract.id}`, {
                    state: { ...listState, driver_name: driverDisplayName },
                  });
                }}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  selected
                    ? 'border-[#8B1A1A] bg-red-50 ring-1 ring-[#8B1A1A]/20'
                    : 'border-gray-200 hover:border-[#8B1A1A]/50 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Contrato {contract.contrato_numero}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${contract.etapa === 'activo' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                    {contract.etapa === 'activo' ? 'Activo' : 'Por activar'}
                  </span>
                </div>
                <p className="mt-2 font-mono text-base font-bold tracking-wide text-gray-900">{contract.placa_asignada || 'Sin placa'}</p>
                <p className="truncate text-xs text-gray-600">{contract.vehiculo_name || contract.cronograma_name || 'Sin vehículo configurado'}</p>
                <p className="mt-2 text-[11px] text-gray-500">
                  {Number(contract.cuotas_pagadas || 0)} pagadas · {Number(contract.cuotas_vencidas || 0)} vencidas
                </p>
              </button>
            );
          })}
        </div>
      </section>

      {!solicitud.fecha_inicio_cobro_semanal && solicitud.origen_registro === 'contrato_adicional' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-amber-900">Contrato adicional pendiente de activación</p>
            <p className="text-xs text-amber-800">Registra y valida el pago inicial antes de iniciar el cronograma semanal.</p>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/admin/yego-mi-auto/requests/${id}`)}
            className="rounded-lg bg-amber-800 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-900"
          >
            Configurar pago e iniciar
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => navigate('/admin/yego-mi-auto/rent-sale', { state: getBackToListState() })}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#8B1A1A] rounded-lg"
        >
          <ArrowLeft className="w-4 h-4" />
          Volver a Alquiler / Venta
        </button>
      </div>

      {/* Métricas KPI */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
            <div className="flex items-center gap-2 text-gray-600 text-sm mb-1">
              <Calendar className="w-4 h-4" />
              <span>Cuotas</span>
            </div>
            <p className="text-xl font-bold text-gray-900">
              {cuotasPagadas} / {planCuotasTotal}
            </p>
            <p className="text-xs text-gray-500">pagadas del plan</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
            <div className="flex items-center gap-2 text-gray-600 text-sm mb-1">
              <TrendingUp className="w-4 h-4" />
              <span>Vencidas</span>
            </div>
            <p className={`text-xl font-bold ${cuotasVencidas > 0 ? 'text-red-600' : 'text-gray-900'}`}>
              {cuotasVencidas}
            </p>
          </div>
          <div className="bg-white rounded-lg border border-green-100 p-4 shadow-sm">
            <div className="flex items-center gap-2 text-green-700 text-sm mb-1">
              <Banknote className="w-4 h-4" />
              <span>Total pagado</span>
            </div>
            <p className="text-xl font-bold text-green-800">
              {monedaSolicitud === 'USD'
                ? `$ ${kpiTotalesPorMoneda.totalPagadoUSD.toFixed(2)}`
                : `S/. ${kpiTotalesPorMoneda.totalPagadoPEN.toFixed(2)}`}
            </p>
          </div>
          <div className="bg-white rounded-lg border border-red-100 p-4 shadow-sm">
            <div className="flex items-center gap-2 text-red-700 text-sm mb-1">
              <Banknote className="w-4 h-4" />
              <span>Vencido</span>
            </div>
            <p
              className={`text-xl font-bold ${
                (monedaSolicitud === 'USD' ? kpiTotalesPorMoneda.totalVencidoUSD : kpiTotalesPorMoneda.totalVencidoPEN) > 0 ? 'text-red-600' : 'text-gray-900'
              }`}
            >
              {monedaSolicitud === 'USD'
                ? `$ ${kpiTotalesPorMoneda.totalVencidoUSD.toFixed(2)}`
                : `S/. ${kpiTotalesPorMoneda.totalVencidoPEN.toFixed(2)}`}
            </p>
            <p className="text-xs text-gray-500">saldo en cuotas vencidas</p>
          </div>
          {bonoTiempoActivo && (
            <div className="bg-white rounded-lg border border-[#8B1A1A]/20 p-4 shadow-sm">
              <div className="flex items-center gap-2 text-[#8B1A1A] text-sm mb-1">
                <Award className="w-4 h-4" />
                <span>Bono tiempo</span>
              </div>
              <p className="text-xl font-bold text-[#8B1A1A]">{bonoAplicado}</p>
              <p className="text-xs text-gray-500">
                {bonoAplicado >= 1 ? `${bonoAplicado} cuota${bonoAplicado !== 1 ? 's' : ''} consolidada${bonoAplicado !== 1 ? 's' : ''}` : 'sin bonos aún'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Datos del contrato */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-[#8B1A1A] uppercase tracking-wide mb-3">Datos del contrato</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 text-sm">
          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-gray-400" />
            <div>
              <span className="text-gray-500 block">DNI</span>
              <span className="font-medium text-gray-900">{solicitud.dni || '—'}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-gray-400" />
            <div>
              <span className="text-gray-500 block">Cronograma</span>
              <span className="font-medium text-gray-900">{solicitud.cronograma?.name || '—'}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Car className="w-4 h-4 text-gray-400" />
            <div>
              <span className="text-gray-500 block">Vehículo</span>
              <span className="font-medium text-gray-900">{solicitud.cronograma_vehiculo?.name || '—'}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-gray-400" />
            <div>
              <span className="text-gray-500 block">Placa</span>
              <span className="font-medium text-gray-900 font-mono tracking-wide">{solicitud.placa_asignada || '—'}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-gray-400" />
            <div className="min-w-0">
              <span className="text-gray-500 block">Inicio cobro</span>
              <span className="block font-medium text-gray-900">
                {solicitud.fecha_inicio_cobro_semanal
                  ? formatDate(solicitud.fecha_inicio_cobro_semanal, 'es-ES')
                  : '—'}
              </span>
              {user?.role !== 'driver' && solicitud.fecha_inicio_cobro_semanal && (
                <button
                  type="button"
                  onClick={openStartDateCorrectionModal}
                  className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-[#8B1A1A]/20 bg-red-50 px-2.5 text-xs font-semibold text-[#8B1A1A] shadow-sm transition-colors hover:border-[#8B1A1A]/40 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/20"
                  title="Corregir inicio de cobro"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Modificar
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Cronograma semanal + Otros gastos (pestañas) */}
      <div className="relative min-h-[200px] rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="sticky top-0 z-30 flex gap-0.5 border-b border-gray-200 bg-white px-2 shadow-sm sm:px-3" role="tablist" aria-label="Cronograma y otros gastos">
          <button
            type="button"
            role="tab"
            aria-selected={tabCronograma === 'semanales'}
            onClick={() => setTabCronograma('semanales')}
            className={`px-3 sm:px-4 py-3 text-xs sm:text-sm font-semibold uppercase tracking-wide border-b-2 -mb-px transition-colors ${
              tabCronograma === 'semanales'
                ? 'border-[#8B1A1A] text-[#8B1A1A]'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            Cronograma semanal
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tabCronograma === 'otros_gastos'}
            onClick={() => setTabCronograma('otros_gastos')}
            className={`px-3 sm:px-4 py-3 text-xs sm:text-sm font-semibold uppercase tracking-wide border-b-2 -mb-px transition-colors ${
              tabCronograma === 'otros_gastos'
                ? 'border-[#8B1A1A] text-[#8B1A1A]'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            Otros gastos
          </button>
        </div>

        <div>
        {tabCronograma === 'semanales' && (
        <>
        {cuotas.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            Aún no hay cuotas generadas para este contrato.
          </div>
        ) : (
          <>
          <div className="px-4 pt-3 pb-1">
            <div className="-mx-1 overflow-x-auto rounded-lg border border-gray-100 bg-white px-1 sm:mx-0 sm:px-0 xl:overflow-visible">
            <table className="w-full min-w-[1280px] table-fixed border-collapse text-sm">
              <colgroup>
                <col style={{ width: '8.5%' }} />
                <col style={{ width: '7.5%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '6.5%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '6.5%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '9.5%' }} />
                <col style={{ width: '6%' }} />
                <col style={{ width: '8.5%' }} />
              </colgroup>
              <thead className="sticky top-0 z-20 xl:top-[49px]">
                <tr className="border-b border-gray-200 bg-gray-50/80">
                  <th className="sticky left-0 z-[1] bg-gray-50/95 py-2.5 pl-3 pr-1.5 align-middle text-left text-[11px] font-semibold uppercase tracking-wide text-gray-700 shadow-[2px_0_6px_-2px_rgba(0,0,0,0.06)] leading-tight">
                    <span className="block">Semana</span>
                  </th>
                  <th className="py-2.5 pr-1.5 align-middle text-left text-[11px] font-semibold uppercase tracking-wide text-gray-600 leading-tight">
                    <span className="block">Fecha</span>
                  </th>
                  <th className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-gray-900 leading-tight">
                    <span className="inline-block text-right">Viajes<br/>Bono</span>
                  </th>
                  <th className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-gray-900 leading-tight">
                    <span className="inline-block text-right">Cuota<br/>Semanal</span>
                  </th>
                  <th
                    className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-green-700 leading-tight"
                    title="83% del fee de socio Yango retenido sobre ingresos de la semana."
                  >
                    <span className="inline-block text-right">Recaudo<br/>por semana</span>
                  </th>
                  <th
                    className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-green-700 leading-tight"
                    title="Monto retirado del saldo del conductor en Yango Fleet acreditado a esta cuota."
                  >
                    <span className="block text-right">Cobro<br/>saldo</span>
                  </th>
                  <th className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-gray-900 leading-tight"
                    title="Saldo pendiente del capital cuota (sin mora).">
                    <span className="inline-block text-right">Cuota a<br/>pagar</span>
                  </th>
                  <th className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-red-600 leading-tight"
                    title="Saldo mora pendiente.">
                    <span className="block text-right">Mora</span>
                    {solicitud?.cronograma?.tasa_interes_mora != null && Number(solicitud.cronograma.tasa_interes_mora) > 0
                      ? ` (${(Number(solicitud.cronograma.tasa_interes_mora) * 100).toFixed(2)}%)`
                      : ''}
                  </th>
                  <th className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-orange-600 leading-tight">
                    <span className="block text-right">Pendiente<br/>de pago</span>
                  </th>
                  <th className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-green-700 leading-tight">
                    <span className="block text-right">Pagado</span>
                  </th>
                  <th className="py-2.5 pl-1 pr-3 align-middle text-center text-[11px] font-semibold uppercase tracking-wide text-gray-700 leading-tight">
                    <span className="block">Estado</span>
                  </th>
                  {bonoTiempoActivo && (
                    <th className="py-2.5 pl-1 pr-3 align-middle text-center text-[11px] font-semibold uppercase tracking-wide text-gray-700 leading-tight">
                      <span className="block">Pago<br/>puntual</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {cronPg.paginatedItems.map((c, index) => {
                  const numeroSemana =
                    miautoSemanaLista(cuotas, c.week_start_date) ??
                    miautoSemanaOrdinalPorVencimiento(cuotas, c.due_date, c.week_start_date) ??
                    (cronPg.page - 1) * cronPg.limit + index + 1;
                  const comps = comprobantesByCuotaId[c.id] ?? [];
                  const origenComp = (cp: ComprobanteCuotaSemanal) => (cp.origen || 'conductor').toLowerCase();
                  const compsConductor = comps.filter((cp) => origenComp(cp) === 'conductor');
                  const conformidadesAdmin = comps.filter((cp) => origenComp(cp) === 'admin_confirmacion');
                  const pagosManualReg = comps.filter((cp) => origenComp(cp) === 'pago_manual');
                  const pendienteRestanteConformidad = pendienteRestanteConformidadCuota(c);
                  const conformidadBloqueadaSinSaldo = pendienteRestanteConformidad <= 0.005;
                  const cuotaFinalSemana = miautoCuotaFinalCronogramaSemanal(c);
                  const montoPagadoDisplay = miautoMontoPagadoColumnaCronograma(c);
                  const abierto = comprobantesSemanaAbierta[c.id] === true;
                  const symCuota = symMoneda(monedaCuotaRow(c));
                  const bonoAutoVal = miautoNum(c.bono_auto);
                  const tributoCobroIngresos = miautoCobroPorIngresosTributoDisplay(c);
                  const titleCobroIngresos = miautoTooltipCobroPorIngresos(symCuota, c, cuotas);
                  const filasCascadaCobro = miautoCascadaCobroIngresosFilasParaUi(cuotas, c);
                  // Usar valores del API (backend ya calcula todo correctamente)
                  const moraPendiente = miautoNum(c.mora_pendiente ?? 0);
                  const moraAcumulada = miautoNum(c.mora_acumulada ?? c.late_fee ?? 0);
                  const moraExtra = miautoNum(c.mora_extra);
                  const moraExtraTotal = miautoNum(c.mora_extra_total ?? c.mora_extra);
                  const paidReal = miautoNum(c.paid_amount);
                  const moraPagada = roundToTwoDecimals(Math.min(paidReal, Math.max(0, moraAcumulada - moraPendiente)));
                  const moraExtraPagada = roundToTwoDecimals(miautoNum(c.mora_extra_cobrada ?? Math.max(0, moraExtraTotal - moraExtra)));
                  const cuotaOriginal = miautoNum(c.amount_due);
                  const cuotaPagada = roundToTwoDecimals(Math.min(cuotaOriginal, Math.max(0, paidReal - moraPagada - moraExtraPagada)));
                  const cuotaCapitalPendienteApi = c.status === 'paid' || c.status === 'bonificada' ? 0 : miautoCuotaCapitalPendienteColumna(c);
                  const cuotaAPagarNeta = roundToTwoDecimals(Math.max(0, cuotaCapitalPendienteApi, cuotaOriginal - cuotaPagada));
                  const saldoFavor = miautoNum(c.saldo_favor_conductor);
                  const cobroSaldoRefs = Array.isArray(c.cobro_saldo_referencia) ? c.cobro_saldo_referencia : [];
                  const cobroSaldoReferenciadoComoDestino = cuotas.some((cc) =>
                    cc.id !== c.id &&
                    Array.isArray(cc.cobro_saldo_referencia) &&
                    cc.cobro_saldo_referencia.some((ref) => String(ref.cuota_semanal_id || '') === c.id)
                  );
                  const cobroSaldoDisplay = cobroSaldoReferenciadoComoDestino ? 0 : miautoCobroSaldoDisplay(c);
                  const recaudoDisplay = miautoNum(c.partner_fees_83);
                  const pagoRealDisplay = montoPagadoDisplay;
                  const pagadoCubiertoDisplay = c.status === 'paid'
                    ? roundToTwoDecimals(pagoRealDisplay + recaudoDisplay)
                    : pagoRealDisplay;
                  const mostrarDesglosePagado = c.status === 'paid' && recaudoDisplay > 0.005;
                  const pendienteDisplay = roundToTwoDecimals(Math.max(
                    miautoCuotaFinalCronogramaSemanal(c),
                    cuotaAPagarNeta + moraPendiente + moraExtra
                  ));
                  return (
                  <Fragment key={c.id}>
                  <tr className="group border-b border-gray-100 hover:bg-gray-50/60">
                    {/* Semana */}
                    <td className="sticky left-0 z-[1] bg-white py-2.5 pl-3 pr-2 align-middle shadow-[2px_0_6px_-2px_rgba(0,0,0,0.06)] group-hover:bg-gray-50/80">
                      <button type="button" onClick={() => toggleComprobantesSemana(c.id)} className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0 text-left text-[13px] leading-snug text-gray-700 transition-colors hover:bg-gray-100/90">
                        {abierto ? <ChevronDown className="h-4 w-4 flex-shrink-0 self-center text-gray-500" aria-hidden /> : <ChevronRight className="h-4 w-4 flex-shrink-0 self-center text-gray-500" aria-hidden />}
                        <span className="min-w-0 truncate font-semibold text-[#8B1A1A]">Semana {numeroSemana}</span>
                      </button>
                    </td>
                    {/* Fecha */}
                    <td className="py-2.5 pr-1.5 align-middle text-[12px] leading-snug text-gray-700 whitespace-nowrap">
                      {c.due_date ? formatDate(c.due_date, 'es-ES') : c.week_start_date ? formatDate(c.week_start_date, 'es-ES') : '—'}
                    </td>
                    {/* Viajes - Bono Auto */}
                    <td className="py-2.5 px-1 align-middle text-[11px] tabular-nums text-right leading-snug">
                      {c.num_viajes != null ? (
                        <><span className="text-gray-700">{c.num_viajes} — </span><span className="text-green-700">Bono {miautoFmtMonto(symCuota, bonoAutoVal)}</span></>
                      ) : c.bono_auto != null ? (
                        <span className="text-green-700">Bono {miautoFmtMonto(symCuota, bonoAutoVal)}</span>
                      ) : (<span className="text-gray-500">—</span>)}
                    </td>
                    {/* Cuota Semanal */}
                    <td className="py-2.5 px-1 align-middle font-medium tabular-nums text-gray-900 text-right text-[12px]">
                      {miautoFmtMonto(symCuota, miautoCuotaSemanalOAbonoDisplay(c))}
                    </td>
                    {/* Cobro por ingresos */}
                    <td className="py-2.5 px-1 align-top text-[11px] tabular-nums text-right text-green-700" title={titleCobroIngresos}>
                      <div className="flex min-w-0 flex-col items-end gap-1">
                        <span className="font-medium">{miautoFmtMonto(symCuota, miautoNum(c.partner_fees_83))}</span>
                        {filasCascadaCobro.length > 0 ? (
                          <div className="w-full min-w-0 text-[10px] font-normal leading-snug text-gray-600">
                            {filasCascadaCobro.map((it, idx) => (
                              <span key={idx} className="block tabular-nums">
                                →{' '}
                                {it.semana != null ? (<>Semana {it.semana}: {miautoFmtMonto(symCuota, it.monto)}</>
                                ) : it.week_start_ymd ? (<>Lunes {formatDate(it.week_start_ymd + 'T12:00:00', 'es-ES')}: {miautoFmtMonto(symCuota, it.monto)}</>
                                ) : (<>{miautoFmtMonto(symCuota, it.monto)}</>)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <span className="text-[10px] text-gray-500">83.33%: {miautoFmtMonto(symCuota, tributoCobroIngresos)}</span>
                        {saldoFavor > 0.005 && (
                          <span className="text-[10px] font-medium text-blue-600">Saldo a favor: {miautoFmtMonto(symCuota, saldoFavor)}</span>
                        )}
                      </div>
                    </td>
                    {/* Cobro saldo */}
                    <td className="py-2.5 px-1 align-top text-[11px] tabular-nums text-right text-green-700">
                      <div className="flex min-w-0 flex-col items-end gap-1">
                        {(() => {
                          return (
                            <>
                              <span>{miautoFmtMonto(symCuota, cobroSaldoDisplay)}</span>
                              {cobroSaldoRefs.length > 0 && (
                                <div className="flex max-w-[120px] flex-col items-end gap-0.5 text-[10px] font-normal leading-tight text-gray-600">
                                  {cobroSaldoRefs.map((ref, idx) => {
                                    const refDate = ref.due_date || ref.week_start_date || '';
                                    const semana = ref.semana ?? (refDate ? miautoSemanaOrdinalPorVencimiento(cuotas, refDate, ref.week_start_date || refDate) : null);
                                    const title = `${miautoFmtMonto(symCuota, ref.monto)} aplicado a ${semana ? `Semana ${semana}` : 'otra cuota'}${refDate ? ` (${formatDate(refDate, 'es-ES')})` : ''}`;
                                    return (
                                      <span
                                        key={`${ref.cuota_semanal_id || idx}-${idx}`}
                                        className="inline-flex max-w-full items-center justify-end truncate rounded-full border border-green-100 bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700"
                                        title={title}
                                      >
                                        → Sem. {semana || '-'} · {miautoFmtMonto(symCuota, ref.monto)}
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </td>
                    {/* Cuota a pagar */}
                    <td className="py-2.5 px-1 align-middle font-medium tabular-nums text-right text-gray-900 text-[12px]" title="Cuota neta después de descuentos (Recaudo + Cobro saldo)">
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="text-[10px] text-gray-400">Total: {miautoFmtMonto(symCuota, cuotaOriginal)}</span>
                        <span className="block font-semibold">{miautoFmtMonto(symCuota, cuotaAPagarNeta)}</span>
                        {cuotaPagada > 0.005 && (
                          <span className="text-[10px] font-normal leading-snug text-green-700">
                            Cobrado: {miautoFmtMonto(symCuota, cuotaPagada)}
                          </span>
                        )}
                      </div>
                    </td>
                    {/* Mora */}
                    <td className="py-2.5 px-1 align-middle font-medium tabular-nums text-right text-[12px] text-red-600">
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="text-[10px] text-gray-400">Generada: {miautoFmtMonto(symCuota, moraAcumulada)}</span>
                        <span className="block font-semibold" title="Mora pendiente por cobrar">
                          {miautoFmtMonto(symCuota, moraPendiente)}
                        </span>
                        {moraPagada > 0.005 && (
                          <span className="text-[10px] font-normal leading-snug text-green-700">
                            Cobrada: {miautoFmtMonto(symCuota, moraPagada)}
                          </span>
                        )}
                        {moraAcumulada > 0.005 && moraPendiente <= 0.005 && moraPagada <= 0.005 && (
                          <span className="text-[10px] font-normal leading-snug text-gray-500">
                            Sin saldo
                          </span>
                        )}
                        {(moraExtraTotal > 0.005 || moraExtra > 0.005 || moraExtraPagada > 0.005) && (
                          <span
                            className="group/extra relative mt-0.5 inline-flex cursor-help items-center whitespace-nowrap rounded-full bg-red-50 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-red-600 ring-1 ring-inset ring-red-100"
                            title={`Mora extra generada: ${miautoFmtMonto(symCuota, moraExtraTotal)}\nMora extra pendiente: ${miautoFmtMonto(symCuota, moraExtra)}\nMora extra cobrada: ${miautoFmtMonto(symCuota, moraExtraPagada)}`}
                          >
                            Extra
                            <span className="pointer-events-none absolute right-0 top-full z-20 mt-1 hidden w-48 rounded-md border border-red-100 bg-white p-2 text-left text-[10px] font-normal leading-snug text-gray-600 shadow-lg group-hover/extra:block">
                              <span className="mb-1 block border-b border-red-50 pb-1 text-[10px] font-semibold text-gray-800">Mora extra</span>
                              <span className="flex items-center justify-between gap-3">
                                <span className="text-gray-400">Generada</span>
                                <span className="font-semibold text-gray-700">{miautoFmtMonto(symCuota, moraExtraTotal)}</span>
                              </span>
                              <span className="flex items-center justify-between gap-3">
                                <span className="text-gray-400">Pendiente</span>
                                <span className="font-semibold text-red-600">{miautoFmtMonto(symCuota, moraExtra)}</span>
                              </span>
                              <span className="flex items-center justify-between gap-3">
                                <span className="text-gray-400">Cobrada</span>
                                <span className="font-semibold text-green-700">{miautoFmtMonto(symCuota, moraExtraPagada)}</span>
                              </span>
                            </span>
                          </span>
                        )}
                      </div>
                    </td>
                    {/* Pendiente de pago */}
                    <td className="py-2.5 px-1 align-middle text-right text-[13px]">
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="font-medium tabular-nums text-orange-600">
                          {miautoFmtMonto(symCuota, pendienteDisplay)}
                        </span>
                      </div>
                    </td>
                    {/* Pagado */}
                    <td className="py-2.5 pr-2 align-middle text-right text-[13px] text-green-800">
                      <div className="flex flex-col items-end gap-0.5">
                        <span
                          className="font-medium tabular-nums"
                          title={mostrarDesglosePagado ? 'Total cubierto = recaudo + pago aplicado' : undefined}
                        >
                          {miautoFmtMonto(symCuota, pagadoCubiertoDisplay)}
                        </span>
                        {mostrarDesglosePagado && (
                          <span className="text-[10px] font-normal leading-snug text-gray-500">
                            {[
                              recaudoDisplay > 0.005 ? `Recaudo ${miautoFmtMonto(symCuota, recaudoDisplay)}` : null,
                              pagoRealDisplay > 0.005 ? `Pago ${miautoFmtMonto(symCuota, pagoRealDisplay)}` : null,
                            ].filter(Boolean).join(' + ')}
                          </span>
                        )}
                      </div>
                    </td>
                    {/* Estado */}
                    <td className="py-2.5 pl-1 pr-2 align-middle whitespace-nowrap">
                      <div className="flex flex-col items-center gap-0.5">
                        <span className={`inline-flex w-fit whitespace-nowrap px-1.5 py-0.5 rounded text-xs font-medium ${MIAUTO_CUOTA_STATUS_PILL[c.status] ?? 'bg-gray-100 text-gray-700'}`}
                          title={c.status === 'bonificada' ? 'Bonificación por 4 cuotas seguidas al día' : undefined}>
                          {MIAUTO_CUOTA_STATUS_LABELS[c.status] ?? c.status}
                        </span>
                        {c.status === 'bonificada' && (<span className="text-center text-[10px] text-gray-500">Por 4 cuotas al día</span>)}
                      </div>
                    </td>
                    {bonoTiempoActivo && (
                      <td className="py-2.5 pl-1 pr-3 align-middle text-center">
                        <label className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-gray-200 bg-white transition-colors hover:border-green-300 hover:bg-green-50">
                          <input
                            type="checkbox"
                            checked={c.pago_puntual === true}
                            disabled={guardandoPagoPuntualId === c.id || c.status !== 'paid' || numeroSemana === 1}
                            onChange={(event) => void togglePagoPuntualCuota(c.id, event.target.checked)}
                            className="h-4 w-4 cursor-pointer rounded border-gray-300 text-green-600 focus:ring-green-500 disabled:cursor-wait disabled:opacity-60"
                            aria-label={`Marcar pago puntual semana ${numeroSemana}`}
                            title={numeroSemana === 1 ? 'La primera semana de depósito no cuenta para el bono tiempo' : c.status !== 'paid' ? 'La cuota debe estar pagada para marcarla puntual' : 'Marcar pago puntual'}
                          />
                        </label>
                      </td>
                    )}
                  </tr>
                  <tr className="border-b border-gray-100">
                       <td colSpan={bonoTiempoActivo ? 12 : 11} className="p-0 align-top">
                        <div
                          className="overflow-hidden transition-[max-height,opacity] duration-300 ease-out"
                          style={{ maxHeight: abierto ? 1800 : 0, opacity: abierto ? 1 : 0 }}
                        >
                           <div className="px-4 py-3 bg-gray-50/80 border-t border-gray-200">
                             <div className="flex items-center gap-2 mb-3">
                               <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[#8B1A1A]/10">
                                 <FileText className="w-4 h-4 text-[#8B1A1A]" />
                               </div>
                               <div>
                                 <h4 className="text-sm font-semibold text-gray-900">Semana {numeroSemana}</h4>
                                 <p className="text-xs text-gray-500">
                                   {c.due_date ? formatDate(c.due_date, 'es-ES') : c.week_start_date ? formatDate(c.week_start_date, 'es-ES') : '—'}
                                 </p>
                               </div>
                             </div>

                             {/* Sub-pestañas dentro de la cuota */}
                             <div className="flex border-b border-gray-200 mb-3 gap-0.5" role="tablist" aria-label={`Detalle semana ${numeroSemana}`}>
                               <button
                                 type="button" role="tab"
                                 aria-selected={(subTabCuota[c.id] ?? 'comprobantes') === 'comprobantes'}
                                 onClick={() => setSubTabCuota((prev) => ({ ...prev, [c.id]: 'comprobantes' }))}
                                 className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide border-b-2 -mb-px transition-colors ${
                                   (subTabCuota[c.id] ?? 'comprobantes') === 'comprobantes'
                                     ? 'border-[#8B1A1A] text-[#8B1A1A]'
                                     : 'border-transparent text-gray-500 hover:text-gray-800'
                                 }`}
                               >
                                 Comprobantes
                               </button>
                               <button
                                 type="button" role="tab"
                                 aria-selected={(subTabCuota[c.id] ?? 'comprobantes') === 'evidencias'}
                                 onClick={() => setSubTabCuota((prev) => ({ ...prev, [c.id]: 'evidencias' }))}
                                 className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide border-b-2 -mb-px transition-colors ${
                                   (subTabCuota[c.id] ?? 'comprobantes') === 'evidencias'
                                     ? 'border-[#8B1A1A] text-[#8B1A1A]'
                                     : 'border-transparent text-gray-500 hover:text-gray-800'
                                 }`}
                               >
                                 Evidencias Fleet
                               </button>
                             </div>

                             {(subTabCuota[c.id] ?? 'comprobantes') === 'comprobantes' && (
                             <>
                              <h5 className="text-xs font-semibold text-gray-900 mb-2">Comprobantes del conductor</h5>
                              {compsConductor.length > 0 ? (
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                              {compsConductor.map((comp, idxCond) => {
                                const compLabel = `Comprobante del conductor ${idxCond + 1}`;
                                const estado = (comp.estado || '').toLowerCase();
                                const cardBg =
                                  estado === 'validado'
                                    ? 'bg-green-50/90 border-green-200'
                                    : estado === 'rechazado'
                                      ? 'bg-red-50/90 border-red-200'
                                      : 'bg-amber-50/90 border-amber-200';
                                const iconBg =
                                  estado === 'validado'
                                    ? 'bg-green-100 text-green-700'
                                    : estado === 'rechazado'
                                      ? 'bg-red-100 text-red-700'
                                      : 'bg-amber-100 text-amber-700';
                                const labelClass =
                                  estado === 'validado'
                                    ? 'bg-green-100 text-green-800'
                                    : estado === 'rechazado'
                                      ? 'bg-red-100 text-red-800'
                                      : 'bg-amber-100 text-amber-800';
                                const verBtnClass =
                                  estado === 'validado'
                                    ? 'border-green-200 bg-green-50 text-green-800 hover:bg-green-100'
                                    : estado === 'rechazado'
                                      ? 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100'
                                      : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100';
                                const puedeVerArchivo = !!comp.file_path && comp.file_path !== 'manual';
                                const url = puedeVerArchivo
                                  ? comp.file_path!.startsWith('http')
                                    ? comp.file_path!
                                    : getMiautoAdjuntoUrl(comp.file_path!)
                                  : '';
                                const isImage =
                                  puedeVerArchivo &&
                                  !/\.pdf$/i.test(comp.file_name || '') &&
                                  /\.(jpe?g|png|gif|webp)$/i.test(comp.file_name || '');
                                const montoComp = montoComprobanteCuotaNumber(comp);
                                const openPreview = () => url && setComprobantePreview({ url, fileName: compLabel, isImage: !!isImage });
                                return (
                                  <div key={comp.id} className={`rounded-xl border-2 p-3 ${cardBg} hover:shadow-md transition-all flex flex-col gap-2`}>
                                    <div className="flex gap-3">
                                      <div className={`flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center overflow-hidden ${iconBg}`}>
                                        {puedeVerArchivo && isImage ? (
                                          <button type="button" onClick={openPreview} className="w-full h-full rounded-lg overflow-hidden border border-white/50 shadow-sm hover:opacity-90">
                                            <img src={url} alt="" className="w-full h-full object-cover" />
                                          </button>
                                        ) : puedeVerArchivo ? (
                                          <button type="button" onClick={openPreview} className="w-full h-full rounded-lg border border-gray-200 bg-white/80 flex items-center justify-center hover:bg-gray-50">
                                            <FileText className="w-6 h-6 text-gray-500" />
                                          </button>
                                        ) : (
                                          <span className="w-12 h-12 rounded-lg border border-gray-200 bg-white/80 flex items-center justify-center">
                                            <FileText className="w-6 h-6 text-gray-500" />
                                          </span>
                                        )}
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold text-gray-900">{compLabel}</p>
                                        {comp.created_at && (
                                          <p className="text-xs text-gray-500 mt-0.5">{formatDateTime(comp.created_at, 'es-ES')}</p>
                                        )}
                                        <p className="text-xs text-gray-600">
                                          Monto enviado: {montoComp != null ? `${symMoneda(comp.moneda)} ${montoComp.toFixed(2)}` : 'no registrado'}
                                        </p>
                                        <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium mt-1 ${labelClass}`}>
                                          {estado === 'validado'
                                            ? 'Validado'
                                            : estado === 'rechazado'
                                              ? 'Rechazado'
                                              : 'Pendiente'}
                                        </span>
                                  </div>
                                    </div>
                                    {estado === 'rechazado' && (comp.rechazo_razon?.trim() ?? '') && (
                                      <p className="flex items-start gap-1.5 text-xs text-red-700 bg-red-50/90 rounded-lg px-2 py-1.5 border border-red-100">
                                        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                        <span className="line-clamp-2">{(comp.rechazo_razon ?? '').trim()}</span>
                                      </p>
                                    )}
                                    {puedeVerArchivo && (
                                      <button
                                        type="button"
                                        onClick={openPreview}
                                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-colors self-start ${verBtnClass}`}
                                      >
                                        <ExternalLink className="w-3.5 h-3.5" />
                                        Ver archivo
                                      </button>
                                    )}
                                    </div>
                                );
                              })}
                            </div>
                              ) : (
                                <p className="text-xs text-gray-500">No hay comprobantes enviados por el conductor para esta semana.</p>
                              )}

                            <div className="mb-4 rounded-lg border border-gray-200 bg-white px-3 py-3 shadow-sm">
                                <h5 className="text-xs font-semibold text-gray-900">Comprobante de pago (Yego)</h5>
                                <p className="text-[11px] text-gray-500 mt-1 mb-3">
                                  Documento de respaldo que ve el conductor en la app. Indica el monto y la moneda que refleja el voucher antes de subirlo.
                                </p>
                                {conformidadBloqueadaSinSaldo && (
                                  <p className="text-[11px] text-amber-800 bg-amber-50/90 border border-amber-100 rounded-md px-2 py-1.5 mb-3">
                                    Cuota sin saldo pendiente
                                  </p>
                                )}
                                  <div className="mb-3 flex flex-wrap items-end gap-3 gap-y-2 border-b border-gray-100 pb-3">
                                    <div className="flex flex-wrap items-end gap-2">
                                      <div>
                                        <label className="block text-[10px] font-medium text-gray-600 mb-0.5">Monto</label>
                                        <input
                                          type="number"
                                          step="0.01"
                                          min="0"
                                          max={!conformidadBloqueadaSinSaldo ? pendienteRestanteConformidad : undefined}
                                          disabled={conformidadBloqueadaSinSaldo || subiendoConformidadCuotaId === c.id}
                                          value={conformidadMontoInput[c.id] ?? defaultMontoConformidadCuota(c)}
                                          onChange={(e) =>
                                            setConformidadMontoInput((prev) => ({ ...prev, [c.id]: e.target.value }))
                                          }
                                          className="w-24 px-2 py-1 border border-gray-300 rounded text-[11px] text-gray-900 disabled:bg-gray-100 disabled:text-gray-500"
                                        />
                                      </div>
                                      <div>
                                        <label className="block text-[10px] font-medium text-gray-600 mb-0.5">Moneda</label>
                                        <select
                                          value={conformidadMonedaInput[c.id] ?? monedaCuotaRow(c)}
                                          onChange={(e) => {
                                            const newMon = e.target.value as MiautoMoneda;
                                            const prevMon = conformidadMonedaInput[c.id] ?? monedaCuotaRow(c);
                                            if (prevMon === newMon) return;
                                            const montoStr = conformidadMontoInput[c.id]?.trim();
                                            const defaultStr = defaultMontoConformidadCuota(c);
                                            const raw = (montoStr || defaultStr).replace(',', '.');
                                            const num = parseFloat(raw);
                                            if (Number.isFinite(num) && num > 0) {
                                              const convStr = montoConvertidoPenUsdFormatted(
                                                num,
                                                prevMon,
                                                newMon,
                                                tipoCambioUsdLocal
                                              );
                                              setConformidadMontoInput((prev) => ({
                                                ...prev,
                                                [c.id]: convStr,
                                              }));
                                            }
                                            setConformidadMonedaInput((prev) => ({
                                              ...prev,
                                              [c.id]: newMon,
                                            }));
                                          }}
                                          disabled={conformidadBloqueadaSinSaldo || subiendoConformidadCuotaId === c.id}
                                          className="px-2 py-1 border border-gray-300 rounded text-[11px] text-gray-900 disabled:bg-gray-100 disabled:text-gray-500"
                                        >
                                          <option value="PEN">PEN (S/.)</option>
                                          <option value="COP">COP</option>
                                          <option value="USD">USD</option>
                                        </select>
                                      </div>
                                    </div>
                                    <input
                                      ref={(el) => { conformidadFileRefs.current[c.id] = el; }}
                                      type="file"
                                      accept=".pdf,image/*"
                                      className="hidden"
                                      onChange={(e) => {
                                        const f = e.target.files?.[0] ?? null;
                                        setConformidadArchivoPendiente((prev) => ({ ...prev, [c.id]: f }));
                                        e.target.value = '';
                                      }}
                                    />
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        type="button"
                                        disabled={
                                          conformidadBloqueadaSinSaldo || subiendoConformidadCuotaId === c.id
                                        }
                                        onClick={() => conformidadFileRefs.current[c.id]?.click()}
                                        className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 disabled:opacity-50 transition-colors"
                                      >
                                        <Upload className="w-3.5 h-3.5 text-gray-500" />
                                        Elegir archivo
                                      </button>
                                      <button
                                        type="button"
                                        disabled={
                                          conformidadBloqueadaSinSaldo ||
                                          subiendoConformidadCuotaId === c.id ||
                                          !conformidadArchivoPendiente[c.id]
                                        }
                                        onClick={() => {
                                          const f = conformidadArchivoPendiente[c.id];
                                          if (!f) return;
                                          const montoStr =
                                            conformidadMontoInput[c.id]?.trim() || defaultMontoConformidadCuota(c);
                                          const montoNum = parseFloat(montoStr.replace(',', '.'));
                                          if (Number.isNaN(montoNum) || montoNum <= 0) {
                                            toast.error('Indica un monto válido para el comprobante');
                                            return;
                                          }
                                          const montoR = roundToTwoDecimals(montoNum);
                                          const topeR = roundToTwoDecimals(pendienteRestanteConformidad);
                                          if (montoR > topeR) {
                                            toast.error(
                                              `El monto no puede superar el saldo pendiente de esta cuota (${symCuota} ${topeR.toFixed(2)})`
                                            );
                                            return;
                                          }
                                          const mon = conformidadMonedaInput[c.id] ?? monedaCuotaRow(c);
                                          void handleSubirConformidadAdmin(c.id, f, montoNum, mon);
                                        }}
                                        className="inline-flex items-center gap-1.5 rounded-md border border-[#8B1A1A] bg-[#8B1A1A] px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-[#7a1717] disabled:opacity-50 disabled:pointer-events-none transition-colors"
                                      >
                                        {subiendoConformidadCuotaId === c.id ? 'Subiendo…' : 'Subir'}
                                      </button>
                                    </div>
                                    {conformidadArchivoPendiente[c.id] && (
                                      <p className="text-[10px] text-gray-600 truncate max-w-[14rem]" title={conformidadArchivoPendiente[c.id]?.name}>
                                        Pendiente: {conformidadArchivoPendiente[c.id]?.name}
                                      </p>
                                    )}
                                  </div>
                                {conformidadesAdmin.length > 0 ? (
                                  <div className="overflow-x-auto -mx-1 px-1">
                                    <table className="w-full min-w-[280px] text-xs border-collapse">
                                      <thead>
                                        <tr className="border-b border-gray-200 text-left text-gray-600">
                                          <th className="py-2 pr-3 font-medium">Archivo</th>
                                          <th className="py-2 pr-3 font-medium whitespace-nowrap">Monto</th>
                                          <th className="py-2 pr-3 font-medium whitespace-nowrap">Fecha</th>
                                          <th className="py-2 pr-3 font-medium whitespace-nowrap">Estado</th>
                                          <th className="py-2 text-right font-medium whitespace-nowrap">Acciones</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {conformidadesAdmin.map((comp) => {
                                          const estado = (comp.estado || '').toLowerCase();
                                          const labelClass =
                                            estado === 'validado'
                                              ? 'bg-green-100 text-green-800'
                                              : estado === 'rechazado'
                                                ? 'bg-red-100 text-red-800'
                                                : 'bg-amber-100 text-amber-800';
                                          const compLabel = 'Conformidad de pago (Yego)';
                                          const puedeVerArchivo = !!comp.file_path && comp.file_path !== 'manual';
                                          const url = puedeVerArchivo
                                            ? comp.file_path!.startsWith('http')
                                              ? comp.file_path!
                                              : getMiautoAdjuntoUrl(comp.file_path!)
                                            : '';
                                          const isImage =
                                            puedeVerArchivo &&
                                            !/\.pdf$/i.test(comp.file_name || '') &&
                                            /\.(jpe?g|png|gif|webp)$/i.test(comp.file_name || '');
                                          const openPreview = () =>
                                            url && setComprobantePreview({ url, fileName: compLabel, isImage: !!isImage });
                                          return (
                                            <tr key={comp.id} className="border-b border-gray-100 last:border-0">
                                              <td className="py-2 pr-3 align-middle text-gray-900 max-w-[10rem] truncate" title={comp.file_name || undefined}>
                                                {comp.file_name || '—'}
                                              </td>
                                              <td className="py-2 pr-3 align-middle text-gray-800 whitespace-nowrap">
                                                {comp.monto != null && Number.isFinite(Number(comp.monto))
                                                  ? `${symMoneda(comp.moneda)} ${Number(comp.monto).toFixed(2)}`
                                                  : '—'}
                                              </td>
                                              <td className="py-2 pr-3 align-middle text-gray-600 whitespace-nowrap">
                                                {comp.created_at ? formatDateTime(comp.created_at, 'es-ES') : '—'}
                                              </td>
                                              <td className="py-2 pr-3 align-middle whitespace-nowrap">
                                                <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${labelClass}`}>
                                                  {estado === 'validado'
                                                    ? 'Validado'
                                                    : estado === 'rechazado'
                                                      ? 'Rechazado'
                                                      : 'Pendiente'}
                                                </span>
                                              </td>
                                              <td className="py-2 align-middle text-right whitespace-nowrap">
                                                <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                                                  {puedeVerArchivo && (
                                                    <button
                                                      type="button"
                                                      onClick={openPreview}
                                                      className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
                                                    >
                                                      <ExternalLink className="w-3 h-3.5" />
                                                      Ver
                                                    </button>
                                                  )}
                                                  <button
                                                    type="button"
                                                    onClick={() => setConformidadEliminarModal({ comprobanteId: comp.id })}
                                                    disabled={eliminandoConformidadId === comp.id}
                                                    className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:pointer-events-none"
                                                  >
                                                    <Trash2 className="w-3 h-3.5" />
                                                    Eliminar
                                                  </button>
                                                </div>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <p className="text-xs text-gray-500">Aún no hay documento de conformidad subido.</p>
                                )}
                              </div>

                            {pagosManualReg.length > 0 && (
                              <div className="mb-1">
                                <h5 className="text-xs font-semibold text-gray-900 mb-2">Registros de pago (administración)</h5>
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                  {pagosManualReg.map((comp) => {
                                    const estado = (comp.estado || '').toLowerCase();
                                    const compLabel = 'Pago manual (registro)';
                                    const cardBg =
                                      estado === 'validado'
                                        ? 'bg-green-50/90 border-green-200'
                                        : estado === 'rechazado'
                                          ? 'bg-red-50/90 border-red-200'
                                          : 'bg-amber-50/90 border-amber-200';
                                    const iconBg =
                                      estado === 'validado'
                                        ? 'bg-green-100 text-green-700'
                                        : estado === 'rechazado'
                                          ? 'bg-red-100 text-red-700'
                                          : 'bg-amber-100 text-amber-700';
                                    const labelClass =
                                      estado === 'validado'
                                        ? 'bg-green-100 text-green-800'
                                        : estado === 'rechazado'
                                          ? 'bg-red-100 text-red-800'
                                          : 'bg-amber-100 text-amber-800';
                                    const verBtnClass =
                                      estado === 'validado'
                                        ? 'border-green-200 bg-green-50 text-green-800 hover:bg-green-100'
                                        : estado === 'rechazado'
                                          ? 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100'
                                          : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100';
                                    const puedeVerArchivo = !!comp.file_path && comp.file_path !== 'manual';
                                    const url = puedeVerArchivo
                                      ? comp.file_path!.startsWith('http')
                                        ? comp.file_path!
                                        : getMiautoAdjuntoUrl(comp.file_path!)
                                      : '';
                                    const isImage =
                                      puedeVerArchivo &&
                                      !/\.pdf$/i.test(comp.file_name || '') &&
                                      /\.(jpe?g|png|gif|webp)$/i.test(comp.file_name || '');
                                    const openPreview = () =>
                                      url && setComprobantePreview({ url, fileName: compLabel, isImage: !!isImage });
                                    return (
                                      <div key={comp.id} className={`rounded-xl border-2 p-3 ${cardBg} hover:shadow-md transition-all flex flex-col gap-2`}>
                                        <div className="flex gap-3">
                                          <div className={`flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center overflow-hidden ${iconBg}`}>
                                            {puedeVerArchivo && isImage ? (
                                              <button type="button" onClick={openPreview} className="w-full h-full rounded-lg overflow-hidden border border-white/50 shadow-sm hover:opacity-90">
                                                <img src={url} alt="" className="w-full h-full object-cover" />
                                              </button>
                                            ) : puedeVerArchivo ? (
                                              <button type="button" onClick={openPreview} className="w-full h-full rounded-lg border border-gray-200 bg-white/80 flex items-center justify-center hover:bg-gray-50">
                                                <FileText className="w-6 h-6 text-gray-500" />
                                              </button>
                                            ) : (
                                              <span className="w-12 h-12 rounded-lg border border-gray-200 bg-white/80 flex items-center justify-center">
                                                <FileText className="w-6 h-6 text-gray-500" />
                                              </span>
                                            )}
                                          </div>
                                          <div className="min-w-0 flex-1">
                                            <p className="text-sm font-semibold text-gray-900">{compLabel}</p>
                                            {comp.created_at && (
                                              <p className="text-xs text-gray-500 mt-0.5">{formatDateTime(comp.created_at, 'es-ES')}</p>
                                            )}
                                            <p className="text-xs text-gray-600">
                                              {comp.monto != null
                                                ? `${symMoneda(comp.moneda)} ${Number(comp.monto).toFixed(2)}`
                                                : '—'}
                                            </p>
                                            <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium mt-1 ${labelClass}`}>
                                              {estado === 'validado'
                                                ? 'Validado'
                                                : estado === 'rechazado'
                                                  ? 'Rechazado'
                                                  : 'Pendiente'}
                                            </span>
                                          </div>
                                        </div>
                                        {estado === 'rechazado' && (comp.rechazo_razon?.trim() ?? '') && (
                                          <p className="flex items-start gap-1.5 text-xs text-red-700 bg-red-50/90 rounded-lg px-2 py-1.5 border border-red-100">
                                            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                            <span className="line-clamp-2">{(comp.rechazo_razon ?? '').trim()}</span>
                                          </p>
                                        )}
                                        {puedeVerArchivo && (
                                          <button
                                            type="button"
                                            onClick={openPreview}
                                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-colors self-start ${verBtnClass}`}
                                          >
                                            <ExternalLink className="w-3.5 h-3.5" />
                                            Ver archivo
                                          </button>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                              {compsConductor.length > 0 && (
                                <MiautoComprobantesResumenSemana
                                  comps={comps.map((comp) => ({ ...comp, monto: montoComprobanteCuotaNumber(comp) }))}
                                  symCronograma={symCuota}
                                saldoPendienteSemanaCronograma={roundToTwoDecimals(
                                  Math.max(0, Number(cuotaFinalSemana))
                                )}
                              />
                            )}
                            </>
                            )}

                            {(subTabCuota[c.id] ?? 'comprobantes') === 'evidencias' && (
                            <>
                            {/* --- Evidencias de cobro Fleet --- */}
                            <div className="">
                              <div className="flex items-center gap-2 mb-3">
                                <Upload className="w-4 h-4 text-[#8B1A1A]" />
                                <h5 className="text-xs font-semibold text-gray-900">Evidencias cobro Fleet</h5>
                              </div>

                              {(() => {
                                const evsCuota = evidenciasByCuotaId[c.id] ?? [];
                                const subiendoEstaCuota = subiendoEvidenciaCuotaId === c.id;
                                return (
                                  <>
                                    {evsCuota.length > 0 && (
                                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2 mb-3">
                                        {evsCuota.map((ev) => {
                                          const url = ev.file_path?.startsWith('http') ? ev.file_path : getMiautoAdjuntoUrl(ev.file_path);
                                          const isImage = ev.file_path && !/\.pdf$/i.test(ev.file_name || '') && /\.(jpe?g|png|gif|webp)$/i.test(ev.file_name || '');
                                          const openPreview = () => url && setComprobantePreview({ url, fileName: ev.file_name, isImage: !!isImage });
                                          return (
                                            <div key={ev.id} className="rounded-lg border border-gray-200 bg-white p-2 flex items-center gap-2 group/ev">
                                              <button type="button" onClick={openPreview} className="flex-shrink-0 w-10 h-10 rounded-md bg-gray-100 flex items-center justify-center overflow-hidden hover:ring-2 hover:ring-[#8B1A1A]/30">
                                                {isImage ? (
                                                  <img src={url} alt="" className="w-full h-full object-cover" />
                                                ) : (
                                                  <FileText className="w-5 h-5 text-gray-500" />
                                                )}
                                              </button>
                                              <div className="min-w-0 flex-1">
                                                <p className="text-xs font-medium text-gray-700 truncate" title={ev.file_name}>{ev.file_name}</p>
                                                {ev.created_at && (
                                                  <p className="text-[10px] text-gray-400">{formatDateTime(ev.created_at, 'es-ES')}</p>
                                                )}
                                              </div>
                                              <button
                                                type="button"
                                                onClick={() => handleEliminarEvidenciaFleet(ev.id)}
                                                disabled={eliminandoEvidenciaId === ev.id}
                                                className="flex-shrink-0 p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover/ev:opacity-100 transition-opacity disabled:opacity-50"
                                                title="Eliminar evidencia"
                                              >
                                                {eliminandoEvidenciaId === ev.id ? (
                                                  <div className="animate-spin rounded-full h-3 w-3 border-2 border-red-600 border-t-transparent" />
                                                ) : (
                                                  <Trash2 className="w-3.5 h-3.5" />
                                                )}
                                              </button>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}

                                    <div className="flex items-center gap-2">
                                      <input
                                        ref={(el) => { evidenciaFleetFileRefs.current[c.id] = el; }}
                                        type="file"
                                        accept="image/jpeg,image/png,application/pdf"
                                        multiple
                                        onChange={() => handleSubirEvidenciasFleetCuota(c.id)}
                                        className="hidden"
                                        id={`evidencia-fleet-${c.id}`}
                                      />
                                      <label
                                        htmlFor={`evidencia-fleet-${c.id}`}
                                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                                          subiendoEstaCuota
                                            ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                                            : 'bg-[#8B1A1A]/10 text-[#8B1A1A] hover:bg-[#8B1A1A]/20 border border-[#8B1A1A]/30'
                                        }`}
                                      >
                                        {subiendoEstaCuota ? (
                                          <>
                                            <div className="animate-spin rounded-full h-3 w-3 border-2 border-[#8B1A1A] border-t-transparent" />
                                            Subiendo…
                                          </>
                                        ) : (
                                          <>
                                            <Upload className="w-3 h-3" />
                                            Subir evidencia
                                          </>
                                        )}
                                      </label>
                                      {evsCuota.length === 0 && (
                                        <span className="text-xs text-gray-400">Sin evidencias</span>
                                      )}
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                            </>
                            )}

                          </div>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                );
                })}
              </tbody>
            </table>
            </div>
          </div>
          </>
        )}
        </>
        )}

        {tabCronograma === 'otros_gastos' && (
        <>
            <div className="flex flex-wrap justify-end gap-2 border-b border-gray-200 px-4 py-3">
              <button
                type="button"
                onClick={openAdditionalExpenseFleetCharge}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-[#8B1A1A] px-3 text-sm font-semibold text-white hover:bg-[#741616]"
              >
                <Banknote className="h-4 w-4" />
                Cobrar
              </button>
              <button
                type="button"
                onClick={() => openGastoConfigModal()}
                disabled={loadingGastoConfig || !gastoConfig}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loadingGastoConfig ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Settings2 className="h-4 w-4" />
                )}
                {loadingGastoConfig ? 'Cargando...' : 'Configurar gastos'}
              </button>
            </div>

            {otrosGastosGroups.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8 px-4">No hay cuotas de otros gastos para este contrato.</p>
            ) : (
              <div className="px-4 pb-3 pt-2">
                {/* Resumen general */}
                <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                  <span className="font-semibold text-gray-700">
                    Total: {Object.keys(otrosGastosSummary.totals).length > 0
                      ? Object.entries(otrosGastosSummary.totals)
                        .map(([currency, total]) => `${symMoneda(currency)} ${total.toFixed(2)} ${currency}`)
                        .join(' · ')
                      : '—'}
                  </span>
                  <span className="text-gray-300">·</span>
                  <span>{otrosGastosRows.length} cuotas</span>
                  <span className="text-gray-300">·</span>
                  <span className="text-green-600">{otrosGastosSummary.paid} pagadas</span>
                  <span className="text-gray-300">·</span>
                  <span className="text-amber-600">{otrosGastosSummary.pending} pendientes</span>
                  <span className="text-gray-300">·</span>
                  <span className="text-red-600">{otrosGastosSummary.overdue} vencidas</span>
                </div>

                {/* Filtros por tipo de gasto */}
                <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-hide">
                  <button
                    type="button"
                    onClick={() => setOgTipoFilterAdmin(null)}
                    onContextMenu={(event) => openGastoConfigContextMenu(event, null, 'Todos')}
                    title="Clic izquierdo para filtrar · clic derecho para configurar"
                    className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${!ogTipoFilterAdmin ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]' : 'bg-white text-gray-600 border-gray-200'}`}
                  >
                    Todos ({otrosGastosRows.length})
                  </button>
                  {otrosGastosGroups.map(({ type, expenses }) => {
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setOgTipoFilterAdmin(ogTipoFilterAdmin === type ? null : type)}
                        onContextMenu={(event) => openGastoConfigContextMenu(event, type, labelOtrosGastoType(type))}
                        title="Clic izquierdo para filtrar · clic derecho para configurar"
                        className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${ogTipoFilterAdmin === type ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]' : 'bg-white text-gray-600 border-gray-200'}`}
                      >
                        {labelOtrosGastoType(type)} ({expenses.length})
                      </button>
                    );
                  })}
                </div>

                <div className="divide-y divide-gray-200 border-y border-gray-200">
                  {otrosGastosGroups.map(({ type, expenses, paid, periods, totals }) => {
                    if (ogTipoFilterAdmin && ogTipoFilterAdmin !== type) return null;

                    const isOpen = otrosTiposAbiertos[type] !== false;
                    const cuotasTotal = expenses.length;
                    const paidCount = paid;
                    const pct = cuotasTotal > 0 ? Math.round((paidCount / cuotasTotal) * 100) : 0;
                    const label = labelOtrosGastoType(type);
                    const isConfiguredActive = activeOtrosGastoTypeSet.has(type);
                    const accentBorder = TIPO_OTROS_GASTOS_ACCENT[type] || 'border-l-gray-400';
                    const accentBar = TIPO_OTROS_GASTOS_BAR[type] || 'bg-gray-400';

                    return (
                      <section key={type} className={`bg-white border-l-[3px] ${accentBorder}`}>
                        <button
                          type="button"
                          onClick={() => setOtrosTiposAbiertos(prev => ({ ...prev, [type]: prev[type] === false }))}
                          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50/70 hover:bg-gray-100/80 transition-colors"
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            {isOpen ? <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-gray-900">{label}</span>
                                {isConfiguredActive && (
                                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700">
                                    Activo
                                  </span>
                                )}
                                <span className="text-xs font-semibold text-gray-500">{periods.join(', ')}</span>
                                <span className="text-[11px] text-gray-400">{cuotasTotal} cuotas</span>
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden max-w-[120px]">
                                  <div className={`h-full rounded-full transition-all duration-300 ${accentBar}`} style={{ width: `${pct}%` }} />
                                </div>
                                <span className="text-[10px] text-gray-500">{paidCount}/{cuotasTotal} pagadas</span>
                              </div>
                            </div>
                          </div>
                          <span className="ml-3 shrink-0 text-sm font-semibold text-gray-900">
                            {Object.keys(totals).length > 0
                              ? Object.entries(totals)
                                .map(([currency, total]) => `${symMoneda(currency)} ${total.toFixed(2)}`)
                                .join(' · ')
                              : '—'}
                          </span>
                        </button>

                        {isOpen && (
                          <div className="border-t border-gray-100 px-3 py-3">
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                              {expenses.length === 0 ? (
                                <p className="col-span-full rounded-md border border-dashed border-gray-200 px-4 py-5 text-center text-xs text-gray-500">
                                  Este gasto está activo en el cronograma, pero aún no tiene cuotas generadas.
                                </p>
                              ) : expenses.map((og) => {
                                const gastoSym = symMoneda(og.moneda || 'PEN');
                                const receipts = comprobantesOtrosGastosPorGasto.get(og.id) || [];
                                const latestReceipt = receipts[0];
                                const pendingReceipt = receipts.find(
                                  (receipt) => String(receipt.estado || '').toLowerCase() === 'pendiente'
                                );
                                const displayedReceipt = pendingReceipt || latestReceipt;
                                const receiptStatus = String(displayedReceipt?.estado || '').toLowerCase();
                                const hasPendingReceipt = Boolean(pendingReceipt);
                                const awaitingFleetReceipt = Boolean(og.pending_fleet_application_id);
                                const pendingReceiptApplied = receiptStatus === 'pendiente' && Boolean(
                                  displayedReceipt?.pago_aplicado || Number(displayedReceipt?.monto_aplicado || 0) > 0.005
                                );
                                const canViewReceipt = Boolean(
                                  displayedReceipt?.file_path && displayedReceipt.file_path !== 'manual'
                                );
                                const openReceiptPreview = () => {
                                  if (!canViewReceipt || !displayedReceipt) return;
                                  const url = displayedReceipt.file_path.startsWith('http')
                                    ? displayedReceipt.file_path
                                    : getMiautoAdjuntoUrl(displayedReceipt.file_path);
                                  const isImage = !/\.pdf$/i.test(displayedReceipt.file_name || '') &&
                                    /\.(jpe?g|png|gif|webp)$/i.test(displayedReceipt.file_name || '');
                                  setComprobantePreview({
                                    url,
                                    fileName: displayedReceipt.file_name || 'Comprobante de otros gastos',
                                    isImage,
                                  });
                                };

                                return (
                                <div
                                  key={og.id}
                                  className={`grid min-h-24 grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-md border p-3 ${
                                    awaitingFleetReceipt ? 'border-amber-300 bg-amber-50/60' :
                                    og.status === 'paid' ? 'bg-green-50/50 border-green-200' :
                                    og.status === 'overdue' ? 'bg-red-50/50 border-red-200' :
                                    'bg-white border-gray-200'
                                  }`}
                                >
                                  <span className="text-xs font-semibold text-gray-700">
                                    Cuota {og.numero_cuota || og.week_index}{og.total_cuotas ? ` de ${og.total_cuotas}` : ''}
                                  </span>
                                  <span className={`row-span-2 text-sm font-bold ${
                                    og.status === 'paid' ? 'text-green-700' :
                                    og.status === 'overdue' ? 'text-red-700' :
                                    'text-gray-900'
                                  }`}>
                                    {gastoSym} {Number(og.amount_due).toFixed(2)}
                                  </span>
                                  <span className="text-[11px] text-gray-500">{formatOtrosGastoDueDate(og.due_date)}</span>
                                  <div className="col-span-2 mt-1 flex items-center justify-between border-t border-black/5 pt-2 text-[11px]">
                                    <span className="text-green-700">Pagado: {gastoSym} {Number(og.paid_amount || 0).toFixed(2)}</span>
                                    <span className="font-semibold text-gray-700">Saldo: {gastoSym} {Number(og.pending_amount ?? Math.max(0, Number(og.amount_due) - Number(og.paid_amount || 0))).toFixed(2)}</span>
                                    {awaitingFleetReceipt ? (
                                      <button
                                        type="button"
                                        onClick={() => openAdditionalExpenseReceiptFromCard(og)}
                                        className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-800 hover:bg-amber-100"
                                      >
                                        <Upload className="h-3 w-3" />
                                        Subir comprobante
                                      </button>
                                    ) : og.status === 'paid' ? (
                                      <span className="rounded bg-green-100 px-1.5 py-0.5 font-semibold text-green-700">
                                        {labelOtrosGastoStatus(og.status)}
                                      </span>
                                    ) : hasPendingReceipt ? (
                                      <span className={`rounded px-1.5 py-0.5 font-semibold ${
                                        pendingReceiptApplied
                                          ? 'bg-amber-100 text-amber-700'
                                          : 'bg-green-100 text-green-700'
                                      }`}>
                                        {pendingReceiptApplied ? 'Pendiente banco' : 'Comprobante listo'}
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={Boolean(pagandoGastoManualId)}
                                        onClick={() => setGastoManualPagoTarget(og)}
                                        className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-1.5 py-0.5 font-semibold text-[#8B1A1A] hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                                        title="Registrar esta cuota como pagada sin descontar saldo en Yango Fleet"
                                      >
                                        {pagandoGastoManualId === og.id
                                          ? <RefreshCw className="h-3 w-3 animate-spin" />
                                          : <CheckCircle2 className="h-3 w-3" />}
                                        Registrar pago
                                      </button>
                                    )}
                                  </div>
                                  {displayedReceipt && (
                                    <div className="col-span-2 mt-1 flex items-center justify-between gap-2 border-t border-black/5 pt-2">
                                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                        receiptStatus === 'validado'
                                          ? 'bg-green-100 text-green-700'
                                          : receiptStatus === 'rechazado'
                                            ? 'bg-red-100 text-red-700'
                                            : 'bg-amber-100 text-amber-700'
                                      }`}>
                                        {receiptStatus === 'validado'
                                          ? 'Validado banco'
                                          : receiptStatus === 'rechazado'
                                            ? 'Rechazado'
                                            : pendingReceiptApplied
                                              ? 'Pendiente banco'
                                              : 'Listo para cobrar'}
                                      </span>
                                      {canViewReceipt && (
                                        <button
                                          type="button"
                                          onClick={openReceiptPreview}
                                          className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
                                        >
                                          <ExternalLink className="h-3 w-3" />
                                          Ver comprobante
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              </div>
            )}
        </>
        )}
        </div>

        {tabCronograma === 'semanales' && cuotas.length > 0 && (
          <TablePaginationBar
            page={cronPg.page}
            setPage={cronPg.setPage}
            totalPages={cronPg.totalPages}
            limit={cronPg.limit}
            setLimit={cronPg.setLimit}
            pageSizes={cronPg.pageSizes}
            totalItems={cuotas.length}
            compact
            containerClassName="flex shrink-0 flex-col items-center justify-between gap-3 border-t border-gray-200 bg-white px-4 py-2.5 sm:flex-row"
          />
        )}

        {refreshingDetail && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-white/75 backdrop-blur-[1px]"
            aria-busy="true"
            aria-live="polite"
          >
            <div className="flex flex-col items-center gap-2">
              <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
              <span className="text-sm font-medium text-gray-600">Actualizando cronograma…</span>
            </div>
          </div>
        )}
      </div>

      {gastoConfigContextMenu && createPortal(
        <div
          className="fixed inset-0 z-[9997]"
          onClick={() => setGastoConfigContextMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setGastoConfigContextMenu(null);
          }}
        >
          <div
            role="menu"
            aria-label={`Opciones de ${gastoConfigContextMenu.label}`}
            className="fixed w-48 overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-xl"
            style={{ left: gastoConfigContextMenu.x, top: gastoConfigContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="truncate border-b border-gray-100 px-3 py-2 text-xs font-semibold text-gray-500">
              {gastoConfigContextMenu.label}
            </p>
            <button
              type="button"
              role="menuitem"
              disabled={loadingGastoConfig || !gastoConfig}
              onClick={() => {
                openGastoConfigModal(gastoConfigFocusForType(gastoConfigContextMenu.type));
                setGastoConfigContextMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-red-50 hover:text-[#8B1A1A] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingGastoConfig ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />}
              {loadingGastoConfig ? 'Cargando...' : 'Configurar'}
            </button>
          </div>
        </div>,
        document.body,
      )}

      <MiautoGastosConfigurationModal
        open={showGastoConfigModal}
        config={gastoConfig}
        saving={savingGastoConfig}
        generating={generatingGastos}
        initialFocus={gastoConfigFocus}
        onClose={() => {
          setShowGastoConfigModal(false);
          setGastoConfigFocus(null);
        }}
        onSave={saveGastoConfiguration}
        onSaveAndGenerate={saveAndGenerateAdditionalExpenses}
      />

      {gastoManualPagoTarget && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="gasto-manual-payment-title"
          onClick={() => {
            if (!pagandoGastoManualId) setGastoManualPagoTarget(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 id="gasto-manual-payment-title" className="text-base font-bold text-gray-900">
                  Marcar cuota como pagada
                </h3>
                <p className="mt-1 text-xs text-gray-500">
                  {labelOtrosGastoType(gastoManualPagoTarget.tipo)} · Cuota {gastoManualPagoTarget.numero_cuota || gastoManualPagoTarget.week_index}
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(pagandoGastoManualId)}
                onClick={() => setGastoManualPagoTarget(null)}
                className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                aria-label="Cerrar"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-5 py-4">
              <div className="rounded-md border border-green-200 bg-green-50 p-3">
                <p className="text-sm font-semibold text-green-900">
                  Saldo a registrar: {symMoneda(gastoManualPagoTarget.moneda || 'PEN')} {saldoPendienteOtroGasto(gastoManualPagoTarget).toFixed(2)}
                </p>
                <p className="mt-1 text-xs text-green-800">
                  Esta operación registra el pago manualmente y no consulta ni descuenta saldo en Yango Fleet.
                </p>
              </div>
              <p className="mt-3 text-xs text-gray-500">
                La operación quedará registrada con el usuario administrador que la confirma.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-4">
              <button
                type="button"
                disabled={Boolean(pagandoGastoManualId)}
                onClick={() => setGastoManualPagoTarget(null)}
                className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={Boolean(pagandoGastoManualId)}
                onClick={() => void confirmManualAdditionalExpensePayment()}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-[#8B1A1A] px-3 text-sm font-semibold text-white hover:bg-[#741616] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pagandoGastoManualId
                  ? <RefreshCw className="h-4 w-4 animate-spin" />
                  : <CheckCircle2 className="h-4 w-4" />}
                {pagandoGastoManualId ? 'Registrando...' : 'Confirmar pagado'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showGastoFleetChargeModal && createPortal(
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="gasto-fleet-charge-title"
          onClick={closeAdditionalExpenseFleetCharge}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 id="gasto-fleet-charge-title" className="text-base font-bold text-gray-900">Cobrar otros gastos</h3>
                <p className="mt-0.5 text-xs text-gray-500">Primero realiza el cobro; después adjunta su comprobante.</p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={loadingGastoFleetCharge || chargingGastoFleet}
                  onClick={() => {
                    setGastoComprobanteTarget(null);
                    setGastoComprobanteArchivo(null);
                    setGastoComprobanteFleetApplicationId(null);
                    void loadAdditionalExpenseFleetCharge();
                  }}
                  className="rounded p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50"
                  aria-label="Actualizar saldo"
                  title="Actualizar saldo"
                >
                  <RefreshCw className={`h-4 w-4 ${loadingGastoFleetCharge ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  disabled={chargingGastoFleet || subiendoGastoComprobante}
                  onClick={closeAdditionalExpenseFleetCharge}
                  className="rounded p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                  aria-label="Cerrar"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {loadingGastoFleetCharge ? (
              <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-sm text-gray-500">
                <RefreshCw className="h-6 w-6 animate-spin text-[#8B1A1A]" />
                Consultando saldo Fleet...
              </div>
            ) : (
              <>
                <div className="border-b border-gray-200 bg-gray-50 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-gray-500">{gastoFleetPreview?.driver_name || 'Conductor'}</p>
                    <p className="text-sm font-bold text-gray-900">
                      Saldo disponible: {gastoFleetPreview?.balance == null
                        ? 'No disponible'
                        : `${symMoneda(gastoFleetPreview.balance_currency || 'PEN')} ${Number(gastoFleetPreview.balance).toFixed(2)} ${gastoFleetPreview.balance_currency || ''}`}
                    </p>
                  </div>
                </div>

                {(gastoFleetPreview?.expenses.length || 0) > 0 && (
                  <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-gray-200 bg-white px-5 py-2.5">
                    {additionalExpenseFleetGroups.map((group) => {
                      const selectedCount = group.expenses.filter(
                        (expense) => gastosFleetSeleccionados[expense.id]
                      ).length;
                      const isActive = activeAdditionalExpenseFleetGroup?.type === group.type;
                      return (
                        <button
                          key={group.type}
                          type="button"
                          onClick={() => setGastoFleetTipoActivo(group.type)}
                          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition-colors ${
                            isActive
                              ? 'border-[#8B1A1A] bg-[#8B1A1A] text-white'
                              : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          {group.label}
                          <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                            isActive ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
                          }`}>
                            {selectedCount > 0 ? `${selectedCount}/` : ''}{group.expenses.length}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto">
                  {(gastoFleetPreview?.expenses.length || 0) === 0 ? (
                    <div className="flex min-h-56 items-center justify-center px-5 text-center text-sm text-gray-500">
                      No hay cuotas pendientes disponibles para cobro.
                    </div>
                  ) : (
                    <div className="divide-y-4 divide-gray-100">
                      {(activeAdditionalExpenseFleetGroup ? [activeAdditionalExpenseFleetGroup] : []).map((group) => {
                        const selectedInGroup = group.expenses.filter(
                          (expense) => gastosFleetSeleccionados[expense.id]
                        ).length;
                        return (
                          <section key={group.type}>
                            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-gray-200 bg-gray-50 px-5 py-2.5">
                              <span>
                                <span className="block text-sm font-bold text-gray-900">{group.label}</span>
                                <span className="block text-[11px] text-gray-500">
                                  {selectedInGroup} de {group.expenses.length} seleccionadas
                                </span>
                              </span>
                              <span className="text-xs font-bold text-gray-700">
                                {Object.entries(group.totals)
                                  .map(([currency, total]) => `${symMoneda(currency)} ${total.toFixed(2)} ${currency}`)
                                  .join(' · ')}
                              </span>
                            </div>
                            <div className="divide-y divide-gray-100">
                              {group.expenses.map((expense) => {
                                const awaitingFleetReceipt = Boolean(expense.pending_fleet_application_id);
                                const receiptReady = Boolean(
                                  expense.pending_receipt_id && !expense.pending_receipt_applied
                                );
                                const receiptApplied = Boolean(
                                  expense.pending_receipt_id && expense.pending_receipt_applied
                                );
                                const hasReceiptFile = Boolean(expense.pending_receipt_file_path);
                                return (
                                  <div
                                    key={expense.id}
                                    className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-3 sm:grid-cols-[auto_1fr_auto_auto] ${
                                      awaitingFleetReceipt
                                        ? 'bg-amber-50/60'
                                        : receiptReady ? 'bg-green-50/60' : 'hover:bg-gray-50'
                                    }`}
                                  >
                                  <label
                                    className={`flex items-center ${!awaitingFleetReceipt && !receiptApplied && expense.pending_amount > 0.005 ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                                    aria-label={`Seleccionar cuota ${expense.numero_cuota || ''}`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={Boolean(gastosFleetSeleccionados[expense.id])}
                                      disabled={awaitingFleetReceipt || expense.id === gastoComprobanteTarget?.id || receiptApplied || expense.pending_amount <= 0.005}
                                      onChange={(event) => setGastosFleetSeleccionados((current) => ({
                                        ...current,
                                        [expense.id]: event.target.checked,
                                      }))}
                                      className="h-4 w-4 rounded border-gray-300 text-[#8B1A1A] focus:ring-[#8B1A1A] disabled:cursor-not-allowed disabled:opacity-40"
                                    />
                                  </label>
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm font-semibold text-gray-900">
                                      Cuota {expense.numero_cuota || '—'}{expense.total_cuotas ? ` de ${expense.total_cuotas}` : ''}
                                    </span>
                                    <span className="block text-xs text-gray-500">
                                      {expense.periodo_anio || 'Sin periodo'}
                                      {expense.due_date ? ` · ${formatDateUTC(expense.due_date, 'es-ES')}` : ''}
                                    </span>
                                  </span>
                                  <span className="text-right">
                                    <span className="block text-sm font-bold text-gray-900">
                                      {awaitingFleetReceipt
                                        ? `${symMoneda(expense.pending_fleet_original_currency || expense.currency)} ${Number(expense.pending_fleet_original_amount || 0).toFixed(2)}`
                                        : `${symMoneda(expense.currency)} ${Number(expense.pending_amount).toFixed(2)}`}
                                    </span>
                                    <span className={`text-[11px] font-semibold ${
                                      awaitingFleetReceipt
                                        ? 'text-amber-700'
                                        : expense.status === 'overdue' ? 'text-red-600' : 'text-amber-600'
                                    }`}>
                                      {awaitingFleetReceipt ? 'Cobrado · falta comprobante' : labelOtrosGastoStatus(expense.status)}
                                    </span>
                                    {receiptReady && (
                                      <span className="mt-0.5 block text-[10px] font-semibold text-green-700">
                                        Comprobante: {symMoneda(expense.pending_receipt_currency || expense.currency)} {Number(expense.pending_receipt_amount || 0).toFixed(2)}
                                      </span>
                                    )}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => awaitingFleetReceipt
                                      ? openFleetChargeReceipt(expense)
                                      : openFleetExpenseReceiptPreview(expense)}
                                    disabled={chargingGastoFleet || subiendoGastoComprobante || (!awaitingFleetReceipt && !expense.pending_receipt_id)}
                                    className={`col-span-3 inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold disabled:opacity-50 sm:col-span-1 ${
                                      awaitingFleetReceipt
                                        ? 'border-[#8B1A1A] bg-red-50 text-[#8B1A1A] hover:bg-red-100'
                                        : receiptReady
                                        ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
                                        : receiptApplied
                                          ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
                                        : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100'
                                    }`}
                                  >
                                    {receiptReady || receiptApplied
                                      ? <ExternalLink className="h-3.5 w-3.5" />
                                      : awaitingFleetReceipt
                                        ? <Upload className="h-3.5 w-3.5" />
                                        : <Banknote className="h-3.5 w-3.5" />}
                                    {awaitingFleetReceipt
                                      ? 'Subir comprobante'
                                      : receiptReady
                                      ? (hasReceiptFile ? 'Comprobante anterior' : 'Comprobante listo')
                                      : receiptApplied
                                        ? 'Pendiente banco'
                                        : 'Listo para cobrar'}
                                  </button>
                                  </div>
                                );
                              })}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-200 px-5 py-4">
                  {gastoComprobanteTarget && (
                    <div className="mb-4 rounded-md border border-red-200 bg-red-50/40 p-3">
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-gray-900">Subir comprobante</p>
                          <p className="truncate text-xs text-gray-500">
                            {labelOtrosGastoType(gastoComprobanteTarget.tipo)} · Cuota {gastoComprobanteTarget.numero_cuota || gastoComprobanteTarget.week_index}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={subiendoGastoComprobante}
                          onClick={() => {
                            setGastoComprobanteTarget(null);
                            setGastoComprobanteArchivo(null);
                            setGastoComprobanteFleetApplicationId(null);
                          }}
                          className="rounded p-1 text-gray-400 hover:bg-white hover:text-gray-700 disabled:opacity-50"
                          aria-label="Cerrar formulario de comprobante"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_6.5rem_minmax(0,1.4fr)_auto] sm:items-end">
                        <label className="text-xs font-medium text-gray-600">
                          Monto
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={gastoComprobanteMonto}
                            onChange={(event) => setGastoComprobanteMonto(event.target.value)}
                            readOnly={Boolean(gastoComprobanteFleetApplicationId)}
                            className="mt-1 h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 text-sm text-gray-900 read-only:bg-gray-100"
                          />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          Moneda
                          <select
                            value={gastoComprobanteMoneda}
                            onChange={(event) => setGastoComprobanteMoneda(event.target.value)}
                            disabled={Boolean(gastoComprobanteFleetApplicationId)}
                            className="mt-1 h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-900 disabled:bg-gray-100"
                          >
                            <option value="PEN">PEN</option>
                            <option value="USD">USD</option>
                            <option value="COP">COP</option>
                          </select>
                        </label>
                        <label className="min-w-0 text-xs font-medium text-gray-600">
                          Archivo
                          <input
                            type="file"
                            accept=".pdf,image/*"
                            onChange={(event) => setGastoComprobanteArchivo(event.target.files?.[0] || null)}
                            className="mt-1 block h-9 w-full min-w-0 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 file:mr-2 file:border-0 file:bg-transparent file:text-xs file:font-semibold"
                          />
                        </label>
                        <button
                          type="button"
                          disabled={subiendoGastoComprobante || !gastoComprobanteArchivo}
                          onClick={uploadAdditionalExpenseReceipt}
                          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[#8B1A1A] px-3 text-xs font-semibold text-white hover:bg-[#741616] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {subiendoGastoComprobante ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                          Subir
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-medium text-gray-600">{selectedAdditionalExpenseFleetIds.length} seleccionadas</span>
                    <span className="font-bold text-gray-900">
                      {Object.entries(selectedAdditionalExpenseFleetTotals).length > 0
                        ? Object.entries(selectedAdditionalExpenseFleetTotals)
                          .map(([currency, total]) => `${symMoneda(currency)} ${total.toFixed(2)} ${currency}`)
                          .join(' · ')
                        : 'Total: —'}
                    </span>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      disabled={chargingGastoFleet || subiendoGastoComprobante}
                      onClick={closeAdditionalExpenseFleetCharge}
                      className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      disabled={chargingGastoFleet || Boolean(gastoComprobanteTarget) || selectedAdditionalExpenseFleetIds.length === 0}
                      onClick={() => void chargeSelectedAdditionalExpenses()}
                      className="inline-flex h-9 items-center gap-2 rounded-md bg-[#8B1A1A] px-3 text-sm font-semibold text-white hover:bg-[#741616] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {chargingGastoFleet ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                      {chargingGastoFleet ? 'Cobrando...' : 'Confirmar cobro'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {comprobantePreview && createPortal(
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center p-4"
          style={{ zIndex: 9999 }}
          onClick={() => setComprobantePreview(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Ver comprobante"
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
              <span className="text-sm font-medium text-gray-900 truncate">{comprobantePreview.fileName}</span>
              <button
                type="button"
                onClick={() => setComprobantePreview(null)}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-600"
                aria-label="Cerrar"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-4 overflow-auto">
              {comprobantePreview.isImage ? (
                <img
                  src={comprobantePreview.url}
                  alt={comprobantePreview.fileName}
                  className="max-w-full h-auto max-h-[70vh] object-contain mx-auto"
                />
              ) : (
                <iframe
                  src={comprobantePreview.url}
                  title={comprobantePreview.fileName}
                  className="w-full min-h-[70vh] rounded-lg border border-gray-200"
                />
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {conformidadEliminarModal &&
        createPortal(
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center p-4"
            style={{ zIndex: 10000 }}
            onClick={() => !eliminandoConformidadId && setConformidadEliminarModal(null)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="conformidad-eliminar-titulo"
          >
            <div
              className="bg-white rounded-xl shadow-xl max-w-md w-full p-5 border border-gray-200"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="conformidad-eliminar-titulo" className="text-base font-semibold text-gray-900">
                ¿Eliminar comprobante de conformidad?
              </h3>
              <p className="mt-2 text-sm text-gray-600">
                Se quitará el documento oficial de esta semana. Podrás subir uno nuevo después.
              </p>
              <div className="mt-4 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5 text-sm text-gray-800">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Usuario que confirma la acción</p>
                <p className="font-medium text-gray-900">
                  {[user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() || '—'}
                </p>
                {user?.email && (
                  <p className="text-xs text-gray-600 mt-0.5 break-all">{user.email}</p>
                )}
                {user?.phone && !user?.email && (
                  <p className="text-xs text-gray-600 mt-0.5">{user.phone}</p>
                )}
              </div>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={!!eliminandoConformidadId}
                  onClick={() => setConformidadEliminarModal(null)}
                  className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={eliminandoConformidadId === conformidadEliminarModal.comprobanteId}
                  onClick={() => void handleConfirmarEliminarConformidadAdmin()}
                  className="px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                >
                  {eliminandoConformidadId === conformidadEliminarModal.comprobanteId ? 'Eliminando…' : 'Sí, eliminar'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {showWhatsAppModal && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowWhatsAppModal(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gray-50">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 bg-[#25D366] rounded-lg flex items-center justify-center">
                  <FaWhatsapp className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900">Enviar por WhatsApp</h3>
              </div>
              <button type="button" onClick={() => setShowWhatsAppModal(false)} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex border-b border-gray-200">
              <button type="button" onClick={() => { setWhatsAppTab('cuotas'); }} className={`px-5 py-2.5 text-sm font-medium transition-colors ${whatsAppTab === 'cuotas' ? 'text-[#8B1A1A] border-b-2 border-[#8B1A1A]' : 'text-gray-500 hover:text-gray-700'}`}>
                Cuotas
              </button>
              <button type="button" onClick={() => handleWhatsAppTabChange('metricas')} className={`px-5 py-2.5 text-sm font-medium transition-colors ${whatsAppTab === 'metricas' ? 'text-[#8B1A1A] border-b-2 border-[#8B1A1A]' : 'text-gray-500 hover:text-gray-700'}`}>
                Metricas
              </button>
              <button type="button" onClick={() => handleWhatsAppTabChange('comprobante')} className={`px-5 py-2.5 text-sm font-medium transition-colors ${whatsAppTab === 'comprobante' ? 'text-[#8B1A1A] border-b-2 border-[#8B1A1A]' : 'text-gray-500 hover:text-gray-700'}`}>
                Comprobante de pago
              </button>
            </div>
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-100 bg-white">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">WhatsApp</p>
                <p className="text-sm font-medium text-gray-900 truncate">{solicitud?.phone || 'Sin teléfono'}</p>
              </div>
              <button
                type="button"
                onClick={() => void handleRefreshWhatsAppPhone()}
                disabled={refreshingWhatsAppPhone}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                title="Actualizar teléfono desde Fleet"
              >
                <RefreshCw className={`w-4 h-4 ${refreshingWhatsAppPhone ? 'animate-spin' : ''}`} />
                Actualizar
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1 grid grid-cols-2 gap-4">
              {/* Columna izquierda */}
              <div className="space-y-3 border-r border-gray-100 pr-3">
                {whatsAppTab === 'cuotas' ? (
                  <>
                    <div>
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conductor</span>
                      <p className="mt-1 text-gray-900 font-medium">
                        {driverDisplayName}
                      </p>
                    </div>
                    <div>
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        {overdueCuotas.length > 0 ? 'Cuotas vencidas' : pendingCuotasHoy.length > 0 ? 'Cuotas que vencen hoy' : 'Estado'}
                      </span>
                      {overdueCuotas.length === 0 && pendingCuotasHoy.length === 0 ? (
                        <p className="mt-1 text-gray-600 text-sm">No hay cuotas vencidas ni pendientes hoy</p>
                      ) : (
                        <ul className="mt-2 space-y-2 max-h-[300px] overflow-y-auto pr-1">
                          {(overdueCuotas.length > 0 ? overdueCuotas : pendingCuotasHoy).slice(0, 10).map((c) => {
                            const sym = symMoneda(monedaCuotaRow(c));
                            const cuotaTotal = Number(c.amount_due || c.cuota_neta) || 0;
                            const pagado = Number(c.paid_amount) || 0;
                            const moraPendiente = Number(c.mora_pendiente ?? c.late_fee) || 0;
                            const moraExtra = Number(c.mora_extra) || 0;
                            const total = miautoCuotaFinalCronogramaSemanal(c);
                            const semana = miautoSemanaOrdinalPorVencimiento(cuotas, c.due_date, c.week_start_date);
                            return (
                              <li key={c.id} className="rounded-lg border border-gray-200 bg-gray-50/80 p-3">
                                <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
                                  <span className="font-semibold text-gray-700">Semana {semana}</span>
                                  <span>{c.status === 'overdue' ? 'Vencio' : 'Vence'} {c.due_date ? formatDateUTC(c.due_date, 'es-ES') : '—'}</span>
                                </div>
                                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                                  <span><span className="text-gray-500">Cuota:</span> <span className="font-medium text-gray-900">{sym} {cuotaTotal.toFixed(2)}</span></span>
                                  {pagado > 0.01 && (
                                    <span><span className="text-gray-500">Pagado:</span> <span className="font-medium text-gray-900">{sym} {pagado.toFixed(2)}</span></span>
                                  )}
                                   {moraPendiente > 0 && (
                                     <span>
                                       <span className="text-gray-500">Mora:</span>
                                       <span className={`font-medium ${pagado > 0.01 ? 'text-green-600' : 'text-red-600'}`}>
                                         {sym} {moraPendiente.toFixed(2)}
                                         {pagado > 0.01 ? <span className="text-[10px] ml-0.5">(pagada)</span> : null}
                                       </span>
                                     </span>
                                   )}
                                  {moraExtra > 0.01 && (
                                    <span><span className="text-gray-500">Mora extra:</span> <span className="font-medium text-red-500">{sym} {moraExtra.toFixed(2)}</span></span>
                                  )}
                                  <span><span className="text-gray-500">Total:</span> <span className="font-semibold text-gray-900">{sym} {total.toFixed(2)}</span></span>
                                </div>
                              </li>
                            );
                          })}
                          {(overdueCuotas.length > 10 || pendingCuotasHoy.length > 10) && (
                            <li className="text-sm text-gray-500 py-1">y {Math.max(overdueCuotas.length, pendingCuotasHoy.length) - 10} cuota(s) mas</li>
                          )}
                        </ul>
                      )}
                    </div>
                    {whatsAppCuotaReciente && (
                      <div>
                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Recaudo de la semana</span>
                        <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50/80 p-3 text-sm space-y-1">
                          {(() => {
                            const pfYangoRaw = Number(whatsAppCuotaReciente.partner_fees_yango_raw || 0);
                            const pf83Real = pfYangoRaw > 0.01 ? roundToTwoDecimals(pfYangoRaw * 0.8333) : 0;
                            const cobroDesdeSaldo = Number(whatsAppCuotaReciente.cobro_desde_saldo_conductor || 0);
                            const cobroSaldoRegla = Number(whatsAppCuotaReciente.cobro_saldo || 0);
                            const sym = symMoneda(monedaCuotaRow(whatsAppCuotaReciente));
                            const viajes = whatsAppCuotaReciente.num_viajes ?? 0;
                            return (
                              <>
                                <div className="flex justify-between"><span className="text-gray-500">Viajes:</span> <span className="font-medium">{viajes}</span></div>
                                {pfYangoRaw > 0.01 && <div className="flex justify-between"><span className="text-gray-500">Recaudo Yango:</span> <span className="font-medium">{sym} {pfYangoRaw.toFixed(2)}</span></div>}
                                {pf83Real > 0.01 && <div className="flex justify-between"><span className="text-gray-500">Cobro ingresos (83%):</span> <span className="font-medium text-orange-600">-{sym} {pf83Real.toFixed(2)}</span></div>}
                                {cobroSaldoRegla > 0.01 && <div className="flex justify-between"><span className="text-gray-500">Cobro de saldo:</span> <span className="font-medium text-orange-600">-{sym} {cobroSaldoRegla.toFixed(2)}</span></div>}
                                {cobroDesdeSaldo > 0.01 && <div className="flex justify-between"><span className="text-gray-500">Cobro Fleet aplicado:</span> <span className="font-medium text-orange-600">-{sym} {cobroDesdeSaldo.toFixed(2)}</span></div>}
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                  </>
                ) : whatsAppTab === 'metricas' ? (
                  <>
                    <div>
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conductor</span>
                      <p className="mt-1 text-gray-900 font-medium">
                        {metricasData?.driver_name || driverDisplayName}
                      </p>
                    </div>
                    {loadingMetricas && (
                      <div className="flex items-center gap-2 py-4">
                        <div className="w-5 h-5 border-2 border-gray-300 border-t-[#8B1A1A] rounded-full animate-spin" />
                        <span className="text-sm text-gray-500">Cargando metricas...</span>
                      </div>
                    )}
                    {metricasError && (
                      <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                        <p className="text-sm text-red-600">{metricasError}</p>
                        <button type="button" onClick={fetchMetricas} className="mt-2 text-sm font-medium text-red-700 hover:text-red-800">
                          Reintentar
                        </button>
                      </div>
                    )}
                    {metricasData?.active_goals?.length > 0 && (() => {
                      const goal = metricasData.active_goals[0];
                      const step = goal.steps?.[0];
                      if (!step) return null;
                      const meta = step.nrides || 0;
                      const completados = goal.total_rides || 0;
                      const pct = meta > 0 ? Math.round((completados / meta) * 100) : 0;
                      const restantes = Math.max(0, meta - completados);
                      const bonus = step.max_bonus || 0;
                      const mult = step.amount || 0;
                      const diasRestantes = goal.window?.end
                        ? Math.max(0, Math.ceil((new Date(goal.window.end).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
                        : 0;
                      const moneda = goal.currency_code || 'PEN';
                      const sym = moneda === 'USD' ? '$' : 'S/';
                      const startDate = goal.window?.start ? formatDateUTC(goal.window.start, 'es-ES') : '—';
                      const endDate = goal.window?.end ? formatDateUTC(goal.window.end, 'es-ES') : '—';
                      const barColor = pct >= 100 ? 'bg-green-500' : pct >= 50 ? 'bg-blue-500' : pct >= 25 ? 'bg-yellow-500' : 'bg-red-400';

                      return (
                        <>
                          <div>
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Objetivo actual</span>
                            <p className="text-xs text-gray-400 mt-0.5">{startDate} - {endDate}</p>
                            <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50/80 p-3 space-y-2">
                              <div className="flex items-center gap-3">
                                <span className="text-xl font-bold text-gray-900">{completados}<span className="text-base text-gray-400 font-normal">/{meta}</span></span>
                                <span className="text-xs text-gray-500">{pct}%</span>
                              </div>
                              <div className="w-full bg-gray-200 rounded-full h-2">
                                <div className={`${barColor} h-2 rounded-full transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
                              </div>
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                                <span><span className="text-gray-500">Meta: </span><span className="font-medium">{meta} viajes</span></span>
                                <span><span className="text-gray-500">Bonus: </span><span className="font-medium">{sym} {Number(bonus).toFixed(2)}</span></span>
                                <span><span className="text-gray-500">Mult: </span><span className="font-medium">{mult}%</span></span>
                                <span><span className="text-gray-500">Faltan: </span><span className="font-medium">{restantes} viajes</span></span>
                                <span><span className="text-gray-500">Restan: </span><span className="font-medium">{diasRestantes} dias</span></span>
                              </div>
                            </div>
                          </div>
                          {metricasData.previous_goals?.length > 0 && (() => {
                            const prev = metricasData.previous_goals[0];
                            const prevStep = prev.steps?.[0];
                            if (!prevStep) return null;
                            const prevMeta = prevStep.nrides || 0;
                            const prevTotal = prev.total_rides || 0;
                            const prevCompleted = prevStep.is_completed;
                            const prevPago = prev.payment_info?.amount || 0;
                            const prevPagoFecha = prev.payment_info?.expected_payment_date || '';
                            const prevStart = prev.window?.start ? formatDateUTC(prev.window.start, 'es-ES') : '—';
                            const prevEnd = prev.window?.end ? formatDateUTC(prev.window.end, 'es-ES') : '—';
                            return (
                              <div>
                                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Semana anterior</span>
                                <p className="text-xs text-gray-400 mt-0.5">{prevStart} - {prevEnd}</p>
                                <div className="mt-1.5 rounded-lg border border-gray-200 bg-gray-50/80 p-2.5 text-xs space-y-1">
                                  <div className="flex justify-between">
                                    <span className="text-gray-500">Estado:</span>
                                    <span className={`font-medium ${prevCompleted ? 'text-green-600' : 'text-gray-900'}`}>
                                      {prevCompleted ? 'Completada' : 'No completada'}
                                    </span>
                                  </div>
                                  <div className="flex justify-between"><span className="text-gray-500">Viajes:</span> <span className="font-medium">{prevTotal}/{prevMeta}</span></div>
                                  {Number(prevPago) > 0 && (
                                    <div className="flex justify-between"><span className="text-gray-500">Pago:</span> <span className="font-medium">{sym} {Number(prevPago).toFixed(2)}</span></div>
                                  )}
                                  {prevPagoFecha && (
                                    <div className="flex justify-between"><span className="text-gray-500">Fecha pago:</span> <span className="font-medium">{formatDateUTC(prevPagoFecha, 'es-ES')}</span></div>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </>
                      );
                    })()}
                    {!loadingMetricas && !metricasError && (!metricasData?.active_goals || metricasData.active_goals.length === 0) && (
                      <p className="text-sm text-gray-500 py-4">No hay objetivos activos para este conductor.</p>
                    )}
                  </>
                ) : (
                  <>
                    <div>
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conductor</span>
                      <p className="mt-1 text-gray-900 font-medium">
                        {driverDisplayName}
                      </p>
                      {solicitud?.phone && (
                        <p className="text-sm text-gray-500 mt-0.5">{solicitud.phone}</p>
                      )}
                    </div>

                    {notasVentaConPdf.length === 0 ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <p className="text-sm font-medium text-amber-900">No hay comprobantes con PDF disponible.</p>
                        <p className="text-xs text-amber-700 mt-1">Primero genera la nota de venta y espera que el PDF quede guardado.</p>
                      </div>
                    ) : (
                      <div>
                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Comprobante</span>
                        <div className="mt-2 space-y-2 max-h-[340px] overflow-y-auto pr-1">
                          {notasVentaConPdf.map((nota) => {
                            const selected = whatsAppNotaSeleccionada?.id === nota.id;
                            const moneda = nota.currency_type_id || 'PEN';
                            const semanas = (nota.cuotas || [])
                              .map((c) => c.semana)
                              .filter((semana): semana is number => semana != null)
                              .sort((a, b) => a - b);
                            return (
                              <label
                                key={nota.id}
                                className={`block rounded-lg border p-3 cursor-pointer transition ${selected ? 'border-[#8B1A1A] bg-red-50/50' : 'border-gray-200 bg-gray-50/80 hover:bg-gray-50'}`}
                              >
                                <div className="flex items-start gap-3">
                                  <input
                                    type="radio"
                                    checked={selected}
                                    onChange={() => setWhatsAppNotaVentaId(nota.id)}
                                    className="mt-1 h-4 w-4 border-gray-300 text-[#8B1A1A] focus:ring-[#8B1A1A]"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-semibold text-gray-900 truncate">{nota.number_full || `ID ${nota.facturador_sale_note_id}`}</span>
                                      <span className="text-sm font-bold text-green-700 whitespace-nowrap">{symMoneda(moneda)} {miautoNum(nota.total).toFixed(2)}</span>
                                    </div>
                                    <p className="text-xs text-gray-500 mt-1">
                                      {semanas.length > 0 ? `Cuota(s): ${semanas.map((s) => `#${s}`).join(', ')}` : 'Sin cuotas asociadas'}
                                    </p>
                                    <div className="mt-2 flex items-center gap-2 text-xs">
                                      <FileText className="w-3.5 h-3.5 text-[#8B1A1A]" />
                                      <span className="text-gray-600 truncate">{nota.download_name || `${nota.number_full || 'comprobante'}.pdf`}</span>
                                    </div>
                                  </div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
              {/* Columna derecha: Mensaje */}
              <div className="flex flex-col">
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Mensaje que vera el conductor</label>
                <textarea
                  value={whatsAppMessage}
                  onChange={(e) => setWhatsAppMessage(e.target.value)}
                  rows={16}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 resize-none"
                  placeholder="Escribe el mensaje..."
                />
              </div>
            </div>
            <div className="flex gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={() => setShowWhatsAppModal(false)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg font-medium hover:bg-gray-50"
              >
                Cerrar
              </button>
              <button
                type="button"
                onClick={handleSendWhatsApp}
                disabled={!whatsAppCanSend}
                className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white ${whatsAppCanSend ? 'bg-[#25D366] hover:bg-[#20BD5A]' : 'bg-gray-300 cursor-not-allowed'}`}
              >
                <FaWhatsapp className="w-5 h-5" />
                {sendingWhatsApp ? 'Enviando...' : whatsAppPhone ? (whatsAppTab === 'comprobante' ? 'Enviar comprobante' : 'Enviar por WhatsApp') : 'Sin numero'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showNotasVentaModal && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => !generandoNotaVenta && setShowNotasVentaModal(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-[#8B1A1A]/10 flex items-center justify-center">
                  <ReceiptText className="w-5 h-5 text-[#8B1A1A]" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-900">Generar boletas</h3>
                  <p className="text-xs text-gray-500">Selecciona cuotas pagadas en soles o dólares para emitir nota de venta.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowNotasVentaModal(false)}
                disabled={generandoNotaVenta}
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4 overflow-y-auto max-h-[calc(90vh-150px)]">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
                <div className="rounded-lg border border-gray-200 px-4 py-2 bg-gray-50">
                  <span className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Cliente facturador</span>
                  <span className="text-sm font-semibold text-gray-900">
                    Vinculado - ID {facturadorCustomerId}
                  </span>
                </div>
                <div className="rounded-lg border border-gray-200 px-4 py-2 bg-gray-50 min-w-[150px]">
                  <span className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Total</span>
                  <span className="text-lg font-bold text-gray-900">{symMoneda(notaVentaMonedaSeleccionada)} {notaVentaTotalSeleccionado.toFixed(2)}</span>
                </div>
              </div>

              {notaVentaSeleccionMixta && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Selecciona cuotas de una sola moneda para generar la nota de venta.
                </div>
              )}

              {notasVenta.length > 0 && (
                <div className="rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-xs text-green-800">
                  Ya existen {notasVenta.length} nota(s) generada(s) para este contrato. Las cuotas ya facturadas quedan bloqueadas.
                </div>
              )}

              {cuotasNotaVentaDisponibles.length === 0 ? (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-5 text-center">
                  <p className="text-sm font-medium text-gray-800">No hay cuotas pagadas disponibles para facturar.</p>
                  <p className="text-xs text-gray-500 mt-1">Solo aparecen cuotas con estado pagado, monto mayor a cero, moneda PEN o USD y sin nota previa.</p>
                </div>
              ) : (
                <div className="rounded-lg border border-gray-200 overflow-hidden">
                  <div className="flex items-center justify-between gap-3 px-3 py-2 bg-gray-50 border-b border-gray-200">
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                      {notaVentaCuotasIds.length} de {cuotasNotaVentaDisponibles.length} seleccionadas
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const allSelected = notaVentaCuotasIds.length === cuotasNotaVentaDisponibles.length;
                        const next: Record<string, boolean> = {};
                        cuotasNotaVentaDisponibles.forEach((c) => { next[c.id] = !allSelected; });
                        setNotaVentaCuotasSeleccionadas(next);
                      }}
                      className="text-xs font-medium text-[#8B1A1A] hover:text-[#6B1515]"
                    >
                      {notaVentaCuotasIds.length === cuotasNotaVentaDisponibles.length ? 'Quitar selección' : 'Seleccionar todo'}
                    </button>
                  </div>
                  <div className="divide-y divide-gray-100 max-h-[360px] overflow-y-auto">
                    {cuotasNotaVentaDisponibles.map((c) => {
                      const semana = miautoSemanaLista(cuotas, c.week_start_date) ?? miautoSemanaOrdinalPorVencimiento(cuotas, c.due_date, c.week_start_date) ?? '—';
                      const checked = notaVentaCuotasSeleccionadas[c.id] === true;
                      const monedaCuota = monedaCuotaRow(c);
                      const pagoDirecto = miautoNum(c.paid_amount);
                      const recaudo = Math.max(0, miautoNum(c.partner_fees_83));
                      const cobroSaldoRaw = miautoNum(c.cobro_saldo);
                      const cobroDesdeSaldoConductor = Math.max(0, miautoNum(c.cobro_desde_saldo_conductor));
                      const cobroSaldoInterno = Math.max(0, Math.abs(cobroSaldoRaw) - cobroDesdeSaldoConductor);
                      const montoFacturable = miautoMontoFacturableNotaVentaCuota(c);
                      const detallesFacturacion = [
                        recaudo > 0.005 ? `Recaudo ${symMoneda(monedaCuota)} ${recaudo.toFixed(2)}` : null,
                        cobroSaldoInterno > 0.005 ? `Cobro saldo ${symMoneda(monedaCuota)} ${cobroSaldoInterno.toFixed(2)}` : null,
                        pagoDirecto > 0.005 ? `Pago ${symMoneda(monedaCuota)} ${pagoDirecto.toFixed(2)}` : null,
                      ].filter(Boolean);
                      return (
                        <label key={c.id} className="flex items-center gap-3 px-3 py-3 hover:bg-gray-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleNotaVentaCuota(c.id)}
                            className="h-4 w-4 rounded border-gray-300 text-[#8B1A1A] focus:ring-[#8B1A1A]"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="text-sm font-semibold text-gray-900">Semana {semana}</span>
                              <span className="text-xs text-gray-500">{c.due_date ? formatDate(c.due_date, 'es-ES') : 'Sin fecha'}</span>
                            </div>
                            <p className="text-xs text-gray-500 truncate">
                              {detallesFacturacion.length > 0 ? detallesFacturacion.join(' + ') : 'Cuota pagada lista para nota de venta'}
                            </p>
                          </div>
                          <span className="text-sm font-bold tabular-nums text-green-700">{symMoneda(monedaCuota)} {montoFacturable.toFixed(2)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {notasVenta.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Notas generadas</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {notasVenta.slice(0, 6).map((nota) => (
                      <div key={nota.id} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-gray-900">{nota.number_full || `ID ${nota.facturador_sale_note_id}`}</span>
                          <span className="text-green-700 font-medium">{symMoneda(nota.currency_type_id || 'PEN')} {miautoNum(nota.total).toFixed(2)}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-gray-500">
                          <span>{nota.created_at ? formatDateTime(nota.created_at, 'es-ES') : '—'}</span>
                          <div className="flex items-center gap-2">
                            {nota.print_a4 && (
                              <button
                                type="button"
                                onClick={() => handleDescargarNotaVenta(nota)}
                                disabled={descargandoNotaVentaId === nota.id}
                                className="inline-flex items-center gap-1 text-[#8B1A1A] hover:underline disabled:opacity-60"
                              >
                                {descargandoNotaVentaId === nota.id ? 'Descargando...' : 'Descargar'}
                                <Download className="w-3 h-3" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setNotaVentaAnularModal(nota)}
                              disabled={anulandoNotaVentaId === nota.id || generandoNotaVenta}
                              className="inline-flex items-center gap-1 text-red-600 hover:text-red-700 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Trash2 className="w-3 h-3" />
                              {anulandoNotaVentaId === nota.id ? 'Anulando...' : 'Anular'}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={() => setShowNotasVentaModal(false)}
                disabled={generandoNotaVenta}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                Cerrar
              </button>
              <button
                type="button"
                onClick={handleGenerarNotaVenta}
                disabled={generandoNotaVenta || notaVentaCuotasIds.length === 0 || notaVentaTotalSeleccionado <= 0 || notaVentaSeleccionMixta}
                className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white ${
                  !generandoNotaVenta && notaVentaCuotasIds.length > 0 && notaVentaTotalSeleccionado > 0 && !notaVentaSeleccionMixta
                    ? 'bg-[#8B1A1A] hover:bg-[#6B1515]'
                    : 'bg-gray-300 cursor-not-allowed'
                }`}
              >
                <ReceiptText className="w-4 h-4" />
                {generandoNotaVenta ? 'Generando...' : 'Generar nota de venta'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {notaVentaAnularModal && createPortal(
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50"
          onClick={() => !anulandoNotaVentaId && setNotaVentaAnularModal(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white shadow-2xl border border-gray-200 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200">
              <div className="w-10 h-10 rounded-lg bg-red-50 text-red-700 flex items-center justify-center">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-gray-900">Anular nota de venta</h3>
                <p className="text-xs text-gray-500 truncate">
                  {notaVentaAnularModal.number_full || `ID ${notaVentaAnularModal.facturador_sale_note_id}`}
                </p>
              </div>
            </div>

            <div className="px-5 py-4 space-y-3">
              <p className="text-sm text-gray-700">
                Se anulará la nota en el facturador y las cuotas asociadas quedarán disponibles para generar una nueva nota.
              </p>
              <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-800">
                Esta acción no elimina la trazabilidad local; solo marca la nota como anulada.
              </div>
            </div>

            <div className="flex gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={() => setNotaVentaAnularModal(null)}
                disabled={!!anulandoNotaVentaId}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmarAnularNotaVenta}
                disabled={anulandoNotaVentaId === notaVentaAnularModal.id}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-4 h-4" />
                {anulandoNotaVentaId === notaVentaAnularModal.id ? 'Anulando...' : 'Sí, anular'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showStartDateCorrectionModal && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="start-date-correction-title"
          onClick={() => {
            if (!savingStartDateCorrection) setShowStartDateCorrectionModal(false);
          }}
        >
          <form
            className="w-full max-w-md overflow-hidden rounded-lg bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void saveStartDateCorrection();
            }}
          >
            <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 id="start-date-correction-title" className="text-base font-bold text-gray-900">
                  Modificar inicio de cobro
                </h3>
                <p className="mt-1 text-xs text-gray-500">
                  Fecha actual: {solicitud.fecha_inicio_cobro_semanal
                    ? formatDate(solicitud.fecha_inicio_cobro_semanal, 'es-ES')
                    : '—'}
                </p>
              </div>
              <button
                type="button"
                disabled={savingStartDateCorrection}
                onClick={() => setShowStartDateCorrectionModal(false)}
                className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                aria-label="Cerrar"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <label className="block text-sm font-semibold text-gray-700">
                Nueva fecha de inicio de cobro
                <input
                  type="date"
                  required
                  value={startDateCorrection}
                  onChange={(event) => setStartDateCorrection(event.target.value)}
                  disabled={savingStartDateCorrection}
                  className="mt-1.5 h-10 w-full rounded-md border border-gray-300 px-3 text-sm text-gray-900 outline-none focus:border-[#8B1A1A] focus:ring-1 focus:ring-[#8B1A1A] disabled:bg-gray-100"
                />
              </label>
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
                La corrección reprogramará la semana de depósito y su vencimiento inicial. Por seguridad,
                solo se permite antes de que existan cuotas posteriores, comprobantes, cobros o bonos.
              </div>
              <p className="text-xs leading-relaxed text-gray-500">
                Los otros gastos conservan su fecha de entrega independiente. Si aún no se generaron,
                la fecha de entrega inicial también se sincronizará.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-4">
              <button
                type="button"
                disabled={savingStartDateCorrection}
                onClick={() => setShowStartDateCorrectionModal(false)}
                className="h-9 rounded-md border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={
                  savingStartDateCorrection
                  || !startDateCorrection
                  || startDateCorrection === String(solicitud.fecha_inicio_cobro_semanal || '').slice(0, 10)
                }
                className="inline-flex h-9 items-center gap-2 rounded-md bg-[#8B1A1A] px-4 text-sm font-semibold text-white hover:bg-[#741616] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingStartDateCorrection
                  ? <RefreshCw className="h-4 w-4 animate-spin" />
                  : <CheckCircle2 className="h-4 w-4" />}
                {savingStartDateCorrection ? 'Guardando...' : 'Guardar cambio'}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      )}

      {id && (
        <MiautoAttachContractModal
          open={showAttachContractModal}
          sourceContractId={id}
          country={solicitud.country || 'PE'}
          onClose={() => setShowAttachContractModal(false)}
          onCreated={(contractId) => {
            setShowAttachContractModal(false);
            navigate(`/admin/yego-mi-auto/rent-sale/${contractId}`, {
              state: { ...listState, driver_name: driverDisplayName },
            });
          }}
        />
      )}

      {id && <MiautoGenerarCuotaModal
        solicitudId={id}
        open={showGenerarCuotaModal}
        onClose={() => setShowGenerarCuotaModal(false)}
        onGenerated={() => fetchDetail(undefined, { refresh: true })}
      />}
    </div>
  );
}
