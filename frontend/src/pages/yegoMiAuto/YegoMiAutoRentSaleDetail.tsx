import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import api from '../../services/api';
import { ArrowLeft, FileText, Banknote, Calendar, User, Car, Tag, TrendingUp, Copy, Check, ExternalLink, X, ChevronDown, ChevronRight, AlertCircle, Award, Upload, Trash2, Plus } from 'lucide-react';
import { FaWhatsapp } from 'react-icons/fa';
import toast from 'react-hot-toast';
import { formatDate, formatDateTime, formatDateUTC } from '../../utils/date';
import { CUENTAS_BANCARIAS_WHATSAPP } from '../yegoRapidin/LoanDetail';
import { TablePaginationBar } from '../../components/TablePaginationBar';
import { useTablePagination } from '../../hooks/useTablePagination';
import { type MiautoOtrosGastoRow } from '../../utils/miautoOtrosGastos';
import { monedaCuotasLabel, symMoneda } from '../../utils/miautoAlquilerVentaList';
import { MIAUTO_NO_CACHE_HEADERS, emptyListIfNotAbort, isAxiosAbortError } from '../../utils/miautoApiUtils';
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
import { MiautoComprobantePagoActions } from '../../components/yegoMiAuto/MiautoComprobantePagoActions';
import { MiautoComprobantesResumenSemana } from '../../components/yegoMiAuto/MiautoComprobantesResumenSemana';
import { MiautoGenerarCuotaModal } from '../../components/yegoMiAuto/MiautoGenerarCuotaModal';
import { useAuth } from '../../contexts/AuthContext';
import { roundToTwoDecimals } from '../../utils/currency';
import {
  montoConvertidoPenUsdFormatted,
  resolveTipoCambioUsdALocalFromRows,
} from '../../utils/miautoPenUsdConversion';

const TIPO_OTROS_GASTOS_LABELS: Record<string, string> = {
  gps: 'GPS',
  src: 'Seguro RC (SRC)',
  soat: 'SOAT',
  impuesto_vehicular: 'Impuesto Vehicular',
  todo_riesgo_mas_gps_agrupado: 'STR + GPS',
  inicial_parcial: 'Inicial Parcial',
  generico: 'Otros Gastos',
};

const TIPO_OTROS_GASTOS_ACCENT: Record<string, string> = {
  gps: 'border-l-blue-500',
  src: 'border-l-amber-500',
  soat: 'border-l-green-500',
  impuesto_vehicular: 'border-l-orange-500',
  todo_riesgo_mas_gps_agrupado: 'border-l-purple-500',
  inicial_parcial: 'border-l-teal-500',
  generico: 'border-l-gray-400',
};

const TIPO_OTROS_GASTOS_BAR: Record<string, string> = {
  gps: 'bg-blue-500',
  src: 'bg-amber-500',
  soat: 'bg-green-500',
  impuesto_vehicular: 'bg-orange-500',
  todo_riesgo_mas_gps_agrupado: 'bg-purple-500',
  inicial_parcial: 'bg-teal-500',
  generico: 'bg-gray-400',
};

interface CuotaSemanal {
  id: string;
  week_start_date: string;
  due_date: string;
  num_viajes?: number | null;
  bono_auto?: number;
  cuota_semanal?: number;
  amount_due: number;
  paid_amount: number;
  /** Comprobante en revisión (staff): suma proyectada aún no persistida en `paid_amount`. */
  abono_comprobante_en_revision?: number;
  late_fee: number;
  /** Días civiles tras el vencimiento (Lima); el día de vencimiento es 0. */
  late_fee_calendar_days?: number;
  /** Interés devengado del periodo (misma cifra que `late_fee` en API cuando la pendiente es 0). */
  mora_interes_periodo?: number;
  /** Mora total acumulada en este periodo (valor BD). Aunque ya pagada, muestra cuánto se acumuló. */
  mora_acumulada?: number;
  /** Mora extra: generada sobre el pendiente cuando hay pagos parciales en cuotas vencidas. Empieza en 0. */
  mora_extra?: number;
  /** Saldo mora pendiente tras pagos (API); para neto Excel. */
  mora_pendiente?: number;
  status: string;
  pending_total?: number;
  moneda?: string;
  cobro_saldo?: number;
  cobro_desde_saldo_conductor?: number;
  saldo_favor_conductor?: number;
  cobro_saldo_referencia?: { semana?: number; week_start_date?: string; monto: number }[];
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
  country?: string;
  status: string;
  fecha_inicio_cobro_semanal?: string;
  placa_asignada?: string;
  cronograma?: { id: string; name: string; tasa_interes_mora?: number; bono_tiempo_activo?: boolean } | null;
  cronograma_vehiculo?: { id: string; name: string; cuotas_semanales?: number; inicial_moneda?: string } | null;
  otros_gastos?: MiautoOtrosGastoRow[];
}

interface ComprobanteCuotaSemanal {
  id: string;
  solicitud_id: string;
  cuota_semanal_id: string;
  monto?: number | null;
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

/** Saldo pendiente numérico para conformidad admin (Yego): API primero, luego columnas − pagado. */
function pendienteRestanteConformidadCuota(c: CuotaSemanal): number {
  const ad = Number(c.amount_due) || 0;
  const moraP = Math.max(Number(c.mora_pendiente ?? 0), Number(c.mora_acumulada ?? c.late_fee ?? 0)) || 0;
  const moraExtra = miautoNum(c.mora_extra);
  const pd = Number(c.paid_amount) || 0;
  return roundToTwoDecimals(Math.max(0, ad + moraP + moraExtra - pd));
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
  const driverNameFromState = (location.state as { driver_name?: string })?.driver_name;

  type AlquilerVentaListState = {
    fromList?: boolean;
    country?: string;
    driverSearchInput?: string;
    cronogramaId?: string;
    cuotaEstado?: string;
    page?: number;
    pageSize?: number;
  };

  type AlquilerVentaBackState = AlquilerVentaListState & { fromDetail?: boolean };

  const getBackToListState = (): AlquilerVentaBackState | undefined => {
    const s = location.state as AlquilerVentaListState | null;
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

  const [solicitud, setSolicitud] = useState<SolicitudSummary | null>(null);
  const [cuotas, setCuotas] = useState<CuotaSemanal[]>([]);
  const [comprobantesPagos, setComprobantesPagos] = useState<ComprobanteCuotaSemanal[]>([]);
  const [comprobantePreview, setComprobantePreview] = useState<{ url: string; fileName: string; isImage: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  /** Recarga tras validar/rechazar: solo overlay en cronograma (no pantalla entera). */
  const [refreshingDetail, setRefreshingDetail] = useState(false);
  const [error, setError] = useState('');
  const [idCopied, setIdCopied] = useState(false);
  const [validandoCompId, setValidandoCompId] = useState<string | null>(null);
  const [rechazandoCompId, setRechazandoCompId] = useState<string | null>(null);
  const [comprobantesSemanaAbierta, setComprobantesSemanaAbierta] = useState<Record<string, boolean>>({});
  const [otrosTiposAbiertos, setOtrosTiposAbiertos] = useState<Record<string, boolean>>({});
  const [subiendoConformidadCuotaId, setSubiendoConformidadCuotaId] = useState<string | null>(null);
  /** Archivo elegido por cuota; la subida es explícita con el botón «Subir». */
  const [conformidadArchivoPendiente, setConformidadArchivoPendiente] = useState<Record<string, File | null>>({});
  /** Sobrescritura opcional de monto/moneda mostrados al subir conformidad (por defecto = pendiente de la cuota). */
  const [conformidadMontoInput, setConformidadMontoInput] = useState<Record<string, string>>({});
  const [conformidadMonedaInput, setConformidadMonedaInput] = useState<Record<string, 'PEN' | 'USD'>>({});
  const conformidadFileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [conformidadEliminarModal, setConformidadEliminarModal] = useState<{ comprobanteId: string } | null>(null);
  const [eliminandoConformidadId, setEliminandoConformidadId] = useState<string | null>(null);
  const [racha, setRacha] = useState<number | null>(null);
  const [bonoAplicado, setBonoAplicado] = useState<number>(0);
  const [tabCronograma, setTabCronograma] = useState<'semanales' | 'otros_gastos'>('semanales');
  const [otrosGastosFilter, setOtrosGastosFilter] = useState<'todos' | 'pending' | 'paid' | 'overdue'>('todos');
  const [subTabCuota, setSubTabCuota] = useState<Record<string, 'comprobantes' | 'evidencias'>>({});
  const [evidenciasFleet, setEvidenciasFleet] = useState<{ id: string; cuota_semanal_id: string; file_name: string; file_path: string; created_at: string }[]>([]);
  const [subiendoEvidenciaCuotaId, setSubiendoEvidenciaCuotaId] = useState<string | null>(null);
  const [eliminandoEvidenciaId, setEliminandoEvidenciaId] = useState<string | null>(null);
  const evidenciaFleetFileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [showGenerarCuotaModal, setShowGenerarCuotaModal] = useState(false);
  const [whatsAppMessage, setWhatsAppMessage] = useState('');
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);
  const [whatsAppTab, setWhatsAppTab] = useState<'cuotas' | 'metricas'>('cuotas');
  const [whatsAppCuotasMsg, setWhatsAppCuotasMsg] = useState('');
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

  const pendienteTotalCronogramaValidar = useMemo(() => {
    const sum = cuotas.reduce((acc, row) => {
      if (row.status === 'bonificada') return acc;
      const saldoApi = row.pending_total ?? row.cuota_final;
      if (saldoApi != null && Number.isFinite(Number(saldoApi))) {
        const v = Math.max(0, roundToTwoDecimals(Number(saldoApi)));
        if (v > 0.005) return acc + v;
      }
      if (row.status === 'paid') return acc;
      const ad = Number(row.amount_due) || 0;
      const moraP = row.mora_pendiente != null ? Number(row.mora_pendiente) : Number(row.late_fee) || 0;
      const pd = Number(row.paid_amount) || 0;
      return acc + Math.max(0, roundToTwoDecimals(ad + moraP - pd));
    }, 0);
    return roundToTwoDecimals(sum);
  }, [cuotas]);

  const overdueCuotas = useMemo(() => cuotas.filter((c) => c.status === 'overdue'), [cuotas]);
  const pendingCuotasHoy = useMemo(() => {
    const hoy = new Date().toISOString().slice(0, 10);
    return cuotas.filter((c) => c.status === 'pending' && c.due_date?.slice(0, 10) === hoy);
  }, [cuotas]);

  const cuotasPendientes = useMemo(() => cuotas.filter((c) =>
    c.status !== 'paid' && c.status !== 'bonificada' && (Number(c.pending_total ?? 0) || 0) > 0.01
  ), [cuotas]);

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

  const openWhatsAppModal = () => {
    setWhatsAppTab('cuotas');
    setMetricasData(null);
    setMetricasError('');
    const name = driverNameFromState || 'Conductor';

    const cuotaReciente = [...cuotas].sort((a, b) => {
      const wa = a.week_start_date || '';
      const wb = b.week_start_date || '';
      if (wa > wb) return -1;
      if (wa < wb) return 1;
      return 0;
    })[0];

    let defaultText: string;

    if (overdueCuotas.length > 0) {
      const sym = cuotaReciente ? symMoneda(monedaCuotaRow(cuotaReciente)) : 'S/';
      const viajes = cuotaReciente?.num_viajes ?? 0;
      const cuotaSemanal = Number(cuotaReciente?.cuota_semanal || 0);

      let header = `Hola ${name},\n\nLe compartimos el detalle de su pago:\n`;
      if (cuotaReciente) {
        header += `- Semana ${miautoSemanaOrdinalPorVencimiento(cuotas, cuotaReciente.due_date, cuotaReciente.week_start_date)}: ${viajes} viajes - ${sym} ${cuotaSemanal.toFixed(2)}\n`;
      }

      const pfYangoRaw = Number(cuotaReciente?.partner_fees_yango_raw || 0);
      const pf83Real = pfYangoRaw > 0.01 ? roundToTwoDecimals(pfYangoRaw * 0.8333) : 0;
      const cobroDesdeSaldo = Number(cuotaReciente?.cobro_desde_saldo_conductor || 0);
      const cobroSaldoRegla = Number(cuotaReciente?.cobro_saldo || 0);

      let descuentos = '\nDESCUENTOS:\n';
      let hasDescuentos = false;
      if (pf83Real > 0.01) { descuentos += `🔹 Cobro por ingresos (83.33%): ${sym} ${pf83Real.toFixed(2)}\n`; hasDescuentos = true; }
      if (cobroSaldoRegla > 0.01) { descuentos += `🔹 Cobro de saldo: ${sym} ${cobroSaldoRegla.toFixed(2)}\n`; hasDescuentos = true; }
      if (cobroDesdeSaldo > 0.01) { descuentos += `🔹 Cobro de saldo (Fleet): ${sym} ${cobroDesdeSaldo.toFixed(2)}\n`; hasDescuentos = true; }
      if (!hasDescuentos) descuentos += `🔹 Sin descuentos esta semana\n`;

      const cascadaRef = cuotaReciente?.partner_fees_cascada_aplicado_a;
      if (Array.isArray(cascadaRef) && cascadaRef.length > 0) {
        descuentos += `\n📌 Cobro aplicado a otras semanas:\n`;
        cascadaRef.forEach((ref: any) => {
          const sem = miautoSemanaOrdinalPorVencimiento(cuotas, ref.week_start_date, ref.week_start_date);
          descuentos += `   → Semana ${sem}: ${sym} ${Number(ref.monto).toFixed(2)}\n`;
        });
      }

      descuentos += `\n------------------------------------------------------------------------\nPENDIENTE:\n`;

      const pendientes = cuotasPendientes
        .filter((c) => (Number(c.pending_total ?? 0) || 0) > 0.01)
        .slice(0, 10)
        .map((c) => {
          const s = symMoneda(monedaCuotaRow(c));
          const pendingTotal = Number(c.amount_due || 0) - Number(c.paid_amount || 0)
            + Math.max(Number(c.mora_pendiente ?? 0), Number(c.mora_acumulada ?? c.late_fee ?? 0))
            + miautoNum(c.mora_extra);
          const semana = miautoSemanaOrdinalPorVencimiento(cuotas, c.due_date, c.week_start_date);
          return { semana, sym: s, pendingTotal };
        });
      const mas = cuotasPendientes.length > 10 ? cuotasPendientes.length - 10 : 0;

      const lineasPendientes = pendientes.map((p) => `🔹 Semana ${p.semana}: ${p.sym} ${p.pendingTotal.toFixed(2)} 🚨`);
      descuentos += lineasPendientes.join('\n');
      if (mas > 0)       descuentos += `\n🔹 Y ${mas} cuota(s) más... 🚨`;
      defaultText = `${header}${descuentos}\n\nCualquier consulta quedamos atentos 👍\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
    } else if (cuotaReciente) {
      const sym = symMoneda(monedaCuotaRow(cuotaReciente));
      const viajes = cuotaReciente.num_viajes ?? 0;
      const cuotaSemanal = Number(cuotaReciente.cuota_semanal || cuotaReciente.amount_due || 0);
      const pfYangoRaw = Number(cuotaReciente.partner_fees_yango_raw || 0);
      const pf83Real = roundToTwoDecimals(pfYangoRaw * 0.8333);
      const cobroSaldoRegla = Number(cuotaReciente.cobro_saldo || 0);
      const cobroDesdeSaldo = Number(cuotaReciente.cobro_desde_saldo_conductor || 0);
      const saldoFavor = Number(cuotaReciente.saldo_favor_conductor || 0);
      const pagado = Number(cuotaReciente.paid_amount || 0);
      const pendingTotalCuota = Number(cuotaReciente.amount_due || 0) - Number(cuotaReciente.paid_amount || 0)
        + Math.max(Number(cuotaReciente.mora_pendiente ?? 0), Number(cuotaReciente.mora_acumulada ?? cuotaReciente.late_fee ?? 0))
        + miautoNum(cuotaReciente.mora_extra);
      const semana = miautoSemanaOrdinalPorVencimiento(cuotas, cuotaReciente.due_date, cuotaReciente.week_start_date);
      const cubierto = pendingTotalCuota <= 0.01;

      let header = `Hola ${name},\n\nLe compartimos el detalle de su pago:\n- Semana ${semana}: ${viajes} viajes - ${sym} ${cuotaSemanal.toFixed(2)}\n`;

      let descuentos = '\nDESCUENTOS:\n';
      let hasDescuentos = false;
      if (pf83Real > 0.01) { descuentos += `🔹 Cobro por ingresos (83.33%): ${sym} ${pf83Real.toFixed(2)}\n`; hasDescuentos = true; }
      if (cobroSaldoRegla > 0.01) { descuentos += `🔹 Cobro de saldo: ${sym} ${cobroSaldoRegla.toFixed(2)}\n`; hasDescuentos = true; }
      if (cobroDesdeSaldo > 0.01) { descuentos += `🔹 Cobro de saldo (Fleet): ${sym} ${cobroDesdeSaldo.toFixed(2)}\n`; hasDescuentos = true; }
      if (!hasDescuentos) descuentos += `🔹 Sin descuentos esta semana\n`;

      const cascadaRefSingle = cuotaReciente?.partner_fees_cascada_aplicado_a;
      if (Array.isArray(cascadaRefSingle) && cascadaRefSingle.length > 0) {
        descuentos += `\n📌 Cobro aplicado a otras semanas:\n`;
        cascadaRefSingle.forEach((ref: any) => {
          const sem = miautoSemanaOrdinalPorVencimiento(cuotas, ref.week_start_date, ref.week_start_date);
          descuentos += `   → Semana ${sem}: ${sym} ${Number(ref.monto).toFixed(2)}\n`;
        });
      }

      if (cubierto) {
        let pagadoText = `\n------------------------------------------------------------------------\nPAGADO:\n`;
        if (pagado > 0.01) pagadoText += `🔹 Pagado: ${sym} ${pagado.toFixed(2)} ✅\n`;
        pagadoText += `\n🔸 ¡Cuota cubierta! ✅\n`;
        if (saldoFavor > 0.01) pagadoText += `\nSaldo a tu favor: ${sym} ${saldoFavor.toFixed(2)} 🎉`;
        defaultText = `${header}${descuentos}${pagadoText}\n\nCualquier consulta quedamos atentos 👍`;
      } else {
        defaultText = `${header}${descuentos}\n------------------------------------------------------------------------\nPENDIENTE:\n🔹 Semana ${semana}: ${sym} ${pendingTotalCuota.toFixed(2)} 🚨\n\nCualquier consulta quedamos atentos 👍\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
      }
    } else {
      defaultText = `Hola ${name},\n\nTe contactamos respecto a tu contrato Yego Mi Auto. Cualquier duda estamos a tu disposición.\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
    }

    setWhatsAppMessage(defaultText);
    setWhatsAppCuotasMsg(defaultText);
    setShowWhatsAppModal(true);
  };

  const handleSendWhatsApp = async () => {
    if (!id || !whatsAppMessage.trim() || !whatsAppPhone) return;
    setSendingWhatsApp(true);
    try {
      await api.post(`/miauto/solicitudes/${id}/send-whatsapp`, { message: whatsAppMessage });
      toast.success('Mensaje enviado por WhatsApp');
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

  const handleWhatsAppTabChange = useCallback((tab: 'cuotas' | 'metricas') => {
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
    } else if (whatsAppTab === 'cuotas' && whatsAppCuotasMsg) {
      setWhatsAppMessage(whatsAppCuotasMsg);
    }
  }, [whatsAppTab, metricasMessages, whatsAppCuotasMsg]);

  const handleCopyId = useCallback(() => {
    if (!id) return;
    navigator.clipboard.writeText(id).then(() => {
      setIdCopied(true);
      toast.success('ID copiado');
      setTimeout(() => setIdCopied(false), 2000);
    }).catch(() => toast.error('No se pudo copiar'));
  }, [id]);

  const fetchDetail = useCallback(async (signal?: AbortSignal, opts?: { refresh?: boolean }) => {
    if (!id) return;
    const isRefresh = !!opts?.refresh;
    try {
      if (isRefresh) setRefreshingDetail(true);
      else setLoading(true);
      setError('');
      const req = { signal, headers: MIAUTO_NO_CACHE_HEADERS };
      const [resSol, resCuotas, resComp, resEvidencias] = await Promise.all([
        api.get(`/miauto/solicitudes/${id}`, req),
        api.get(`/miauto/solicitudes/${id}/cuotas-semanales`, req),
        api.get(`/miauto/solicitudes/${id}/comprobantes-cuota-semanal`, req).catch(emptyListIfNotAbort),
        api.get(`/miauto/solicitudes/${id}/evidencias-fleet`, req).catch(emptyListIfNotAbort),
      ]);
      const sol = resSol.data?.data ?? resSol.data;
      const { cuotas: rawCuotas, racha: rachaNum, cuotasSemanalesBonificadas: bonoNum } = parseCuotasSemanalesPayload(resCuotas);
      const comp = resComp.data?.data ?? resComp.data ?? [];
      const evFleet = resEvidencias.data?.data ?? resEvidencias.data ?? [];
      setSolicitud(sol || null);
      setCuotas(rawCuotas as CuotaSemanal[]);
      setComprobantesPagos(Array.isArray(comp) ? comp : []);

      setEvidenciasFleet(Array.isArray(evFleet) ? evFleet : []);
      setRacha(rachaNum);
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
  
        setEvidenciasFleet([]);
        setRacha(null);
        setBonoAplicado(0);
      }
    } finally {
      if (signal?.aborted) return;
      if (isRefresh) setRefreshingDetail(false);
      else setLoading(false);
    }
  }, [id]);

  const runComprobantePatch = useCallback(
    async (opts: {
      setBusy: (v: string | null) => void;
      busyId: string;
      request: () => Promise<unknown>;
      successMsg: string;
      errorMsg: string;
    }) => {
      const { setBusy, busyId, request, successMsg, errorMsg } = opts;
      if (!id) return;
      try {
        setBusy(busyId);
        await request();
        toast.success(successMsg);
        await fetchDetail(undefined, { refresh: true });
      } catch (e: any) {
        toast.error(e.response?.data?.message || errorMsg);
      } finally {
        setBusy(null);
      }
    },
    [id, fetchDetail]
  );

  const handleValidarComprobante = (comprobanteId: string, monto: number, moneda: 'PEN' | 'USD') =>
    runComprobantePatch({
      setBusy: setValidandoCompId,
      busyId: comprobanteId,
      request: () =>
        api.patch(`/miauto/solicitudes/${id}/comprobantes-cuota-semanal/${comprobanteId}/validar`, { monto, moneda }),
      successMsg: 'Comprobante validado',
      errorMsg: 'Error al validar',
    });

  const handleRechazarComprobante = (comprobanteId: string, motivo: string) =>
    runComprobantePatch({
      setBusy: setRechazandoCompId,
      busyId: comprobanteId,
      request: () =>
        api.patch(`/miauto/solicitudes/${id}/comprobantes-cuota-semanal/${comprobanteId}/rechazar`, {
          motivo: motivo.trim(),
        }),
      successMsg: 'Comprobante rechazado',
      errorMsg: 'Error al rechazar',
    });

  const handleSubirConformidadAdmin = async (
    cuotaSemanalId: string,
    file: File,
    monto: number,
    moneda: 'PEN' | 'USD'
  ) => {
    if (!id) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('monto', String(monto));
    fd.append('moneda', moneda);
    try {
      setSubiendoConformidadCuotaId(cuotaSemanalId);
      await api.post(`/miauto/solicitudes/${id}/cuotas-semanales/${cuotaSemanalId}/comprobantes-conformidad-admin`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
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

  const handleOtroGastoStatusChange = useCallback(async (ogId: string, newStatus: string) => {
    try {
      if (!id) return;
      await api.put(`/miauto/solicitudes/${id}/otros-gastos/${ogId}/estado`, { status: newStatus });
      toast.success('Estado actualizado');
      fetchDetail(undefined, { refresh: true });
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error');
    }
  }, [id]);

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
        headers: { 'Content-Type': 'multipart/form-data' },
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

  const cronPg = useTablePagination(cuotas);
  const otrosGastosRows = useMemo(
    () => (Array.isArray(solicitud?.otros_gastos) ? solicitud.otros_gastos : []),
    [solicitud?.otros_gastos]
  );

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
      const pagado = miautoMontoPagadoCuotaSemanal(c.paid_amount) + miautoNum(c.abono_comprobante_en_revision);
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

  /** Comprobantes de otros gastos agrupados por otros_gastos_id */

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


  //hola
  return (
    <div className="space-y-6">
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
                <Banknote className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
                  {driverDisplayRentSale(solicitud, driverNameFromState)}
                </h1>
                <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                  Cronograma y métricas del contrato
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
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
            <button
              type="button"
              onClick={handleCopyId}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white text-sm font-medium"
              title="Copiar ID del contrato (alquiler/venta)"
            >
              {idCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {idCopied ? 'Copiado' : 'Copiar ID'}
            </button>
          </div>
        </div>
      </header>

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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
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
            <>
              <div className="bg-white rounded-lg border border-green-100 p-4 shadow-sm">
                <div className="flex items-center gap-2 text-green-700 text-sm mb-1">
                  <TrendingUp className="w-4 h-4" />
                  <span>Racha</span>
                </div>
                <p className="text-xl font-bold text-green-800">{racha ?? '—'}</p>
                <p className="text-xs text-gray-500">cuotas seguidas al día</p>
              </div>
              <div className="bg-white rounded-lg border border-[#8B1A1A]/20 p-4 shadow-sm">
                <div className="flex items-center gap-2 text-[#8B1A1A] text-sm mb-1">
                  <Award className="w-4 h-4" />
                  <span>Bono tiempo</span>
                </div>
                <p className="text-xl font-bold text-[#8B1A1A]">{bonoAplicado}</p>
                <p className="text-xs text-gray-500">
                  {bonoAplicado >= 1 ? `${bonoAplicado} cuota${bonoAplicado !== 1 ? 's' : ''} bonificada${bonoAplicado !== 1 ? 's' : ''}` : 'aplicado'}
                </p>
              </div>
            </>
          )}
        </div>
        {bonoTiempoActivo && (
          <p className="text-xs text-gray-500 px-1">
            Bono tiempo: 1 cuota bonificada por cada 4 pagos consecutivos a tiempo; en cada una de esas 4 semanas el conductor debe tener al menos 120 viajes.
          </p>
        )}
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
            <div>
              <span className="text-gray-500 block">Inicio cobro</span>
              <span className="font-medium text-gray-900">
                {solicitud.fecha_inicio_cobro_semanal
                  ? formatDate(solicitud.fecha_inicio_cobro_semanal, 'es-ES')
                  : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Cronograma semanal + Otros gastos (pestañas) */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden relative min-h-[200px]">
        <div className="flex border-b border-gray-200 px-2 sm:px-3 gap-0.5" role="tablist" aria-label="Cronograma y otros gastos">
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

        {tabCronograma === 'semanales' && (
        <>
        {cuotas.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            Aún no hay cuotas generadas para este contrato.
          </div>
        ) : (
          <>
          <div className="px-4 pt-3 pb-1">
            <div className="overflow-x-auto -mx-1 px-1 sm:mx-0 sm:px-0 rounded-lg border border-gray-100 bg-white">
            <table className="w-full min-w-[1180px] table-fixed border-collapse text-sm">
              <colgroup>
                <col style={{ width: '9%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '8.5%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '8.5%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '7%' }} />
              </colgroup>
              <thead>
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
                  // Cuota a pagar = amount_due (DB)
                  const cuotaOriginal = miautoNum(c.amount_due);
                  // Mora = mora_acumulada (DB, total histórico)
                  const moraOriginal = miautoNum(c.mora_acumulada ?? c.late_fee);
                  // Desglose del pago: mora primero, luego cuota
                  const pagadoVal = miautoNum(c.paid_amount);
                  const moraPagada = Math.min(pagadoVal, moraOriginal);
                  const cuotaPagada = Math.max(0, pagadoVal - moraPagada);
                  // Lo que queda por pagar
                  const cuotaAPagarNeta = c.status === 'paid' || c.status === 'bonificada' ? 0 : (cuotaOriginal - cuotaPagada);
                  const moraPendiente = c.status === 'paid' || c.status === 'bonificada' ? 0 : (moraOriginal - moraPagada);
                  // Saldo a favor
                  const saldoFavor = miautoNum(c.saldo_favor_conductor);
                  // Pendiente total
                  const pendienteDisplay = cuotaAPagarNeta + moraPendiente;
                  // Mora extra
                  const moraExtra = miautoNum(c.mora_extra);
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
                        <span>{miautoFmtMonto(symCuota, miautoCobroSaldoDisplay(c))}</span>
                        {c.cobro_saldo_referencia && c.cobro_saldo_referencia.length > 0 && (
                          <div className="text-[10px] font-normal leading-snug text-gray-600">
                            {c.cobro_saldo_referencia.map((ref, idx) => (
                              <span key={idx} className="block tabular-nums">
                                → Semana {ref.semana ?? (ref.week_start_date ? miautoSemanaOrdinalPorVencimiento(cuotas, ref.week_start_date, ref.week_start_date) : '')}: {miautoFmtMonto(symCuota, ref.monto)}
                              </span>
                            ))}
                          </div>
                        )}
                        {/* Mostrar distribución del cobro fleet */}
                        {(() => {
                          const cobroFleetVal = miautoNum(c.cobro_desde_saldo_conductor);
                          if (cobroFleetVal <= 0.005) return null;
                          if (c.cobro_saldo_referencia && c.cobro_saldo_referencia.length > 0) return null;
                          // El cobro se distribuyó → buscar semanas que recibieron el pago
                          const destinos: { semana: number; monto: number }[] = [];
                          for (const cc of cuotas) {
                            if (cc.id === c.id) continue;
                            if (cc.status === 'paid' || cc.status === 'bonificada') continue;
                            const ccPaid = miautoNum(cc.paid_amount);
                            if (ccPaid <= 0.005) continue;
                            const semana = miautoSemanaOrdinalPorVencimiento(cuotas, cc.due_date, cc.week_start_date);
                            if (semana) destinos.push({ semana, monto: cobroFleetVal });
                          }
                          if (destinos.length === 0) return (
                            <span className="text-[10px] font-normal leading-snug text-gray-500">→ distribuido a semanas anteriores</span>
                          );
                          return (
                            <div className="text-[10px] font-normal leading-snug text-gray-600">
                              {destinos.map((d, idx) => (
                                <span key={idx} className="block tabular-nums">
                                  → Semana {d.semana}: {miautoFmtMonto(symCuota, d.monto)}
                                </span>
                              ))}
                            </div>
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
                        <span className="text-[10px] text-gray-400">Total: {miautoFmtMonto(symCuota, moraOriginal)}</span>
                        <span className="block font-semibold">{miautoFmtMonto(symCuota, moraPendiente)}</span>
                        {moraPagada > 0.005 && (
                          <span className="text-[10px] font-normal leading-snug text-green-700">
                            Cobrado: {miautoFmtMonto(symCuota, moraPagada)}
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
                        {moraExtra > 0.005 && (
                          <span className="text-[10px] font-normal leading-snug text-red-500 tabular-nums">
                            Mora extra: {miautoFmtMonto(symCuota, moraExtra)}
                          </span>
                        )}
                      </div>
                    </td>
                    {/* Pagado */}
                    <td className="py-2.5 pr-2 align-middle text-right text-[13px] text-green-800">
                      <span className="font-medium">{miautoFmtMonto(symCuota, montoPagadoDisplay)}</span>
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
                  </tr>
                  <tr className="border-b border-gray-100">
                       <td colSpan={11} className="p-0 align-top">
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
                                const isPendiente = (comp.estado || '').toLowerCase() === 'pendiente';
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
                                          {isPendiente
                                            ? '—'
                                            : comp.monto != null
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
                                    {isPendiente && c.status !== 'paid' && c.status !== 'bonificada' && (
                                      <div className="pt-2 border-t border-gray-200/80">
                                        <MiautoComprobantePagoActions
                                          comprobanteId={comp.id}
                                          validando={validandoCompId === comp.id}
                                          rechazando={rechazandoCompId === comp.id}
                                          onValidar={handleValidarComprobante}
                                          onRechazar={handleRechazarComprobante}
                                          montoMaximo={pendienteTotalCronogramaValidar}
                                          defaultMoneda={monedaCuotaRow(c)}
                                          valorUsdALocal={tipoCambioUsdLocal}
                                        />
                                      </div>
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
                                            const newMon = e.target.value as 'PEN' | 'USD';
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
                                        e.target.value = '';
                                        setConformidadArchivoPendiente((prev) => ({ ...prev, [c.id]: f }));
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
                                          <th className="py-2 text-right font-medium whitespace-nowrap">Acciones</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {conformidadesAdmin.map((comp) => {
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
                                                    disabled={eliminandoConformidadId === comp.id || c.status === 'paid' || c.status === 'bonificada'}
                                                    title={c.status === 'paid' || c.status === 'bonificada' ? 'No se puede eliminar: la cuota ya está pagada' : undefined}
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
                                comps={comps}
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
          {cuotas.length > 0 && (
            <TablePaginationBar
              page={cronPg.page}
              setPage={cronPg.setPage}
              totalPages={cronPg.totalPages}
              limit={cronPg.limit}
              setLimit={cronPg.setLimit}
              pageSizes={cronPg.pageSizes}
              containerClassName="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-3 border-t border-gray-100"
            />
          )}
          </>
        )}
        </>
        )}

        {tabCronograma === 'otros_gastos' && (
        <>
            {otrosGastosRows.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8 px-4">No hay cuotas de otros gastos para este contrato.</p>
            ) : (
              <div className="px-4 pb-3 pt-2">
                {/* Resumen general */}
                <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                  <span className="font-semibold text-gray-700">
                    Total: {(() => {
                      const syms = [...new Set(otrosGastosRows.map(og => symMoneda(og.moneda || 'PEN')))];
                      if (syms.length === 1) {
                        const total = otrosGastosRows.reduce((s, og) => s + Number(og.amount_due), 0);
                        return `${syms[0]} ${total.toFixed(2)}`;
                      }
                      return otrosGastosRows.reduce((s, og) => s + Number(og.amount_due), 0).toFixed(2);
                    })()}
                  </span>
                  <span className="text-gray-300">·</span>
                  <span>{otrosGastosRows.length} cuotas</span>
                  <span className="text-gray-300">·</span>
                  <span className="text-green-600">{otrosGastosRows.filter(og => og.status === 'paid').length} pagadas</span>
                  <span className="text-gray-300">·</span>
                  <span className="text-amber-600">{otrosGastosRows.filter(og => og.status === 'pending').length} pendientes</span>
                  <span className="text-gray-300">·</span>
                  <span className="text-red-600">{otrosGastosRows.filter(og => og.status === 'overdue').length} vencidas</span>
                </div>

                {/* Filtros */}
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {(['todos', 'pending', 'paid', 'overdue'] as const).map((f) => {
                    const filterLabels: Record<string, string> = { todos: 'Todos', pending: 'Pendientes', paid: 'Pagados', overdue: 'Vencidos' };
                    const filterCounts: Record<string, number> = {
                      todos: otrosGastosRows.length,
                      pending: otrosGastosRows.filter(og => og.status === 'pending').length,
                      paid: otrosGastosRows.filter(og => og.status === 'paid').length,
                      overdue: otrosGastosRows.filter(og => og.status === 'overdue').length,
                    };
                    return (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setOtrosGastosFilter(prev => prev === f ? 'todos' : f)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                          otrosGastosFilter === f
                            ? 'bg-[#8B1A1A] text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {filterLabels[f]} ({filterCounts[f]})
                      </button>
                    );
                  })}
                </div>

                {/* Cards por categoría */}
                <div className="space-y-4">
                  {Object.entries(
                    otrosGastosRows.reduce((acc, og) => {
                      const t = og.tipo || 'generico';
                      if (!acc[t]) acc[t] = [];
                      acc[t].push(og);
                      return acc;
                    }, {} as Record<string, MiautoOtrosGastoRow[]>)
                  ).map(([tipo, cuotas]) => {
                    const filteredCuotas = otrosGastosFilter === 'todos'
                      ? cuotas
                      : cuotas.filter(c => c.status === otrosGastosFilter);
                    if (filteredCuotas.length === 0) return null;

                    const isOpen = otrosTiposAbiertos[tipo] !== false;
                    const totalTipo = cuotas.reduce((s, c) => s + Number(c.amount_due), 0);
                    const cuotasFiltroCount = filteredCuotas.length;
                    const cuotasTotal = cuotas.length;
                    const paidCount = cuotas.filter(c => c.status === 'paid').length;
                    const pct = cuotasTotal > 0 ? Math.round((paidCount / cuotasTotal) * 100) : 0;
                    const label = TIPO_OTROS_GASTOS_LABELS[tipo] || tipo;
                    const moneda = cuotas[0]?.moneda || 'PEN';
                    const sym = symMoneda(moneda);
                    const accentBorder = TIPO_OTROS_GASTOS_ACCENT[tipo] || 'border-l-gray-400';
                    const accentBar = TIPO_OTROS_GASTOS_BAR[tipo] || 'bg-gray-400';
                    const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

                    const formatCuotaDate = (dueDate: string) => {
                      if (!dueDate) return '—';
                      const parts = String(dueDate).slice(0,10).split('-');
                      if (parts.length === 3) return parts[2] + '-' + months[parseInt(parts[1]) - 1];
                      return '—';
                    };

                    return (
                      <div key={tipo} className={`rounded-xl border border-gray-200 overflow-hidden bg-white border-l-[3px] ${accentBorder}`}>

                        {/* Header colapsable */}
                        <button
                          type="button"
                          onClick={() => setOtrosTiposAbiertos(prev => ({ ...prev, [tipo]: prev[tipo] === false ? true : false }))}
                          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50/70 hover:bg-gray-100/80 transition-colors"
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            {isOpen ? <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-gray-900">{label}</span>
                                <span className="text-[11px] text-gray-400">{cuotasFiltroCount}/{cuotasTotal} cuotas</span>
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden max-w-[120px]">
                                  <div className={`h-full rounded-full transition-all duration-300 ${accentBar}`} style={{ width: `${pct}%` }} />
                                </div>
                                <span className="text-[10px] text-gray-500">{paidCount}/{cuotasTotal} pagadas</span>
                              </div>
                            </div>
                          </div>
                          <span className="text-sm font-semibold text-gray-900 ml-3 shrink-0">{sym} {totalTipo.toFixed(2)}</span>
                        </button>

                        {isOpen && (
                          <div className="border-t border-gray-100 px-3 py-3">
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                              {filteredCuotas.map((og) => (
                                <div
                                  key={og.id}
                                  className={`rounded-lg border p-2.5 flex flex-col items-center gap-1.5 ${
                                    og.status === 'paid' ? 'bg-green-50/50 border-green-200' :
                                    og.status === 'overdue' ? 'bg-red-50/50 border-red-200' :
                                    'bg-white border-gray-200'
                                  }`}
                                >
                                  <span className="text-[10px] text-gray-500 font-medium">
                                    {formatCuotaDate(og.due_date)}
                                  </span>
                                  <span className={`text-xs font-bold ${
                                    og.status === 'paid' ? 'text-green-700' :
                                    og.status === 'overdue' ? 'text-red-700' :
                                    'text-gray-900'
                                  }`}>
                                    {sym} {Number(og.amount_due).toFixed(2)}
                                  </span>
                                  <select
                                    value={og.status}
                                    onChange={(e) => handleOtroGastoStatusChange(og.id, e.target.value)}
                                    className={`text-[10px] border rounded px-1.5 py-0.5 font-medium cursor-pointer w-full text-center ${
                                      og.status === 'paid' ? 'bg-green-50 border-green-300 text-green-700' :
                                      og.status === 'overdue' ? 'bg-red-50 border-red-300 text-red-600' :
                                      'bg-gray-50 border-gray-300 text-gray-600'
                                    }`}
                                  >
                                    <option value="pending">Pendiente</option>
                                    <option value="paid">Pagado</option>
                                    <option value="overdue">Vencido</option>
                                  </select>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
        </>
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
            </div>
            <div className="p-5 overflow-y-auto flex-1 grid grid-cols-2 gap-4">
              {/* Columna izquierda */}
              <div className="space-y-3 border-r border-gray-100 pr-3">
                {whatsAppTab === 'cuotas' ? (
                  <>
                    <div>
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conductor</span>
                      <p className="mt-1 text-gray-900 font-medium">
                        {driverNameFromState || solicitud?.phone || solicitud?.dni || '—'}
                      </p>
                      {solicitud?.phone && (
                        <p className="text-sm text-gray-500 mt-0.5">{solicitud.phone}</p>
                      )}
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
                            const moraPendiente = Math.max(Number(c.mora_pendiente) || 0, Number(c.mora_acumulada ?? c.late_fee) || 0);
                            const moraExtra = Number(c.mora_extra) || 0;
                            const total = Math.max(0, cuotaTotal - pagado) + moraPendiente + moraExtra;
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
                                {cobroDesdeSaldo > 0.01 && <div className="flex justify-between"><span className="text-gray-500">Cobro saldo (Fleet):</span> <span className="font-medium text-orange-600">-{sym} {cobroDesdeSaldo.toFixed(2)}</span></div>}
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div>
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conductor</span>
                      <p className="mt-1 text-gray-900 font-medium">
                        {metricasData?.driver_name || driverNameFromState || solicitud?.dni || '—'}
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
                disabled={!whatsAppPhone || !whatsAppMessage.trim() || sendingWhatsApp}
                className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white ${whatsAppPhone && whatsAppMessage.trim() && !sendingWhatsApp ? 'bg-[#25D366] hover:bg-[#20BD5A]' : 'bg-gray-300 cursor-not-allowed'}`}
              >
                <FaWhatsapp className="w-5 h-5" />
                {sendingWhatsApp ? 'Enviando...' : whatsAppPhone ? 'Enviar por WhatsApp' : 'Sin numero'}
              </button>
            </div>
          </div>
        </div>,
        document.body
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
