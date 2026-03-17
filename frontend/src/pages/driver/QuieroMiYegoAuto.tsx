import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react';
import { createPortal } from 'react-dom';
import api from '../../services/api';
import { Car, FileText, Check, ShieldCheck, Phone, Mail, ChevronDown, ChevronRight, ChevronUp, Upload, XCircle, X, Info, CreditCard, AlertCircle, ChevronLeft, ChevronsLeft, ChevronsRight, ExternalLink } from 'lucide-react';
import { getStoredSession, getStoredRapidinDriverId, getStoredSelectedParkId } from '../../utils/authStorage';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';
import { formatDate, formatDateFlex, formatDateTime } from '../../utils/date';

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
  desistido: 'Desistido',
  aprobado: 'Aprobado',
};

const STATUS_CLASS: Record<string, string> = {
  pendiente: 'bg-amber-100 text-amber-800',
  citado: 'bg-blue-100 text-blue-800',
  rechazado: 'bg-red-100 text-red-800',
  desistido: 'bg-gray-100 text-gray-700',
  aprobado: 'bg-green-100 text-green-800',
};

const MAX_REAGENDOS = 2;
const STATUS_LABEL_ACTIVE: Record<string, string> = { pendiente: 'Pendiente', citado: 'Cita agendada', aprobado: 'Aprobado' };
const PAGE_SIZES_CUOTAS = [5, 10, 20, 50];

const INPUT_BASE =
  'w-full pl-9 pr-3 py-2.5 border rounded-lg bg-white text-gray-900 placeholder:text-gray-400 focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A]';

async function uploadAdjunto(solicitudId: number, tipo: string, file: File): Promise<void> {
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
  cited_at?: string | null;
  appointment_date?: string | null;
  reagendo_count?: number;
  reviewed_at?: string | null;
  withdrawn_at?: string | null;
  withdrawal_reason?: string | null;
  observations?: string | null;
  citas_historial?: { id: string; tipo: string; appointment_date: string; created_at: string; resultado?: string }[];
  created_at: string;
  apps?: { code: string; name?: string }[];
  cronograma_id?: string | null;
  cronograma_vehiculo_id?: string | null;
  pago_tipo?: 'completo' | 'parcial' | null;
  pago_estado?: 'pendiente' | 'completo' | null;
  cronograma?: { id: string; name: string; tasa_interes_mora?: number } | null;
  cronograma_vehiculo?: { id: string; name: string; inicial: number; inicial_moneda: string; cuotas_semanales: number; image?: string } | null;
  comprobantes_pago?: { id: string; file_name: string; file_path: string; monto?: number; created_at: string; estado?: 'pendiente' | 'validado' | 'rechazado'; validado?: boolean; rechazado?: boolean; rechazo_razon?: string | null }[];
  fecha_inicio_cobro_semanal?: string | null;
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
  late_fee: number;
  status: string;
  pending_total: number;
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
  cuotasData?: { cuotas: CuotaSemanal[]; comprobantes: ComprobanteCuotaSemanal[]; racha: number | null; cuotas_semanales_bonificadas?: number } | null;
  cuotasLoading?: boolean;
  onInvalidateCuotas?: (solicitudId: string) => void;
}) {
  const [montoOpt, setMontoOpt] = useState('');
  const [comprobantePreview, setComprobantePreview] = useState<{ url: string; fileName: string; isImage: boolean } | null>(null);
  const [comprobantesInicialAbierto, setComprobantesInicialAbierto] = useState(false);
  const [tabActiva, setTabActiva] = useState<'informacion' | 'cronogramas-pagos'>('informacion');
  const comprobantesSliderRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cuotasSemanales = cuotasData?.cuotas ?? [];
  const rachaFromBackend = cuotasData?.racha ?? null;
  const bonoAplicado = cuotasData?.cuotas_semanales_bonificadas ?? 0;
  const loadingCuotas = cuotasLoading ?? false;
  const comprobantesCuotaSemanal = cuotasData?.comprobantes ?? [];
  const [historialAbiertoPorCuota, setHistorialAbiertoPorCuota] = useState<string | null>(null);
  const [uploadCuotaLoading, setUploadCuotaLoading] = useState<string | null>(null);
  const [cuotaMoneda, setCuotaMoneda] = useState<Record<string, string>>({});
  const [fileParaSubir, setFileParaSubir] = useState<File | null>(null);
  const [fileCuotaPreview, setFileCuotaPreview] = useState<{ cuotaId: string; file: File } | null>(null);
  const fileCuotaRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [cuotasPage, setCuotasPage] = useState(1);
  const [cuotasLimit, setCuotasLimit] = useState(10);
  const previewInicial = useFilePreview(fileParaSubir);
  const previewCuotaFile = useFilePreview(fileCuotaPreview?.file ?? null);
  const cronograma = solicitud.cronograma;
  const vehiculo = solicitud.cronograma_vehiculo;
  const getEstado = (cp: { estado?: string; validado?: boolean; rechazado?: boolean }): 'pendiente' | 'validado' | 'rechazado' => {
    const e = (cp.estado || '').toLowerCase();
    if (e === 'validado' || e === 'rechazado') return e;
    return cp.rechazado ? 'rechazado' : cp.validado ? 'validado' : 'pendiente';
  };
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const comprobantes = solicitud.comprobantes_pago ?? [];
  const pagoTipoLabel = solicitud.pago_tipo === 'parcial' ? 'Pago parcial' : solicitud.pago_tipo === 'completo' ? 'Pago completo' : null;
  const cuotaInicial = round2(vehiculo?.inicial != null ? Number(vehiculo.inicial) : 0);
  const totalValidado = round2(
    comprobantes
      .filter((cp) => getEstado(cp) === 'validado' && cp.monto != null)
      .reduce((sum: number, cp: { monto?: number }) => sum + Number(cp.monto), 0)
  );
  const falta = Math.max(0, round2(cuotaInicial - totalValidado));
  const progreso = cuotaInicial > 0 ? Math.min(100, (totalValidado / cuotaInicial) * 100) : 0;
  // Si la cuota inicial está pagada/completa, no se muestra "Subir comprobante" ni barra de progreso.
  // Backend puede enviar pago_estado === 'completo'; si no lo envía, inferimos por comprobantes validados >= cuota inicial.
  const pagoInicialCompleto =
    String(solicitud.pago_estado ?? '').toLowerCase() === 'completo' ||
    (cuotaInicial > 0 && totalValidado >= cuotaInicial);
  const monedaSimbolo = vehiculo?.inicial_moneda === 'PEN' ? 'S/.' : '$';

  const comprobantesSliderEl = (
    <div className="relative">
      <div
        ref={comprobantesSliderRef}
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
    const monto = cuota ? String((cuota.amount_due + (cuota.late_fee ?? 0)).toFixed(2)) : '';
    const moneda = (cuotaMoneda[cuotaId] || 'PEN').toUpperCase() === 'PEN' ? 'PEN' : 'USD';
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
      setHistorialAbiertoPorCuota(cuotaId);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al subir comprobante');
    } finally {
      setUploadCuotaLoading(null);
      setFileCuotaPreview((prev) => (prev?.cuotaId === cuotaId ? null : prev));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setFileParaSubir(file);
      onUploadComprobante(solicitud.id, file, montoOpt || undefined);
      e.target.value = '';
    }
  };

  useEffect(() => {
    if (!uploadLoading) setFileParaSubir(null);
  }, [uploadLoading]);

  const comprobantesByCuotaId = useMemo(() => {
    const m: Record<string, ComprobanteCuotaSemanal[]> = {};
    for (const c of comprobantesCuotaSemanal) {
      const id = c.cuota_semanal_id;
      if (!m[id]) m[id] = [];
      m[id].push(c);
    }
    return m;
  }, [comprobantesCuotaSemanal]);

  const totalCuotasPages = Math.max(1, Math.ceil(cuotasSemanales.length / cuotasLimit));
  const paginatedCuotas = useMemo(() => {
    const start = (cuotasPage - 1) * cuotasLimit;
    return cuotasSemanales.slice(start, start + cuotasLimit);
  }, [cuotasSemanales, cuotasPage, cuotasLimit]);

  useEffect(() => {
    if (totalCuotasPages > 0 && cuotasPage > totalCuotasPages) setCuotasPage(totalCuotasPages);
  }, [totalCuotasPages, cuotasPage]);

  const getEstadoComp = (cp: ComprobanteCuotaSemanal): 'pendiente' | 'validado' | 'rechazado' => {
    const e = (cp.estado || '').toLowerCase();
    if (e === 'validado' || e === 'rechazado') return e;
    return 'pendiente';
  };

  return (
    <div className="mt-4 bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full px-4 py-3 border-b border-gray-200 flex items-center justify-between text-left hover:bg-gray-50">
        <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <Car className="w-5 h-5 text-[#8B1A1A]" />
          Tu auto asignado {cronograma?.name ? `· ${cronograma.name}` : ''}
        </h3>
        {expanded ? <ChevronDown className="w-5 h-5 text-gray-500" /> : <ChevronRight className="w-5 h-5 text-gray-500" />}
      </button>
      {expanded && (
        <div className="p-4 space-y-4">
          <div className="flex border-b border-gray-200 -mb-1">
            <button
              type="button"
              onClick={() => setTabActiva('informacion')}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tabActiva === 'informacion' ? 'border-[#8B1A1A] text-[#8B1A1A]' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Info className="w-4 h-4" />
              Información
            </button>
            <button
              type="button"
              onClick={() => setTabActiva('cronogramas-pagos')}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tabActiva === 'cronogramas-pagos' ? 'border-[#8B1A1A] text-[#8B1A1A]' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <CreditCard className="w-4 h-4" />
              Cronogramas y pagos
            </button>
          </div>

          {tabActiva === 'informacion' && (
            <div className="space-y-4">
          {vehiculo ? (
            <div className="p-4 rounded-xl border-2 border-gray-200 bg-gray-50/50 flex flex-col sm:flex-row gap-4">
              {vehiculo.image && (
                <div className="flex-shrink-0 w-full sm:w-40 h-40 sm:h-32 rounded-lg overflow-hidden bg-gray-200">
                  <img
                    src={vehiculo.image.startsWith('data:') || vehiculo.image.startsWith('http') ? vehiculo.image : getComprobanteUrl(vehiculo.image)}
                    alt={vehiculo.name || 'Carro asignado'}
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h4 className="font-semibold text-gray-900">{vehiculo.name}</h4>
                <p className="text-sm text-gray-600 mt-1">
                  Cuota inicial: {vehiculo.inicial_moneda === 'PEN' ? 'S/.' : '$'} {Number(vehiculo.inicial).toFixed(2)} · {vehiculo.cuotas_semanales} cuotas/semana
                </p>
                {vehiculo.inicial_moneda === 'USD' && tipoCambio?.valor_usd_a_local && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    Equiv. {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'} {(Number(vehiculo.inicial) * tipoCambio.valor_usd_a_local).toFixed(2)} (tipo de cambio actual)
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">Aún no se ha asignado cronograma ni carro.</p>
          )}
          {pagoTipoLabel && (
            <p className="text-sm text-gray-700">
              <span className="font-medium">Tipo de pago:</span> {pagoTipoLabel}
            </p>
          )}
          {cuotaInicial > 0 && !pagoInicialCompleto && (
            <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4">
              <p className="text-xs font-medium text-gray-600 mb-1">Cuota inicial</p>
              <div className="flex flex-col gap-0.5 text-sm mb-2">
                <span className="text-gray-700">
                  Validado: <span className="font-semibold text-green-700">{monedaSimbolo} {totalValidado.toFixed(2)}</span>
                  {' '}/ {monedaSimbolo} {cuotaInicial.toFixed(2)}
                </span>
                {vehiculo?.inicial_moneda === 'USD' && tipoCambio?.valor_usd_a_local && (
                  <span className="text-xs text-gray-500">
                    {tipoCambio.moneda_local === 'COP' ? 'Equiv. en pesos (Colombia):' : 'Equiv. en soles (Perú):'}{' '}
                    {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'} {(totalValidado * tipoCambio.valor_usd_a_local).toFixed(2)} / {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'} {(cuotaInicial * tipoCambio.valor_usd_a_local).toFixed(2)}
                  </span>
                )}
              </div>
              <div className="h-2.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#8B1A1A] rounded-full transition-all duration-300"
                  style={{ width: `${progreso}%` }}
                />
              </div>
              {falta > 0 ? (
                <p className="text-sm text-amber-700 font-medium mt-2">
                  Te falta: {monedaSimbolo} {falta.toFixed(2)}
                  {vehiculo?.inicial_moneda === 'USD' && tipoCambio?.valor_usd_a_local && (
                    <span className="block text-xs font-normal text-amber-600 mt-0.5">
                      {tipoCambio.moneda_local === 'COP' ? 'Equiv. en pesos (Colombia):' : 'Equiv. en soles (Perú):'}{' '}
                      {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'} {(falta * tipoCambio.valor_usd_a_local).toFixed(2)}
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-green-700 font-medium mt-2">Cuota inicial cubierta</p>
              )}
            </div>
          )}
          {cuotaInicial > 0 && !pagoInicialCompleto && (
            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-2">Subir comprobante de pago (cuota inicial)</h4>
              <div className="flex flex-wrap items-end gap-3">
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".pdf,image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <input
                  type="text"
                  placeholder="Monto (opcional)"
                  value={montoOpt}
                  onChange={(e) => setMontoOpt(e.target.value)}
                  className="w-32 px-3 py-2 border rounded-lg text-sm"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadLoading}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] text-sm font-medium disabled:opacity-50"
                >
                  <Upload className="w-4 h-4" />
                  {uploadLoading ? 'Subiendo...' : 'Elegir archivo'}
                </button>
                {(fileParaSubir || uploadLoading) && (
                  <div className="flex items-center gap-2 border border-gray-200 rounded-lg p-2 bg-gray-50">
                    {previewInicial ? (
                      <img src={previewInicial} alt="Vista previa" className="w-16 h-16 object-cover rounded border border-gray-200" />
                    ) : fileParaSubir ? (
                      <div className="w-16 h-16 rounded border border-gray-200 bg-white flex items-center justify-center">
                        <FileText className="w-8 h-8 text-gray-400" />
                      </div>
                    ) : null}
                    <div className="text-xs text-gray-700">
                      {fileParaSubir && <span className="block font-medium truncate max-w-[140px]" title={fileParaSubir.name}>{fileParaSubir.name}</span>}
                      {uploadLoading && <span className="text-amber-600">Subiendo...</span>}
                    </div>
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1">Puedes subir varios comprobantes si tu pago es parcial.</p>
            </div>
          )}
          {cuotaInicial > 0 && pagoInicialCompleto && (
            <div className="space-y-2">
              <p className="text-sm text-green-700 font-medium">
                Pago completado · Total pagado: {monedaSimbolo} {totalValidado.toFixed(2)}
              </p>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => setComprobantesInicialAbierto((v) => !v)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left bg-gray-50 hover:bg-gray-100"
                >
                  <span className="text-sm font-semibold text-gray-900">
                    Ver comprobantes de la cuota inicial {comprobantes.length > 0 && `(${comprobantes.length})`}
                  </span>
                  {comprobantesInicialAbierto ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                </button>
              {comprobantesInicialAbierto && (
                <div className="p-4 pt-0 border-t border-gray-200">
                  {comprobantes.length > 0 ? comprobantesSliderEl : (
                    <p className="text-sm text-gray-500">No hay comprobantes registrados.</p>
                  )}
                </div>
              )}
              </div>
            </div>
          )}
          {cuotaInicial > 0 && !pagoInicialCompleto && (
            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-2">Comprobantes subidos</h4>
              {comprobantes.length > 0 ? comprobantesSliderEl : (
                <p className="text-sm text-gray-500">Aún no hay comprobantes.</p>
              )}
            </div>
          )}
            </div>
          )}

          {tabActiva === 'cronogramas-pagos' && (
            <div className="space-y-4">
          {solicitud.fecha_inicio_cobro_semanal && !loadingCuotas && cuotasSemanales.length > 0 && (() => {
            const cuotasPagadas = cuotasSemanales.filter((c) => c.status === 'paid' || c.status === 'bonificada').length;
            const vencidas = cuotasSemanales.filter((c) => c.status === 'overdue').length;
            const totalPagado = round2(cuotasSemanales.reduce((s, c) => s + (c.paid_amount ?? 0), 0));
            const planTotal = Math.max(vehiculo?.cuotas_semanales ?? 0, cuotasSemanales.length) || cuotasSemanales.length;
            const racha = rachaFromBackend ?? (() => {
              const tieneVencida = cuotasSemanales.some((c) => (c.status || '').toLowerCase() === 'overdue');
              if (tieneVencida) return 0;
              const ordenadas = [...cuotasSemanales].sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
              let n = 0;
              for (const c of ordenadas) {
                if ((c.status === 'paid' || c.status === 'bonificada') && (c.late_fee ?? 0) === 0) n++;
                else break;
              }
              return n;
            })();
            return (
              <div className="rounded-xl border border-gray-200 bg-gray-50/80 p-4 space-y-3">
                <h4 className="text-sm font-semibold text-gray-900">Resumen de tus cuotas</h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-gray-500">Cuotas pagadas</p>
                    <p className="font-bold text-gray-900">{cuotasPagadas} <span className="font-normal text-gray-600">/ {planTotal}</span></p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Racha (cuotas seguidas al día)</p>
                    <p className="font-bold text-green-700">
                      {racha}
                      {racha === 3 && <span className="text-xs font-normal text-amber-700"> (¡beneficio cerca! 1 más)</span>}
                      {racha >= 4 && <span className="text-xs font-normal text-green-700"> (¡condición cumplida!)</span>}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Bono tiempo aplicado</p>
                    <p className="font-bold text-[#8B1A1A]">{bonoAplicado}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Vencidas</p>
                    <p className={`font-bold ${vencidas > 0 ? 'text-red-600' : 'text-gray-700'}`}>{vencidas}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Total pagado</p>
                    <p className="font-bold text-green-700">S/. {totalPagado.toFixed(2)}</p>
                  </div>
                </div>
                {bonoAplicado >= 1 && (
                  <p className="text-xs text-gray-600">Has ganado <strong>{bonoAplicado}</strong> cuota{bonoAplicado !== 1 ? 's' : ''} bonificada{bonoAplicado !== 1 ? 's' : ''}.</p>
                )}
                {racha === 3 && (
                  <p className="text-xs text-amber-700">Paga 1 cuota más al día y se te bonificará 1 cuota.</p>
                )}
              </div>
            );
          })()}
          {solicitud.fecha_inicio_cobro_semanal && (
            <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4">
              <h4 className="text-sm font-semibold text-gray-900 mb-2">Mis cuotas semanales</h4>
              <p className="text-xs text-gray-600 mb-3">
                Puedes pagar cualquier monto por cuota (con mora aplicada si hay retraso). Sube tu comprobante e indica monto y moneda.
              </p>
              {loadingCuotas ? (
                <div className="flex justify-center py-4">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#8B1A1A] border-t-transparent" />
                </div>
              ) : cuotasSemanales.length === 0 ? (
                <p className="text-sm text-gray-500">Aún no hay cuotas semanales generadas.</p>
              ) : (
                <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-gray-600">
                        <th className="py-2.5 pr-2 text-xs font-semibold uppercase tracking-wide">Semana</th>
                        <th className="py-2.5 pr-2 text-xs font-semibold uppercase tracking-wide">Vence</th>
                        <th className="py-2.5 pr-2 text-xs font-semibold uppercase tracking-wide">Cuota completa</th>
                        <th className="py-2.5 pr-2 text-xs font-semibold uppercase tracking-wide">Viajes - B.A</th>
                        <th className="py-2.5 pr-2 text-xs font-semibold uppercase tracking-wide">Cuota a pagar</th>
                        <th className="py-2.5 pr-2 text-xs font-semibold uppercase tracking-wide">
                          Mora{solicitud.cronograma?.tasa_interes_mora != null && Number(solicitud.cronograma.tasa_interes_mora) > 0 ? ` (${(Number(solicitud.cronograma.tasa_interes_mora) * 100).toFixed(2)}%)` : ''}
                        </th>
                        <th className="py-2.5 pr-2 text-xs font-semibold uppercase tracking-wide">Cuota final</th>
                        <th className="py-2.5 pr-2 text-xs font-semibold uppercase tracking-wide">Pagado</th>
                        <th className="py-2.5 pr-2 text-xs font-semibold uppercase tracking-wide">Estado</th>
                        <th className="py-2.5 pr-2 text-xs font-semibold uppercase tracking-wide">Comprobante</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedCuotas.map((c, index) => {
                        const numeroSemana = (cuotasPage - 1) * cuotasLimit + index + 1;
                        const pendiente = c.pending_total > 0;
                        const comps = comprobantesByCuotaId[c.id] ?? [];
                        const abierto = historialAbiertoPorCuota === c.id;
                        return (
                          <Fragment key={c.id}>
                            <tr className="border-b border-gray-100">
                              <td className="py-2 pr-2 text-gray-700">
                                <span className="font-medium text-[#8B1A1A]">Semana {numeroSemana}</span>
                                <span className="block text-xs text-gray-500 mt-0.5">{formatDateFlex(c.week_start_date)}</span>
                              </td>
                              <td className="py-2 pr-2 text-gray-700">{formatDateFlex(c.due_date)}</td>
                              <td className="py-2 pr-2 font-medium">S/. {(c.amount_due ?? 0).toFixed(2)}</td>
                              <td className="py-2 pr-2 text-gray-700 text-xs whitespace-nowrap">
                                {c.num_viajes != null && c.bono_auto != null
                                  ? `${c.num_viajes} — S/. ${(c.bono_auto).toFixed(2)}`
                                  : c.num_viajes != null
                                    ? String(c.num_viajes)
                                    : c.bono_auto != null
                                      ? `S/. ${(c.bono_auto).toFixed(2)}`
                                      : '—'}
                              </td>
                              <td className="py-2 pr-2 font-medium">S/. {(Math.max(0, c.pending_total ?? (c.amount_due + (c.late_fee ?? 0) - (c.paid_amount ?? 0)))).toFixed(2)}</td>
                              <td className="py-2 pr-2 text-red-600 font-medium">S/. {(c.late_fee ?? 0).toFixed(2)}</td>
                              <td className="py-2 pr-2 font-medium">S/. {(c.amount_due + (c.late_fee ?? 0)).toFixed(2)}</td>
                              <td className="py-2 pr-2 text-green-700">S/. {c.paid_amount.toFixed(2)}</td>
                              <td className="py-2 pr-2">
                                <div className="flex flex-col gap-0.5">
                                  <span
                                    className={`inline-flex w-fit px-1.5 py-0.5 rounded text-xs font-medium ${
                                      c.status === 'paid' || c.status === 'bonificada' ? 'bg-green-100 text-green-800' :
                                      c.status === 'overdue' ? 'bg-red-100 text-red-800' :
                                      c.status === 'partial' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'
                                    }`}
                                    title={c.status === 'bonificada' ? 'Bonificación por 4 cuotas seguidas al día' : undefined}
                                  >
                                    {c.status === 'bonificada' ? 'Bonificada' : c.status === 'paid' ? 'Pagada' : c.status === 'overdue' ? 'Vencida' : c.status === 'partial' ? 'Parcial' : 'Pendiente'}
                                  </span>
                                  {c.status === 'bonificada' && (
                                    <span className="text-[10px] text-gray-500">Por 4 cuotas al día</span>
                                  )}
                                </div>
                              </td>
                              <td className="py-2 pr-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  {pendiente && (
                                    <>
                                      <select
                                        value={cuotaMoneda[c.id] ?? 'PEN'}
                                        onChange={(e) => setCuotaMoneda((prev) => ({ ...prev, [c.id]: e.target.value }))}
                                        disabled={uploadCuotaLoading === c.id}
                                        className="px-2 py-1.5 border border-gray-200 rounded bg-gray-50 text-gray-700 text-xs focus:bg-white focus:border-[#8B1A1A]/40 disabled:opacity-60 disabled:cursor-not-allowed"
                                      >
                                        <option value="PEN">S/.</option>
                                        <option value="USD">USD</option>
                                      </select>
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
                                      <button
                                        type="button"
                                        disabled={uploadCuotaLoading === c.id || (fileCuotaPreview?.cuotaId === c.id)}
                                        onClick={() => fileCuotaRefs.current[c.id]?.click()}
                                        className="inline-flex items-center gap-1 px-2 py-1 border border-[#8B1A1A] text-[#8B1A1A] rounded text-xs font-medium hover:bg-red-50 disabled:opacity-50"
                                      >
                                        <Upload className="w-3 h-3" />
                                        Elegir archivo
                                      </button>
                                      {fileCuotaPreview?.cuotaId === c.id && (
                                        <>
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
                                              className="absolute top-0 right-0 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 shadow -translate-y-1/2 translate-x-1/2 disabled:opacity-50 disabled:pointer-events-none"
                                              aria-label="Quitar archivo"
                                            >
                                              <X className="w-2.5 h-2.5" />
                                            </button>
                                          </span>
                                          <button
                                            type="button"
                                            disabled={uploadCuotaLoading === c.id}
                                            onClick={() => handleUploadComprobanteCuota(c.id, fileCuotaPreview.file)}
                                            className="inline-flex items-center gap-1 px-2 py-1 bg-[#8B1A1A] text-white rounded text-xs font-medium disabled:opacity-50"
                                          >
                                            {uploadCuotaLoading === c.id ? 'Enviando...' : 'Pagar cuota'}
                                          </button>
                                        </>
                                      )}
                                    </>
                                  )}
                                  {comps.length > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => setHistorialAbiertoPorCuota(abierto ? null : c.id)}
                                      className="inline-flex items-center gap-1 text-xs font-medium text-[#8B1A1A] hover:underline"
                                    >
                                      {abierto ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                      {abierto ? 'Ocultar historial' : `Historial (${comps.length})`}
                                    </button>
                                  )}
                                  {!pendiente && comps.length === 0 && <span className="text-gray-400">—</span>}
                                </div>
                              </td>
                            </tr>
                            {comps.length > 0 && (
                              <tr className="border-b border-gray-100">
                                <td colSpan={10} className="p-0 align-top">
                                  <div
                                    className="overflow-hidden transition-[max-height,opacity] duration-300 ease-out"
                                    style={{ maxHeight: abierto ? 1400 : 0, opacity: abierto ? 1 : 0 }}
                                  >
                                    <div className="px-4 py-3 bg-gray-50/80 border-t border-gray-200">
                                      <div className="flex items-center gap-2 mb-3">
                                        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[#8B1A1A]/10">
                                          <FileText className="w-4 h-4 text-[#8B1A1A]" />
                                        </div>
                                        <div>
                                          <h4 className="text-sm font-semibold text-gray-900">Comprobantes — Semana {numeroSemana}</h4>
                                          <p className="text-xs text-gray-500">{formatDateFlex(c.week_start_date)}</p>
                                        </div>
                                      </div>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                        {comps.map((cp, compIdx) => {
                                          const estado = getEstadoComp(cp);
                                          const sym = cp.moneda === 'USD' ? '$' : 'S/.';
                                          const url = getComprobanteUrl(cp.file_path);
                                          const isImage = cp.file_path && !/\.pdf$/i.test(cp.file_name || '') && /\.(jpe?g|png|gif|webp)$/i.test(cp.file_name || '');
                                          const compLabel = `Comprobante ${compIdx + 1}`;
                                          const openPreview = () => cp.file_path && setComprobantePreview({ url, fileName: compLabel, isImage: !!isImage });
                                          const cardBg = estado === 'validado' ? 'bg-green-50/90 border-green-200' : estado === 'rechazado' ? 'bg-red-50/90 border-red-200' : 'bg-amber-50/90 border-amber-200';
                                          const iconBg = estado === 'validado' ? 'bg-green-100 text-green-700' : estado === 'rechazado' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700';
                                          const labelEstado = estado === 'validado' ? 'Verificado' : estado === 'rechazado' ? 'Rechazado' : 'En revisión';
                                          const labelClass = estado === 'validado' ? 'bg-green-100 text-green-800' : estado === 'rechazado' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800';
                                          const verBtnClass = estado === 'validado'
                                            ? 'border-green-200 bg-green-50 text-green-800 hover:bg-green-100'
                                            : estado === 'rechazado'
                                              ? 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100'
                                              : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100';
                                          return (
                                            <div key={cp.id} className={`rounded-xl border-2 p-3 ${cardBg} hover:shadow-md transition-all flex flex-col gap-2`}>
                                              <div className="flex gap-3">
                                                <div className={`flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center overflow-hidden ${iconBg}`}>
                                                  {cp.file_path && isImage ? (
                                                    <button type="button" onClick={openPreview} className="w-full h-full rounded-lg overflow-hidden border border-white/50 shadow-sm hover:opacity-90 transition-opacity">
                                                      <img src={url} alt="" className="w-full h-full object-cover" />
                                                    </button>
                                                  ) : cp.file_path ? (
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
                                                      {estado === 'pendiente' ? '—' : (cp.monto != null ? `${sym} ${Number(cp.monto).toFixed(2)}` : '—')}
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
                                              {cp.file_path && (
                                                <button
                                                  type="button"
                                                  onClick={openPreview}
                                                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-colors self-start ${verBtnClass}`}
                                                >
                                                  <ExternalLink className="w-3.5 h-3.5" />
                                                  Ver comprobante
                                                </button>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                      {(() => {
                                        const verificado = comps.filter((cp) => getEstadoComp(cp) === 'validado').reduce((s, cp) => s + (cp.monto != null ? Number(cp.monto) : 0), 0);
                                        const totalEnv = verificado;
                                        const rechazado = comps.filter((cp) => getEstadoComp(cp) === 'rechazado').reduce((s, cp) => s + (cp.monto != null ? Number(cp.monto) : 0), 0);
                                        const totalCuota = c.amount_due + (c.late_fee ?? 0);
                                        const restantePorPagar = Math.max(0, c.pending_total ?? (totalCuota - verificado));
                                        return (
                                          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-white border border-gray-200 px-4 py-3 text-sm text-gray-700 shadow-sm">
                                            <span><strong className="text-gray-800">Total enviado:</strong> S/. {totalEnv.toFixed(2)}</span>
                                            <span><strong className="text-gray-800">Verificado:</strong> S/. {verificado.toFixed(2)}</span>
                                            <span><strong className="text-gray-800">Rechazado:</strong> S/. {rechazado.toFixed(2)}</span>
                                            <span><strong className="text-gray-800">Pendiente:</strong> S/. {restantePorPagar.toFixed(2)}</span>
                                          </div>
                                        );
                                      })()}
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
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-2 py-3 border-t border-gray-200 mt-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-gray-500">Por página:</span>
                      <select
                        value={cuotasLimit}
                        onChange={(e) => {
                          setCuotasLimit(Number(e.target.value));
                          setCuotasPage(1);
                        }}
                        className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A]"
                      >
                        {PAGE_SIZES_CUOTAS.map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setCuotasPage(1)}
                        disabled={cuotasPage <= 1}
                        className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-[#8B1A1A] text-[#8B1A1A] hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        aria-label="Primera página"
                      >
                        <ChevronsLeft className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setCuotasPage((p) => Math.max(1, p - 1))}
                        disabled={cuotasPage <= 1}
                        className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-[#8B1A1A] text-[#8B1A1A] hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        aria-label="Página anterior"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      {totalCuotasPages > 1 && (
                        <div className="flex items-center gap-1">
                          {Array.from({ length: Math.min(5, totalCuotasPages) }, (_, i) => {
                            let pageNum: number;
                            if (totalCuotasPages <= 5) pageNum = i + 1;
                            else if (cuotasPage <= 3) pageNum = i + 1;
                            else if (cuotasPage >= totalCuotasPages - 2) pageNum = totalCuotasPages - 4 + i;
                            else pageNum = cuotasPage - 2 + i;
                            const isActive = cuotasPage === pageNum;
                            return (
                              <button
                                key={pageNum}
                                type="button"
                                onClick={() => setCuotasPage(pageNum)}
                                className={`min-w-[2.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                                  isActive ? 'bg-[#8B1A1A] text-white border-2 border-[#8B1A1A]' : 'border-2 border-[#8B1A1A] text-[#8B1A1A] hover:bg-red-50'
                                }`}
                              >
                                {pageNum}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => setCuotasPage((p) => Math.min(totalCuotasPages, p + 1))}
                        disabled={cuotasPage >= totalCuotasPages}
                        className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-[#8B1A1A] text-[#8B1A1A] hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        aria-label="Página siguiente"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setCuotasPage(totalCuotasPages)}
                        disabled={cuotasPage >= totalCuotasPages}
                        className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-[#8B1A1A] text-[#8B1A1A] hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        aria-label="Última página"
                      >
                        <ChevronsRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
                </>
              )}
              <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50/70 px-3 py-2">
                <p className="text-xs text-gray-700">
                  Beneficio: si pagas 4 cuotas consecutivas a tiempo, se te bonifica 1 cuota semanal del total.
                </p>
              </div>
            </div>
          )}
            </div>
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
        </div>
      )}
    </div>
  );
}

function DesistidoBlock({ solicitud }: { solicitud: Solicitud }) {
  const fecha = solicitud.withdrawn_at || solicitud.reviewed_at;
  const motivo = solicitud.withdrawal_reason?.trim() || (solicitud.observations?.trim() ? solicitud.observations.trim() : null);
  return (
    <div className="mt-4 bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50/70">
        <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <XCircle className="w-5 h-5 text-gray-500" />
          Solicitud desistida
        </h3>
      </div>
      <div className="p-4 space-y-3">
        {fecha && (
          <p className="text-sm text-gray-600">
            <span className="font-medium text-gray-700">Fecha:</span> {formatDateFlex(fecha)}
          </p>
        )}
        {motivo && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-0.5">Motivo</p>
            <p className="text-sm text-gray-600 whitespace-pre-wrap">{motivo}</p>
          </div>
        )}
        {!motivo && !fecha && (
          <p className="text-sm text-gray-500">Esta solicitud fue marcada como desistida.</p>
        )}
      </div>
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
  type CuotasCacheEntry = { cuotas: CuotaSemanal[]; comprobantes: ComprobanteCuotaSemanal[]; racha: number | null; cuotas_semanales_bonificadas?: number };
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
      const msg = e && typeof e === 'object' && 'response' in e
        ? (e as { response?: { data?: { message?: string } } }).response?.data?.message
        : null;
      setError(msg || 'Error al cargar tus solicitudes');
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
      const [resCuotas, resComp] = await Promise.all([
        api.get(`/miauto/solicitudes/${solicitudId}/cuotas-semanales`),
        api.get(`/miauto/solicitudes/${solicitudId}/comprobantes-cuota-semanal`).catch(() => ({ data: [] })),
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
      setCuotasCache((prev) => ({
        ...prev,
        [solicitudId]: { cuotas, comprobantes, racha: rachaVal, cuotas_semanales_bonificadas: bonoAplicado },
      }));
    } catch {
      setCuotasCache((prev) => ({ ...prev, [solicitudId]: { cuotas: [], comprobantes: [], racha: null, cuotas_semanales_bonificadas: 0 } }));
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
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al subir comprobante');
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
      const msg = err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { data?: { message?: string } } }).response?.data?.message
        : null;
      toast.error(msg || 'Error al enviar la solicitud');
    } finally {
      setSubmitting(false);
    }
  };

  const hasSolicitudes = solicitudes.length > 0;
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
                    <Car className="h-5 w-5" />
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
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Estado de tu solicitud</h2>
            {canCreateNew && (
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="text-sm font-medium text-[#8B1A1A] hover:underline"
              >
                Nueva solicitud
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Fecha creación</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Estado</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Fecha de cita</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Citas agendadas</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Observaciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {solicitudes.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900">{formatDate(s.created_at)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${STATUS_CLASS[s.status] || 'bg-gray-100 text-gray-800'}`}>
                        {STATUS_LABELS[s.status] || s.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {s.appointment_date
                        ? formatDateFlex(s.appointment_date, 'es-ES')
                        : s.status === 'rechazado'
                          ? 'No hubo'
                          : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {(s.status === 'citado' || s.status === 'aprobado' || s.status === 'rechazado' || s.status === 'desistido') ? (
                        <span className={((s.reagendo_count ?? 0) >= MAX_REAGENDOS ? 'text-amber-600 font-medium' : '')}>
                          {s.reagendo_count ?? 0}/{MAX_REAGENDOS}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 max-w-[280px]">
                      {s.observations?.trim()
                        ? s.observations.trim()
                        : s.status === 'rechazado' && s.rejection_reason?.trim()
                          ? <span className="text-red-700" title="Motivo de rechazo">{s.rejection_reason.trim()}</span>
                          : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {solicitudes.filter((s) => s.status === 'aprobado').map((s) => (
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

        {solicitudes.filter((s) => s.status === 'desistido').map((s) => (
          <DesistidoBlock key={s.id} solicitud={s} />
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
