import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react';
import { createPortal } from 'react-dom';
import BottomSheet from '../../components/BottomSheet';
import MobilePagination from '../../components/MobilePagination';
import api from '../../services/api';
import { Car, FileText, Check, ShieldCheck, Phone, Mail, ChevronDown, ChevronRight, Upload, X, AlertCircle, ExternalLink, Sparkles, Zap, Eye } from 'lucide-react';
import { TablePaginationBar } from '../../components/TablePaginationBar';
import { useTablePagination } from '../../hooks/useTablePagination';
import {
  canonicalOtrosGastoType,
  labelOtrosGastoType,
  type ComprobanteOtrosGastos,
  type MiautoOtrosGastoRow,
} from '../../utils/miautoOtrosGastos';
import { getStoredSession, getStoredRapidinDriverId, getStoredSelectedParkId } from '../../utils/authStorage';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';
import { formatDate, formatDateTime } from '../../utils/date';
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

const MAX_REAGENDOS = 2;
const STATUS_LABEL_ACTIVE: Record<string, string> = { pendiente: 'Pendiente', citado: 'Cita agendada', aprobado: 'Aprobado' };

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

function esComprobanteAdminPago(cp: { origen?: string | null; estado?: string | null }): boolean {
  return origenComprobanteCuota(cp) === 'admin_confirmacion' && parseEstadoComprobante(cp.estado) === 'validado';
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
  otros_gastos?: MiautoOtrosGastoRow[];
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
  monto?: number | string | null;
  amount?: number | string | null;
  monto_declarado?: number | string | null;
  declared_amount?: number | string | null;
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

type MiautoPagoMoneda = 'PEN' | 'USD';

function normalizePagoMoneda(moneda?: string | null): MiautoPagoMoneda {
  return String(moneda || '').toUpperCase() === 'USD' ? 'USD' : 'PEN';
}

function montoComprobanteNumber(cp: ComprobanteCuotaSemanal): number | null {
  const raw = cp.monto ?? cp.monto_declarado ?? cp.declared_amount ?? cp.amount;
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function AprobadoBlock({
  solicitud,
  expanded,
  onToggle,
  onUploadComprobante,
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
  onUploadComprobante: (solicitudId: string, file: File, monto?: string, moneda?: string) => Promise<void>;
  getComprobanteUrl: (path: string | undefined) => string;
  onRefetchSolicitudes?: () => void;
  tipoCambio?: { valor_usd_a_local: number; moneda_local: string } | null;
  cuotasData?: { cuotas: CuotaSemanal[]; comprobantes: ComprobanteCuotaSemanal[]; racha: number | null; cuotas_semanales_bonificadas?: number; comprobantesOtrosGastos?: ComprobanteOtrosGastos[]; otrosGastos?: MiautoOtrosGastoRow[] } | null;
  cuotasLoading?: boolean;
  onInvalidateCuotas?: (solicitudId: string) => void;
}) {
  const [comprobantePreview, setComprobantePreview] = useState<{ url: string; fileName: string; isImage: boolean } | null>(null);
  const [cuotaSheet, setCuotaSheet] = useState<CuotaSemanal | null>(null);
  const [comprobantesInicialAbierto, setComprobantesInicialAbierto] = useState(false);
  const [fileInicialPreview, setFileInicialPreview] = useState<File | null>(null);
  const [montoInicialPago, setMontoInicialPago] = useState('');
  const [uploadInicialLoading, setUploadInicialLoading] = useState(false);
  const [cuotasDriverAbiertas, setCuotasDriverAbiertas] = useState(true);
  const [otrosGastosDriverAbiertos, setOtrosGastosDriverAbiertos] = useState(false);
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
  const [montoCuotaPago, setMontoCuotaPago] = useState<Record<string, string>>({});
  const [monedaCuotaPago, setMonedaCuotaPago] = useState<Record<string, MiautoPagoMoneda>>({});
  const [deleteCuotaComprobanteLoading, setDeleteCuotaComprobanteLoading] = useState<string | null>(null);
  const fileCuotaRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [ogSheet, setOgSheet] = useState<MiautoOtrosGastoRow | null>(null);
  const [ogTipoFilter, setOgTipoFilter] = useState<string | null>(null);
  const [uploadOgLoading, setUploadOgLoading] = useState<string | null>(null);
  const [fileOgPreview, setFileOgPreview] = useState<{ otrosGastosId: string; file: File } | null>(null);
  const [comprobantesOgAbierta, setComprobantesOgAbierta] = useState<Record<string, boolean>>({});
  const [montoOgPago, setMontoOgPago] = useState<Record<string, string>>({});
  const [monedaOgPorFila, setMonedaOgPorFila] = useState<Record<string, 'PEN' | 'USD'>>({});
  const fileOgRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const previewCuotaFile = useFilePreview(fileCuotaPreview?.file ?? null);
  const previewOgFile = useFilePreview(fileOgPreview?.file ?? null);
  const previewInicialFile = useFilePreview(fileInicialPreview);
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
    const monto = (montoCuotaPago[cuotaId] || '').trim().replace(',', '.');
    const monedaCuota = normalizePagoMoneda(cuota?.moneda);
    const moneda = monedaCuotaPago[cuotaId] ?? monedaCuota;
    const montoNum = Number(monto);
    if (!cuota) {
      toast.error('No se pudo obtener la cuota');
      return;
    }
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      toast.error('Indica cuánto estás pagando');
      return;
    }
    const pendienteCuota = round2(Math.max(0, miautoCuotaFinalCronogramaSemanal(cuota)));
    if (moneda === monedaCuota && montoNum > pendienteCuota + 0.01) {
      toast.error(`El monto no puede superar ${symMoneda(moneda)}${pendienteCuota.toFixed(2)}`);
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
      setMontoCuotaPago((prev) => {
        const next = { ...prev };
        delete next[cuotaId];
        return next;
      });
      setMonedaCuotaPago((prev) => {
        const next = { ...prev };
        delete next[cuotaId];
        return next;
      });
    } catch (e: unknown) {
      toast.error(apiErrMessage(e) || 'Error al subir comprobante');
    } finally {
      setUploadCuotaLoading(null);
      setFileCuotaPreview((prev) => (prev?.cuotaId === cuotaId ? null : prev));
    }
  };

  const handleDeleteComprobanteCuota = async (comprobanteId: string) => {
    setDeleteCuotaComprobanteLoading(comprobanteId);
    try {
      await api.delete(`/miauto/solicitudes/${solicitud.id}/comprobantes-cuota-semanal/${comprobanteId}`);
      toast.success('Comprobante eliminado');
      onInvalidateCuotas?.(solicitud.id);
      onRefetchSolicitudes?.();
    } catch (e: unknown) {
      toast.error(apiErrMessage(e) || 'Error al eliminar comprobante');
    } finally {
      setDeleteCuotaComprobanteLoading(null);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setFileInicialPreview(file);
      e.target.value = '';
    }
  };

  const handleSubmitComprobanteInicial = async () => {
    const monto = montoInicialPago.trim().replace(',', '.');
    const montoNum = Number(monto);
    if (!fileInicialPreview) {
      toast.error('Selecciona el comprobante');
      return;
    }
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      toast.error('Indica cuánto estás pagando');
      return;
    }
    if (falta > 0 && montoNum > falta + 0.01) {
      toast.error(`El monto no puede superar ${monedaSimbolo}${falta.toFixed(2)}`);
      return;
    }
    setUploadInicialLoading(true);
    try {
      await onUploadComprobante(solicitud.id, fileInicialPreview, monto, vehiculo?.inicial_moneda || 'PEN');
      setFileInicialPreview(null);
      setMontoInicialPago('');
      setComprobantesInicialAbierto(true);
    } finally {
      setUploadInicialLoading(false);
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
    const monto = (montoOgPago[otrosGastosId] || '').trim().replace(',', '.');
    const moneda = monedaOgPorFila[otrosGastosId] ?? monedaOtrosGastos;
    const montoNum = Number(monto);
    if (!og) {
      toast.error('No se pudo obtener el gasto');
      return;
    }
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      toast.error('Indica cuánto estás pagando');
      return;
    }
    const ogMoneda = normalizePagoMoneda((og as { moneda?: string | null }).moneda || monedaOtrosGastos);
    const saldoOg = round2(Math.max(0, Number((og as { amount_due: number }).amount_due) - Number((og as { paid_amount?: number }).paid_amount || 0)));
    if (moneda === ogMoneda && montoNum > saldoOg + 0.01) {
      toast.error(`El monto no puede superar ${symMoneda(moneda)}${saldoOg.toFixed(2)}`);
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
      setMontoOgPago((prev) => {
        const next = { ...prev };
        delete next[otrosGastosId];
        return next;
      });
      setMonedaOgPorFila((prev) => {
        const next = { ...prev };
        delete next[otrosGastosId];
        return next;
      });
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
  const otrosGastosTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const expense of otrosGastosRows) {
      const type = canonicalOtrosGastoType(expense.tipo);
      counts.set(type, (counts.get(type) || 0) + 1);
    }
    return Array.from(counts, ([type, count]) => ({ type, count }));
  }, [otrosGastosRows]);
  const filteredOgRows = useMemo(
    () => !ogTipoFilter
      ? otrosGastosRows
      : otrosGastosRows.filter((og) => canonicalOtrosGastoType(og.tipo) === ogTipoFilter),
    [otrosGastosRows, ogTipoFilter]
  );
  const otrosPg = useTablePagination(filteredOgRows);

  return (
    <>
    <div className="mt-3 bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50/70 transition-colors">
        <span className="min-w-0">
          <h3 className="text-lg font-bold text-gray-900">Tu auto asignado</h3>
          {cronograma?.name && <span className="text-[11px] font-medium text-gray-500">{cronograma.name}</span>}
        </span>
        {expanded ? <ChevronDown className="w-5 h-5 text-gray-500" /> : <ChevronRight className="w-5 h-5 text-gray-500" />}
      </button>
      {expanded && (
        <div className="p-3">
              <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                <div className="px-4 pt-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Unidad asignada</p>
                </div>
                <div className="px-4 pt-3">
                  <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-3">
                    <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Trazabilidad</p>
                    {(() => {
                      const statusLow = (solicitud.status || '').toLowerCase();
                      const steps: Array<{ id: string; label: string; sub?: string; state: 'done' | 'active' | 'pending' }> = [
                        {
                          id: 'solicitud',
                          label: 'Solicitud creada',
                          sub: solicitud.created_at ? formatDate(solicitud.created_at, 'es-ES') : undefined,
                          state: 'done',
                        },
                        {
                          id: 'aprobacion',
                          label: 'Aprobación',
                          sub: statusLow === 'aprobado' || statusLow === 'citado' ? 'Aprobada' : statusLow === 'rechazado' ? 'Rechazada' : 'Pendiente',
                          state: statusLow === 'aprobado' || statusLow === 'citado' ? 'done' : statusLow === 'rechazado' ? 'pending' : 'active',
                        },
                        {
                          id: 'inicial',
                          label: 'Cuota inicial',
                          sub: pagoInicialCompleto ? 'Completada' : cuotaInicial > 0 ? `${monedaSimbolo}${totalValidado.toFixed(2)} / ${monedaSimbolo}${cuotaInicial.toFixed(2)}` : 'Sin inicial',
                          state: pagoInicialCompleto ? 'done' : totalValidado > 0 ? 'active' : 'pending',
                        },
                        {
                          id: 'unidad',
                          label: 'Unidad asignada',
                          sub: solicitud.placa_asignada || vehiculo?.name || 'Pendiente',
                          state: vehiculo || solicitud.placa_asignada ? 'done' : 'pending',
                        },
                        {
                          id: 'entrega',
                          label: 'Inicio de cobro',
                          sub: solicitud.fecha_inicio_cobro_semanal ? 'Activo' : pagoInicialCompleto ? 'Por activar' : 'Pendiente',
                          state: solicitud.fecha_inicio_cobro_semanal ? 'done' : pagoInicialCompleto ? 'active' : 'pending',
                        },
                      ];
                      return (
                        <ol className="relative space-y-3">
                          {steps.map((step, idx) => {
                            const isLast = idx === steps.length - 1;
                            const dotClass =
                              step.state === 'done'
                                ? 'bg-[#8B1A1A] ring-4 ring-[#8B1A1A]/15'
                                : step.state === 'active'
                                  ? 'bg-white ring-2 ring-[#8B1A1A]'
                                  : 'bg-white ring-2 ring-gray-300';
                            const textClass = step.state === 'pending' ? 'text-gray-400' : 'text-gray-900';
                            return (
                              <li key={step.id} className="relative pl-7">
                                <span className={`absolute left-0 top-1 h-3 w-3 rounded-full ${dotClass}`} />
                                {!isLast && (
                                  <span className={`absolute left-[5px] top-4 bottom-[-12px] w-px ${step.state === 'done' ? 'bg-[#8B1A1A]/35' : 'bg-gray-200'}`} />
                                )}
                                <p className={`text-sm font-semibold leading-tight ${textClass}`}>{step.label}</p>
                                {step.sub && <p className="mt-0.5 text-[10px] uppercase tracking-wider text-gray-500">{step.sub}</p>}
                              </li>
                            );
                          })}
                        </ol>
                      );
                    })()}
                  </div>
                </div>
                <div className="px-4 pt-3">
                  <div className="relative w-full h-44 rounded-xl bg-gray-100 overflow-hidden flex items-center justify-center">
                    {vehiculo?.image ? (
                      <img
                        src={vehiculo.image.startsWith('data:') || vehiculo.image.startsWith('http') ? vehiculo.image : getComprobanteUrl(vehiculo.image)}
                        alt={vehiculo.name || 'Auto asignado'}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Car className="w-14 h-14 text-gray-400" />
                    )}
                  </div>
                </div>
                <div className="px-4 pt-3 pb-4 border-t border-gray-100 mt-3">
                  <h4 className="text-sm font-bold text-gray-900 leading-tight">
                    {vehiculo?.name ?? 'Sin asignar'}
                  </h4>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <p className="text-gray-500 uppercase tracking-wider">Placa</p>
                      <p className="font-bold text-gray-900 font-mono tracking-wider">{solicitud.placa_asignada || '—'}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-gray-500 uppercase tracking-wider">Plan</p>
                      <p className="font-bold text-gray-900">{cronograma?.name || (pagoTipoLabel || '—')}</p>
                    </div>
                  </div>
                </div>
                {cuotaInicial > 0 && (
                  <div className="px-4 pb-4">
                    <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Cuota inicial</p>
                          <p className="mt-1 text-base font-bold text-gray-900 tabular-nums">
                            {monedaSimbolo}{totalValidado.toFixed(2)}
                            <span className="font-normal text-gray-500"> / {monedaSimbolo}{cuotaInicial.toFixed(2)}</span>
                          </p>
                          {vehiculo?.inicial_moneda === 'USD' && tipoCambio?.valor_usd_a_local && (
                            <p className="mt-1 text-[10px] text-gray-500">
                              Equiv. {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'}{' '}
                              {(totalValidado * tipoCambio.valor_usd_a_local).toFixed(2)} / {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'}{' '}
                              {(cuotaInicial * tipoCambio.valor_usd_a_local).toFixed(2)}
                            </p>
                          )}
                        </div>
                        <span className={`rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${
                          pagoInicialCompleto ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                        }`}>
                          {pagoInicialCompleto ? 'Completada' : 'Pendiente'}
                        </span>
                      </div>
                      {!pagoInicialCompleto && falta > 0 && (
                        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <p className="min-w-0 text-xs font-semibold text-amber-900">
                              Falta {monedaSimbolo}{falta.toFixed(2)}
                            </p>
                            <button
                              type="button"
                              disabled={uploadInicialLoading}
                              onClick={() => fileInputRef.current?.click()}
                              className="shrink-0 rounded-md bg-white px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#8B1A1A] shadow-sm ring-1 ring-amber-200 hover:text-[#6B1515] disabled:opacity-50"
                            >
                              {fileInicialPreview ? 'Cambiar archivo' : 'Subir comprobante'}
                            </button>
                          </div>
                          {fileInicialPreview && (
                            <div className="mb-3 flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-2">
                              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-gray-200 bg-gray-50">
                                {previewInicialFile ? (
                                  <img src={previewInicialFile} alt="Vista previa" className="h-full w-full object-cover" />
                                ) : (
                                  <FileText className="h-5 w-5 text-gray-400" />
                                )}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-gray-900">{fileInicialPreview.name}</p>
                                <p className="text-[11px] text-gray-500">Comprobante seleccionado</p>
                              </div>
                              <button
                                type="button"
                                disabled={uploadInicialLoading}
                                onClick={() => setFileInicialPreview(null)}
                                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                                aria-label="Quitar comprobante"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          )}
                          <label className="block">
                            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-gray-500">
                              Cuánto envías ({monedaSimbolo})
                            </span>
                            <div className="flex items-center rounded-md border border-gray-200 bg-gray-50 focus-within:border-[#8B1A1A] focus-within:ring-1 focus-within:ring-[#8B1A1A]">
                              <span className="px-2 text-xs font-bold text-gray-500">{monedaSimbolo}</span>
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0.01"
                                step="0.01"
                                max={Math.max(0, falta).toFixed(2)}
                                value={montoInicialPago}
                                onChange={(e) => setMontoInicialPago(e.target.value)}
                                placeholder={Math.max(0, falta).toFixed(2)}
                                className="min-w-0 flex-1 bg-transparent py-1.5 pr-2 text-right text-xs font-semibold text-gray-900 outline-none placeholder:text-gray-400"
                              />
                            </div>
                          </label>
                          <button
                            type="button"
                            disabled={uploadInicialLoading || !fileInicialPreview || !montoInicialPago.trim()}
                            onClick={handleSubmitComprobanteInicial}
                            className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-[#8B1A1A] px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-[#6B1515] disabled:opacity-50"
                          >
                            {uploadInicialLoading ? 'Enviando...' : 'Enviar comprobante'}
                          </button>
                        </div>
                      )}
                      {pagoInicialCompleto && (
                        <button
                          type="button"
                          onClick={() => setComprobantesInicialAbierto((v) => !v)}
                          className="mt-3 inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-emerald-700 hover:text-emerald-900"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          {comprobantesInicialAbierto ? 'Ocultar' : 'Ver'} comprobantes ({comprobantes.length})
                        </button>
                      )}
                      {comprobantesInicialAbierto && (
                        <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
                          {comprobantes.length > 0 ? comprobantesSliderEl : (
                            <p className="text-sm text-gray-500">No hay comprobantes registrados.</p>
                          )}
                        </div>
                      )}
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
              </div>
        </div>
      )}
    </div>

            <div className="mt-3 space-y-3 min-w-0">
              <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <div className="border-b border-gray-100">
                  <button
                    type="button"
                    onClick={() => setCuotasDriverAbiertas((v) => !v)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50/70"
                  >
                    <div className="min-w-0">
                      <h4 className="text-lg font-bold text-gray-900">Cuotas</h4>
                      <p className="text-[11px] text-gray-500">Cronograma semanal</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {solicitud.fecha_inicio_cobro_semanal && cuotasSemanales.length > 0 && (() => {
                      const totalPagadoPorMoneda = cuotasSemanales.reduce<Record<string, number>>((acc, cuota) => {
                        const monedaCuota = monedaCuotasLabel(cuota.moneda || 'PEN');
                        acc[monedaCuota] = round2((acc[monedaCuota] || 0) + miautoMontoPagadoCuotaSemanal(cuota.paid_amount));
                        return acc;
                      }, {});
                      const totalPagadoCronograma = Object.entries(totalPagadoPorMoneda)
                        .filter(([, monto]) => monto > 0.005)
                        .sort(([a], [b]) => (a === b ? 0 : a === 'PEN' ? -1 : 1))
                        .map(([moneda, monto]) => `${symMoneda(moneda)}${round2(monto).toFixed(2)}`)
                        .join(' · ') || `${symMoneda(monedaCuotasLabel(cuotasSemanales[0]?.moneda || 'PEN'))}0.00`;
                      return (
                        <p className="text-right text-[11px] leading-tight text-gray-500 tabular-nums whitespace-nowrap shrink-0">
                          Total pagado
                          <span className="block text-sm font-bold text-emerald-700">{totalPagadoCronograma}</span>
                        </p>
                      );
                      })()}
                      {cuotasDriverAbiertas ? (
                        <ChevronDown className="h-5 w-5 text-gray-500" />
                      ) : (
                        <ChevronRight className="h-5 w-5 text-gray-500" />
                      )}
                    </div>
                  </button>
                </div>
          {solicitud.fecha_inicio_cobro_semanal && cuotasDriverAbiertas && !loadingCuotas && cuotasSemanales.length > 0 && (() => {
            const cuotasPagadas = cuotasSemanales.filter((c) => c.status === 'paid' || c.status === 'bonificada').length;
            const cuotasVencidas = cuotasSemanales.filter((c) => c.status === 'overdue').length;
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
              <div className="px-4 sm:px-5 py-2 border-b border-gray-100">
                <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs">
                  <span>
                    <span className="text-gray-400">Pagadas </span>
                    <span className="font-bold text-gray-900">{cuotasPagadas}</span>
                  </span>
                  <span className="hidden sm:inline text-gray-200">|</span>
                  <span>
                    <span className={cuotasVencidas > 0 ? 'text-red-500' : 'text-gray-400'}>Vencidas </span>
                    <span className={`font-bold ${cuotasVencidas > 0 ? 'text-red-600' : 'text-gray-900'}`}>{cuotasVencidas}</span>
                  </span>
                  <span className="hidden sm:inline text-gray-200">|</span>
                  <span>
                    <span className="text-gray-400">Total </span>
                    <span className="font-bold text-gray-900">{totalCuotasPlanVehiculoCronograma}</span>
                  </span>
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
          {solicitud.fecha_inicio_cobro_semanal && cuotasDriverAbiertas && (
            <div className="px-4 sm:px-5 py-3">
              {loadingCuotas ? (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-sm text-gray-500">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#8B1A1A] border-t-transparent" />
                  <span>Cargando cuotas...</span>
                </div>
              ) : cuotasSemanales.length === 0 ? (
                <p className="text-sm text-gray-500">Aún no hay cuotas semanales generadas.</p>
              ) : (
                <>
                {/* Vista móvil de cuotas — cards clickeables */}
                <div className="lg:hidden space-y-2">
                  {cuotasPg.paginatedItems.map((c, index) => {
                    const numeroSemana =
                      miautoSemanaLista(cuotasSemanales, c.week_start_date) ??
                      miautoSemanaOrdinalPorVencimiento(cuotasSemanales, c.due_date, c.week_start_date) ??
                      (cuotasPg.page - 1) * cuotasPg.limit + index + 1;
                    const cuotaFinalSemana = miautoCuotaFinalCronogramaSemanal(c);
                    const symCuota = symMoneda(c.moneda ?? solicitud?.cronograma_vehiculo?.inicial_moneda);

                    const statusConfig: Record<string, { label: string; bg: string; text: string }> = {
                      paid: { label: 'PAGADA', bg: 'bg-emerald-50', text: 'text-emerald-700' },
                      bonificada: { label: 'BONIFICADA', bg: 'bg-violet-50', text: 'text-violet-700' },
                      overdue: { label: 'VENCIDA', bg: 'bg-red-50', text: 'text-red-700' },
                      partial: { label: 'PARCIAL', bg: 'bg-blue-50', text: 'text-blue-700' },
                    };
                    const lowerStatus = (c.status || '').toLowerCase();
                    const sc = statusConfig[lowerStatus] ?? { label: 'PENDIENTE', bg: 'bg-amber-50', text: 'text-amber-700' };

                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setCuotaSheet(c)}
                        className="w-full text-left bg-white rounded-xl border border-gray-200 p-3 active:scale-[0.99] transition-transform"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-bold text-sm text-gray-900">Semana {numeroSemana}</p>
                            <p className="text-xs text-gray-500 mt-0.5">{formatDate(c.week_start_date, 'es-ES')}</p>
                          </div>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider ${sc.bg} ${sc.text}`}>
                            {sc.label}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-3 mt-3">
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Vence</p>
                            <p className="text-xs font-medium text-gray-900">{formatDate(c.due_date, 'es-ES')}</p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Cuota final</p>
                            <p className="text-xs font-bold text-gray-900">{miautoFmtMonto(symCuota, cuotaFinalSemana)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Pagado</p>
                            <p className="text-xs font-bold text-emerald-700">{miautoFmtMonto(symCuota, c.paid_amount)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Mora</p>
                            <p className="text-xs font-bold text-red-600">{miautoFmtMonto(symCuota, c.mora_pendiente ?? c.late_fee)}</p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="hidden lg:block overflow-x-auto -mx-1 px-1 sm:mx-0 sm:px-0 rounded-xl border border-gray-200 bg-white shadow-sm">
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
                        const tieneComprobantePendienteConductor = compsPanelConductor.some(
                          (cp) => origenComprobanteCuota(cp) === 'conductor' && parseEstadoComprobante(cp.estado) === 'pendiente'
                        );
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
                        const mostrarPanelUploadCuota = fileCuotaPreview?.cuotaId === c.id;
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
                                          disabled={uploadCuotaLoading === c.id || (fileCuotaPreview?.cuotaId === c.id) || tieneComprobantePendienteConductor}
                                          onClick={() => fileCuotaRefs.current[c.id]?.click()}
                                          title={tieneComprobantePendienteConductor ? 'Espera a que se apruebe o rechace tu comprobante' : undefined}
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
                                          disabled={uploadCuotaLoading === c.id || (fileCuotaPreview?.cuotaId === c.id) || tieneComprobantePendienteConductor}
                                          onClick={() => fileCuotaRefs.current[c.id]?.click()}
                                          title={tieneComprobantePendienteConductor ? 'Espera a que se apruebe o rechace tu comprobante' : undefined}
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
                            {mostrarPanelUploadCuota && fileCuotaPreview && (
                              <tr className="border-b border-gray-100">
                                <td colSpan={12} className="p-0 align-top">
                                  <div className="px-4 py-3 bg-amber-50/80 border-t border-amber-100">
                                    <div className="rounded-xl border border-amber-200 bg-white p-3 shadow-sm">
                                      <div className="mb-3 flex items-center gap-3">
                                        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
                                          {previewCuotaFile ? (
                                            <img src={previewCuotaFile} alt="Vista previa" className="h-full w-full object-cover" />
                                          ) : (
                                            <FileText className="h-5 w-5 text-gray-400" />
                                          )}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                          <p className="truncate text-sm font-semibold text-gray-900">{fileCuotaPreview.file.name}</p>
                                          <p className="text-xs text-gray-500">Semana {numeroSemana} · Pendiente {symCuota}{Math.max(0, cuotaFinalSemana).toFixed(2)}</p>
                                        </div>
                                        {previewCuotaFile && (
                                          <button
                                            type="button"
                                            onClick={() => setComprobantePreview({
                                              url: previewCuotaFile,
                                              fileName: fileCuotaPreview.file.name,
                                              isImage: true,
                                            })}
                                            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                                          >
                                            Ver
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          disabled={uploadCuotaLoading === c.id}
                                          onClick={() => setFileCuotaPreview((prev) => (prev?.cuotaId === c.id ? null : prev))}
                                          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                                          aria-label="Quitar archivo"
                                        >
                                          <X className="h-4 w-4" />
                                        </button>
                                      </div>
                                      {(() => {
                                        const monedaPago = monedaCuotaPago[c.id] ?? normalizePagoMoneda(c.moneda);
                                        const symPago = symMoneda(monedaPago);
                                        return (
                                      <label className="block">
                                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-gray-500">
                                          Cuánto pagas ({symPago})
                                        </span>
                                        <div className="grid grid-cols-[auto,1fr] rounded-md border border-gray-200 bg-gray-50 focus-within:border-[#8B1A1A] focus-within:ring-1 focus-within:ring-[#8B1A1A]">
                                          <select
                                            value={monedaPago}
                                            onChange={(e) => setMonedaCuotaPago((prev) => ({ ...prev, [c.id]: e.target.value as MiautoPagoMoneda }))}
                                            disabled={uploadCuotaLoading === c.id}
                                            className="border-r border-gray-200 bg-white px-2 text-xs font-bold text-gray-600 outline-none disabled:opacity-50"
                                            title="Moneda del comprobante"
                                          >
                                            <option value="PEN">S/.</option>
                                            <option value="USD">USD</option>
                                          </select>
                                          <input
                                            type="number"
                                            inputMode="decimal"
                                            min="0.01"
                                            step="0.01"
                                            max={monedaPago === normalizePagoMoneda(c.moneda) ? Math.max(0, cuotaFinalSemana).toFixed(2) : undefined}
                                            value={montoCuotaPago[c.id] ?? ''}
                                            onChange={(e) => setMontoCuotaPago((prev) => ({ ...prev, [c.id]: e.target.value }))}
                                            placeholder={Math.max(0, cuotaFinalSemana).toFixed(2)}
                                            className="min-w-0 flex-1 bg-transparent py-2 pr-2 text-right text-sm font-semibold text-gray-900 outline-none placeholder:text-gray-400"
                                          />
                                        </div>
                                      </label>
                                        );
                                      })()}
                                      <button
                                        type="button"
                                        disabled={uploadCuotaLoading === c.id || !(montoCuotaPago[c.id] || '').trim()}
                                        onClick={() => handleUploadComprobanteCuota(c.id, fileCuotaPreview.file)}
                                        className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-[#8B1A1A] px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-[#6B1515] disabled:opacity-50"
                                      >
                                        {uploadCuotaLoading === c.id ? 'Enviando...' : 'Enviar comprobante'}
                                      </button>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
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
                                            const montoComp = montoComprobanteNumber(cp);
                                            const compLabel = esPagoManual
                                            ? 'Pago registrado por administración'
                                            : `Comprobante ${compIdx + 1}`;
                                          const puedeEliminar = !esPagoManual && estado !== 'validado';
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
                                                          {montoComp != null ? `${symMontoComp} ${montoComp.toFixed(2)}` : 'Monto no registrado'}
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
                                              <div className="flex flex-wrap items-center gap-2">
                                                {puedeVer && (
                                                  <button
                                                    type="button"
                                                    onClick={openPreview}
                                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-colors ${verBtnClass}`}
                                                  >
                                                    <ExternalLink className="w-3.5 h-3.5" />
                                                    Ver archivo
                                                  </button>
                                                )}
                                                {puedeEliminar && (
                                                  <button
                                                    type="button"
                                                    disabled={deleteCuotaComprobanteLoading === cp.id}
                                                    onClick={() => handleDeleteComprobanteCuota(cp.id)}
                                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border-2 border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:opacity-50"
                                                  >
                                                    <X className="w-3.5 h-3.5" />
                                                    {deleteCuotaComprobanteLoading === cp.id ? 'Eliminando...' : 'Eliminar'}
                                                  </button>
                                                )}
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                      {(() => {
                                          const compsSinOficial = comps.filter((cp) => !esComprobanteAdminPago(cp));
                                          const verificado = compsSinOficial
                                            .filter((cp) => parseEstadoComprobante(cp.estado) === 'validado')
                                            .reduce((s, cp) => s + (montoComprobanteNumber(cp) ?? 0), 0);
                                          const totalEnv = compsSinOficial.reduce(
                                            (s, cp) => s + (montoComprobanteNumber(cp) ?? 0),
                                            0
                                          );
                                          const rechazado = compsSinOficial
                                            .filter((cp) => parseEstadoComprobante(cp.estado) === 'rechazado')
                                            .reduce((s, cp) => s + (montoComprobanteNumber(cp) ?? 0), 0);
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
                  <div className="hidden lg:block">
                    <TablePaginationBar
                      page={cuotasPg.page}
                      setPage={cuotasPg.setPage}
                      totalPages={cuotasPg.totalPages}
                      limit={cuotasPg.limit}
                      setLimit={cuotasPg.setLimit}
                      pageSizes={cuotasPg.pageSizes}
                    />
                  </div>
                )}
                <MobilePagination
                  page={cuotasPg.page}
                  setPage={cuotasPg.setPage}
                  totalPages={cuotasPg.totalPages}
                />
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
              </div>

              <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                {solicitud.fecha_inicio_cobro_semanal && (
                  <div className="border-b border-gray-100">
                    <button
                      type="button"
                      onClick={() => setOtrosGastosDriverAbiertos((v) => !v)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50/70"
                    >
                      <div className="min-w-0">
                        <h4 className="text-lg font-bold text-gray-900">Otros gastos</h4>
                        <p className="text-[11px] text-gray-500">GPS, SOAT, SRC y adicionales</p>
                      </div>
                      {otrosGastosDriverAbiertos ? (
                        <ChevronDown className="h-5 w-5 text-gray-500" />
                      ) : (
                        <ChevronRight className="h-5 w-5 text-gray-500" />
                      )}
                    </button>
                  </div>
                )}
          {solicitud.fecha_inicio_cobro_semanal && otrosGastosDriverAbiertos && (() => {
            const pendientesCount = filteredOgRows.filter((og) => og.status !== 'paid').length;
            const pagadasCount = filteredOgRows.filter((og) => og.status === 'paid').length;
            const totalsByCurrency = Object.values(filteredOgRows.reduce((acc, og) => {
              const currency = og.moneda || 'PEN';
              if (!acc[currency]) acc[currency] = { currency, paid: 0, balance: 0 };
              acc[currency].paid += Number(og.paid_amount || 0);
              acc[currency].balance += Math.max(0, Number(og.amount_due || 0) - Number(og.paid_amount || 0));
              return acc;
            }, {} as Record<string, { currency: string; paid: number; balance: number }>));
            return (
            <div className="px-4 sm:px-5 py-3">
              {loadingCuotas ? (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-sm text-gray-500">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#8B1A1A] border-t-transparent" />
                  <span>Cargando otros gastos...</span>
                </div>
              ) : filteredOgRows.length > 0 ? (
                <>
                <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs mb-4 px-1">
                  <span>
                    <span className="text-gray-400">Pagadas </span>
                    <span className="font-bold text-gray-900">{pagadasCount}</span>
                    <span className="text-gray-300"> / {pagadasCount + pendientesCount}</span>
                  </span>
                  {totalsByCurrency.map((total) => (
                    <span key={total.currency} className="inline-flex gap-3">
                      <span><span className="text-amber-500">Saldo </span><strong className="text-amber-700">{symMoneda(total.currency)} {total.balance.toFixed(2)}</strong></span>
                      <span><span className="text-gray-400">Pagado </span><strong className="text-emerald-700">{symMoneda(total.currency)} {total.paid.toFixed(2)}</strong></span>
                    </span>
                  ))}
                </div>
                {/* Filtros por tipo */}
                <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
                  <button
                    type="button"
                    onClick={() => setOgTipoFilter(null)}
                    className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${!ogTipoFilter ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]' : 'bg-white text-gray-600 border-gray-200'}`}
                  >
                    Todos ({otrosGastosRows.length})
                  </button>
                  {otrosGastosTypes.map(({ type, count }) => {
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setOgTipoFilter(ogTipoFilter === type ? null : type)}
                        className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${ogTipoFilter === type ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]' : 'bg-white text-gray-600 border-gray-200'}`}
                      >
                        {labelOtrosGastoType(type)} ({count})
                      </button>
                    );
                  })}
                </div>
                {/* Vista movil de otros gastos */}
                <div className="lg:hidden space-y-2">
                  {otrosPg.paginatedItems.map((og) => {
                    const ogStatusLow = (og.status || '').toLowerCase();
                    const badge = ogStatusLow === 'paid' ? { label: 'PAGADA', bg: 'bg-emerald-50', text: 'text-emerald-700' }
                      : ogStatusLow === 'overdue' ? { label: 'VENCIDA', bg: 'bg-red-50', text: 'text-red-700' }
                      : ogStatusLow === 'partial' ? { label: 'PARCIAL', bg: 'bg-blue-50', text: 'text-blue-700' }
                      : { label: 'PENDIENTE', bg: 'bg-amber-50', text: 'text-amber-700' };
                    return (
                      <button
                        key={og.id}
                        type="button"
                        onClick={() => setOgSheet(og)}
                        className="w-full text-left bg-white rounded-xl border border-gray-200 p-3 active:scale-[0.99] transition-transform"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-bold text-sm text-gray-900">Cuota {og.numero_cuota || og.week_index}{og.total_cuotas ? ` de ${og.total_cuotas}` : ''}</p>
                            <p className="text-[11px] text-gray-500 mt-0.5">
                              {labelOtrosGastoType(og.tipo)} {og.periodo_anio || String(og.due_date).slice(0, 4)} · {formatDate(og.due_date, 'es-ES')}
                            </p>
                          </div>
                          <span className={"px-2 py-0.5 rounded text-[10px] font-bold tracking-wider " + badge.bg + " " + badge.text}>
                            {badge.label}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mt-3">
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Monto</p>
                            <p className="text-xs font-bold text-gray-900">{symMoneda(og.moneda || 'PEN')} {Number(og.amount_due).toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Pagado</p>
                            <p className="text-xs font-bold text-emerald-700">{symMoneda(og.moneda || 'PEN')} {Number(og.paid_amount).toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Saldo</p>
                            <p className="text-xs font-bold text-red-600">{symMoneda(og.moneda || 'PEN')} {Math.max(0, Number(og.amount_due) - Number(og.paid_amount)).toFixed(2)}</p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Filtros por tipo - desktop */}
                <div className="hidden lg:flex gap-2 pb-3 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setOgTipoFilter(null)}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${!ogTipoFilter ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]' : 'bg-white text-gray-600 border-gray-200'}`}
                  >
                    Todos ({otrosGastosRows.length})
                  </button>
                  {otrosGastosTypes.map(({ type, count }) => {
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setOgTipoFilter(ogTipoFilter === type ? null : type)}
                        className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${ogTipoFilter === type ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]' : 'bg-white text-gray-600 border-gray-200'}`}
                      >
                        {labelOtrosGastoType(type)} ({count})
                      </button>
                    );
                  })}
                </div>
                <div className="hidden lg:block overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                  <table className="w-full text-sm border-collapse tabular-nums">
                    <thead>
                      <tr className="border-b-2 border-gray-200 bg-gradient-to-b from-gray-50 to-gray-100/60 text-gray-900">
                        <th className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wide align-bottom">Cuota</th>
                        <th className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wide align-bottom whitespace-nowrap">Tipo</th>
                        <th className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wide align-bottom whitespace-nowrap">Vence</th>
                        <th className="px-3 py-3 text-right text-xs font-bold uppercase tracking-wide align-bottom">Monto</th>
                        <th className="px-3 py-3 text-right text-xs font-bold uppercase tracking-wide align-bottom">Pagado</th>
                        <th className="px-3 py-3 text-center text-xs font-bold uppercase tracking-wide align-bottom whitespace-nowrap">Estado</th>
                        <th className="px-3 py-3 pr-4 text-right text-xs font-bold uppercase tracking-wide align-bottom">Comprobante</th>
                      </tr>
                    </thead>
                    <tbody>
                      {otrosPg.paginatedItems.map((og: MiautoOtrosGastoRow) => {
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
                                    <span className="font-semibold text-[#8B1A1A] leading-tight">{og.numero_cuota || og.week_index}/{og.total_cuotas || '—'}</span>
                                    {compsOg.length > 0 && (
                                      <span className="inline-flex flex-shrink-0 items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-700 ring-1 ring-gray-200">
                                        {compsOg.length}
                                      </span>
                                    )}
                                  </button>
                                ) : (
                                  <span className="font-semibold text-[#8B1A1A] leading-tight">{og.numero_cuota || og.week_index}/{og.total_cuotas || '—'}</span>
                                )}
                              </td>
                              <td className="px-3 py-3 align-top text-[13px] leading-tight font-medium text-gray-900">
                                {labelOtrosGastoType(og.tipo)} <span className="text-xs text-gray-500">{og.periodo_anio || String(og.due_date).slice(0, 4)}</span>
                              </td>
                              <td className={`px-3 py-3 align-top text-[13px] leading-tight whitespace-nowrap ${ogStatusLow === 'overdue' ? 'text-[#8B1A1A] font-bold uppercase tracking-wide' : 'text-gray-800'}`}>{formatDate(og.due_date, 'es-ES')}</td>
                              <td className="px-3 py-3 align-top text-right tabular-nums font-medium text-gray-900 text-[13px] leading-tight">
                                {symMoneda(og.moneda || 'PEN')} {Number(og.amount_due).toFixed(2)}
                              </td>
                              <td className="px-3 py-3 align-top text-right tabular-nums text-emerald-700 font-medium text-[13px] leading-tight">
                                {symMoneda(og.moneda || 'PEN')} {Number(og.paid_amount).toFixed(2)}
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
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {fileOgPreview?.otrosGastosId === og.id && (
                              <tr className="border-b border-gray-100">
                                <td colSpan={7} className="p-0 align-top">
                                  <div className="px-4 py-3 bg-amber-50/80 border-t border-amber-100">
                                    <div className="rounded-xl border border-amber-200 bg-white p-3 shadow-sm">
                                      <div className="mb-3 flex items-center gap-3">
                                        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
                                          {previewOgFile ? (
                                            <img src={previewOgFile} alt="Vista previa" className="h-full w-full object-cover" />
                                          ) : (
                                            <FileText className="h-5 w-5 text-gray-400" />
                                          )}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                          <p className="truncate text-sm font-semibold text-gray-900">{fileOgPreview.file.name}</p>
                                          <p className="text-xs text-gray-500">
                                            Cuota {og.numero_cuota || og.week_index} · Pendiente {symMoneda(og.moneda || 'PEN')} {Math.max(0, Number(og.amount_due) - Number(og.paid_amount || 0)).toFixed(2)}
                                          </p>
                                        </div>
                                        {previewOgFile && (
                                          <button
                                            type="button"
                                            onClick={() => setComprobantePreview({
                                              url: previewOgFile,
                                              fileName: fileOgPreview.file.name,
                                              isImage: true,
                                            })}
                                            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                                          >
                                            Ver
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          disabled={uploadOgLoading === og.id}
                                          onClick={() => setFileOgPreview((prev) => (prev?.otrosGastosId === og.id ? null : prev))}
                                          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                                          aria-label="Quitar archivo"
                                        >
                                          <X className="h-4 w-4" />
                                        </button>
                                      </div>
                                      {(() => {
                                        const monedaPago = monedaOgPorFila[og.id] ?? normalizePagoMoneda(og.moneda ?? monedaOtrosGastos);
                                        const symPago = symMoneda(monedaPago);
                                        const pendiente = Math.max(0, Number(og.amount_due) - Number(og.paid_amount || 0));
                                        return (
                                          <label className="block">
                                            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-gray-500">
                                              Cuánto pagas ({symPago})
                                            </span>
                                            <div className="grid grid-cols-[auto,1fr] rounded-md border border-gray-200 bg-gray-50 focus-within:border-[#8B1A1A] focus-within:ring-1 focus-within:ring-[#8B1A1A]">
                                              <select
                                                value={monedaPago}
                                                onChange={(e) => setMonedaOgPorFila((prev) => ({ ...prev, [og.id]: e.target.value as MiautoPagoMoneda }))}
                                                disabled={uploadOgLoading === og.id}
                                                className="border-r border-gray-200 bg-white px-2 text-xs font-bold text-gray-600 outline-none disabled:opacity-50"
                                                title="Moneda del comprobante"
                                              >
                                                <option value="PEN">S/.</option>
                                                <option value="USD">USD</option>
                                              </select>
                                              <input
                                                type="number"
                                                inputMode="decimal"
                                                min="0.01"
                                                step="0.01"
                                                max={monedaPago === normalizePagoMoneda(og.moneda ?? monedaOtrosGastos) ? pendiente.toFixed(2) : undefined}
                                                value={montoOgPago[og.id] ?? ''}
                                                onChange={(e) => setMontoOgPago((prev) => ({ ...prev, [og.id]: e.target.value }))}
                                                placeholder={pendiente.toFixed(2)}
                                                disabled={uploadOgLoading === og.id}
                                                className="min-w-0 flex-1 bg-transparent py-2 pr-2 text-right text-sm font-semibold text-gray-900 outline-none placeholder:text-gray-400 disabled:opacity-50"
                                              />
                                            </div>
                                          </label>
                                        );
                                      })()}
                                      <button
                                        type="button"
                                        disabled={uploadOgLoading === og.id || !(montoOgPago[og.id] || '').trim()}
                                        onClick={() => handleUploadComprobanteOtrosGastos(og.id, fileOgPreview.file)}
                                        className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-[#8B1A1A] px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-[#6B1515] disabled:opacity-50"
                                      >
                                        {uploadOgLoading === og.id ? 'Enviando...' : 'Enviar comprobante'}
                                      </button>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                            {mostrarPanelOg && (
                              <tr className="border-b border-gray-50">
                                <td colSpan={7} className="p-0 align-top">
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
                <div className="hidden lg:block">
                  <TablePaginationBar
                    page={otrosPg.page}
                    setPage={otrosPg.setPage}
                    totalPages={otrosPg.totalPages}
                    limit={otrosPg.limit}
                    setLimit={otrosPg.setLimit}
                    pageSizes={otrosPg.pageSizes}
                  />
                </div>
                <MobilePagination
                  page={otrosPg.page}
                  setPage={otrosPg.setPage}
                  totalPages={otrosPg.totalPages}
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

          {/* Bottom Sheet: Detalle de otro gasto */}
          {ogSheet && (
            <BottomSheet
              isOpen={!!ogSheet}
              onClose={() => setOgSheet(null)}
              title={`${labelOtrosGastoType(ogSheet.tipo)} · Cuota ${ogSheet.numero_cuota || ogSheet.week_index}`}
            >
              <div className="bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
                <div className="grid grid-cols-2 gap-0 text-sm">
                  {(() => {
                    const rows = [
                      ['Tipo', labelOtrosGastoType(ogSheet.tipo)],
                      ['Periodo', String(ogSheet.periodo_anio || String(ogSheet.due_date).slice(0, 4))],
                      ['Vencimiento', formatDate(ogSheet.due_date, 'es-ES')],
                      ['Monto', `${symMoneda(ogSheet.moneda || 'PEN')} ${Number(ogSheet.amount_due).toFixed(2)}`],
                      ['Pagado', `${symMoneda(ogSheet.moneda || 'PEN')} ${Number(ogSheet.paid_amount).toFixed(2)}`],
                      ['Saldo', `${symMoneda(ogSheet.moneda || 'PEN')} ${Math.max(0, Number(ogSheet.amount_due) - Number(ogSheet.paid_amount)).toFixed(2)}`],
                      ['Estado', ogSheet.status === 'paid' ? 'Pagada' : ogSheet.status === 'overdue' ? 'Vencida' : ogSheet.status === 'partial' ? 'Parcial' : 'Pendiente'],
                    ];
                    return rows.map(([label, val], idx) => {
                      const isRed = label === 'Saldo' && Number(ogSheet.amount_due) - Number(ogSheet.paid_amount) > 0;
                      const isGreen = label === 'Pagado' || (label === 'Estado' && ogSheet.status === 'paid');
                      const isBold = label === 'Saldo' || label === 'Monto';
                      return (
                        <Fragment key={idx}>
                          <div className="px-4 py-3 border-b border-gray-100">
                            <p className="text-gray-500 text-xs">{label}</p>
                          </div>
                          <div className={`px-4 py-3 border-b border-gray-100 text-right text-sm ${
                            isRed ? 'text-red-600 font-bold' : isGreen ? 'text-emerald-700 font-bold' : isBold ? 'text-gray-900 font-bold' : 'text-gray-900 font-medium'
                          }`}>
                            <p>{val}</p>
                          </div>
                        </Fragment>
                      );
                    });
                  })()}
                </div>
              </div>
              {(() => {
                const pendiente = Math.max(0, Number(ogSheet.amount_due) - Number(ogSheet.paid_amount || 0));
                const uploadActivo = fileOgPreview?.otrosGastosId === ogSheet.id ? fileOgPreview : null;
                const tienePendienteConductor = (comprobantesByOtrosGastosId[ogSheet.id] ?? []).some(
                  (cp) => parseEstadoComprobante(cp.estado) === 'pendiente'
                );
                if (pendiente <= 0.005 || tienePendienteConductor) return null;
                return (
                  <div className="mt-4">
                    <input
                      ref={(el) => { fileOgRefs.current[ogSheet.id] = el; }}
                      type="file"
                      accept=".pdf,image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setFileOgPreview({ otrosGastosId: ogSheet.id, file: f });
                        e.target.value = '';
                      }}
                    />
                    {!uploadActivo ? (
                      <button
                        type="button"
                        disabled={uploadOgLoading === ogSheet.id}
                        className="w-full bg-[#8B1A1A] hover:bg-[#6B1515] text-white font-bold py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
                        onClick={() => fileOgRefs.current[ogSheet.id]?.click()}
                      >
                        Pagar este gasto
                      </button>
                    ) : (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                        <div className="mb-3 flex items-center gap-3">
                          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-white">
                            {previewOgFile ? (
                              <img src={previewOgFile} alt="Vista previa" className="h-full w-full object-cover" />
                            ) : (
                              <FileText className="h-5 w-5 text-gray-400" />
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-gray-900">{uploadActivo.file.name}</p>
                            <p className="text-xs text-gray-500">Pendiente {symMoneda(ogSheet.moneda || 'PEN')} {pendiente.toFixed(2)}</p>
                          </div>
                          {previewOgFile && (
                            <button
                              type="button"
                              onClick={() => setComprobantePreview({
                                url: previewOgFile,
                                fileName: uploadActivo.file.name,
                                isImage: true,
                              })}
                              className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                            >
                              Ver
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={uploadOgLoading === ogSheet.id}
                            onClick={() => setFileOgPreview((prev) => (prev?.otrosGastosId === ogSheet.id ? null : prev))}
                            className="rounded-lg p-1.5 text-gray-400 hover:bg-white hover:text-gray-700 disabled:opacity-50"
                            aria-label="Quitar archivo"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        {(() => {
                          const monedaPago = monedaOgPorFila[ogSheet.id] ?? normalizePagoMoneda(ogSheet.moneda ?? monedaOtrosGastos);
                          const symPago = symMoneda(monedaPago);
                          return (
                            <label className="block">
                              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-gray-500">
                                Cuánto pagas ({symPago})
                              </span>
                              <div className="grid grid-cols-[auto,1fr] rounded-md border border-gray-200 bg-white focus-within:border-[#8B1A1A] focus-within:ring-1 focus-within:ring-[#8B1A1A]">
                                <select
                                  value={monedaPago}
                                  onChange={(e) => setMonedaOgPorFila((prev) => ({ ...prev, [ogSheet.id]: e.target.value as MiautoPagoMoneda }))}
                                  disabled={uploadOgLoading === ogSheet.id}
                                  className="border-r border-gray-200 bg-white px-2 text-xs font-bold text-gray-600 outline-none disabled:opacity-50"
                                  title="Moneda del comprobante"
                                >
                                  <option value="PEN">S/.</option>
                                  <option value="USD">USD</option>
                                </select>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min="0.01"
                                  step="0.01"
                                  max={monedaPago === normalizePagoMoneda(ogSheet.moneda ?? monedaOtrosGastos) ? pendiente.toFixed(2) : undefined}
                                  value={montoOgPago[ogSheet.id] ?? ''}
                                  onChange={(e) => setMontoOgPago((prev) => ({ ...prev, [ogSheet.id]: e.target.value }))}
                                  placeholder={pendiente.toFixed(2)}
                                  disabled={uploadOgLoading === ogSheet.id}
                                  className="min-w-0 flex-1 bg-transparent py-2 pr-2 text-right text-sm font-semibold text-gray-900 outline-none placeholder:text-gray-400 disabled:opacity-50"
                                />
                              </div>
                            </label>
                          );
                        })()}
                        <div className="mt-3 grid grid-cols-[auto,1fr] gap-2">
                          <button
                            type="button"
                            disabled={uploadOgLoading === ogSheet.id}
                            onClick={() => fileOgRefs.current[ogSheet.id]?.click()}
                            className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cambiar
                          </button>
                          <button
                            type="button"
                            disabled={uploadOgLoading === ogSheet.id || !(montoOgPago[ogSheet.id] || '').trim()}
                            onClick={() => handleUploadComprobanteOtrosGastos(ogSheet.id, uploadActivo.file)}
                            className="inline-flex items-center justify-center rounded-md bg-[#8B1A1A] px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-[#6B1515] disabled:opacity-50"
                          >
                            {uploadOgLoading === ogSheet.id ? 'Enviando...' : 'Enviar comprobante'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </BottomSheet>
          )}


          {/* Bottom Sheet: Detalle de cuota semanal */}
          {cuotaSheet && (
            <BottomSheet
              isOpen={!!cuotaSheet}
              onClose={() => setCuotaSheet(null)}
              title={(() => {
                const idxNum = cuotasSemanales.findIndex((x) => x.id === cuotaSheet.id);
                const semana = idxNum >= 0
                  ? (miautoSemanaLista(cuotasSemanales, cuotaSheet.week_start_date) ??
                     miautoSemanaOrdinalPorVencimiento(cuotasSemanales, cuotaSheet.due_date, cuotaSheet.week_start_date) ??
                     idxNum + 1)
                  : 1;
                return `Cuota N. ${semana} - Semana ${semana}`;
              })()}
            >
              <div className="bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
                <div className="grid grid-cols-2 gap-0 text-sm">
                  {(() => {
                    const symCuota = symMoneda(cuotaSheet.moneda ?? solicitud?.cronograma_vehiculo?.inicial_moneda);
                    const cuotaFinalSemana = miautoCuotaFinalCronogramaSemanal(cuotaSheet);
                    const cuotaCapitalPend = miautoCuotaCapitalPendienteColumna(cuotaSheet);
                    const montoPagado = miautoMontoPagadoColumnaCronograma(cuotaSheet);
                    const cobroSaldo = miautoCobroSaldoDisplay(cuotaSheet);
                    const tributo = miautoCobroPorIngresosTributoDisplay(cuotaSheet);
                    const mora = cuotaSheet.mora_pendiente ?? cuotaSheet.late_fee ?? 0;
                    const statusText =
                      cuotaSheet.status === 'paid' ? 'Pagada'
                      : cuotaSheet.status === 'bonificada' ? 'Bonificada'
                      : cuotaSheet.status === 'overdue' ? 'Vencida'
                      : cuotaSheet.status === 'partial' ? 'Parcial'
                      : 'Pendiente';
                    const rows = [
                      ['Vencimiento', formatDate(cuotaSheet.due_date, 'es-ES'), false, false],
                      ['Estado', statusText, false, false],
                      ['Cuota semanal', miautoFmtMonto(symCuota, cuotaSheet.cuota_semanal), false, false],
                      ['Viajes', `${cuotaSheet.num_viajes ?? '-'} viajes`, false, false],
                      ['Cobro ingresos', miautoFmtMonto(symCuota, tributo), false, false],
                      ['Cobro saldo', miautoFmtMonto(symCuota, cobroSaldo), false, false],
                      ['Cuota a pagar', miautoFmtMonto(symCuota, cuotaCapitalPend), true, false],
                      ['Mora', miautoFmtMonto(symCuota, mora), true, true],
                      ['Cuota final', miautoFmtMonto(symCuota, cuotaFinalSemana), false, false],
                      ['Pagado', miautoFmtMonto(symCuota, montoPagado), true, false],
                    ];
                    return rows.map(([label, val, bold, red], idx) => (
                      <Fragment key={idx}>
                        <div className="px-4 py-3 border-b border-gray-100">
                          <p className="text-gray-500 text-xs">{label}</p>
                        </div>
                        <div className={`px-4 py-3 border-b border-gray-100 text-right ${
                          red ? 'text-red-600 font-bold' : bold ? 'text-gray-900 font-bold' : val === 'Pagada' || val === 'Bonificada' ? 'text-emerald-700 font-bold' : val === 'Vencida' ? 'text-red-600 font-bold' : 'text-gray-900 font-medium'
                        }`}>
                          <p className="text-sm">{val}</p>
                        </div>
                      </Fragment>
                    ));
                  })()}
                </div>
              </div>
              {(() => {
                const comps = comprobantesByCuotaId[cuotaSheet.id] ?? [];
                const compsConductor = comps.filter((cp) => !esComprobanteAdminPago(cp));
                if (compsConductor.length === 0) return null;
                return (
                  <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3">
                    <p className="mb-3 text-sm font-bold text-gray-900">Tus comprobantes enviados</p>
                    <div className="space-y-2">
                      {compsConductor.map((cp, idx) => {
                        const estado = parseEstadoComprobante(cp.estado);
                        const puedeVer = !!cp.file_path && cp.file_path !== 'manual';
                          const url = puedeVer ? getComprobanteUrl(cp.file_path) : '';
                          const isImage = puedeVer && comprobanteArchivoEsImagen(cp.file_name, cp.file_path);
                          const symMonto = symMoneda(cp.moneda ?? cuotaSheet.moneda ?? solicitud?.cronograma_vehiculo?.inicial_moneda);
                          const montoComp = montoComprobanteNumber(cp);
                          const labelEstado =
                          estado === 'validado' ? 'Validado'
                          : estado === 'rechazado' ? 'Rechazado'
                          : 'Pendiente';
                          const estadoClass =
                            estado === 'validado' ? 'bg-emerald-100 text-emerald-800'
                            : estado === 'rechazado' ? 'bg-red-100 text-red-800'
                            : 'bg-amber-100 text-amber-800';
                          const puedeEliminar = cp.file_path !== 'manual' && estado !== 'validado';
                          return (
                          <div key={cp.id ?? idx} className="rounded-lg border border-gray-200 bg-gray-50 p-2.5">
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                disabled={!puedeVer}
                                onClick={() => puedeVer && setComprobantePreview({ url, fileName: cp.file_name || `Comprobante ${idx + 1}`, isImage: !!isImage })}
                                className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-white disabled:cursor-default"
                              >
                                {puedeVer && isImage ? (
                                  <img src={url} alt="" className="h-full w-full object-cover" />
                                ) : (
                                  <FileText className="h-5 w-5 text-gray-400" />
                                )}
                              </button>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${estadoClass}`}>
                                    {labelEstado}
                                      </span>
                                      <span className="text-xs font-bold text-gray-900">
                                        Monto enviado: {montoComp != null ? `${symMonto}${montoComp.toFixed(2)}` : 'no registrado'}
                                      </span>
                                </div>
                                <p className="mt-1 truncate text-xs text-gray-500">
                                  {cp.created_at ? formatDateTime(cp.created_at, 'es-ES') : (cp.file_name || `Comprobante ${idx + 1}`)}
                                </p>
                              </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  {puedeVer && (
                                    <button
                                      type="button"
                                      onClick={() => setComprobantePreview({ url, fileName: cp.file_name || `Comprobante ${idx + 1}`, isImage: !!isImage })}
                                      className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                                    >
                                      Ver
                                    </button>
                                  )}
                                  {puedeEliminar && (
                                    <button
                                      type="button"
                                      disabled={deleteCuotaComprobanteLoading === cp.id}
                                      onClick={() => handleDeleteComprobanteCuota(cp.id)}
                                      className="rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                                    >
                                      {deleteCuotaComprobanteLoading === cp.id ? '...' : 'Eliminar'}
                                    </button>
                                  )}
                                </div>
                              </div>
                            {estado === 'rechazado' && cp.rechazo_razon && (
                              <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{cp.rechazo_razon}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
              {(() => {
                  const cuotaFinalSemana = miautoCuotaFinalCronogramaSemanal(cuotaSheet);
                  const symCuota = symMoneda(cuotaSheet.moneda ?? solicitud?.cronograma_vehiculo?.inicial_moneda);
                  const pendiente = Math.max(0, cuotaFinalSemana);
                  const uploadActivo = fileCuotaPreview?.cuotaId === cuotaSheet.id ? fileCuotaPreview : null;
                  const tienePendienteConductor = (comprobantesByCuotaId[cuotaSheet.id] ?? []).some(
                    (cp) => !esComprobanteAdminPago(cp) && parseEstadoComprobante(cp.estado) === 'pendiente'
                  );
                  if (pendiente <= 0.005 || tienePendienteConductor) return null;
                return (
                  <div className="mt-4">
                    <input
                      ref={(el) => { fileCuotaRefs.current[cuotaSheet.id] = el; }}
                      type="file"
                      accept=".pdf,image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setFileCuotaPreview({ cuotaId: cuotaSheet.id, file: f });
                        e.target.value = '';
                      }}
                    />
                    {!uploadActivo ? (
                      <button
                        type="button"
                        disabled={uploadCuotaLoading === cuotaSheet.id}
                        className="w-full bg-[#8B1A1A] hover:bg-[#6B1515] text-white font-bold py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
                        onClick={() => fileCuotaRefs.current[cuotaSheet.id]?.click()}
                      >
                        Pagar esta cuota
                      </button>
                    ) : (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                        <div className="mb-3 flex items-center gap-3">
                          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-white">
                            {previewCuotaFile ? (
                              <img src={previewCuotaFile} alt="Vista previa" className="h-full w-full object-cover" />
                            ) : (
                              <FileText className="h-5 w-5 text-gray-400" />
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-gray-900">{uploadActivo.file.name}</p>
                            <p className="text-xs text-gray-500">Pendiente {symCuota}{pendiente.toFixed(2)}</p>
                          </div>
                          {previewCuotaFile && (
                            <button
                              type="button"
                              onClick={() => setComprobantePreview({
                                url: previewCuotaFile,
                                fileName: uploadActivo.file.name,
                                isImage: true,
                              })}
                              className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                            >
                              Ver
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={uploadCuotaLoading === cuotaSheet.id}
                            onClick={() => setFileCuotaPreview((prev) => (prev?.cuotaId === cuotaSheet.id ? null : prev))}
                            className="rounded-lg p-1.5 text-gray-400 hover:bg-white hover:text-gray-700 disabled:opacity-50"
                            aria-label="Quitar archivo"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        {(() => {
                          const monedaPago = monedaCuotaPago[cuotaSheet.id] ?? normalizePagoMoneda(cuotaSheet.moneda);
                          const symPago = symMoneda(monedaPago);
                          return (
                        <label className="block">
                          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-gray-500">
                            Cuánto pagas ({symPago})
                          </span>
                          <div className="grid grid-cols-[auto,1fr] rounded-md border border-gray-200 bg-white focus-within:border-[#8B1A1A] focus-within:ring-1 focus-within:ring-[#8B1A1A]">
                            <select
                              value={monedaPago}
                              onChange={(e) => setMonedaCuotaPago((prev) => ({ ...prev, [cuotaSheet.id]: e.target.value as MiautoPagoMoneda }))}
                              disabled={uploadCuotaLoading === cuotaSheet.id}
                              className="border-r border-gray-200 bg-white px-2 text-xs font-bold text-gray-600 outline-none disabled:opacity-50"
                              title="Moneda del comprobante"
                            >
                              <option value="PEN">S/.</option>
                              <option value="USD">USD</option>
                            </select>
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0.01"
                              step="0.01"
                              max={monedaPago === normalizePagoMoneda(cuotaSheet.moneda) ? pendiente.toFixed(2) : undefined}
                              value={montoCuotaPago[cuotaSheet.id] ?? ''}
                              onChange={(e) => setMontoCuotaPago((prev) => ({ ...prev, [cuotaSheet.id]: e.target.value }))}
                              placeholder={pendiente.toFixed(2)}
                              className="min-w-0 flex-1 bg-transparent py-2 pr-2 text-right text-sm font-semibold text-gray-900 outline-none placeholder:text-gray-400"
                            />
                          </div>
                        </label>
                          );
                        })()}
                        <div className="mt-3 grid grid-cols-[auto,1fr] gap-2">
                          <button
                            type="button"
                            disabled={uploadCuotaLoading === cuotaSheet.id}
                            onClick={() => fileCuotaRefs.current[cuotaSheet.id]?.click()}
                            className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cambiar
                          </button>
                          <button
                            type="button"
                            disabled={uploadCuotaLoading === cuotaSheet.id || !(montoCuotaPago[cuotaSheet.id] || '').trim()}
                            onClick={() => handleUploadComprobanteCuota(cuotaSheet.id, uploadActivo.file)}
                            className="inline-flex items-center justify-center rounded-md bg-[#8B1A1A] px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-[#6B1515] disabled:opacity-50"
                          >
                            {uploadCuotaLoading === cuotaSheet.id ? 'Enviando...' : 'Enviar comprobante'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </BottomSheet>
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
        </>
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
  const [, setUploadComprobanteLoading] = useState<string | null>(null);
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

  const handleUploadComprobante = async (solicitudId: string, file: File, monto?: string, moneda?: string) => {
    try {
      setUploadComprobanteLoading(solicitudId);
      const fd = new FormData();
      fd.append('file', file);
      if (monto != null && monto.trim() !== '') fd.append('monto', monto.trim());
      if (moneda != null && moneda.trim() !== '') fd.append('moneda', moneda.trim());
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
  useEffect(() => {
    const pendientes = solicitudesAprobadas
      .filter((s) => s.fecha_inicio_cobro_semanal && !cuotasCache[s.id])
      .map((s) => s.id);
    if (pendientes.length === 0) return;
    pendientes.forEach((id) => {
      void fetchCuotasForSolicitud(id);
    });
  }, [solicitudesAprobadas, cuotasCache, fetchCuotasForSolicitud]);
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
              {hasSolicitudes ? 'Gestiona tu auto' : 'Solicita tu auto para trabajar con Yego'}
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
                      Ver mi auto
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
        {canCreateNew && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-white bg-gradient-to-r from-[#8B1A1A] to-[#6B1515] hover:from-[#7B1818] hover:to-[#5B1010] px-3 py-2 rounded-lg whitespace-nowrap shadow-sm transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Nueva solicitud
            </button>
          </div>
        )}

        {solicitudesAprobadas.map((s) => (
          <AprobadoBlock
            key={s.id}
            solicitud={s}
            expanded={aprobadoExpandedId === s.id}
            onToggle={() => setAprobadoExpandedId((id) => (id === s.id ? null : s.id))}
            onUploadComprobante={handleUploadComprobante}
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
