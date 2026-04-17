import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import api from '../../services/api';
import { ArrowLeft, FileText, Banknote, Calendar, User, Car, Tag, TrendingUp, Copy, Check, ExternalLink, X, ChevronDown, ChevronRight, AlertCircle, Award, Upload, Trash2 } from 'lucide-react';
import { FaWhatsapp } from 'react-icons/fa';
import toast from 'react-hot-toast';
import { formatDate, formatDateTime, formatDateUTC } from '../../utils/date';
import { CUENTAS_BANCARIAS_WHATSAPP } from '../yegoRapidin/LoanDetail';
import { TablePaginationBar } from '../../components/TablePaginationBar';
import { useTablePagination } from '../../hooks/useTablePagination';
import { labelOtrosGastoStatus, type MiautoOtrosGastoRow, type ComprobanteOtrosGastos } from '../../utils/miautoOtrosGastos';
import { monedaCuotasLabel, symMoneda } from '../../utils/miautoAlquilerVentaList';
import { MIAUTO_NO_CACHE_HEADERS, emptyListIfNotAbort, isAxiosAbortError } from '../../utils/miautoApiUtils';
import {
  driverDisplayRentSale,
  formatKpiMixPenUsd,
  getMiautoAdjuntoUrl,
  miautoFmtMonto,
  miautoMontoPagadoCuotaSemanal,
  miautoMontoPagadoColumnaCronograma,
  miautoNum,
  miautoSemanaLista,
  miautoSemanaOrdinalPorVencimiento,
  miautoCuotaAPagarCronogramaSemanal,
  miautoCuotaCapitalPendienteColumna,
  miautoCuotaFinalCronogramaSemanal,
  miautoCuotaSemanalOAbonoDisplay,
  miautoTooltipCobroPorIngresos,
  miautoCobroPorIngresosTributoDisplay,
  miautoCobroSaldoDisplay,
  miautoCascadaCobroIngresosFilasParaUi,
  MIAUTO_CUOTA_STATUS_LABELS,
  MIAUTO_CUOTA_STATUS_PILL,
  parseCuotasSemanalesPayload,
} from '../../utils/miautoRentSaleHelpers';
import { MiautoComprobantePagoActions } from '../../components/yegoMiAuto/MiautoComprobantePagoActions';
import { MiautoComprobantesResumenSemana } from '../../components/yegoMiAuto/MiautoComprobantesResumenSemana';
import { useAuth } from '../../contexts/AuthContext';
import { roundToTwoDecimals } from '../../utils/currency';
import {
  montoConvertidoPenUsdFormatted,
  resolveTipoCambioUsdALocalFromRows,
} from '../../utils/miautoPenUsdConversion';

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
  /** Saldo mora pendiente tras pagos (API); para neto Excel. */
  mora_pendiente?: number;
  status: string;
  pending_total?: number;
  moneda?: string;
  cobro_saldo?: number;
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
  const saldoApi = c.pending_total ?? c.cuota_final;
  if (saldoApi != null && Number.isFinite(Number(saldoApi))) {
    return roundToTwoDecimals(Math.max(0, Number(saldoApi)));
  }
  const ad = Number(c.amount_due) || 0;
  const moraP = c.mora_pendiente != null ? Number(c.mora_pendiente) : Number(c.late_fee) || 0;
  const pd = Number(c.paid_amount) || 0;
  return roundToTwoDecimals(Math.max(0, ad + moraP - pd));
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
  const [comprobantesOtrosGastos, setComprobantesOtrosGastos] = useState<ComprobanteOtrosGastos[]>([]);
  const [comprobantesOtrosAbierto, setComprobantesOtrosAbierto] = useState<Record<string, boolean>>({});
  const [validandoCompOgId, setValidandoCompOgId] = useState<string | null>(null);
  const [rechazandoCompOgId, setRechazandoCompOgId] = useState<string | null>(null);
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
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [whatsAppMessage, setWhatsAppMessage] = useState('');
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);

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
    const name = driverNameFromState || 'Conductor';
    let defaultText: string;

    if (overdueCuotas.length > 0) {
      const lineas = overdueCuotas.slice(0, 10).map((c) => {
        const sym = symMoneda(monedaCuotaRow(c));
        const cuotaNeta = Number(c.cuota_neta ?? c.amount_due) || 0;
        const pagado = Number(c.paid_amount) || 0;
        const pendiente = Math.max(0, cuotaNeta - pagado);
        const moraPendiente = Number(c.mora_pendiente ?? c.late_fee) || 0;
        const total = pendiente + moraPendiente;
        const semana = miautoSemanaOrdinalPorVencimiento(cuotas, c.due_date, c.week_start_date);
        const fecha = c.due_date ? formatDateUTC(c.due_date, 'es-ES') : '';
        if (moraPendiente > 0) {
          return `• Semana ${semana}: ${sym} ${pendiente.toFixed(2)} + ${sym} ${moraPendiente.toFixed(2)} mora = ${sym} ${total.toFixed(2)} total (venció ${fecha})`;
        }
        return `• Semana ${semana}: ${sym} ${total.toFixed(2)} (venció ${fecha})`;
      });
      const mas = overdueCuotas.length > 10 ? `\n• Y ${overdueCuotas.length - 10} cuota(s) más.` : '';
      defaultText = `Hola ${name}, tienes ${overdueCuotas.length} cuota(s) vencida(s) en tu contrato Yego Mi Auto:\n\n${lineas.join('\n')}${mas}\n\nPor favor regulariza tu situación lo antes posible. Gracias.\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
    } else if (pendingCuotasHoy.length > 0) {
      const lineas = pendingCuotasHoy.map((c) => {
        const sym = symMoneda(monedaCuotaRow(c));
        const cuotaNeta = Number(c.cuota_neta ?? c.amount_due) || 0;
        const pagado = Number(c.paid_amount) || 0;
        const pendiente = Math.max(0, cuotaNeta - pagado);
        const semana = miautoSemanaOrdinalPorVencimiento(cuotas, c.due_date, c.week_start_date);
        return `• Semana ${semana}: ${sym} ${pendiente.toFixed(2)}`;
      });
      defaultText = `Hola ${name}, recuerda que hoy se vence tu cuota de Yego Mi Auto:\n\n${lineas.join('\n')}\n\nPor favor realiza tu pago a tiempo. Gracias.\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
    } else {
      defaultText = `Hola ${name}, te contactamos respecto a tu contrato Yego Mi Auto. Cualquier duda estamos a tu disposición.`;
    }
    setWhatsAppMessage(defaultText);
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
      const [resSol, resCuotas, resComp, resCompOg] = await Promise.all([
        api.get(`/miauto/solicitudes/${id}`, req),
        api.get(`/miauto/solicitudes/${id}/cuotas-semanales`, req),
        api.get(`/miauto/solicitudes/${id}/comprobantes-cuota-semanal`, req).catch(emptyListIfNotAbort),
        api.get(`/miauto/solicitudes/${id}/comprobantes-otros-gastos`, req).catch(emptyListIfNotAbort),
      ]);
      const sol = resSol.data?.data ?? resSol.data;
      const { cuotas: rawCuotas, racha: rachaNum, cuotasSemanalesBonificadas: bonoNum } = parseCuotasSemanalesPayload(resCuotas);
      const comp = resComp.data?.data ?? resComp.data ?? [];
      const compOg = resCompOg.data?.data ?? resCompOg.data ?? [];
      setSolicitud(sol || null);
      setCuotas(rawCuotas as CuotaSemanal[]);
      setComprobantesPagos(Array.isArray(comp) ? comp : []);
      setComprobantesOtrosGastos(Array.isArray(compOg) ? compOg : []);
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
        setComprobantesOtrosGastos([]);
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

  const handleValidarComprobanteOg = (comprobanteId: string, monto: number, moneda: 'PEN' | 'USD') =>
    runComprobantePatch({
      setBusy: setValidandoCompOgId,
      busyId: comprobanteId,
      request: () =>
        api.patch(`/miauto/solicitudes/${id}/comprobantes-otros-gastos/${comprobanteId}/validar`, { monto, moneda }),
      successMsg: 'Comprobante validado',
      errorMsg: 'Error al validar',
    });

  const handleRechazarComprobanteOg = (comprobanteId: string, motivo: string) =>
    runComprobantePatch({
      setBusy: setRechazandoCompOgId,
      busyId: comprobanteId,
      request: () =>
        api.patch(`/miauto/solicitudes/${id}/comprobantes-otros-gastos/${comprobanteId}/rechazar`, {
          motivo: motivo.trim(),
        }),
      successMsg: 'Comprobante rechazado',
      errorMsg: 'Error al rechazar',
    });

  const toggleComprobantesOtros = useCallback((otrosGastosId: string) => {
    setComprobantesOtrosAbierto((prev) => ({ ...prev, [otrosGastosId]: !prev[otrosGastosId] }));
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchDetail(ac.signal);
    return () => ac.abort();
  }, [fetchDetail]);

  const totalCuotas = cuotas.length;
  const cuotasPagadas = cuotas.filter((c) => c.status === 'paid' || c.status === 'bonificada').length;
  const cuotasVencidas = cuotas.filter((c) => c.status === 'overdue').length;
  const planCuotas = solicitud?.cronograma_vehiculo?.cuotas_semanales ?? totalCuotas;

  const cronPg = useTablePagination(cuotas);
  const otrosGastosRows = useMemo(
    () => (Array.isArray(solicitud?.otros_gastos) ? solicitud.otros_gastos : []),
    [solicitud?.otros_gastos]
  );
  const otrosPg = useTablePagination(otrosGastosRows);

  const comprobantesByCuotaId = useMemo(() => {
    const by: Record<string, ComprobanteCuotaSemanal[]> = {};
    for (const comp of comprobantesPagos) {
      const cid = comp.cuota_semanal_id;
      if (!by[cid]) by[cid] = [];
      by[cid].push(comp);
    }
    return by;
  }, [comprobantesPagos]);

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

  /** Comprobantes de otros gastos agrupados por otros_gastos_id */
  const comprobantesPorOtrosGastos = useMemo(() => {
    const byOg: Record<string, ComprobanteOtrosGastos[]> = {};
    for (const comp of comprobantesOtrosGastos) {
      const id = comp.otros_gastos_id;
      if (!byOg[id]) byOg[id] = [];
      byOg[id].push(comp);
    }
    return byOg;
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
          onClick={() => navigate('/admin/yego-mi-auto/rent-sale')}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#8B1A1A] hover:bg-red-50 rounded-lg border border-[#8B1A1A]"
        >
          <ArrowLeft className="w-4 h-4" />
          Volver a Alquiler / Venta
        </button>
      </div>
    );
  }

  const bonoTiempoActivo = solicitud.cronograma?.bono_tiempo_activo === true;

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
          onClick={() => navigate('/admin/yego-mi-auto/rent-sale')}
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
              {cuotasPagadas} / {planCuotas || totalCuotas}
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
              {formatKpiMixPenUsd(kpiTotalesPorMoneda.totalPagadoPEN, kpiTotalesPorMoneda.totalPagadoUSD)}
            </p>
          </div>
          <div className="bg-white rounded-lg border border-red-100 p-4 shadow-sm">
            <div className="flex items-center gap-2 text-red-700 text-sm mb-1">
              <Banknote className="w-4 h-4" />
              <span>Vencido</span>
            </div>
            <p
              className={`text-xl font-bold ${
                kpiTotalesPorMoneda.totalVencidoPEN + kpiTotalesPorMoneda.totalVencidoUSD > 0 ? 'text-red-600' : 'text-gray-900'
              }`}
            >
              {formatKpiMixPenUsd(kpiTotalesPorMoneda.totalVencidoPEN, kpiTotalesPorMoneda.totalVencidoUSD)}
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
                {/* Suma exacta 100%: más ancho a Viajes / Cobro ingresos (texto largo + imputación cascada); Vence compacto */}
                <col style={{ width: '9.5%' }} />
                <col style={{ width: '7.5%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '10.5%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '10.5%' }} />
              </colgroup>
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50/80">
                  <th className="sticky left-0 z-[1] bg-gray-50/95 py-2.5 pl-3 pr-1.5 align-middle text-left text-[11px] font-semibold uppercase tracking-wide text-gray-700 shadow-[2px_0_6px_-2px_rgba(0,0,0,0.06)] leading-tight">
                    Semana
                  </th>
                  <th className="py-2.5 pr-1.5 align-middle text-left text-[11px] font-semibold uppercase tracking-wide text-gray-600 whitespace-nowrap leading-tight">
                    Vence
                  </th>
                  <th
                    className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-gray-900 leading-tight"
                    title="Cuota del cronograma en la fila (cuota_semanal). El abono registrado está en la columna Pagado."
                  >
                    <span className="inline-block text-right">Cuota sem. (plan)</span>
                  </th>
                  <th className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-green-700 leading-tight">
                    <span className="inline-block text-right">Viajes — B.A</span>
                  </th>
                  <th
                    className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-green-700 leading-tight"
                    title="Lo que se retiene al conductor sobre los ingresos de la semana (83% del fee de socio Yango por viajes)."
                  >
                    <span className="inline-block text-right">Cobro por ingresos</span>
                  </th>
                  <th
                    className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-green-700 leading-tight"
                    title="Cargo fijo de la regla del cronograma (cobro saldo), aparte del cobro por ingresos Yango."
                  >
                    Cobro saldo
                  </th>
                  <th className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-gray-900 leading-tight">
                    <span
                      className="inline-block text-right"
                      title="Saldo pendiente del capital cuota (sin mora). Los pagos cubren primero toda la mora posible; el resto reduce este saldo. Si hay «Plan» debajo, es la cuota neta original del periodo."
                    >
                      Cuota a pagar
                    </span>
                  </th>
                  <th
                    className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-red-600 leading-tight"
                    title="Saldo mora pendiente. Si hay días de retraso respecto al vencimiento, el interés se calcula sobre el capital cuota según el cronograma."
                  >
                    Mora
                    {solicitud?.cronograma?.tasa_interes_mora != null && Number(solicitud.cronograma.tasa_interes_mora) > 0
                      ? ` (${(Number(solicitud.cronograma.tasa_interes_mora) * 100).toFixed(2)}%)`
                      : ''}
                  </th>
                  <th
                    className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-green-700 leading-tight"
                    title="Total a pagar aún: mora pendiente + cuota pendiente (pago parcial: se descuenta primero de mora, luego de la cuota)."
                  >
                    Cuota final
                  </th>
                  <th className="py-2.5 px-1 align-middle text-right text-[11px] font-semibold uppercase tracking-wide tabular-nums text-green-700 leading-tight">
                    Pagado
                  </th>
                  <th className="py-2.5 pl-1 pr-3 align-middle text-center text-[11px] font-semibold uppercase tracking-wide text-gray-700 leading-tight">
                    Estado
                  </th>
                </tr>
              </thead>
              <tbody>
                {cronPg.paginatedItems.map((c, index) => {
                  /** Número por lunes de cuota (orden cronológico del plan); evita invertir 4/5 si varias filas comparten el mismo vencimiento. */
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
                  const totalPendienteFila = Math.max(
                    0,
                    Number(c.pending_total ?? c.cuota_final ?? cuotaFinalSemana) || 0
                  );
                  /** Saldo mora pendiente (API); debe ser 0 si el pago ya absorbió la mora. */
                  const moraPendienteColumna = Number(c.mora_pendiente ?? c.late_fee) || 0;
                  /** Cuota neta del plan (referencia); la columna muestra el remanente tras imputar mora → cuota. */
                  const cuotaNetaPlan = miautoCuotaAPagarCronogramaSemanal(c);
                  const cuotaAPagarDisplay = miautoCuotaCapitalPendienteColumna(c);
                  /** Solo mostrar desglose si mora + cuota cuadran con el total (evita «Mora 33 + Cuota 137» cuando el total es 20). */
                  const desgloseSumaOk =
                    totalPendienteFila <= 0.005 ||
                    Math.abs(moraPendienteColumna + cuotaAPagarDisplay - totalPendienteFila) <= 0.12;
                  const mostrarSublinePlanCuota =
                    totalPendienteFila > 0.005 && cuotaNetaPlan - cuotaAPagarDisplay > 0.005;
                  const mostrarDesgloseParcial =
                    desgloseSumaOk &&
                    totalPendienteFila > 0.005 &&
                    (moraPendienteColumna > 0.005 || cuotaAPagarDisplay > 0.005);
                  return (
                  <Fragment key={c.id}>
                  <tr className="group border-b border-gray-100 hover:bg-gray-50/60">
                    <td className="sticky left-0 z-[1] bg-white py-2.5 pl-3 pr-2 align-middle shadow-[2px_0_6px_-2px_rgba(0,0,0,0.06)] group-hover:bg-gray-50/80">
                      <button
                          type="button"
                          onClick={() => toggleComprobantesSemana(c.id)}
                          className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0 text-left text-[13px] leading-snug text-gray-700 transition-colors hover:bg-gray-100/90"
                        >
                          {abierto ? (
                            <ChevronDown className="h-4 w-4 flex-shrink-0 self-center text-gray-500" aria-hidden />
                          ) : (
                            <ChevronRight className="h-4 w-4 flex-shrink-0 self-center text-gray-500" aria-hidden />
                          )}
                          <span className="min-w-0 truncate font-semibold text-[#8B1A1A]">Semana {numeroSemana}</span>
                        </button>
                    </td>
                    <td className="py-2.5 pr-1.5 align-middle text-[12px] leading-snug text-gray-700 whitespace-nowrap">
                      {c.due_date ? formatDate(c.due_date, 'es-ES') : c.week_start_date ? formatDate(c.week_start_date, 'es-ES') : '—'}
                    </td>
                    <td className="py-2.5 px-1 align-middle font-medium tabular-nums text-gray-900 text-right text-[12px]">
                      {miautoFmtMonto(symCuota, miautoCuotaSemanalOAbonoDisplay(c))}
                    </td>
                    <td className="py-2.5 px-1 align-middle text-[11px] tabular-nums text-right leading-snug">
                      {c.num_viajes != null ? (
                        <>
                          <span className="text-gray-700">{c.num_viajes} — </span>
                          <span className="text-green-700">Bono {miautoFmtMonto(symCuota, bonoAutoVal)}</span>
                        </>
                      ) : c.bono_auto != null ? (
                        <span className="text-green-700">Bono {miautoFmtMonto(symCuota, bonoAutoVal)}</span>
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </td>
                    <td
                      className="py-2.5 px-1 align-top text-[11px] tabular-nums text-right text-green-700"
                      title={titleCobroIngresos}
                    >
                      <div className="flex min-w-0 flex-col items-end gap-1">
                        <span className="shrink-0">{miautoFmtMonto(symCuota, tributoCobroIngresos)}</span>
                        {filasCascadaCobro.length > 0 ? (
                          <div className="w-full min-w-0 text-[10px] font-normal leading-snug text-gray-600">
                            <span className="block text-gray-500">Imputación del cobro</span>
                            {filasCascadaCobro.map((it, idx) => (
                              <span key={idx} className="block tabular-nums">
                                →{' '}
                                {it.semana != null ? (
                                  <>
                                    Semana {it.semana}
                                    {it.week_start_ymd ? (
                                      <span className="text-gray-500">
                                        {' '}
                                        (lunes{' '}
                                        {formatDate(`${it.week_start_ymd}T12:00:00`, 'es-ES')})
                                      </span>
                                    ) : null}
                                  </>
                                ) : it.week_start_ymd ? (
                                  <>Lunes {formatDate(`${it.week_start_ymd}T12:00:00`, 'es-ES')}</>
                                ) : (
                                  '—'
                                )}
                                : {miautoFmtMonto(symCuota, it.monto)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2.5 px-1 align-middle text-[11px] tabular-nums text-right text-green-700">
                      {miautoFmtMonto(symCuota, miautoCobroSaldoDisplay(c))}
                    </td>
                    <td
                      className="py-2.5 px-1 align-middle font-medium tabular-nums text-right text-gray-900 text-[12px]"
                      title="Saldo que falta de la cuota del plan (sin mora), tras imputar abonos: mora primero, luego capital cuota. «Plan» = cuota neta del cronograma si hubo abonos."
                    >
                      <span className="block">{miautoFmtMonto(symCuota, cuotaAPagarDisplay)}</span>
                      {mostrarSublinePlanCuota ? (
                        <span className="mt-0.5 block text-[10px] font-normal leading-snug text-gray-600 tabular-nums">
                          Plan {miautoFmtMonto(symCuota, cuotaNetaPlan)}
                        </span>
                      ) : null}
                    </td>
                    <td
                      className="py-2.5 px-1 align-middle font-medium tabular-nums text-right text-[12px] text-red-600"
                      title={
                        c.due_date
                          ? `Vence ${formatDate(c.due_date, 'es-ES')}. Mora: saldo pendiente tras abonos (interés del periodo en mora_interes_periodo si aplica).`
                          : undefined
                      }
                    >
                      <span className="block">{miautoFmtMonto(symCuota, moraPendienteColumna)}</span>
                    </td>
                    <td className="py-2.5 pr-2 align-middle text-right text-[13px] text-green-700">
                      <span className="font-medium tabular-nums block">{miautoFmtMonto(symCuota, cuotaFinalSemana)}</span>
                      {mostrarDesgloseParcial ? (
                        <span className="mt-0.5 block text-[10px] font-normal leading-snug text-gray-600 tabular-nums">
                          {moraPendienteColumna > 0.005 ? (
                            <>
                              Mora {miautoFmtMonto(symCuota, moraPendienteColumna)}
                            </>
                          ) : null}
                          {moraPendienteColumna > 0.005 && cuotaAPagarDisplay > 0.005 ? ' + ' : null}
                          {cuotaAPagarDisplay > 0.005 ? (
                            <>Cuota {miautoFmtMonto(symCuota, cuotaAPagarDisplay)}</>
                          ) : null}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-2 align-middle text-right text-[13px] text-green-800">
                      <div className="flex flex-col items-end gap-0.5 tabular-nums">
                        <span
                          className="font-medium"
                          title={
                            miautoNum(c.abono_comprobante_en_revision) > 0.005
                              ? `Incluye ${symCuota}\u00A0${miautoNum(c.abono_comprobante_en_revision).toFixed(2)} declarado en comprobante pendiente de validar`
                              : undefined
                          }
                        >
                          {miautoFmtMonto(symCuota, montoPagadoDisplay)}
                        </span>
                        {miautoNum(c.late_fee) > 0.005 ? (
                          <span className="text-[10px] font-normal leading-snug text-amber-700">
                            Mora: {miautoFmtMonto(symCuota, miautoNum(c.late_fee))}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2.5 pl-1 pr-2 align-middle whitespace-nowrap">
                      <div className="flex flex-col items-center gap-0.5">
                        <span
                          className={`inline-flex w-fit whitespace-nowrap px-1.5 py-0.5 rounded text-xs font-medium ${
                            MIAUTO_CUOTA_STATUS_PILL[c.status] ?? 'bg-gray-100 text-gray-700'
                          }`}
                          title={c.status === 'bonificada' ? 'Bonificación por 4 cuotas seguidas al día' : undefined}
                        >
                          {MIAUTO_CUOTA_STATUS_LABELS[c.status] ?? c.status}
                        </span>
                        {c.status === 'bonificada' && (
                          <span className="text-center text-[10px] text-gray-500">Por 4 cuotas al día</span>
                        )}
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
                            <div className="flex items-center gap-2 mb-4">
                              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[#8B1A1A]/10">
                                <FileText className="w-4 h-4 text-[#8B1A1A]" />
                              </div>
                              <div>
                                <h4 className="text-sm font-semibold text-gray-900">Comprobantes — Semana {numeroSemana}</h4>
                                <p className="text-xs text-gray-500">
                                  {c.due_date ? formatDate(c.due_date, 'es-ES') : c.week_start_date ? formatDate(c.week_start_date, 'es-ES') : '—'}
                                </p>
                              </div>
                            </div>

                            <div className="mb-4">
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
                            </div>

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
              <p className="text-sm text-gray-500 text-center py-8 px-4">No hay cuotas de otros gastos para este contrato (solo aplica con pago parcial al generar Yego Mi Auto).</p>
            ) : (
              <>
                <div className="px-4 pb-3 pt-2">
                  <div className="overflow-x-auto -mx-1 px-1 sm:mx-0 sm:px-0 rounded-lg border border-gray-100 bg-white">
                  <table className="w-full min-w-[720px] table-fixed border-collapse text-sm">
                    <colgroup>
                      <col style={{ width: '16%' }} />
                      <col style={{ width: '26%' }} />
                      <col style={{ width: '19%' }} />
                      <col style={{ width: '19%' }} />
                      <col style={{ width: '20%' }} />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50/80">
                        <th className="sticky left-0 z-[1] bg-gray-50/95 py-3 pl-3 pr-2 align-middle text-left text-xs font-semibold uppercase tracking-wide text-gray-700 shadow-[2px_0_6px_-2px_rgba(0,0,0,0.06)]">
                          Semana
                        </th>
                        <th className="py-3 pr-3 align-middle text-left text-xs font-semibold uppercase tracking-wide text-gray-600 whitespace-nowrap">
                          Vencimiento
                        </th>
                        <th className="py-3 pr-2 align-middle text-right text-xs font-semibold uppercase tracking-wide tabular-nums text-gray-900 whitespace-nowrap">
                          Monto
                        </th>
                        <th className="py-3 pr-2 align-middle text-right text-xs font-semibold uppercase tracking-wide tabular-nums text-green-700 whitespace-nowrap">
                          Pagado
                        </th>
                        <th className="py-3 pr-3 align-middle text-center text-xs font-semibold uppercase tracking-wide text-gray-700 whitespace-nowrap">
                          Estado
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {otrosPg.paginatedItems.map((og) => {
                        const compsOg = comprobantesPorOtrosGastos[og.id] ?? [];
                        const abiertoOg = comprobantesOtrosAbierto[og.id] === true;
                        const symOg = symMoneda(solicitud?.cronograma_vehiculo?.inicial_moneda);
                        return (
                          <Fragment key={og.id}>
                            <tr className="group border-b border-gray-100 hover:bg-gray-50/60">
                              <td className="sticky left-0 z-[1] bg-white py-2.5 pl-3 pr-2 align-middle shadow-[2px_0_6px_-2px_rgba(0,0,0,0.06)] group-hover:bg-gray-50/80">
                                {compsOg.length > 0 ? (
                                  <button
                                    type="button"
                                    onClick={() => toggleComprobantesOtros(og.id)}
                                    className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0 text-left text-[13px] leading-snug text-gray-700 transition-colors hover:bg-gray-100/90"
                                  >
                                    {abiertoOg ? (
                                      <ChevronDown className="h-4 w-4 flex-shrink-0 self-center text-gray-500" aria-hidden />
                                    ) : (
                                      <ChevronRight className="h-4 w-4 flex-shrink-0 self-center text-gray-500" aria-hidden />
                                    )}
                                    <span className="min-w-0 truncate font-semibold text-[#8B1A1A]">Semana {og.week_index}</span>
                                  </button>
                                ) : (
                                  <div className="min-w-0 py-0.5 text-[13px] leading-snug">
                                    <span className="block font-semibold text-[#8B1A1A]">Semana {og.week_index}</span>
                                  </div>
                                )}
                              </td>
                              <td className="py-2.5 pr-3 align-middle text-[13px] leading-snug text-gray-700 whitespace-nowrap">
                                {formatDate(og.due_date, 'es-ES')}
                              </td>
                              <td className="py-2.5 pr-2 align-middle font-medium tabular-nums text-right text-gray-900 text-[13px]">
                                {symOg} {Number(og.amount_due).toFixed(2)}
                              </td>
                              <td className="py-2.5 pr-2 align-middle text-[13px] text-right tabular-nums text-green-700">
                                {symOg} {Number(og.paid_amount).toFixed(2)}
                              </td>
                              <td className="py-2.5 pr-3 align-middle whitespace-nowrap">
                                <div className="flex justify-center">
                                  <span
                                    className={`inline-flex w-fit whitespace-nowrap px-1.5 py-0.5 rounded text-xs font-medium ${
                                      MIAUTO_CUOTA_STATUS_PILL[og.status] ?? 'bg-gray-100 text-gray-700'
                                    }`}
                                  >
                                    {MIAUTO_CUOTA_STATUS_LABELS[og.status] ?? labelOtrosGastoStatus(og.status)}
                                  </span>
                                </div>
                              </td>
                            </tr>
                            {compsOg.length > 0 && (
                              <tr className="border-b border-gray-100">
                                <td colSpan={5} className="p-0 align-top">
                                  <div
                                    className="overflow-hidden transition-[max-height,opacity] duration-300 ease-out"
                                    style={{ maxHeight: abiertoOg ? 1400 : 0, opacity: abiertoOg ? 1 : 0 }}
                                  >
                                    <div className="px-4 py-3 bg-gray-50/80 border-t border-gray-200">
                                      <div className="flex items-center gap-2 mb-3">
                                        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[#8B1A1A]/10">
                                          <FileText className="w-4 h-4 text-[#8B1A1A]" />
                                        </div>
                                        <div>
                                          <h4 className="text-sm font-semibold text-gray-900">Comprobantes — Semana {og.week_index}</h4>
                                          <p className="text-xs text-gray-500">{formatDate(og.due_date, 'es-ES')}</p>
                                        </div>
                                      </div>
                                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                                        {compsOg.map((comp, compIdx) => {
                                          const isPendiente = (comp.estado || '').toLowerCase() === 'pendiente';
                                          const montoMaximo = Math.max(0, Number(og.amount_due) - Number(og.paid_amount));
                                          const compLabel = `Comprobante ${compIdx + 1}`;
                                          const estado = (comp.estado || '').toLowerCase();
                                          const cardBg = estado === 'validado' ? 'bg-green-50/90 border-green-200' : estado === 'rechazado' ? 'bg-red-50/90 border-red-200' : 'bg-amber-50/90 border-amber-200';
                                          const url = comp.file_path ? (comp.file_path.startsWith('http') ? comp.file_path : getMiautoAdjuntoUrl(comp.file_path)) : '';
                                          const isImage = comp.file_path && !/\.pdf$/i.test(comp.file_name || '') && /\.(jpe?g|png|gif|webp)$/i.test(comp.file_name || '');
                                          const openPreview = () => url && setComprobantePreview({ url, fileName: compLabel, isImage: !!isImage });
                                          const sym = symMoneda(comp.moneda);
                                          return (
                                            <div key={comp.id} className={`rounded-xl border-2 p-3 ${cardBg} hover:shadow-md transition-all flex flex-col gap-2`}>
                                              <div className="flex gap-3">
                                                <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center overflow-hidden">
                                                  {comp.file_path && isImage ? (
                                                    <button type="button" onClick={openPreview} className="w-full h-full rounded-lg overflow-hidden border border-white/50 shadow-sm hover:opacity-90">
                                                      <img src={url} alt="" className="w-full h-full object-cover" />
                                                    </button>
                                                  ) : comp.file_path ? (
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
                                                    {isPendiente ? '—' : comp.monto != null ? `${sym} ${Number(comp.monto).toFixed(2)}` : '—'}
                                                  </p>
                                                  <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium mt-1 ${estado === 'validado' ? 'bg-green-100 text-green-800' : estado === 'rechazado' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>
                                                    {estado === 'validado' ? 'Validado' : estado === 'rechazado' ? 'Rechazado' : 'Pendiente'}
                                                  </span>
                                                </div>
                                              </div>
                                              {estado === 'rechazado' && (comp.rechazo_razon?.trim() ?? '') && (
                                                <p className="flex items-start gap-1.5 text-xs text-red-700 bg-red-50/90 rounded-lg px-2 py-1.5 border border-red-100">
                                                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                                  <span className="line-clamp-2">{(comp.rechazo_razon ?? '').trim()}</span>
                                                </p>
                                              )}
                                              {comp.file_path && (
                                                <button
                                                  type="button"
                                                  onClick={openPreview}
                                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border-2 border-gray-200 bg-white text-gray-800 hover:bg-gray-50 self-start"
                                                >
                                                  <ExternalLink className="w-3.5 h-3.5" />
                                                  Ver comprobante
                                                </button>
                                              )}
                                              {isPendiente && (
                                                <div className="pt-2 border-t border-gray-200/80">
                                                  <MiautoComprobantePagoActions
                                                    comprobanteId={comp.id}
                                                    validando={validandoCompOgId === comp.id}
                                                    rechazando={rechazandoCompOgId === comp.id}
                                                    onValidar={handleValidarComprobanteOg}
                                                    onRechazar={handleRechazarComprobanteOg}
                                                    montoMaximo={montoMaximo}
                                                    defaultMoneda={monedaCuotasLabel(solicitud?.cronograma_vehiculo?.inicial_moneda)}
                                                    valorUsdALocal={tipoCambioUsdLocal}
                                                  />
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                </div>
                <TablePaginationBar
                  page={otrosPg.page}
                  setPage={otrosPg.setPage}
                  totalPages={otrosPg.totalPages}
                  limit={otrosPg.limit}
                  setLimit={otrosPg.setLimit}
                  pageSizes={otrosPg.pageSizes}
                  containerClassName="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-3 border-t border-gray-100"
                />
              </>
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
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
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
            <div className="p-5 space-y-4 overflow-y-auto flex-1">
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
                  <ul className="mt-2 space-y-2">
                    {(overdueCuotas.length > 0 ? overdueCuotas : pendingCuotasHoy).slice(0, 10).map((c) => {
                      const sym = symMoneda(monedaCuotaRow(c));
                      const cuotaNeta = Number(c.cuota_neta ?? c.amount_due) || 0;
                      const pagado = Number(c.paid_amount) || 0;
                      const pendiente = Math.max(0, cuotaNeta - pagado);
                      const moraPendiente = Number(c.mora_pendiente ?? c.late_fee) || 0;
                      const total = pendiente + moraPendiente;
                      const semana = miautoSemanaOrdinalPorVencimiento(cuotas, c.due_date, c.week_start_date);
                      return (
                        <li key={c.id} className="rounded-lg border border-gray-200 bg-gray-50/80 p-3">
                          <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
                            <span className="font-semibold text-gray-700">Semana {semana}</span>
                            <span>{c.status === 'overdue' ? 'Venció' : 'Vence'} {c.due_date ? formatDateUTC(c.due_date, 'es-ES') : '—'}</span>
                          </div>
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                            <span><span className="text-gray-500">Cuota:</span> <span className="font-medium text-gray-900">{sym} {pendiente.toFixed(2)}</span></span>
                            {moraPendiente > 0 && (
                              <span><span className="text-gray-500">Mora:</span> <span className="font-medium text-red-600">{sym} {moraPendiente.toFixed(2)}</span></span>
                            )}
                            <span><span className="text-gray-500">Total:</span> <span className="font-semibold text-gray-900">{sym} {total.toFixed(2)}</span></span>
                          </div>
                        </li>
                      );
                    })}
                    {(overdueCuotas.length > 10 || pendingCuotasHoy.length > 10) && (
                      <li className="text-sm text-gray-500 py-1">y {Math.max(overdueCuotas.length, pendingCuotasHoy.length) - 10} cuota(s) más</li>
                    )}
                  </ul>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Mensaje que verá el conductor</label>
                <textarea
                  value={whatsAppMessage}
                  onChange={(e) => setWhatsAppMessage(e.target.value)}
                  rows={5}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
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
                {sendingWhatsApp ? 'Enviando...' : whatsAppPhone ? 'Enviar por WhatsApp' : 'Sin número'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
