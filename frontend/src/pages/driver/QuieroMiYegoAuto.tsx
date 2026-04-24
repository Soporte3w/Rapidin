import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react';
import { createPortal } from 'react-dom';
import api from '../../services/api';
import { Car, FileText, Check, ShieldCheck, Phone, Mail, ChevronDown, ChevronRight, Upload, X, AlertCircle, ExternalLink, CheckCircle2, AlertTriangle, Wallet, Calendar, Sparkles, Clock, MessageSquare, CalendarCheck, Zap, Eye } from 'lucide-react';
import { TablePaginationBar } from '../../components/TablePaginationBar';
import { useTablePagination } from '../../hooks/useTablePagination';
import { type ComprobanteOtrosGastos, type MiautoOtrosGastoRow } from '../../utils/miautoOtrosGastos';
import { getStoredSession, getStoredRapidinDriverId, getStoredSelectedParkId } from '../../utils/authStorage';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';
import { formatDate, formatDateFlex, formatDateTime } from '../../utils/date';
import { monedaCuotasLabel, symMoneda } from '../../utils/miautoAlquilerVentaList';
import { roundToTwoDecimals } from '../../utils/currency';
import {
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
  miautoTotalCuotasPlanVehiculo,
} from '../../utils/miautoRentSaleHelpers';

const APPS_OPTIONS = [
  { code: 'uber', name: 'Uber' },
  { code: 'didi', name: 'Didi' },
  { code: 'cabify', name: 'Cabify' },
  { code: 'yango', name: 'Yango' },
  { code: 'indriver', name: 'InDriver' },
  { code: 'otro', name: 'Otro(s)' },
];

const STATUS_LABELS: Record<string, string> = {
  pendiente: 'Pendiente',
  citado: 'Citado',
  rechazado: 'Rechazado',
  desistido: 'Desistió',
  aprobado: 'Aprobado',
};

const MAX_REAGENDOS = 2;
const STATUS_LABEL_ACTIVE: Record<string, string> = { pendiente: 'Pendiente', citado: 'Cita agendada', aprobado: 'Aprobado' };

const STATUS_WITH_REAGENDO_INFO = new Set(['citado', 'aprobado', 'rechazado']);

function apiErrMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object' || !('response' in err)) return null;
  const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
  return typeof msg === 'string' && msg.trim() ? msg : null;
}

function parseEstadoComprobante(estado?: string | null): 'pendiente' | 'validado' | 'rechazado' {
  const e = (estado || '').toLowerCase();
  if (e === 'validado' || e === 'rechazado') return e;
  return 'pendiente';
}

function origenComprobanteCuota(cp: { origen?: string | null }): string {
  return (cp.origen || 'conductor').toLowerCase();
}

function esComprobanteAdminPago(cp: { origen?: string | null }): boolean {
  return origenComprobanteCuota(cp) === 'admin_confirmacion';
}

function comprobanteArchivoEsImagen(fileName?: string | null, filePath?: string | null): boolean {
  const blob = `${fileName || ''} ${filePath || ''}`;
  if (/\.pdf(\?|$|#|\/)/i.test(blob)) return false;
  return /\.(jpe?g|png|gif|webp)(\?|$|#|\/)/i.test(blob);
}

const INPUT_BASE =
  'w-full pl-9 pr-3 py-2.5 border rounded-lg bg-white text-gray-900 placeholder:text-gray-400 focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A]';

async function uploadAdjunto(solicitudId: string, tipo: string, file: File): Promise<void> {
  const fd = new FormData();
  fd.append('tipo', tipo);
  fd.append('file', file);
  await api.post(`/miauto/solicitudes/${solicitudId}/adjuntos`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}

function getComprobanteUrl(filePath: string | undefined): string {
  if (!filePath) return '';
  if (filePath.startsWith('http')) return filePath;
  return `${window.location.origin}${filePath.startsWith('/') ? '' : '/'}${filePath}`;
}

function useFilePreview(file: File | null): string | null {
  const [preview, setPreview] = useState<string | null>(null);
  const ref = useRef<string | null>(null);
  useEffect(() => {
    if (ref.current) {
      URL.revokeObjectURL(ref.current);
      ref.current = null;
    }
    if (!file) {
      setPreview(null);
      return;
    }
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      ref.current = url;
      setPreview(url);
    } else {
      setPreview(null);
    }
    return () => {
      if (ref.current) {
        URL.revokeObjectURL(ref.current);
        ref.current = null;
      }
    };
  }, [file]);
  return preview;
}

interface Solicitud {
  id: string;
  country: string;
  dni: string;
  phone: string | null;
  email: string | null;
  license_number: string | null;
  description: string | null;
  status: string;
  rejection_reason?: string | null;
  appointment_date?: string | null;
  reagendo_count?: number;
  observations?: string | null;
  created_at: string;
  pago_tipo?: 'completo' | 'parcial' | null;
  pago_estado?: 'pendiente' | 'completo' | null;
  cronograma?: { id: string; name: string; tasa_interes_mora?: number; bono_tiempo_activo?: boolean } | null;
  cronograma_vehiculo?: { id: string; name: string; inicial: number; inicial_moneda: string; cuotas_semanales: number; image?: string } | null;
  comprobantes_pago?: { id: string; file_name: string; file_path: string; monto?: number; created_at: string; estado?: 'pendiente' | 'validado' | 'rechazado'; validado?: boolean; rechazado?: boolean; rechazo_razon?: string | null }[];
  total_validado?: number | null;
  fecha_inicio_cobro_semanal?: string | null;
  placa_asignada?: string | null;
  otros_gastos?: { id: string; week_index: number; due_date: string; amount_due: number; paid_amount: number; status: string }[];
}

type CuotasCacheEntry = {
  cuotas: CuotaSemanal[];
  comprobantes: ComprobanteCuotaSemanal[];
  racha: number | null;
  cuotas_semanales_bonificadas?: number;
  comprobantesOtrosGastos?: ComprobanteOtrosGastos[];
  otrosGastos?: MiautoOtrosGastoRow[];
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
  late_fee: number;
  mora_interes_periodo?: number;
  mora_pendiente?: number;
  status: string;
  pending_total: number;
  cuota_final?: number;
  moneda?: string;
  cobro_saldo?: number;
  cuota_neta?: number;
  partner_fees_83?: number;
  partner_fees_yango_raw?: number | null;
  partner_fees_yango_83?: number;
  tipo_cambio_ref?: { valor_usd_a_local?: number; moneda_local?: string };
  partner_fees_cascada_aplicado_a?: {
    cuota_semanal_id?: string;
    week_start_date?: string | null;
    monto: number;
  }[];
}

interface ComprobanteCuotaSemanal {
  id: string;
  cuota_semanal_id: string;
  monto?: number;
  moneda?: string;
  file_name?: string;
  file_path?: string;
  estado?: string;
  created_at?: string;
  rechazo_razon?: string | null;
  origen?: string | null;
}

const REQUISITOS = [
  'DNI vigente',
  'Licencia de conducir vigente',
  'Categoría II-A en adelante',
  'Tener más de 350+ viajes en cualquier apps de taxi',
];

function trimStr(x: unknown): string {
  if (x == null) return '';
  return String(x).trim();
}

function AprobadoBlock({
  solicitud,
  expanded,
  onToggle,
  onUploadComprobante,
  uploadLoading,
  getComprobanteUrl,
  onRefetchSolicitudes,
  tipoCambio: tipoCambioProp,
  cuotasData,
  cuotasLoading,
  onInvalidateCuotas,
}: {
  solicitud: Solicitud;
  expanded: boolean;
  onToggle: () => void;
  onUploadComprobante: (solicitudId: string, file: File, monto?: string) => void;
  uploadLoading: boolean;
  getComprobanteUrl: (path: string | undefined) => string;
  onRefetchSolicitudes?: () => void;
  tipoCambio?: { valor_usd_a_local: number; moneda_local: string } | null;
  cuotasData?: { cuotas: CuotaSemanal[]; comprobantes: ComprobanteCuotaSemanal[]; racha: number | null; cuotas_semanales_bonificadas?: number; comprobantesOtrosGastos?: ComprobanteOtrosGastos[]; otrosGastos?: MiautoOtrosGastoRow[] } | null;
  cuotasLoading?: boolean;
  onInvalidateCuotas?: (solicitudId: string) => void;
}) {
  const [comprobantePreview, setComprobantePreview] = useState<{ url: string; fileName: string; isImage: boolean } | null>(null);
  const [comprobantesInicialAbierto, setComprobantesInicialAbierto] = useState(false);
  const [subTabCronogramaDriver, setSubTabCronogramaDriver] = useState<'semanales' | 'otros_gastos'>('semanales');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cuotasSemanales = cuotasData?.cuotas ?? [];
  const rachaFromBackend = cuotasData?.racha ?? null;
  const bonoAplicado = cuotasData?.cuotas_semanales_bonificadas ?? 0;
  const loadingCuotas = cuotasLoading ?? false;
  const comprobantesCuotaSemanal = cuotasData?.comprobantes ?? [];
  const comprobantesOtrosGastos = cuotasData?.comprobantesOtrosGastos ?? [];
  const [comprobantesSemanaAbierta, setComprobantesSemanaAbierta] = useState<Record<string, boolean>>({});
  const [uploadCuotaLoading, setUploadCuotaLoading] = useState<string | null>(null);
  const [fileCuotaPreview, setFileCuotaPreview] = useState<{ cuotaId: string; file: File } | null>(null);
  const fileCuotaRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [uploadOgLoading, setUploadOgLoading] = useState<string | null>(null);
  const [fileOgPreview, setFileOgPreview] = useState<{ otrosGastosId: string; file: File } | null>(null);
  const [comprobantesOgAbierta, setComprobantesOgAbierta] = useState<Record<string, boolean>>({});
  const [monedaOgPorFila, setMonedaOgPorFila] = useState<Record<string, 'PEN' | 'USD'>>({});
  const fileOgRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const previewCuotaFile = useFilePreview(fileCuotaPreview?.file ?? null);
  const previewOgFile = useFilePreview(fileOgPreview?.file ?? null);
  const toggleComprobantesSemana = useCallback((cuotaId: string) => {
    setComprobantesSemanaAbierta((prev) => ({ ...prev, [cuotaId]: !prev[cuotaId] }));
  }, []);
  const toggleComprobantesOg = useCallback((ogId: string) => {
    setComprobantesOgAbierta((prev) => ({ ...prev, [ogId]: !prev[ogId] }));
  }, []);
  const cronograma = solicitud.cronograma;
  const vehiculo = solicitud.cronograma_vehiculo;
  const totalCuotasPlanVehiculoCronograma = useMemo(
    () => miautoTotalCuotasPlanVehiculo(vehiculo?.cuotas_semanales, cuotasSemanales.length),
    [vehiculo?.cuotas_semanales, cuotasSemanales.length]
  );
  const getEstado = (cp: { estado?: string; validado?: boolean; rechazado?: boolean }): 'pendiente' | 'validado' | 'rechazado' => {
    const e = (cp.estado || '').toLowerCase();
    if (e === 'validado' || e === 'rechazado') return e;
    return cp.rechazado ? 'rechazado' : cp.validado ? 'validado' : 'pendiente';
  };
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const comprobantes = solicitud.comprobantes_pago ?? [];
  const pagoTipoLabel = solicitud.pago_tipo === 'parcial' ? 'Pago parcial' : solicitud.pago_tipo === 'completo' ? 'Pago completo' : null;
  const cuotaInicial = round2(vehiculo?.inicial != null ? Number(vehiculo.inicial) : 0);
  const totalValidado =
    solicitud.total_validado != null
      ? round2(Number(solicitud.total_validado))
      : round2(
          comprobantes
            .filter((cp) => getEstado(cp) === 'validado' && cp.monto != null)
            .reduce((sum: number, cp: { monto?: number }) => sum + Number(cp.monto), 0)
        );
  const falta = Math.max(0, round2(cuotaInicial - totalValidado));
  const progreso = cuotaInicial > 0 ? Math.min(100, (totalValidado / cuotaInicial) * 100) : 0;
  const pagoInicialCompleto =
    String(solicitud.pago_estado ?? '').toLowerCase() === 'completo' ||
    (cuotaInicial > 0 && totalValidado >= cuotaInicial);
  const monedaSimbolo = vehiculo?.inicial_moneda === 'PEN' ? 'S/.' : '$';

  const comprobantesSliderEl = (
    <div className="relative">
      <div
        className="flex gap-3 overflow-x-auto overflow-y-hidden pb-2 snap-x snap-mandatory scroll-smooth scrollbar-hide"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {comprobantes.map((cp, index) => {
          const isPagoManual = cp.file_path === 'manual';
          const url = getComprobanteUrl(cp.file_path);
          const isImage = !isPagoManual && /\.(jpe?g|png|gif|webp)$/i.test(cp.file_name || '');
          const openPreview = () => !isPagoManual && setComprobantePreview({ url, fileName: `Comprobante ${index + 1}`, isImage });
          const estado = getEstado(cp);
          return (
            <div key={cp.id} className="flex flex-col items-center gap-1 flex-shrink-0 snap-center w-[120px] sm:w-[130px]">
              <button type="button" onClick={openPreview} className="relative rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden hover:border-[#8B1A1A]/40 hover:shadow transition-all w-[110px] h-[110px] sm:w-[120px] sm:h-[120px] p-0 cursor-pointer flex items-center justify-center">
                <span className="absolute top-1 left-1 z-10 w-6 h-6 rounded-full bg-[#8B1A1A] text-white text-xs font-bold flex items-center justify-center">{index + 1}</span>
                <span className={`absolute top-1 right-1 z-10 px-1.5 py-0.5 rounded text-[10px] font-medium ${estado === 'rechazado' ? 'bg-red-600 text-white' : estado === 'validado' ? 'bg-green-600 text-white' : 'bg-amber-500 text-white'}`}>
                  {estado === 'rechazado' ? 'Rechazado' : estado === 'validado' ? 'Validado' : 'Pendiente'}
                </span>
                {isPagoManual ? (
                  <div className="w-full h-full flex flex-col items-center justify-center bg-gray-50 p-1">
                    <span className="text-[9px] text-gray-500 font-medium text-center leading-tight">Pago manual</span>
                    {cp.monto != null && <span className="text-[10px] font-semibold text-gray-700 mt-0.5">{monedaSimbolo} {Number(cp.monto).toFixed(2)}</span>}
                  </div>
                ) : isImage ? <img src={url} alt="" className="w-full h-full object-cover" /> : (
                  <div className="w-full h-full flex items-center justify-center bg-gray-50"><FileText className="w-8 h-8 text-gray-400" /></div>
                )}
              </button>
              {estado === 'rechazado' && cp.rechazo_razon && <p className="text-[10px] text-red-600 max-w-[120px] text-center truncate" title={cp.rechazo_razon}>{cp.rechazo_razon}</p>}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 mt-1">Toca un comprobante para verlo.</p>
    </div>
  );

  const tipoCambio = tipoCambioProp ?? null;

  const handleUploadComprobanteCuota = async (cuotaId: string, file: File) => {
    const cuota = cuotasSemanales.find((x) => x.id === cuotaId);
    const monto = cuota ? String(miautoCuotaFinalCronogramaSemanal(cuota).toFixed(2)) : '';
    const moneda = (cuota?.moneda === 'USD' ? 'USD' : 'PEN') as 'PEN' | 'USD';
    if (!monto || Number.isNaN(parseFloat(monto)) || parseFloat(monto) <= 0) {
      toast.error('No se pudo obtener el monto de la cuota');
      return;
    }
    setUploadCuotaLoading(cuotaId);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('monto', monto);
      fd.append('moneda', moneda);
      await api.post(`/miauto/solicitudes/${solicitud.id}/cuotas-semanales/${cuotaId}/comprobantes`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Comprobante subido. Un admin lo validará.');
      onInvalidateCuotas?.(solicitud.id);
      onRefetchSolicitudes?.();
      setComprobantesSemanaAbierta((prev) => ({ ...prev, [cuotaId]: true }));
    } catch (e: unknown) {
      toast.error(apiErrMessage(e) || 'Error al subir comprobante');
    } finally {
      setUploadCuotaLoading(null);
      setFileCuotaPreview((prev) => (prev?.cuotaId === cuotaId ? null : prev));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadComprobante(solicitud.id, file);
      e.target.value = '';
    }
  };

  const comprobantesByCuotaId = useMemo(() => {
    const m: Record<string, ComprobanteCuotaSemanal[]> = {};
    for (const c of comprobantesCuotaSemanal) {
      const id = c.cuota_semanal_id;
      if (!m[id]) m[id] = [];
      m[id].push(c);
    }
    return m;
  }, [comprobantesCuotaSemanal]);

  const comprobantesByOtrosGastosId = useMemo(() => {
    const m: Record<string, ComprobanteOtrosGastos[]> = {};
    for (const c of comprobantesOtrosGastos) {
      const id = c.otros_gastos_id;
      if (!m[id]) m[id] = [];
      m[id].push(c);
    }
    return m;
  }, [comprobantesOtrosGastos]);

  const monedaOtrosGastos = (vehiculo?.inicial_moneda === 'USD' ? 'USD' : 'PEN') as 'PEN' | 'USD';

  const handleUploadComprobanteOtrosGastos = async (otrosGastosId: string, file: File) => {
    const og = otrosGastosRows.find((o: { id: string }) => o.id === otrosGastosId);
    const monto = og ? String(Number((og as { amount_due: number }).amount_due).toFixed(2)) : '';
    const moneda = monedaOgPorFila[otrosGastosId] ?? monedaOtrosGastos;
    if (!monto || Number.isNaN(parseFloat(monto)) || parseFloat(monto) <= 0) {
      toast.error('No se pudo obtener el monto de la cuota');
      return;
    }
    setUploadOgLoading(otrosGastosId);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('monto', monto);
      fd.append('moneda', moneda);
      await api.post(`/miauto/solicitudes/${solicitud.id}/otros-gastos/${otrosGastosId}/comprobantes`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Comprobante subido. Un admin lo validará.');
      onInvalidateCuotas?.(solicitud.id);
      onRefetchSolicitudes?.();
      setComprobantesOgAbierta((prev) => ({ ...prev, [otrosGastosId]: true }));
    } catch (e: unknown) {
      toast.error(apiErrMessage(e) || 'Error al subir comprobante');
    } finally {
      setUploadOgLoading(null);
      setFileOgPreview((prev) => (prev?.otrosGastosId === otrosGastosId ? null : prev));
    }
  };

  const cuotasPg = useTablePagination(cuotasSemanales);
  const otrosGastosRows = useMemo(
    () => (Array.isArray(cuotasData?.otrosGastos) ? cuotasData.otrosGastos : Array.isArray(solicitud.otros_gastos) ? solicitud.otros_gastos : []),
    [cuotasData?.otrosGastos, solicitud.otros_gastos]
  );
  const otrosPg = useTablePagination(otrosGastosRows);

  return (
    <div className="mt-4 bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full bg-white px-5 py-3.5 border-b border-gray-200 flex items-center justify-between text-left hover:bg-gray-50/60 transition-colors">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2.5">
          <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-[#8B1A1A] to-[#6B1515] text-white shadow-sm">
            <Car className="w-4 h-4" />
          </span>
          <span className="flex flex-col">
            <span className="leading-tight">Tu auto asignado</span>
            {cronograma?.name && <span className="text-[11px] font-medium text-gray-500">{cronograma.name}</span>}
          </span>
        </h3>
        {expanded ? <ChevronDown className="w-5 h-5 text-gray-500" /> : <ChevronRight className="w-5 h-5 text-gray-500" />}
      </button>
      {expanded && (
        <div className="p-4">
          <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)] items-start">
            <aside className="space-y-4">
              {(() => {
                const statusLow = (solicitud.status || '').toLowerCase();
                const steps: Array<{ id: string; label: string; sub?: string; state: 'done' | 'active' | 'pending' }> = [];
                steps.push({
                  id: 'creada',
                  label: 'Solicitud creada',
                  sub: solicitud.created_at ? formatDate(solicitud.created_at, 'es-ES') : undefined,
                  state: 'done',
                });
                steps.push({
                  id: 'aprobacion',
                  label: 'Aprobación técnica',
                  sub: statusLow === 'aprobado' || statusLow === 'citado' ? formatDate(solicitud.created_at, 'es-ES') : statusLow === 'rechazado' ? 'Rechazada' : 'Pendiente',
                  state: statusLow === 'aprobado' || statusLow === 'citado' ? 'done' : statusLow === 'rechazado' ? 'pending' : 'active',
                });
                steps.push({
                  id: 'inicial',
                  label: 'Cuota inicial',
                  sub: pagoInicialCompleto ? 'Completada' : cuotaInicial > 0 ? 'En progreso' : '—',
                  state: pagoInicialCompleto ? 'done' : (cuotaInicial > 0 && totalValidado > 0) ? 'active' : statusLow === 'aprobado' ? 'active' : 'pending',
                });
                steps.push({
                  id: 'entrega',
                  label: 'Entrega de unidad',
                  sub: solicitud.appointment_date ? formatDateFlex(solicitud.appointment_date, 'es-ES') : 'Por agendar',
                  state: solicitud.fecha_inicio_cobro_semanal ? 'done' : pagoInicialCompleto ? 'active' : 'pending',
                });
                return (
                  <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4">
                    <div className="flex items-start justify-between mb-4">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">Progreso de gestión</p>
                      <FileText className="w-4 h-4 text-gray-400" />
                    </div>
                    <ol className="relative space-y-3.5">
                      {steps.map((s, idx) => {
                        const isLast = idx === steps.length - 1;
                        const dot = s.state === 'done'
                          ? 'bg-[#8B1A1A] ring-4 ring-[#8B1A1A]/15'
                          : s.state === 'active'
                            ? 'bg-white ring-2 ring-[#8B1A1A]'
                            : 'bg-white ring-2 ring-gray-300';
                        const labelColor = s.state === 'pending' ? 'text-gray-400' : 'text-gray-900';
                        const subColor = s.state === 'pending' ? 'text-gray-300' : 'text-gray-500';
                        return (
                          <li key={s.id} className="relative pl-7">
                            <span className={`absolute left-0 top-1 w-3 h-3 rounded-full ${dot}`} />
                            {!isLast && (
                              <span className={`absolute left-[5px] top-4 bottom-[-12px] w-px ${s.state === 'done' ? 'bg-[#8B1A1A]/40' : 'bg-gray-200'}`} />
                            )}
                            <p className={`text-sm font-semibold leading-tight ${labelColor}`}>{s.label}</p>
                            {s.sub && <p className={`text-[10px] uppercase tracking-wider mt-0.5 ${subColor}`}>{s.sub}</p>}
                          </li>
                        );
                      })}
                    </ol>
                    {(solicitud.appointment_date || solicitud.reagendo_count != null) && (
                      <div className="mt-4 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2 text-center">
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Cita</p>
                          <p className="text-xs font-bold text-gray-900 mt-0.5">
                            {solicitud.appointment_date ? formatDateFlex(solicitud.appointment_date, 'es-ES') : '—'}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Reagendos</p>
                          <p className="text-xs font-bold text-gray-900 mt-0.5 tabular-nums">
                            {solicitud.reagendo_count ?? 0} / {MAX_REAGENDOS}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="rounded-2xl bg-gradient-to-br from-gray-900 via-gray-900 to-black text-white shadow-lg overflow-hidden">
                <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-400">Unidad asignada</p>
                  <Car className="w-4 h-4 text-gray-500" />
                </div>
                <div className="px-4 pb-3">
                  <div className="relative w-full h-32 rounded-lg bg-gray-800/60 overflow-hidden flex items-center justify-center">
                    {vehiculo?.image ? (
                      <img
                        src={vehiculo.image.startsWith('data:') || vehiculo.image.startsWith('http') ? vehiculo.image : getComprobanteUrl(vehiculo.image)}
                        alt={vehiculo.name || 'Auto asignado'}
                        className="w-full h-full object-cover opacity-95"
                      />
                    ) : (
                      <Car className="w-14 h-14 text-gray-600" />
                    )}
                  </div>
                </div>
                <div className="px-4 pb-4">
                  <h4 className="text-base font-bold text-white leading-tight">
                    {vehiculo?.name ?? 'Sin asignar'}
                  </h4>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-mono uppercase tracking-wider text-gray-300">
                      <span className="text-gray-500">PLACA · </span>
                      <span className="font-bold text-white">{solicitud.placa_asignada || '—'}</span>
                    </span>
                    {cronograma?.name && (
                      <span className="font-mono uppercase tracking-wider text-gray-400 text-right">
                        <span className="font-bold text-white">{cronograma.name}</span>
                      </span>
                    )}
                  </div>
                  {!cronograma?.name && pagoTipoLabel && (
                    <p className="mt-1.5 text-[10px] uppercase tracking-wider text-gray-500">
                      {pagoTipoLabel}
                    </p>
                  )}
                </div>
              </div>
            </aside>

            <div className="space-y-4 min-w-0">
              {cuotaInicial > 0 && !pagoInicialCompleto && (
                <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                  <div className="px-4 sm:px-5 pt-4 pb-3">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">Control de cuota inicial</p>
                        <p className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums leading-none">
                          {monedaSimbolo}{totalValidado.toFixed(2)}
                          <span className="text-gray-300 font-normal"> / {monedaSimbolo}{cuotaInicial.toFixed(2)}</span>
                        </p>
                        {vehiculo?.inicial_moneda === 'USD' && tipoCambio?.valor_usd_a_local && (
                          <p className="text-[11px] text-gray-500 mt-1.5">
                            {tipoCambio.moneda_local === 'COP' ? 'Equiv. en pesos:' : 'Equiv. en soles:'}{' '}
                            {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'} {(totalValidado * tipoCambio.valor_usd_a_local).toFixed(2)} / {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'} {(cuotaInicial * tipoCambio.valor_usd_a_local).toFixed(2)}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-2xl sm:text-3xl font-bold text-[#8B1A1A] tabular-nums leading-none">{Math.round(progreso)}%</p>
                        <p className="text-[10px] uppercase tracking-wider text-gray-500 mt-1">Completado</p>
                      </div>
                    </div>
                    <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-[#8B1A1A] to-[#C53838] rounded-full transition-all duration-500"
                        style={{ width: `${progreso}%` }}
                      />
                    </div>
                  </div>
                  {falta > 0 && (
                    <div className="mx-4 sm:mx-5 mb-3 flex items-center justify-between gap-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        <p className="text-sm text-amber-900">
                          <span className="font-semibold">Te falta {monedaSimbolo}{falta.toFixed(2)}</span>
                          {vehiculo?.inicial_moneda === 'USD' && tipoCambio?.valor_usd_a_local && (
                            <span className="text-[11px] text-amber-700">
                              {' · '}Equiv. {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'} {(falta * tipoCambio.valor_usd_a_local).toFixed(2)}
                            </span>
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-[11px] font-bold uppercase tracking-wider text-[#8B1A1A] hover:text-[#6B1515] whitespace-nowrap"
                      >
                        Subir comprobante
                      </button>
                    </div>
                  )}
                  <div className="px-4 sm:px-5 pb-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">
                        Comprobantes subidos {comprobantes.length > 0 && <span className="text-gray-400">· {comprobantes.length}</span>}
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {comprobantes.length > 0 ? (
                        comprobantes.map((cp, idx) => {
                          const estado = getEstado(cp);
                          const url = cp.file_path === 'manual' ? '' : getComprobanteUrl(cp.file_path);
                          const isImage = cp.file_path !== 'manual' && /\.(jpe?g|png|gif|webp)$/i.test(cp.file_name || '');
                          const openPreview = () => url && setComprobantePreview({ url, fileName: `Comprobante ${idx + 1}`, isImage });
                          const labelEstado = estado === 'validado' ? 'VALIDADO' : estado === 'rechazado' ? 'RECHAZADO' : 'PENDIENTE';
                          const cardCls = estado === 'validado'
                            ? 'border-emerald-200 bg-emerald-50/40'
                            : estado === 'rechazado'
                              ? 'border-red-200 bg-red-50/40'
                              : 'border-amber-200 bg-amber-50/40';
                          const iconCls = estado === 'validado' ? 'text-emerald-600' : estado === 'rechazado' ? 'text-red-600' : 'text-amber-600';
                          const badgeCls = estado === 'validado' ? 'bg-emerald-100 text-emerald-800' : estado === 'rechazado' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800';
                          return (
                            <button
                              key={cp.id}
                              type="button"
                              onClick={openPreview}
                              className={`flex items-center gap-3 rounded-xl border ${cardCls} px-3 py-2.5 text-left hover:shadow-md transition-all`}
                            >
                              <CheckCircle2 className={`w-5 h-5 shrink-0 ${iconCls}`} />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-gray-900 leading-tight truncate">Comprobante #{idx + 1}</p>
                                <p className="text-[11px] text-gray-600 mt-0.5 tabular-nums">
                                  {cp.monto != null ? `${monedaSimbolo}${Number(cp.monto).toFixed(2)}` : '—'} · {labelEstado.charAt(0) + labelEstado.slice(1).toLowerCase()}
                                </p>
                              </div>
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider ${badgeCls}`}>{labelEstado}</span>
                            </button>
                          );
                        })
                      ) : null}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadLoading}
                        className="flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 px-3 py-2.5 text-gray-500 hover:border-[#8B1A1A] hover:text-[#8B1A1A] hover:bg-red-50/30 transition-colors disabled:opacity-50"
                      >
                        <Upload className="w-4 h-4" />
                        <span className="text-sm font-medium">{uploadLoading ? 'Subiendo...' : 'Subir nuevo comprobante'}</span>
                      </button>
                    </div>
                    <input
                      type="file"
                      ref={fileInputRef}
                      accept=".pdf,image/*"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                  </div>
                </div>
              )}
              {cuotaInicial > 0 && pagoInicialCompleto && (
                <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50/40 to-white shadow-sm overflow-hidden">
                  <div className="px-4 py-3 border-b border-emerald-100 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-sm shrink-0">
                        <CheckCircle2 className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">Cuota inicial · Pago completado</p>
                        <p className="text-base font-bold text-emerald-900 leading-tight tabular-nums">{monedaSimbolo} {totalValidado.toFixed(2)}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setComprobantesInicialAbierto((v) => !v)}
                      className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 hover:text-emerald-900 whitespace-nowrap inline-flex items-center gap-1"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      {comprobantesInicialAbierto ? 'Ocultar' : 'Ver'} comprobantes ({comprobantes.length})
                    </button>
                  </div>
                  {comprobantesInicialAbierto && (
                    <div className="p-4 border-t border-emerald-100">
                      {comprobantes.length > 0 ? comprobantesSliderEl : (
                        <p className="text-sm text-gray-500">No hay comprobantes registrados.</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-gray-100">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">Movimientos del financiamiento</p>
                      <h4 className="mt-1 text-lg font-bold text-gray-900">
                        {subTabCronogramaDriver === 'semanales' ? 'Mis cuotas · próximas' : 'Otros gastos'}
                      </h4>
                    </div>
                    {solicitud.fecha_inicio_cobro_semanal && cuotasSemanales.length > 0 && subTabCronogramaDriver === 'semanales' && (() => {
                      const vencidas = cuotasSemanales.filter((c) => c.status === 'overdue').length;
                      return (
                        <p className="text-xs text-gray-500 tabular-nums whitespace-nowrap shrink-0">
                          <span className={vencidas > 0 ? 'text-[#8B1A1A] font-bold' : 'font-bold text-gray-700'}>{vencidas}</span> / {totalCuotasPlanVehiculoCronograma} vencidas
                        </p>
                      );
                    })()}
                  </div>
                  {solicitud.fecha_inicio_cobro_semanal && (
                    <div className="mt-3 -mb-3 flex gap-1">
                      <button
                        type="button"
                        onClick={() => setSubTabCronogramaDriver('semanales')}
                        className={`px-3 py-2 text-xs font-bold uppercase tracking-wider border-b-2 -mb-px transition-colors ${
                          subTabCronogramaDriver === 'semanales'
                            ? 'border-[#8B1A1A] text-[#8B1A1A]'
                            : 'border-transparent text-gray-400 hover:text-gray-700'
                        }`}
                      >
                        Cronograma
                      </button>
                      <button
                        type="button"
                        onClick={() => setSubTabCronogramaDriver('otros_gastos')}
                        className={`px-3 py-2 text-xs font-bold uppercase tracking-wider border-b-2 -mb-px transition-colors ${
                          subTabCronogramaDriver === 'otros_gastos'
                            ? 'border-[#8B1A1A] text-[#8B1A1A]'
                            : 'border-transparent text-gray-400 hover:text-gray-700'
                        }`}
                      >
                        Otros gastos
                      </button>
                    </div>
                  )}
                </div>
          {solicitud.fecha_inicio_cobro_semanal && subTabCronogramaDriver === 'semanales' && !loadingCuotas && cuotasSemanales.length > 0 && (() => {
            const cuotasPagadas = cuotasSemanales.filter((c) => c.status === 'paid' || c.status === 'bonificada').length;
            const vencidas = cuotasSemanales.filter((c) => c.status === 'overdue').length;
            const totalPagado = round2(
              cuotasSemanales.reduce((s, c) => s + miautoMontoPagadoCuotaSemanal(c.paid_amount), 0),
            );
            const bonoTiempoActivo = solicitud.cronograma?.bono_tiempo_activo === true;
            const racha = bonoTiempoActivo ? (rachaFromBackend ?? (() => {
              const tieneVencida = cuotasSemanales.some((c) => (c.status || '').toLowerCase() === 'overdue');
              if (tieneVencida) return 0;
              const ordenadas = [...cuotasSemanales].sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
              let n = 0;
              for (const c of ordenadas) {
                if ((c.status === 'paid' || c.status === 'bonificada') && (Number(c.pending_total) || 0) === 0) n++;
                else break;
              }
              return n;
            })()) : null;
            return (
              <div className="px-4 sm:px-5 py-3 border-b border-gray-100">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2 items-end">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                      Pagadas
                    </p>
                    <p className="text-base font-bold text-gray-900 tabular-nums mt-1">
                      {cuotasPagadas}
                      <span className="text-gray-400 font-normal"> / {totalCuotasPlanVehiculoCronograma}</span>
                    </p>
                  </div>
                  <div>
                    <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] flex items-center gap-1 ${vencidas > 0 ? 'text-[#8B1A1A]' : 'text-gray-500'}`}>
                      <AlertTriangle className={`w-3 h-3 ${vencidas > 0 ? 'text-[#8B1A1A]' : 'text-gray-400'}`} />
                      Vencidas
                    </p>
                    <p className={`text-base font-bold tabular-nums mt-1 ${vencidas > 0 ? 'text-[#8B1A1A]' : 'text-gray-700'}`}>
                      {vencidas}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500 flex items-center gap-1">
                      <Wallet className="w-3 h-3 text-emerald-600" />
                      Total pagado
                    </p>
                    <p className="text-base font-bold text-emerald-700 tabular-nums mt-1">S/. {totalPagado.toFixed(2)}</p>
                  </div>
                </div>
                {bonoTiempoActivo && (bonoAplicado >= 1 || racha === 3) && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {bonoAplicado >= 1 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-[11px] font-medium text-emerald-800">
                        <Sparkles className="w-3 h-3" />
                        {bonoAplicado} cuota{bonoAplicado !== 1 ? 's' : ''} bonificada{bonoAplicado !== 1 ? 's' : ''}
                      </span>
                    )}
                    {racha === 3 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-1 text-[11px] font-medium text-amber-800">
                        <Zap className="w-3 h-3" />
                        Paga 1 más para bono
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
          {solicitud.fecha_inicio_cobro_semanal && subTabCronogramaDriver === 'semanales' && (
            <div className="px-4 sm:px-5 py-4">
              {loadingCuotas ? (
                <div className="flex justify-center py-4">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#8B1A1A] border-t-transparent" />
                </div>
              ) : cuotasSemanales.length === 0 ? (
                <p className="text-sm text-gray-500">Aún no hay cuotas semanales generadas.</p>
              ) : (
                <>
                <div className="overflow-x-auto -mx-1 px-1 sm:mx-0 sm:px-0 rounded-xl border border-gray-200 bg-white shadow-sm">
                  <table className="w-full min-w-[1080px] text-sm border-collapse tabular-nums">
                    <thead>
                      <tr className="border-b-2 border-gray-200 bg-gradient-to-b from-gray-50 to-gray-100/60">
                        <th className="sticky left-0 z-[1] bg-gradient-to-b from-gray-50 to-gray-100/60 py-3 pl-3 pr-2 text-left text-xs font-bold uppercase tracking-wide text-gray-900 shadow-[2px_0_6px_-2px_rgba(0,0,0,0.06)] min-w-[9.5rem] align-bottom">
                          Semana
                        </th>
                        <th className="py-3 px-3 text-left text-xs font-bold uppercase tracking-wide text-gray-900 whitespace-nowrap min-w-[7.5rem] align-bottom">
                          Vence
                        </th>
                        <th
                          className="py-3 px-3 text-right text-xs font-bold uppercase tracking-wide text-gray-900 whitespace-nowrap w-[7.25rem] align-bottom"
                          title="Cuota del cronograma en la fila (cuota_semanal). El abono registrado está en la columna Pagado."
                        >
                          Cuota sem. (plan)
                        </th>
                        <th className="py-3 px-3 text-right text-xs font-bold uppercase tracking-wide text-green-700 whitespace-nowrap min-w-[8.5rem] align-bottom">
                          Viajes — B.A
                        </th>
                        <th
                          className="py-3 px-3 text-right text-xs font-bold uppercase tracking-wide text-green-700 whitespace-nowrap w-[5.5rem] align-bottom"
                          title="Lo que se retiene sobre los ingresos de la semana (83% del fee Yango por viajes)."
                        >
                          Cobro por ingresos
                        </th>
                        <th
                          className="py-3 px-3 text-right text-xs font-bold uppercase tracking-wide text-green-700 whitespace-nowrap min-w-[6.5rem] align-bottom"
                          title="Cargo fijo de la regla del cronograma (cobro saldo), aparte del cobro por ingresos."
                        >
                          Cobro saldo
                        </th>
                        <th
                          className="py-3 px-3 text-right text-xs font-bold uppercase tracking-wide text-gray-900 whitespace-nowrap w-[6.5rem] align-bottom"
                          title="Saldo pendiente del capital cuota (sin mora). Los pagos cubren primero la mora; el resto reduce este saldo."
                        >
                          Cuota a pagar
                        </th>
                        <th className="py-3 px-3 text-right text-xs font-bold uppercase tracking-wide text-red-600 whitespace-nowrap min-w-[5.5rem] align-bottom">
                          Mora
                          {solicitud.cronograma?.tasa_interes_mora != null && Number(solicitud.cronograma.tasa_interes_mora) > 0
                            ? ` (${(Number(solicitud.cronograma.tasa_interes_mora) * 100).toFixed(2)}%)`
                            : ''}
                        </th>
                        <th className="py-3 px-3 text-right text-xs font-bold uppercase tracking-wide text-green-700 whitespace-nowrap w-[6.5rem] align-bottom">
                          Cuota final
                        </th>
                        <th
                          className="py-3 px-3 text-right text-xs font-bold uppercase tracking-wide text-green-700 whitespace-nowrap w-[6.5rem] align-bottom"
                          title="Legado Excel: sin abono, monto hoja (amount_due); con abono, paid_amount. Fuera de legado: paid_amount."
                        >
                          Pagado
                        </th>
                        <th className="py-3 px-3 text-center text-xs font-bold uppercase tracking-wide text-gray-900 whitespace-nowrap w-[6.5rem] align-bottom">
                          Estado
                        </th>
                        <th className="py-3 pl-3 pr-4 text-right text-xs font-bold uppercase tracking-wide text-gray-900 min-w-[10rem] align-bottom">
                          Comprobante
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {cuotasPg.paginatedItems.map((c, index) => {
                        const numeroSemana =
                          miautoSemanaLista(cuotasSemanales, c.week_start_date) ??
                          miautoSemanaOrdinalPorVencimiento(cuotasSemanales, c.due_date, c.week_start_date) ??
                          (cuotasPg.page - 1) * cuotasPg.limit + index + 1;
                        const filaTinte =
                          c.status === 'overdue' ? 'bg-red-50/30 hover:bg-red-50/60'
                          : (c.status === 'paid' || c.status === 'bonificada') ? 'bg-emerald-50/20 hover:bg-emerald-50/50'
                          : c.status === 'partial' ? 'bg-blue-50/20 hover:bg-blue-50/50'
                          : 'hover:bg-gray-50/60';
                        const stickyPrimeraCol =
                          c.status === 'overdue' ? 'bg-red-50/30 group-hover:bg-red-50/60'
                          : (c.status === 'paid' || c.status === 'bonificada') ? 'bg-emerald-50/20 group-hover:bg-emerald-50/50'
                          : c.status === 'partial' ? 'bg-blue-50/20 group-hover:bg-blue-50/50'
                          : 'bg-white group-hover:bg-gray-50/80';
                        const comps = comprobantesByCuotaId[c.id] ?? [];
                        const conformidadesAdmin = comps.filter(esComprobanteAdminPago);
                        const compsPanelConductor = comps.filter((cp) => !esComprobanteAdminPago(cp));
                        const cuotaCerrada = c.status === 'paid' || c.status === 'bonificada';
                        const cuotaFinalSemana = miautoCuotaFinalCronogramaSemanal(c);
                        const montoPagadoDisplay = miautoMontoPagadoColumnaCronograma(c);
                        const totalPendienteFila = Math.max(
                          0,
                          Number(c.pending_total ?? c.cuota_final ?? cuotaFinalSemana) || 0
                        );
                        const cuotaNetaPlan = miautoCuotaAPagarCronogramaSemanal(c);
                        const cuotaCapitalPendDisplay = miautoCuotaCapitalPendienteColumna(c);
                        const mostrarSublinePlanCuota =
                          totalPendienteFila > 0.005 && cuotaNetaPlan - cuotaCapitalPendDisplay > 0.005;
                        const moraPendienteCol = Number(c.mora_pendiente ?? c.late_fee) || 0;
                        const saldoSemanaNeto = cuotaFinalSemana;
                        const pendienteMonto = Math.max(0, saldoSemanaNeto);
                        const pendiente = pendienteMonto > 0;
                        const mostrarPanelComprobantes = comps.length > 0 || cuotaCerrada;
                        const abierto = comprobantesSemanaAbierta[c.id] === true;
                        const symCuota = symMoneda(c.moneda ?? solicitud?.cronograma_vehiculo?.inicial_moneda);
                        const tributoCobroIngresos = miautoCobroPorIngresosTributoDisplay(c);
                        const titleCobroIngresos = miautoTooltipCobroPorIngresos(symCuota, c, cuotasSemanales);
                        const filasCascadaCobro = miautoCascadaCobroIngresosFilasParaUi(cuotasSemanales, c);
                        return (
                          <Fragment key={c.id}>
                            <tr className={`group border-b border-gray-100 transition-colors ${filaTinte}`}>
                              <td className={`sticky left-0 z-[1] px-3 py-3 align-top shadow-[2px_0_6px_-2px_rgba(0,0,0,0.06)] ${stickyPrimeraCol}`}>
                                {mostrarPanelComprobantes ? (
                                  <button
                                    type="button"
                                    onClick={() => toggleComprobantesSemana(c.id)}
                                    className="flex w-full max-w-[13rem] flex-col items-stretch gap-0.5 rounded-md py-0.5 text-left text-gray-700 transition-colors hover:bg-gray-100/90"
                                  >
                                    <span className="flex items-center gap-1.5">
                                      {abierto ? (
                                        <ChevronDown className="h-4 w-4 flex-shrink-0 text-gray-500" aria-hidden />
                                      ) : (
                                        <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-500" aria-hidden />
                                      )}
                                      <span className="font-semibold text-[#8B1A1A] leading-tight">Semana {numeroSemana}</span>
                                    </span>
                                    <span className="pl-[1.375rem] block text-left text-[11px] leading-tight text-gray-500 tabular-nums">
                                      {formatDate(c.week_start_date, 'es-ES')}
                                    </span>
                                  </button>
                                ) : (
                                  <div className="max-w-[13rem]">
                                    <span className="block font-semibold text-[#8B1A1A] leading-tight">Semana {numeroSemana}</span>
                                    <span className="mt-0.5 block text-[11px] leading-tight text-gray-500 tabular-nums">{formatDate(c.week_start_date, 'es-ES')}</span>
                                  </div>
                                )}
                              </td>
                              <td className={`px-3 py-3 align-top text-[13px] leading-tight whitespace-nowrap ${c.status === 'overdue' ? 'text-[#8B1A1A] font-bold uppercase tracking-wide' : 'text-gray-800'}`}>{formatDate(c.due_date, 'es-ES')}</td>
                              <td className="px-3 py-3 align-top font-medium tabular-nums text-gray-900 text-right text-[13px] leading-tight">
                                {miautoFmtMonto(symCuota, miautoCuotaSemanalOAbonoDisplay(c))}
                              </td>
                              <td className="px-3 py-3 align-top text-xs tabular-nums text-right text-green-700 leading-tight">
                                {c.num_viajes != null ? (
                                  <>
                                    <span className="text-gray-700">{c.num_viajes} — </span>
                                    <span className="text-green-700">Bono {miautoFmtMonto(symCuota, c.bono_auto)}</span>
                                  </>
                                ) : c.bono_auto != null ? (
                                  <span className="text-green-700">Bono {miautoFmtMonto(symCuota, c.bono_auto)}</span>
                                ) : (
                                  <span className="text-gray-500">—</span>
                                )}
                              </td>
                              <td
                                className="px-3 py-3 align-top text-xs tabular-nums text-right text-green-700 leading-tight"
                                title={titleCobroIngresos}
                              >
                                <div className="flex flex-col items-end gap-1">
                                  <span className="block">{miautoFmtMonto(symCuota, tributoCobroIngresos)}</span>
                                  {filasCascadaCobro.length > 0 ? (
                                    <div className="max-w-[12rem] text-left text-[10px] font-normal leading-snug text-gray-600">
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
                              <td className="px-3 py-3 align-top text-xs tabular-nums text-right text-green-700 leading-tight">
                                {miautoFmtMonto(symCuota, miautoCobroSaldoDisplay(c))}
                              </td>
                              <td className="px-3 py-3 align-top font-medium tabular-nums text-right text-gray-900 text-[13px] leading-tight">
                                <div className="flex flex-col items-end gap-0.5">
                                  <span>{miautoFmtMonto(symCuota, cuotaCapitalPendDisplay)}</span>
                                  {mostrarSublinePlanCuota ? (
                                    <span className="text-[10px] font-normal leading-snug text-gray-500 tabular-nums">
                                      Plan {miautoFmtMonto(symCuota, cuotaNetaPlan)}
                                    </span>
                                  ) : null}
                                </div>
                              </td>
                              <td className="px-3 py-3 align-top font-medium tabular-nums text-right text-[13px] text-red-600 leading-tight">
                                {miautoFmtMonto(symCuota, moraPendienteCol)}
                              </td>
                              <td className="px-3 py-3 align-top font-medium tabular-nums text-right text-[13px] text-green-700 leading-tight">
                                {miautoFmtMonto(symCuota, cuotaFinalSemana)}
                              </td>
                              <td className="px-3 py-3 align-top text-right text-[13px] text-green-800 leading-tight">
                                <div className="flex flex-col items-end gap-0.5 tabular-nums">
                                  <span className="font-medium">{miautoFmtMonto(symCuota, montoPagadoDisplay)}</span>
                                  {miautoNum(c.late_fee) > 0.005 ? (
                                    <span className="text-[10px] font-normal leading-snug text-amber-700">
                                      Mora: {miautoFmtMonto(symCuota, miautoNum(c.late_fee))}
                                    </span>
                                  ) : null}
                                </div>
                              </td>
                              <td className="px-3 py-3 align-top whitespace-nowrap">
                                {(() => {
                                  let badgeLabel = 'PENDIENTE';
                                  let badgeCls = 'bg-amber-100 text-amber-800';
                                  if (c.status === 'paid') { badgeLabel = 'PAGADA'; badgeCls = 'bg-emerald-100 text-emerald-800'; }
                                  else if (c.status === 'bonificada') { badgeLabel = 'BONIFICADA'; badgeCls = 'bg-violet-100 text-violet-800'; }
                                  else if (c.status === 'overdue') { badgeLabel = 'VENCIDA'; badgeCls = 'bg-red-100 text-red-800'; }
                                  else if (c.status === 'partial') { badgeLabel = 'PARCIAL'; badgeCls = 'bg-blue-100 text-blue-800'; }
                                  else {
                                    const dueMs = c.due_date ? new Date(c.due_date).getTime() : 0;
                                    const sieteDiasMs = 7 * 24 * 60 * 60 * 1000;
                                    const esProyectada = dueMs > Date.now() + sieteDiasMs;
                                    if (esProyectada) { badgeLabel = 'PROYECTADA'; badgeCls = 'bg-gray-100 text-gray-500'; }
                                  }
                                  return (
                                    <div className="flex flex-col items-center gap-0.5">
                                      <span
                                        className={`inline-flex items-center justify-center px-2 py-0.5 rounded text-[10px] font-bold tracking-wider ${badgeCls}`}
                                        title={c.status === 'bonificada' ? 'Bonificación por 4 cuotas seguidas al día' : undefined}
                                      >
                                        {badgeLabel}
                                      </span>
                                      {c.status === 'bonificada' && (
                                        <span className="text-center text-[10px] text-gray-500 leading-tight">Por 4 cuotas al día</span>
                                      )}
                                    </div>
                                  );
                                })()}
                              </td>
                              <td className="px-3 py-3 pl-3 pr-4 align-top text-right">
                                <div className="flex min-w-0 flex-col items-end gap-1.5">
                                  {(() => {
                                    const cfPrincipal = conformidadesAdmin[0];
                                    const urlPrincipal = cfPrincipal?.file_path ? getComprobanteUrl(cfPrincipal.file_path) : '';
                                    if (cuotaCerrada && cfPrincipal && urlPrincipal) {
                                      const isImg = !!cfPrincipal.file_path && comprobanteArchivoEsImagen(cfPrincipal.file_name, cfPrincipal.file_path);
                                      return (
                                        <button
                                          type="button"
                                          onClick={() => setComprobantePreview({ url: urlPrincipal, fileName: cfPrincipal.file_name || 'Recibo', isImage: isImg })}
                                          className="text-[11px] font-bold uppercase tracking-wider text-[#8B1A1A] hover:underline whitespace-nowrap"
                                        >
                                          Ver recibo
                                        </button>
                                      );
                                    }
                                    if (cuotaCerrada) {
                                      return (
                                        <button
                                          type="button"
                                          onClick={() => toggleComprobantesSemana(c.id)}
                                          className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 hover:underline whitespace-nowrap"
                                        >
                                          Ver comprobantes
                                        </button>
                                      );
                                    }
                                    if (c.status === 'overdue' && pendiente) {
                                      return (
                                        <button
                                          type="button"
                                          disabled={uploadCuotaLoading === c.id || (fileCuotaPreview?.cuotaId === c.id)}
                                          onClick={() => fileCuotaRefs.current[c.id]?.click()}
                                          className="inline-flex items-center px-2.5 py-1 bg-[#8B1A1A] hover:bg-[#6B1515] text-white rounded text-[10px] font-bold uppercase tracking-wider disabled:opacity-50 whitespace-nowrap"
                                        >
                                          Pagar ahora
                                        </button>
                                      );
                                    }
                                    if (pendiente) {
                                      return (
                                        <button
                                          type="button"
                                          disabled={uploadCuotaLoading === c.id || (fileCuotaPreview?.cuotaId === c.id)}
                                          onClick={() => fileCuotaRefs.current[c.id]?.click()}
                                          className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-gray-600 hover:text-[#8B1A1A] whitespace-nowrap disabled:opacity-50"
                                        >
                                          <Upload className="w-3 h-3" />
                                          Subir
                                        </button>
                                      );
                                    }
                                    if (!pendiente && comps.length === 0 && conformidadesAdmin.length === 0) {
                                      return <span className="text-gray-400 text-xs">—</span>;
                                    }
                                    return null;
                                  })()}
                                  {pendiente && (
                                    <input
                                      ref={(el) => { fileCuotaRefs.current[c.id] = el; }}
                                      type="file"
                                      accept=".pdf,image/*"
                                      className="hidden"
                                      onChange={(e) => {
                                        const f = e.target.files?.[0];
                                        if (f) setFileCuotaPreview({ cuotaId: c.id, file: f });
                                        e.target.value = '';
                                      }}
                                    />
                                  )}
                                  {fileCuotaPreview?.cuotaId === c.id && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="relative inline-block flex-shrink-0">
                                        {previewCuotaFile ? (
                                          <img src={previewCuotaFile} alt="Vista previa" className="w-8 h-8 object-cover rounded border border-gray-200" />
                                        ) : (
                                          <span className="w-8 h-8 rounded border border-gray-200 bg-gray-50 flex items-center justify-center">
                                            <FileText className="w-4 h-4 text-gray-400" />
                                          </span>
                                        )}
                                        <button
                                          type="button"
                                          disabled={uploadCuotaLoading === c.id}
                                          onClick={() => setFileCuotaPreview((prev) => (prev?.cuotaId === c.id ? null : prev))}
                                          className="absolute top-0 right-0 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 shadow -translate-y-1/2 translate-x-1/2 disabled:opacity-50"
                                          aria-label="Quitar archivo"
                                        >
                                          <X className="w-2.5 h-2.5" />
                                        </button>
                                      </span>
                                      <button
                                        type="button"
                                        disabled={uploadCuotaLoading === c.id}
                                        onClick={() => handleUploadComprobanteCuota(c.id, fileCuotaPreview.file)}
                                        className="inline-flex items-center px-2 py-1 bg-[#8B1A1A] text-white rounded text-[10px] font-bold uppercase tracking-wider disabled:opacity-50 whitespace-nowrap"
                                      >
                                        {uploadCuotaLoading === c.id ? 'Enviando...' : 'Pagar'}
                                      </button>
                                    </div>
                                  )}
                                  {conformidadesAdmin.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => toggleComprobantesSemana(c.id)}
                                      className="text-[10px] text-gray-500 hover:text-gray-700 underline"
                                    >
                                      +{conformidadesAdmin.length - 1} más
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {mostrarPanelComprobantes && (
                              <tr className="border-b border-gray-100">
                                <td colSpan={12} className="p-0 align-top">
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
                                          <h4 className="text-sm font-semibold text-gray-900">Comprobantes — Semana {numeroSemana}</h4>
                                          <p className="text-xs text-gray-500">{formatDate(c.week_start_date, 'es-ES')}</p>
                                        </div>
                                      </div>

                                      {comps.length === 0 ? (
                                        <p className="text-xs text-gray-500 mb-2">No hay comprobantes registrados para esta semana.</p>
                                      ) : compsPanelConductor.length === 0 ? (
                                        <p className="text-xs text-gray-500 mb-2">
                                          No has enviado comprobantes para esta semana.
                                        </p>
                                      ) : (
                                      <>
                                      <p className="mb-2 text-xs font-semibold text-gray-800">Comprobantes que enviaste</p>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                        {compsPanelConductor.map((cp, compIdx) => {
                                          const esPagoManual = origenComprobanteCuota(cp) === 'pago_manual';
                                          const estado = parseEstadoComprobante(cp.estado);
                                          const symMontoComp = symMoneda(cp.moneda);
                                          const puedeVer = !!cp.file_path && cp.file_path !== 'manual';
                                          const url = puedeVer ? getComprobanteUrl(cp.file_path) : '';
                                          const isImage = puedeVer && comprobanteArchivoEsImagen(cp.file_name, cp.file_path);
                                          const compLabel = esPagoManual
                                            ? 'Pago registrado por administración'
                                            : `Comprobante ${compIdx + 1}`;
                                          const openPreview = () =>
                                            puedeVer && setComprobantePreview({ url, fileName: compLabel, isImage: !!isImage });
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
                                          const labelEstado =
                                            estado === 'validado'
                                              ? 'Verificado'
                                              : estado === 'rechazado'
                                                ? 'Rechazado'
                                                : 'En revisión';
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
                                          return (
                                            <div key={cp.id} className={`rounded-xl border-2 p-3 ${cardBg} hover:shadow-md transition-all flex flex-col gap-2`}>
                                              <div className="flex gap-3">
                                                <div className={`flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center overflow-hidden ${iconBg}`}>
                                                  {puedeVer && isImage ? (
                                                    <button type="button" onClick={openPreview} className="w-full h-full rounded-lg overflow-hidden border border-white/50 shadow-sm hover:opacity-90 transition-opacity">
                                                      <img src={url} alt="" className="w-full h-full object-cover" />
                                                    </button>
                                                  ) : puedeVer ? (
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
                                                  {cp.created_at && (
                                                    <p className="text-xs text-gray-500 mt-0.5">{formatDateTime(cp.created_at, 'es-ES')}</p>
                                                  )}
                                                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                                                    <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${labelClass}`}>
                                                      {labelEstado}
                                                    </span>
                                                    <span className="text-xs font-semibold text-gray-800">
                                                      {esPagoManual
                                                        ? '—'
                                                        : estado === 'pendiente'
                                                          ? '—'
                                                          : (cp.monto != null ? `${symMontoComp} ${Number(cp.monto).toFixed(2)}` : '—')}
                                                    </span>
                                                  </div>
                                                </div>
                                              </div>
                                              {estado === 'rechazado' && (cp.rechazo_razon?.trim() ?? '') && (
                                                <p className="flex items-start gap-1.5 text-xs text-red-700 bg-red-50/90 rounded-lg px-2 py-1.5 border border-red-100">
                                                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                                  <span className="line-clamp-2">{(cp.rechazo_razon ?? '').trim()}</span>
                                                </p>
                                              )}
                                              {puedeVer && (
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
                                      {(() => {
                                        const compsSinOficial = comps.filter((cp) => !esComprobanteAdminPago(cp));
                                        const verificado = compsSinOficial
                                          .filter((cp) => parseEstadoComprobante(cp.estado) === 'validado')
                                          .reduce((s, cp) => s + (cp.monto != null ? Number(cp.monto) : 0), 0);
                                        const totalEnv = compsSinOficial.reduce(
                                          (s, cp) => s + (cp.monto != null ? Number(cp.monto) : 0),
                                          0
                                        );
                                        const rechazado = compsSinOficial
                                          .filter((cp) => parseEstadoComprobante(cp.estado) === 'rechazado')
                                          .reduce((s, cp) => s + (cp.monto != null ? Number(cp.monto) : 0), 0);
                                        const monedasComp = [...new Set(compsSinOficial.map((cp) => monedaCuotasLabel(cp.moneda)))];
                                        const symMontosComp =
                                          monedasComp.length === 1 ? symMoneda(monedasComp[0]) : symCuota;
                                        const saldoPlanSemana = roundToTwoDecimals(
                                          Math.max(0, Number(cuotaFinalSemana))
                                        );
                                        return (
                                          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-white border border-gray-200 px-4 py-3 text-sm text-gray-700 shadow-sm">
                                            <span title="Montos según cada comprobante (p. ej. soles si se validó en PEN).">
                                              <strong className="text-gray-800">Total enviado:</strong> {symMontosComp}{' '}
                                              {totalEnv.toFixed(2)}
                                            </span>
                                            <span title="Montos según cada comprobante.">
                                              <strong className="text-gray-800">Verificado:</strong> {symMontosComp}{' '}
                                              {verificado.toFixed(2)}
                                            </span>
                                            <span title="Montos según cada comprobante.">
                                              <strong className="text-gray-800">Rechazado:</strong> {symMontosComp}{' '}
                                              {rechazado.toFixed(2)}
                                            </span>
                                            <span title="Saldo de esta semana en la moneda del cronograma.">
                                              <strong className="text-gray-800">Saldo pendiente (plan):</strong> {symCuota}{' '}
                                              {saldoPlanSemana.toFixed(2)}
                                            </span>
                                          </div>
                                        );
                                      })()}
                                      </>
                                      )}
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
                {cuotasSemanales.length > 0 && (
                  <TablePaginationBar
                    page={cuotasPg.page}
                    setPage={cuotasPg.setPage}
                    totalPages={cuotasPg.totalPages}
                    limit={cuotasPg.limit}
                    setLimit={cuotasPg.setLimit}
                    pageSizes={cuotasPg.pageSizes}
                  />
                )}
                </>
              )}
              {solicitud.cronograma?.bono_tiempo_activo === true && (
                <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50/70 px-3 py-2">
                  <p className="text-xs text-gray-700">
                    Beneficio: si pagas 4 cuotas consecutivas a tiempo, se te bonifica 1 cuota semanal del total.
                  </p>
                </div>
              )}
            </div>
          )}
          {solicitud.fecha_inicio_cobro_semanal && subTabCronogramaDriver === 'otros_gastos' && (() => {
            const totalOg = otrosGastosRows.reduce((s: number, og: { amount_due: number }) => s + Number(og.amount_due ?? 0), 0);
            const pagadoOg = otrosGastosRows.reduce((s: number, og: { paid_amount: number }) => s + Number(og.paid_amount ?? 0), 0);
            const pendientesCount = otrosGastosRows.filter((og: { status: string }) => og.status !== 'paid').length;
            const pagadasCount = otrosGastosRows.filter((og: { status: string }) => og.status === 'paid').length;
            const saldoOg = Math.max(0, totalOg - pagadoOg);
            return (
            <div className="px-4 sm:px-5 py-4">
              {otrosGastosRows.length > 0 ? (
                <>
                <div className="grid grid-cols-3 gap-x-6 gap-y-2 mb-4 px-1">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                      Pagadas
                    </p>
                    <p className="text-base font-bold text-gray-900 tabular-nums mt-1">
                      {pagadasCount}
                      <span className="text-gray-400 font-normal"> / {pagadasCount + pendientesCount}</span>
                    </p>
                  </div>
                  <div>
                    <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] flex items-center gap-1 ${saldoOg > 0 ? 'text-amber-700' : 'text-gray-500'}`}>
                      <AlertTriangle className={`w-3 h-3 ${saldoOg > 0 ? 'text-amber-600' : 'text-gray-400'}`} />
                      Saldo
                    </p>
                    <p className={`text-base font-bold tabular-nums mt-1 ${saldoOg > 0 ? 'text-amber-700' : 'text-gray-700'}`}>
                      {monedaSimbolo}{saldoOg.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500 flex items-center gap-1">
                      <Wallet className="w-3 h-3 text-emerald-600" />
                      Total pagado
                    </p>
                    <p className="text-base font-bold text-emerald-700 tabular-nums mt-1">{monedaSimbolo}{pagadoOg.toFixed(2)}</p>
                  </div>
                </div>
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                  <table className="w-full text-sm border-collapse tabular-nums">
                    <thead>
                      <tr className="border-b-2 border-gray-200 bg-gradient-to-b from-gray-50 to-gray-100/60 text-gray-900">
                        <th className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wide align-bottom">Semana</th>
                        <th className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wide align-bottom whitespace-nowrap">Vence</th>
                        <th className="px-3 py-3 text-right text-xs font-bold uppercase tracking-wide align-bottom">Monto</th>
                        <th className="px-3 py-3 text-right text-xs font-bold uppercase tracking-wide align-bottom">Pagado</th>
                        <th className="px-3 py-3 text-center text-xs font-bold uppercase tracking-wide align-bottom whitespace-nowrap">Estado</th>
                        <th className="px-3 py-3 pr-4 text-right text-xs font-bold uppercase tracking-wide align-bottom">Comprobante</th>
                      </tr>
                    </thead>
                    <tbody>
                      {otrosPg.paginatedItems.map((og: { id: string; week_index: number; due_date: string; amount_due: number; paid_amount: number; status: string }) => {
                        const pendienteOg = og.status !== 'paid';
                        const compsOg = comprobantesByOtrosGastosId[og.id] ?? [];
                        const mostrarPanelOg = compsOg.length > 0 || !pendienteOg;
                        const abiertoOg = comprobantesOgAbierta[og.id] === true;
                        const tieneCompPendienteOg = compsOg.some((cp: { estado?: string }) => (cp.estado || '').toLowerCase() === 'pendiente');
                        const ogStatusLow = (og.status || '').toLowerCase();
                        const ogTinte = ogStatusLow === 'paid' ? 'bg-emerald-50/20 hover:bg-emerald-50/50'
                          : ogStatusLow === 'overdue' ? 'bg-red-50/30 hover:bg-red-50/60'
                          : 'hover:bg-gray-50/60';
                        return (
                          <Fragment key={og.id}>
                            <tr className={`border-b border-gray-100 transition-colors ${ogTinte}`}>
                              <td className="px-3 py-3 align-top">
                                {mostrarPanelOg ? (
                                  <button
                                    type="button"
                                    onClick={() => toggleComprobantesOg(og.id)}
                                    className="inline-flex flex-wrap items-center gap-1.5 text-left hover:opacity-90"
                                  >
                                    {abiertoOg ? (
                                      <ChevronDown className="w-4 h-4 text-gray-600 flex-shrink-0" aria-hidden />
                                    ) : (
                                      <ChevronRight className="w-4 h-4 text-gray-600 flex-shrink-0" aria-hidden />
                                    )}
                                    <span className="font-semibold text-[#8B1A1A] leading-tight">Semana {og.week_index}</span>
                                    {compsOg.length > 0 && (
                                      <span className="inline-flex flex-shrink-0 items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-700 ring-1 ring-gray-200">
                                        {compsOg.length}
                                      </span>
                                    )}
                                  </button>
                                ) : (
                                  <span className="font-semibold text-[#8B1A1A] leading-tight">Semana {og.week_index}</span>
                                )}
                              </td>
                              <td className={`px-3 py-3 align-top text-[13px] leading-tight whitespace-nowrap ${ogStatusLow === 'overdue' ? 'text-[#8B1A1A] font-bold uppercase tracking-wide' : 'text-gray-800'}`}>{formatDate(og.due_date, 'es-ES')}</td>
                              <td className="px-3 py-3 align-top text-right tabular-nums font-medium text-gray-900 text-[13px] leading-tight">
                                {monedaSimbolo}{Number(og.amount_due).toFixed(2)}
                              </td>
                              <td className="px-3 py-3 align-top text-right tabular-nums text-emerald-700 font-medium text-[13px] leading-tight">
                                {monedaSimbolo}{Number(og.paid_amount).toFixed(2)}
                              </td>
                              <td className="px-3 py-3 align-top text-center">
                                {(() => {
                                  let label = 'PENDIENTE';
                                  let cls = 'bg-amber-100 text-amber-800';
                                  if (ogStatusLow === 'paid') { label = 'PAGADA'; cls = 'bg-emerald-100 text-emerald-800'; }
                                  else if (ogStatusLow === 'overdue') { label = 'VENCIDA'; cls = 'bg-red-100 text-red-800'; }
                                  else if (ogStatusLow === 'partial') { label = 'PARCIAL'; cls = 'bg-blue-100 text-blue-800'; }
                                  return (
                                    <div className="flex justify-center">
                                      <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded text-[10px] font-bold tracking-wider ${cls}`}>
                                        {label}
                                      </span>
                                    </div>
                                  );
                                })()}
                              </td>
                              <td className="px-3 py-3 pr-4 align-top text-right">
                                <div className="flex flex-col items-end gap-1.5">
                                  {(() => {
                                    if (!pendienteOg) {
                                      if (ogStatusLow === 'paid' && compsOg.length > 0) {
                                        return (
                                          <button
                                            type="button"
                                            onClick={() => toggleComprobantesOg(og.id)}
                                            className="text-[11px] font-bold uppercase tracking-wider text-[#8B1A1A] hover:underline whitespace-nowrap"
                                          >
                                            Ver recibo
                                          </button>
                                        );
                                      }
                                      return <span className="text-gray-400 text-xs">—</span>;
                                    }
                                    if (ogStatusLow === 'overdue') {
                                      return (
                                        <button
                                          type="button"
                                          disabled={uploadOgLoading === og.id || (fileOgPreview?.otrosGastosId === og.id) || tieneCompPendienteOg}
                                          onClick={() => fileOgRefs.current[og.id]?.click()}
                                          className="inline-flex items-center px-2.5 py-1 bg-[#8B1A1A] hover:bg-[#6B1515] text-white rounded text-[10px] font-bold uppercase tracking-wider disabled:opacity-50 whitespace-nowrap"
                                          title={tieneCompPendienteOg ? 'Espera a que se apruebe o rechace tu comprobante' : undefined}
                                        >
                                          Pagar ahora
                                        </button>
                                      );
                                    }
                                    return (
                                      <button
                                        type="button"
                                        disabled={uploadOgLoading === og.id || (fileOgPreview?.otrosGastosId === og.id) || tieneCompPendienteOg}
                                        onClick={() => fileOgRefs.current[og.id]?.click()}
                                        className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-gray-600 hover:text-[#8B1A1A] disabled:opacity-50 whitespace-nowrap"
                                        title={tieneCompPendienteOg ? 'Espera a que se apruebe o rechace tu comprobante' : undefined}
                                      >
                                        <Upload className="w-3 h-3" />
                                        Subir
                                      </button>
                                    );
                                  })()}
                                  {pendienteOg && (
                                    <>
                                      <input
                                        ref={(el) => { fileOgRefs.current[og.id] = el; }}
                                        type="file"
                                        accept=".pdf,image/*"
                                        className="hidden"
                                        disabled={tieneCompPendienteOg}
                                        onChange={(e) => {
                                          const f = e.target.files?.[0];
                                          if (f) setFileOgPreview({ otrosGastosId: og.id, file: f });
                                          e.target.value = '';
                                        }}
                                      />
                                      <select
                                        value={monedaOgPorFila[og.id] ?? monedaOtrosGastos}
                                        onChange={(e) => setMonedaOgPorFila((prev) => ({ ...prev, [og.id]: e.target.value as 'PEN' | 'USD' }))}
                                        disabled={tieneCompPendienteOg || !fileOgPreview || fileOgPreview.otrosGastosId !== og.id}
                                        className={`px-1.5 py-0.5 border border-gray-200 rounded text-[10px] text-gray-700 ${tieneCompPendienteOg ? 'bg-gray-100 cursor-not-allowed' : 'bg-white'} ${(!fileOgPreview || fileOgPreview.otrosGastosId !== og.id) ? 'hidden' : ''}`}
                                        title="Moneda del pago"
                                      >
                                        <option value="PEN">S/.</option>
                                        <option value="USD">USD</option>
                                      </select>
                                    </>
                                  )}
                                  {fileOgPreview?.otrosGastosId === og.id && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="relative inline-block flex-shrink-0">
                                        {previewOgFile ? (
                                          <img src={previewOgFile} alt="Vista previa" className="w-8 h-8 object-cover rounded border border-gray-200" />
                                        ) : (
                                          <span className="w-8 h-8 rounded border border-gray-200 bg-gray-50 flex items-center justify-center">
                                            <FileText className="w-4 h-4 text-gray-400" />
                                          </span>
                                        )}
                                        <button
                                          type="button"
                                          disabled={uploadOgLoading === og.id}
                                          onClick={() => setFileOgPreview((prev) => (prev?.otrosGastosId === og.id ? null : prev))}
                                          className="absolute top-0 right-0 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 shadow -translate-y-1/2 translate-x-1/2"
                                          aria-label="Quitar archivo"
                                        >
                                          <X className="w-2.5 h-2.5" />
                                        </button>
                                      </span>
                                      <button
                                        type="button"
                                        disabled={uploadOgLoading === og.id}
                                        onClick={() => handleUploadComprobanteOtrosGastos(og.id, fileOgPreview!.file)}
                                        className="inline-flex items-center px-2 py-1 bg-[#8B1A1A] text-white rounded text-[10px] font-bold uppercase tracking-wider disabled:opacity-50 whitespace-nowrap"
                                      >
                                        {uploadOgLoading === og.id ? 'Enviando...' : 'Pagar'}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {mostrarPanelOg && (
                              <tr className="border-b border-gray-50">
                                <td colSpan={6} className="p-0 align-top">
                                  <div
                                    className="overflow-hidden transition-[max-height,opacity] duration-300 ease-out"
                                    style={{ maxHeight: abiertoOg ? 1200 : 0, opacity: abiertoOg ? 1 : 0 }}
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
                                      {compsOg.length === 0 ? (
                                        <p className="text-xs text-gray-500">No hay comprobantes registrados para esta semana.</p>
                                      ) : (
                                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                        {compsOg.map((cp, compIdx) => {
                                          const estadoOg = parseEstadoComprobante(cp.estado);
                                          const sym = cp.moneda === 'USD' ? '$' : 'S/.';
                                          const url = getComprobanteUrl(cp.file_path);
                                          const isImage = cp.file_path && !/\.pdf$/i.test(cp.file_name || '') && /\.(jpe?g|png|gif|webp)$/i.test(cp.file_name || '');
                                          const cardBg = estadoOg === 'validado' ? 'bg-green-50/90 border-green-200' : estadoOg === 'rechazado' ? 'bg-red-50/90 border-red-200' : 'bg-amber-50/90 border-amber-200';
                                          const labelEstado = estadoOg === 'validado' ? 'Verificado' : estadoOg === 'rechazado' ? 'Rechazado' : 'En revisión';
                                          return (
                                            <div key={cp.id} className={`rounded-xl border-2 p-3 ${cardBg}`}>
                                              <div className="flex gap-3">
                                                <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center overflow-hidden">
                                                  {cp.file_path && isImage ? (
                                                    <img src={url} alt="" className="w-full h-full object-cover" />
                                                  ) : (
                                                    <FileText className="w-6 h-6 text-gray-500" />
                                                  )}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                  <p className="text-sm font-semibold text-gray-900">Comprobante {compIdx + 1}</p>
                                                  <p className="text-xs text-gray-600">{cp.monto != null ? `${sym} ${Number(cp.monto).toFixed(2)}` : '—'}</p>
                                                  <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium mt-1 ${estadoOg === 'validado' ? 'bg-green-100 text-green-800' : estadoOg === 'rechazado' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>
                                                    {labelEstado}
                                                  </span>
                                                </div>
                                              </div>
                                              {cp.file_path && (
                                                <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-[#8B1A1A] hover:underline">
                                                  <ExternalLink className="w-3.5 h-3.5" />
                                                  Ver comprobante
                                                </a>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                      )}
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
                <TablePaginationBar
                  page={otrosPg.page}
                  setPage={otrosPg.setPage}
                  totalPages={otrosPg.totalPages}
                  limit={otrosPg.limit}
                  setLimit={otrosPg.setLimit}
                  pageSizes={otrosPg.pageSizes}
                />
                </>
              ) : (
                <p className="text-sm text-gray-500">No hay cuotas de otros gastos para esta solicitud (plan con pago completo de cuota inicial).</p>
              )}
            </div>
            );
          })()}
              </div>
            </div>
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
              <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
                  <span className="text-sm font-medium text-gray-900 truncate">{comprobantePreview.fileName}</span>
                  <button type="button" onClick={() => setComprobantePreview(null)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-600" aria-label="Cerrar">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="flex-1 min-h-0 p-4 overflow-auto">
                  {comprobantePreview.isImage ? (
                    <img src={comprobantePreview.url} alt={comprobantePreview.fileName} className="max-w-full h-auto max-h-[70vh] object-contain mx-auto" />
                  ) : (
                    <iframe src={comprobantePreview.url} title={comprobantePreview.fileName} className="w-full min-h-[70vh] rounded-lg border border-gray-200" />
                  )}
                </div>
              </div>
            </div>,
            document.body
          )}
        </div>
      )}
    </div>
  );
}

function QuieroMiYegoAuto() {
  const { updateUser } = useAuth();
  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [activeBlocking, setActiveBlocking] = useState<{ hasActive: boolean; sameFlota?: boolean; flota?: string; status?: string; statusLabel?: string } | null>(null);
  const [aprobadoExpandedId, setAprobadoExpandedId] = useState<string | null>(null);
  const [uploadComprobanteLoading, setUploadComprobanteLoading] = useState<string | null>(null);
  const initialFetchInFlight = useRef(false);
  const [tipoCambioByCountry, setTipoCambioByCountry] = useState<Record<string, { valor_usd_a_local: number; moneda_local: string } | null>>({});
  const [cuotasCache, setCuotasCache] = useState<Record<string, CuotasCacheEntry>>({});
  const [cuotasLoadingId, setCuotasLoadingId] = useState<string | null>(null);

  const blockedByActiveInOtherFlota = activeBlocking?.hasActive === true && activeBlocking?.sameFlota === false;
  const blockingMessage = blockedByActiveInOtherFlota
    ? `Ya tienes una solicitud con estado "${activeBlocking?.statusLabel ?? STATUS_LABEL_ACTIVE[activeBlocking?.status ?? ''] ?? 'Aprobado'}" en la flota "${activeBlocking?.flota ?? 'Otra flota'}". No puedes crear otra.`
    : null;

  const storedUser = getStoredSession()?.user as { country?: string; phone?: string; document_number?: string; email?: string; license?: string } | undefined;
  const [form, setForm] = useState({
    country: storedUser?.country === 'CO' ? 'CO' : 'PE',
    dni: trimStr(storedUser?.document_number),
    phone: trimStr(storedUser?.phone),
    email: trimStr(storedUser?.email),
    license_number: trimStr(storedUser?.license),
    description: '',
    app_codes: [] as string[],
  });
  const [fileLicencia, setFileLicencia] = useState<File | null>(null);
  const [fileComprobante, setFileComprobante] = useState<File | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ celular?: string; email?: string; apps?: string }>({});
  const previewLicencia = useFilePreview(fileLicencia);
  const previewComprobante = useFilePreview(fileComprobante);

  useEffect(() => {
    const session = getStoredSession();
    if (!session?.token) return;
    const needEmail = !form.email?.trim();
    const needLicense = !form.license_number?.trim();
    const needDni = !form.dni?.trim();
    if (!needEmail && !needLicense && !needDni) return;
    const loadProfile = async () => {
      const params: Record<string, string> = {};
      const rapidinId = getStoredRapidinDriverId();
      const parkId = getStoredSelectedParkId();
      if (rapidinId) params.rapidin_driver_id = rapidinId;
      if (parkId) params.park_id = parkId;
      try {
        const { data } = await api.get('/driver/profile', { params });
        const d = data?.data;
        if (d) {
          const emailVal = (d.email != null && String(d.email).trim() !== '') ? String(d.email).trim() : '';
          const licenseVal = (d.license != null && String(d.license).trim() !== '') ? String(d.license).trim() : '';
          const dniVal = (d.documentNumber != null && String(d.documentNumber).trim() !== '') ? String(d.documentNumber).trim() : '';
          if (emailVal || licenseVal || dniVal) {
            setForm((prev) => ({
              ...prev,
              ...(needEmail && emailVal && { email: emailVal }),
              ...(needLicense && licenseVal && { license_number: licenseVal }),
              ...(needDni && dniVal && { dni: dniVal }),
            }));
            updateUser({ ...(emailVal && { email: emailVal }), ...(licenseVal && { license: licenseVal }) });
          }
          return;
        }
      } catch (_) {}
      try {
        const conductorParams: Record<string, string> = {};
        if (rapidinId) conductorParams.rapidin_driver_id = rapidinId;
        const { data } = await api.get('/driver/conductor-data', { params: conductorParams });
        const d = data?.data;
        if (d) {
          const dniVal = (d.documentNumber != null && String(d.documentNumber).trim() !== '') ? String(d.documentNumber).trim() : '';
          const licenseVal = (d.license != null && String(d.license).trim() !== '') ? String(d.license).trim() : '';
          const phoneVal = (d.phone != null && String(d.phone).trim() !== '') ? String(d.phone).trim() : '';
          setForm((prev) => ({
            ...prev,
            ...(needDni && dniVal && { dni: dniVal }),
            ...(needLicense && licenseVal && { license_number: licenseVal }),
            ...(phoneVal && { phone: phoneVal }),
          }));
          if (licenseVal) updateUser({ license: licenseVal });
        }
      } catch (_) {}
    };
    loadProfile();
  }, []);

  const fetchSolicitudes = useCallback(async () => {
    try {
      setError('');
      const rapidinDriverId = getStoredRapidinDriverId();
      const params: Record<string, string> = { limit: '50' };
      if (rapidinDriverId) params.rapidin_driver_id = rapidinDriverId;
      const response = await api.get('/miauto/solicitudes', { params });
      const data = response.data?.data ?? response.data ?? [];
      setSolicitudes(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      setError(apiErrMessage(e) || 'Error al cargar tus solicitudes');
      setSolicitudes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchActiveBlocking = useCallback(async () => {
    try {
      const rapidinDriverId = getStoredRapidinDriverId();
      const params: Record<string, string> = {};
      if (rapidinDriverId) params.rapidin_driver_id = rapidinDriverId;
      const { data } = await api.get('/miauto/active-blocking', { params });
      const d = data?.data ?? data;
      setActiveBlocking(d && typeof d.hasActive === 'boolean' ? d : null);
    } catch {
      setActiveBlocking(null);
    }
  }, []);

  useEffect(() => {
    if (initialFetchInFlight.current) return;
    initialFetchInFlight.current = true;
    setLoading(true);
    Promise.all([fetchSolicitudes(), fetchActiveBlocking()]).finally(() => {
      initialFetchInFlight.current = false;
    });
  }, [fetchSolicitudes, fetchActiveBlocking]);

  const expandedSolicitud = useMemo(
    () => (aprobadoExpandedId ? solicitudes.find((s) => s.id === aprobadoExpandedId) ?? null : null),
    [aprobadoExpandedId, solicitudes]
  );

  useEffect(() => {
    const country = expandedSolicitud?.country;
    if (!country || tipoCambioByCountry[country] !== undefined) return;
    api.get(`/miauto/tipo-cambio?country=${country}`)
      .then((res) => {
        const d = res.data?.data ?? res.data;
        if (d && typeof d.valor_usd_a_local === 'number') {
          setTipoCambioByCountry((prev) => ({
            ...prev,
            [country]: { valor_usd_a_local: d.valor_usd_a_local, moneda_local: d.moneda_local || 'PEN' },
          }));
        } else {
          setTipoCambioByCountry((prev) => ({ ...prev, [country]: null }));
        }
      })
      .catch(() => setTipoCambioByCountry((prev) => ({ ...prev, [country]: null })));
  }, [expandedSolicitud?.country, tipoCambioByCountry]);

  const fetchCuotasForSolicitud = useCallback(async (solicitudId: string) => {
    setCuotasLoadingId(solicitudId);
    try {
      const [resCuotas, resComp, resCompOg, resOtrosGastos] = await Promise.all([
        api.get(`/miauto/solicitudes/${solicitudId}/cuotas-semanales`),
        api.get(`/miauto/solicitudes/${solicitudId}/comprobantes-cuota-semanal`).catch(() => ({ data: [] })),
        api.get(`/miauto/solicitudes/${solicitudId}/comprobantes-otros-gastos`).catch(() => ({ data: [] })),
        api.get(`/miauto/solicitudes/${solicitudId}/otros-gastos`).catch(() => ({ data: [] })),
      ]);
      const body = resCuotas?.data ?? {};
      const inner = body.data ?? body;
      const raw = inner?.data ?? inner;
      const data = Array.isArray(raw) ? raw : (raw?.data ?? (Array.isArray(inner) ? inner : []));
      const cuotas = Array.isArray(data) ? data : [];
      const rachaFromApi = (inner?.racha ?? raw?.racha ?? (body as { racha?: number }).racha) as number | string | undefined;
      const n = typeof rachaFromApi === 'number' ? rachaFromApi : Number(rachaFromApi);
      const rachaVal = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
      const bonoFromApi = inner?.cuotas_semanales_bonificadas ?? raw?.cuotas_semanales_bonificadas ?? (body as { cuotas_semanales_bonificadas?: number }).cuotas_semanales_bonificadas;
      const bonoAplicado = typeof bonoFromApi === 'number' && Number.isFinite(bonoFromApi) ? Math.max(0, Math.floor(bonoFromApi)) : 0;
      const comp = resComp?.data?.data ?? resComp?.data ?? [];
      const comprobantes = Array.isArray(comp) ? comp : [];
      const compOg = resCompOg?.data?.data ?? resCompOg?.data ?? [];
      const comprobantesOtrosGastos = Array.isArray(compOg) ? compOg : [];
      const ogRaw = resOtrosGastos?.data?.data ?? resOtrosGastos?.data ?? [];
      const otrosGastos = Array.isArray(ogRaw) ? ogRaw : [];
      setCuotasCache((prev) => ({
        ...prev,
        [solicitudId]: { cuotas, comprobantes, racha: rachaVal, cuotas_semanales_bonificadas: bonoAplicado, comprobantesOtrosGastos, otrosGastos },
      }));
    } catch {
      setCuotasCache((prev) => ({ ...prev, [solicitudId]: { cuotas: [], comprobantes: [], racha: null, cuotas_semanales_bonificadas: 0, comprobantesOtrosGastos: [], otrosGastos: [] } }));
    } finally {
      setCuotasLoadingId(null);
    }
  }, []);

  useEffect(() => {
    const sol = expandedSolicitud;
    if (!sol?.id || !sol.fecha_inicio_cobro_semanal) return;
    if (cuotasCache[sol.id]) return;
    fetchCuotasForSolicitud(sol.id);
  }, [expandedSolicitud?.id, expandedSolicitud?.fecha_inicio_cobro_semanal, cuotasCache, fetchCuotasForSolicitud]);

  const invalidateCuotasCache = useCallback((solicitudId: string) => {
    setCuotasCache((prev) => {
      const next = { ...prev };
      delete next[solicitudId];
      return next;
    });
  }, []);

  const setField = (key: Exclude<keyof typeof form, 'app_codes'>, errorKeyToClear?: keyof typeof fieldErrors) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
      if (errorKeyToClear) setFieldErrors((prev) => ({ ...prev, [errorKeyToClear]: undefined }));
    };

  const handleUploadComprobante = async (solicitudId: string, file: File, monto?: string) => {
    try {
      setUploadComprobanteLoading(solicitudId);
      const fd = new FormData();
      fd.append('file', file);
      if (monto != null && monto.trim() !== '') fd.append('monto', monto.trim());
      await api.post(`/miauto/solicitudes/${solicitudId}/comprobantes-pago`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Comprobante subido');
      await fetchSolicitudes();
    } catch (e: unknown) {
      toast.error(apiErrMessage(e) || 'Error al subir comprobante');
    } finally {
      setUploadComprobanteLoading(null);
    }
  };

  const handleAppToggle = (code: string) => {
    setForm((prev) => ({
      ...prev,
      app_codes: prev.app_codes.includes(code)
        ? prev.app_codes.filter((c) => c !== code)
        : [...prev.app_codes, code],
    }));
    setFieldErrors((prev) => ({ ...prev, apps: undefined }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreateNew) {
      toast.error(blockingMessage ?? 'Ya tienes una solicitud en trámite (pendiente, citada o aprobada). No puedes crear otra.');
      return;
    }
    setFieldErrors({});
    const errors: { celular?: string; email?: string } = {};
    if (!form.phone?.trim()) errors.celular = 'Celular requerido';
    const emailVal = form.email?.trim();
    if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) errors.email = 'Email inválido';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    if (!form.dni.trim()) {
      toast.error('DNI es requerido');
      return;
    }
    if (!form.app_codes.length) {
      setFieldErrors((prev) => ({ ...prev, apps: 'Selecciona al menos una app' }));
      return;
    }
    if (!fileLicencia) {
      toast.error('Debes adjuntar la foto de la licencia');
      return;
    }
    try {
      setSubmitting(true);
      const rapidinDriverId = getStoredRapidinDriverId();
      const payload = {
        country: form.country,
        dni: form.dni.trim(),
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        license_number: form.license_number.trim() || undefined,
        description: form.description.trim() || undefined,
        apps: form.app_codes,
        ...(rapidinDriverId && { rapidin_driver_id: rapidinDriverId }),
      };
      const createRes = await api.post('/miauto/solicitudes', payload);
      const solicitud = createRes.data?.data ?? createRes.data;
      const id = solicitud?.id;
      if (!id) {
        toast.error('No se obtuvo el ID de la solicitud');
        return;
      }

      await uploadAdjunto(id, 'licencia', fileLicencia);
      if (fileComprobante) await uploadAdjunto(id, 'comprobante_viajes', fileComprobante);

      toast.success('Solicitud enviada correctamente');
      await fetchSolicitudes();
      setShowForm(false);
      setForm({
        country: form.country,
        dni: form.dni,
        phone: form.phone,
        email: '',
        license_number: '',
        description: '',
        app_codes: [],
      });
      setFileLicencia(null);
      setFileComprobante(null);
    } catch (err: unknown) {
      toast.error(apiErrMessage(err) || 'Error al enviar la solicitud');
    } finally {
      setSubmitting(false);
    }
  };

  const hasSolicitudes = solicitudes.length > 0;
  const solicitudesAprobadas = useMemo(
    () => solicitudes.filter((s) => s.status === 'aprobado'),
    [solicitudes],
  );
  const hasSolicitudActiva = solicitudes.some((s) =>
    ['pendiente', 'citado', 'aprobado'].includes(s.status)
  );
  const canCreateNew = !hasSolicitudActiva && !blockedByActiveInOtherFlota;
  const showFormBlock = (!hasSolicitudes || showForm) && canCreateNew;

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-[#8B1A1A] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
            <Car className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
              ¡Quiero mi Yego Auto!
            </h1>
            <p className="text-xs lg:text-sm text-white/90 mt-0.5">
              {hasSolicitudes ? 'Estado de tu solicitud' : 'Solicita tu auto para trabajar con Yego'}
            </p>
          </div>
        </div>
      </div>

      <div className="w-full space-y-4 lg:space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {showFormBlock ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-6 items-start">
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 lg:p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#8B1A1A]/10">
                  <ShieldCheck className="h-4 w-4 text-[#8B1A1A]" />
                </span>
                <h2 className="text-base font-bold text-gray-900">Requisitos</h2>
              </div>
              <ul className="space-y-3 text-sm">
                {REQUISITOS.map((text, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#8B1A1A]/10 mt-0.5">
                      <Check className="h-3 w-3 text-[#8B1A1A]" strokeWidth={2.5} />
                    </span>
                    <span className="text-gray-700 font-medium">{text}</span>
                  </li>
                ))}
              </ul>
            </div>

            <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 lg:p-6 space-y-5 flex flex-col">
                <h2 className="text-lg font-bold text-gray-900">Datos de la solicitud</h2>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="dni" className="block text-sm font-medium text-gray-700 mb-1.5">DNI / Documento</label>
                    <div className="relative">
                      <FileText className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                      <input
                        id="dni"
                        type="text"
                        value={form.dni}
                        onChange={setField('dni')}
                        placeholder="Nro. de documento"
                        className={`${INPUT_BASE} border-gray-300`}
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1.5">Celular</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                      <input
                        id="phone"
                        type="text"
                        value={form.phone}
                        onChange={setField('phone', 'celular')}
                        placeholder={form.country === 'CO' ? '+57 300 000 0000' : '+51 999 999 999'}
                        className={`${INPUT_BASE} ${fieldErrors.celular ? 'border-red-500' : 'border-gray-300'}`}
                      />
                    </div>
                    {fieldErrors.celular && <p className="mt-1 text-sm text-red-600">{fieldErrors.celular}</p>}
                  </div>
                  <div>
                    <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">Email</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                      <input
                        id="email"
                        type="email"
                        value={form.email}
                        onChange={setField('email', 'email')}
                        placeholder="Email"
                        className={`${INPUT_BASE} ${fieldErrors.email ? 'border-red-500' : 'border-gray-300'}`}
                      />
                    </div>
                    {fieldErrors.email && <p className="mt-1 text-sm text-red-600">{fieldErrors.email}</p>}
                  </div>
                  <div>
                    <label htmlFor="license_number" className="block text-sm font-medium text-gray-700 mb-1.5">Licencia</label>
                    <div className="relative">
                      <FileText className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                      <input
                        id="license_number"
                        type="text"
                        value={form.license_number}
                        onChange={setField('license_number')}
                        placeholder="Ingresa tu licencia"
                        className={`${INPUT_BASE} border-gray-300`}
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1.5">Descripción de tu licencia</label>
                  <div className="relative">
                    <FileText className="absolute left-3 top-3 h-4 w-4 text-gray-400 pointer-events-none" />
                    <textarea
                      id="description"
                      value={form.description}
                      onChange={setField('description')}
                      rows={2}
                      placeholder="Categoría, fecha de expiración..."
                      className={`${INPUT_BASE} border-gray-300 resize-y`}
                    />
                  </div>
                </div>

                <div className="w-full">
                  <span className="block text-sm font-medium text-gray-700 mb-3">Apps en las que trabajas</span>
                  <div className="flex flex-wrap gap-2 w-full justify-start">
                    {APPS_OPTIONS.map((app) => {
                      const selected = form.app_codes.includes(app.code);
                      return (
                        <button
                          key={app.code}
                          type="button"
                          onClick={() => handleAppToggle(app.code)}
                          className={`inline-flex items-center justify-center px-4 py-2 rounded-lg text-sm font-medium transition-colors border min-w-[5.5rem] ${
                            selected
                              ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]'
                              : 'bg-white border border-gray-300 text-gray-500 hover:bg-gray-50 hover:text-gray-700'
                          }`}
                        >
                          {app.name}
                        </button>
                      );
                    })}
                  </div>
                  {fieldErrors.apps && <p className="mt-2 text-sm text-red-600">{fieldErrors.apps}</p>}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Licencia de conducir</label>
                    <label className="flex flex-col items-center justify-center w-full min-h-[100px] border-2 border-dashed border-gray-300 rounded-lg bg-gray-50 hover:bg-gray-100 cursor-pointer transition-colors py-4 overflow-hidden">
                      <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => setFileLicencia(e.target.files?.[0] ?? null)} />
                      {previewLicencia ? (
                        <>
                          <img src={previewLicencia} alt="Vista previa licencia" className="max-h-20 w-auto object-contain rounded" />
                          <span className="text-xs text-[#8B1A1A] mt-1 truncate max-w-full px-2">{fileLicencia?.name}</span>
                        </>
                      ) : (
                        <>
                          <FileText className="w-6 h-6 text-gray-400 mb-1.5" />
                          <span className="text-sm text-gray-600">Seleccionar archivo</span>
                        </>
                      )}
                    </label>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Comprobante 350+ viajes (opcional)</label>
                    <label className="flex flex-col items-center justify-center w-full min-h-[100px] border-2 border-dashed border-gray-300 rounded-lg bg-gray-50 hover:bg-gray-100 cursor-pointer transition-colors py-4 overflow-hidden">
                      <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => setFileComprobante(e.target.files?.[0] ?? null)} />
                      {previewComprobante ? (
                        <>
                          <img src={previewComprobante} alt="Vista previa comprobante" className="max-h-20 w-auto object-contain rounded" />
                          <span className="text-xs text-[#8B1A1A] mt-1 truncate max-w-full px-2">{fileComprobante?.name}</span>
                        </>
                      ) : (
                        <>
                          <FileText className="w-6 h-6 text-gray-400 mb-1.5" />
                          <span className="text-sm text-gray-600">Seleccionar archivo</span>
                        </>
                      )}
                    </label>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 pt-2 mt-auto">
                  {hasSolicitudes && (
                    <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 font-medium">
                      Ver estado
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex items-center justify-center gap-2 w-full sm:flex-1 py-3 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] disabled:opacity-50 font-medium transition-colors shadow-sm"
                  >
                    <Check className="h-4 w-4" />
                    {submitting ? 'Enviando...' : 'Enviar solicitud'}
                  </button>
                </div>
              </form>
          </div>
        </>
      ) : blockedByActiveInOtherFlota ? (
        <div className="flex justify-center">
          <div className="w-full max-w-lg mx-auto bg-amber-50 border-2 border-amber-300 text-amber-900 px-5 py-4 rounded-xl text-center shadow-sm">
            <p className="font-medium text-sm leading-relaxed">{blockingMessage}</p>
          </div>
        </div>
      ) : (
        <>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="bg-white px-5 py-3.5 border-b border-gray-200 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex items-center gap-2.5">
              <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-[#8B1A1A] to-[#6B1515] text-white shadow-sm shrink-0">
                <FileText className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-gray-900 leading-tight">Estado de tu solicitud</h2>
                <p className="text-[11px] text-gray-500">{solicitudes.length} solicitud{solicitudes.length !== 1 ? 'es' : ''} registrada{solicitudes.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
              {canCreateNew && (
                <button
                  type="button"
                  onClick={() => setShowForm(true)}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-white bg-gradient-to-r from-[#8B1A1A] to-[#6B1515] hover:from-[#7B1818] hover:to-[#5B1010] px-3 py-1.5 rounded-lg whitespace-nowrap shadow-sm transition-colors"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Nueva solicitud
                </button>
              )}
            </div>
          </div>
          <div className="p-4 sm:p-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {solicitudes.map((s) => {
              const statusKey = (s.status || '').toLowerCase();
              const statusGradient =
                statusKey === 'aprobado' ? 'from-emerald-500 to-emerald-600' :
                statusKey === 'rechazado' ? 'from-red-500 to-red-600' :
                statusKey === 'citado' ? 'from-blue-500 to-blue-600' :
                statusKey === 'pendiente' ? 'from-amber-500 to-amber-600' :
                'from-gray-500 to-gray-600';
              const statusIcon =
                statusKey === 'aprobado' ? <CheckCircle2 className="w-3.5 h-3.5" /> :
                statusKey === 'rechazado' ? <X className="w-3.5 h-3.5" /> :
                statusKey === 'citado' ? <CalendarCheck className="w-3.5 h-3.5" /> :
                <Clock className="w-3.5 h-3.5" />;
              const reagendoCount = s.reagendo_count ?? 0;
              const reagendoCerca = reagendoCount >= MAX_REAGENDOS - 1;
              return (
                <div key={s.id} className="group relative overflow-hidden rounded-xl border border-gray-200 bg-gradient-to-br from-white to-gray-50/50 hover:shadow-lg hover:border-gray-300 transition-all">
                  <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${statusGradient}`} />
                  <div className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Solicitud creada</p>
                        <p className="text-sm font-bold text-gray-900 mt-0.5 flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5 text-gray-400" />
                          {formatDate(s.created_at)}
                        </p>
                      </div>
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-full text-white shadow-sm bg-gradient-to-r ${statusGradient}`}>
                        {statusIcon}
                        {STATUS_LABELS[s.status] || s.status}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100">
                      <div className="rounded-lg bg-blue-50/60 border border-blue-100 px-2.5 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-700/80 flex items-center gap-1">
                          <CalendarCheck className="w-3 h-3" />
                          Cita
                        </p>
                        <p className="text-xs font-medium text-gray-900 mt-0.5 truncate" title={s.appointment_date ? formatDateFlex(s.appointment_date, 'es-ES') : ''}>
                          {s.appointment_date
                            ? formatDateFlex(s.appointment_date, 'es-ES')
                            : statusKey === 'rechazado' ? <span className="text-red-600">No hubo</span> : <span className="text-gray-400">—</span>}
                        </p>
                      </div>
                      <div className={`rounded-lg border px-2.5 py-2 ${reagendoCerca && STATUS_WITH_REAGENDO_INFO.has(s.status) ? 'bg-amber-50/60 border-amber-200' : 'bg-gray-50 border-gray-100'}`}>
                        <p className={`text-[10px] font-semibold uppercase tracking-wide flex items-center gap-1 ${reagendoCerca && STATUS_WITH_REAGENDO_INFO.has(s.status) ? 'text-amber-700/80' : 'text-gray-500'}`}>
                          <Clock className="w-3 h-3" />
                          Reagendos
                        </p>
                        <p className="text-xs font-medium text-gray-900 mt-0.5">
                          {STATUS_WITH_REAGENDO_INFO.has(s.status) ? (
                            <span className={reagendoCerca ? 'text-amber-700 font-semibold' : ''}>
                              {reagendoCount} <span className="text-gray-400">/ {MAX_REAGENDOS}</span>
                            </span>
                          ) : <span className="text-gray-400">—</span>}
                        </p>
                      </div>
                    </div>

                    {(s.observations?.trim() || (statusKey === 'rechazado' && s.rejection_reason?.trim())) && (
                      <div className={`flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs leading-relaxed ${statusKey === 'rechazado' && s.rejection_reason?.trim() ? 'bg-red-50/60 border border-red-100 text-red-800' : 'bg-gray-50 border border-gray-100 text-gray-700'}`}>
                        <MessageSquare className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${statusKey === 'rechazado' && s.rejection_reason?.trim() ? 'text-red-500' : 'text-gray-400'}`} />
                        <span className="line-clamp-3">
                          {s.observations?.trim() || (s.rejection_reason ?? '').trim()}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {solicitudes.length === 0 && (
              <div className="col-span-full text-center py-8 text-sm text-gray-500">
                No hay solicitudes registradas.
              </div>
            )}
          </div>
        </div>

        {solicitudesAprobadas.map((s) => (
          <AprobadoBlock
            key={s.id}
            solicitud={s}
            expanded={aprobadoExpandedId === s.id}
            onToggle={() => setAprobadoExpandedId((id) => (id === s.id ? null : s.id))}
            onUploadComprobante={handleUploadComprobante}
            uploadLoading={uploadComprobanteLoading === s.id}
            getComprobanteUrl={getComprobanteUrl}
            onRefetchSolicitudes={fetchSolicitudes}
            tipoCambio={tipoCambioByCountry[s.country] ?? null}
            cuotasData={cuotasCache[s.id] ?? null}
            cuotasLoading={cuotasLoadingId === s.id}
            onInvalidateCuotas={invalidateCuotasCache}
          />
        ))}

        {solicitudes.some((s) => s.status === 'citado') && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
              <p className="text-sm text-amber-800 font-medium">
                Recuerda: puedes reprogramar tu cita hasta {MAX_REAGENDOS} veces. Si reprogramas más de {MAX_REAGENDOS} veces, tu solicitud será rechazada.
              </p>
            </div>
        )}
        </>
      )}
      </div>
    </div>
  );
}

export default QuieroMiYegoAuto;
