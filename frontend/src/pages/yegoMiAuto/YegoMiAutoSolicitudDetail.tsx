import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../services/api';
import {
  ArrowLeft,
  FileText,
  Image as ImageIcon,
  File,
  ExternalLink,
  Calendar,
  X,
  Clock,
  CheckCircle,
  Pencil,
  Calculator,
  Loader2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { formatDateFlex } from '../../utils/date';
import { DateTimePicker } from '../../components/DateTimePicker';
import { CronogramaPagoSection } from './CronogramaPagoSection';

const APP_NAMES: Record<string, string> = {
  yango: 'Yango',
  uber: 'Uber',
  indriver: 'InDriver',
  beat: 'Beat',
  didi: 'Didi',
  cabify: 'Cabify',
};

const TIPO_LABELS: Record<string, string> = {
  licencia: 'Licencia de conducir',
  comprobante_viajes: 'Comprobante de viajes',
};

const STATUS_LABELS: Record<string, string> = {
  pendiente: 'Pendiente',
  citado: 'Citado',
  rechazado: 'Rechazado',
  desistido: 'Desistido',
  aprobado: 'Aprobado',
};

const STATUS_PILL_CLASS: Record<string, string> = {
  pendiente: 'bg-amber-100 text-amber-800',
  citado: 'bg-blue-100 text-blue-800',
  rechazado: 'bg-red-100 text-red-800',
  desistido: 'bg-gray-100 text-gray-700',
  aprobado: 'bg-green-100 text-green-800',
};

const FLOW_STEPS = [
  { key: 'pendiente', label: 'Pendiente', icon: Clock },
  { key: 'citado', label: 'Citado', icon: Calendar },
  { key: 'aprobado', label: 'Aprobado', icon: CheckCircle },
  { key: 'rechazado', label: 'Rechazado', icon: X },
  { key: 'desistido', label: 'Desistido', icon: X },
];

const MAX_REAGENDOS = 2;
const SECTION_HEADING = 'text-xs font-semibold text-[#8B1A1A] uppercase tracking-wide';
const COUNTRY_LABELS: Record<string, string> = { PE: 'Perú', CO: 'Colombia' };

function getAdjuntoUrl(filePath: string | undefined): string {
  if (!filePath) return '';
  if (filePath.startsWith('http')) return filePath;
  return `${window.location.origin}${filePath.startsWith('/') ? '' : '/'}${filePath}`;
}

function isImageAdjunto(fileName: string, tipo: string): boolean {
  return /\.(jpe?g|png|gif|webp)$/i.test(fileName || '') || tipo === 'licencia';
}

function getTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Convierte ISO (backend) a fecha y hora local para el DateTimePicker (mismo valor que se muestra en Citado). */
function isoToLocalDateAndTime(isoString: string | null | undefined): { date: string; time: string } {
  if (!isoString) return { date: '', time: '09:00' };
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return { date: '', time: '09:00' };
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { date, time };
}

function toAppointmentDateTime(date: string, time: string): string {
  if (!date) return '';
  const t = time || '09:00';
  return t.length === 5 ? `${date}T${t}:00` : `${date}T${t}`;
}

function isAppointmentInPast(date: string, time: string): boolean {
  const dt = toAppointmentDateTime(date, time);
  if (!dt) return true;
  return new Date(dt).getTime() < Date.now();
}

function looksLikeFullDate(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) || s.includes('T');
}

function formatCitaDisplay(appointmentDate: string | null | undefined, citedAt: string | null | undefined): string {
  const raw = looksLikeFullDate(appointmentDate) ? appointmentDate : citedAt;
  return formatDateFlex(raw, 'es-ES');
}

function validateCitadoDate(date: string, time: string): string | null {
  if (!date?.trim() || !time?.trim()) return 'Indica la fecha y la hora de la cita';
  if (date < getTodayISO()) return 'La fecha de la cita no puede ser anterior al día actual';
  if (isAppointmentInPast(date, time)) return 'La fecha y hora de la cita no puede ser anterior a ahora';
  return null;
}

export default function YegoMiAutoSolicitudDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userName = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() || user?.email || 'Usuario';
  const [solicitud, setSolicitud] = useState<any>(null);
  const [adjuntos, setAdjuntos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [modalReprogramar, setModalReprogramar] = useState(false);
  const [modalEditarCita, setModalEditarCita] = useState(false);
  const [newAppointmentDate, setNewAppointmentDate] = useState('');
  const [newAppointmentTime, setNewAppointmentTime] = useState('09:00');
  const [editCitaDate, setEditCitaDate] = useState('');
  const [editCitaTime, setEditCitaTime] = useState('09:00');
  const [rejectionReason, setRejectionReason] = useState('');
  const [newStatus, setNewStatus] = useState('');
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [cronogramasList, setCronogramasList] = useState<any[]>([]);
  const [loadingCronogramas, setLoadingCronogramas] = useState(false);
  const [selectedCronogramaForVehicles, setSelectedCronogramaForVehicles] = useState<any | null>(null);
  const [selectedVehiculoId, setSelectedVehiculoId] = useState<string | number | null>(null);
  const [pendingPagoTipo, setPendingPagoTipo] = useState<'completo' | 'parcial'>('completo');
  const [pagoSectionOpen, setPagoSectionOpen] = useState(true);
  const [pasoCronogramaPago, setPasoCronogramaPago] = useState<1 | 2 | 3>(1);
  const [validandoComprobanteId, setValidandoComprobanteId] = useState<string | null>(null);
  const [rechazandoComprobanteId, setRechazandoComprobanteId] = useState<string | null>(null);
  const [tipoCambio, setTipoCambio] = useState<{ valor_usd_a_local: number; moneda_local: string } | null>(null);
  const [showSimularCuotasModal, setShowSimularCuotasModal] = useState(false);
  const [placaParaGenerar, setPlacaParaGenerar] = useState('');

  const fetchDetail = useCallback(async (silent = false) => {
    if (!id) return;
    try {
      if (!silent) {
        setLoading(true);
        setError('');
      }
      const [resSol, resAdj] = await Promise.all([
        api.get(`/miauto/solicitudes/${id}`),
        api.get(`/miauto/solicitudes/${id}/adjuntos`),
      ]);
      const sol = resSol.data?.data ?? resSol.data;
      setSolicitud(sol);
      setAdjuntos(Array.isArray(resAdj.data?.data) ? resAdj.data.data : resAdj.data ?? []);
    } catch (e: any) {
      const msg = e.response?.data?.message || 'Error al cargar la solicitud';
      setError(msg);
      if (silent) toast.error(msg);
      if (!silent) setSolicitud(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  useEffect(() => {
    if (showSimularCuotasModal && solicitud) {
      setPlacaParaGenerar(solicitud.placa_asignada ? String(solicitud.placa_asignada) : '');
    }
  }, [showSimularCuotasModal, solicitud?.id, solicitud?.placa_asignada]);

  const fetchedCronogramaTipoCambioKey = useRef({ status: '', country: '' });
  useEffect(() => {
    if (!(solicitud?.status === 'aprobado' && solicitud?.country)) {
      setCronogramasList([]);
      setSelectedCronogramaForVehicles(null);
      setSelectedVehiculoId(null);
      setTipoCambio(null);
      fetchedCronogramaTipoCambioKey.current = { status: '', country: '' };
      return;
    }
    const key = { status: solicitud.status, country: solicitud.country };
    if (fetchedCronogramaTipoCambioKey.current.status === key.status && fetchedCronogramaTipoCambioKey.current.country === key.country) {
      return;
    }
    fetchedCronogramaTipoCambioKey.current = key;
    setLoadingCronogramas(true);
    Promise.all([
      api.get(`/miauto/cronogramas?country=${solicitud.country}&active=true`),
      api.get(`/miauto/tipo-cambio?country=${solicitud.country}`),
    ])
      .then(([resCron, resTc]) => {
        const data = resCron.data?.data ?? resCron.data;
        setCronogramasList(Array.isArray(data) ? data : []);
        const d = resTc.data?.data ?? resTc.data;
        setTipoCambio(d && typeof d.valor_usd_a_local === 'number' ? { valor_usd_a_local: d.valor_usd_a_local, moneda_local: d.moneda_local || 'PEN' } : null);
      })
      .catch(() => {
        setCronogramasList([]);
        setTipoCambio(null);
      })
      .finally(() => setLoadingCronogramas(false));
  }, [solicitud?.status, solicitud?.country]);

  const prevPagoSectionOpen = useRef(false);
  useEffect(() => {
    if (pagoSectionOpen && !prevPagoSectionOpen.current && !solicitud?.cronograma_id) {
      setPasoCronogramaPago(1);
    }
    prevPagoSectionOpen.current = pagoSectionOpen;
  }, [pagoSectionOpen, solicitud?.cronograma_id]);

  const closeStatusModal = useCallback(() => {
    setShowStatusModal(false);
    setNewStatus('');
    setRejectionReason('');
    setNewAppointmentDate('');
    setNewAppointmentTime('09:00');
  }, []);

  const handleReprogramar = async () => {
    const err = validateCitadoDate(newAppointmentDate, newAppointmentTime);
    if (err) {
      toast.error(err);
      return;
    }
    try {
      setActionLoading(true);
      await api.post(`/miauto/solicitudes/${id}/reagendar`, { appointment_date: toAppointmentDateTime(newAppointmentDate, newAppointmentTime) });
      toast.success('Cita reprogramada');
      setModalReprogramar(false);
      setNewAppointmentDate('');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al reprogramar');
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditarCita = async () => {
    const err = validateCitadoDate(editCitaDate, editCitaTime);
    if (err) {
      toast.error(err);
      return;
    }
    try {
      setActionLoading(true);
      await api.patch(`/miauto/solicitudes/${id}`, { appointment_date: toAppointmentDateTime(editCitaDate, editCitaTime) });
      toast.success('Fecha de cita actualizada');
      setModalEditarCita(false);
      setEditCitaDate('');
      setEditCitaTime('09:00');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al actualizar la fecha');
    } finally {
      setActionLoading(false);
    }
  };

  const handleNoVinoRechazar = async () => {
    try {
      setActionLoading(true);
      await api.post(`/miauto/solicitudes/${id}/no-vino-rechazar`);
      toast.success('Solicitud rechazada por inasistencia');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al rechazar');
    } finally {
      setActionLoading(false);
    }
  };

  const handleGuardarCronogramaPago = async () => {
    if (!selectedCronogramaForVehicles || !selectedVehiculoId) {
      toast.error('Elige cronograma, carro y tipo de pago antes de guardar');
      return;
    }
    try {
      setActionLoading(true);
      await api.patch(`/miauto/solicitudes/${id}`, {
        cronograma_id: selectedCronogramaForVehicles.id,
        cronograma_vehiculo_id: selectedVehiculoId,
        pago_tipo: pendingPagoTipo,
      });
      toast.success('Cronograma, carro y tipo de pago guardados');
      setSelectedCronogramaForVehicles(null);
      setSelectedVehiculoId(null);
      setPendingPagoTipo('completo');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al guardar');
    } finally {
      setActionLoading(false);
    }
  };

  const handleValidarComprobante = async (comprobanteId: string, data: { monto: number; moneda: 'PEN' | 'USD' }) => {
    if (!id) return;
    try {
      setValidandoComprobanteId(comprobanteId);
      await api.patch(`/miauto/solicitudes/${id}/comprobantes-pago/${comprobanteId}/validar`, { monto: data.monto, moneda: data.moneda });
      toast.success('Comprobante validado. Se descontará de la cuota inicial.');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al validar comprobante');
    } finally {
      setValidandoComprobanteId(null);
    }
  };

  const handleRechazarComprobante = async (comprobanteId: string, data: { motivo: string }) => {
    if (!id) return;
    try {
      setRechazandoComprobanteId(comprobanteId);
      await api.patch(`/miauto/solicitudes/${id}/comprobantes-pago/${comprobanteId}/rechazar`, { motivo: data.motivo.trim() });
      toast.success('Comprobante rechazado. El conductor verá el motivo.');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al rechazar comprobante');
    } finally {
      setRechazandoComprobanteId(null);
    }
  };

  const handleAgregarComprobante = async (file: File, monto: number, moneda: 'PEN' | 'USD') => {
    if (!id) return;
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('monto', String(monto));
      form.append('moneda', moneda);
      await api.post(`/miauto/solicitudes/${id}/comprobantes-pago`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Comprobante subido y validado.');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al subir comprobante');
      throw e;
    }
  };

  const handleAgregarPagoManual = async (monto: number, moneda: 'PEN' | 'USD') => {
    if (!id) return;
    try {
      await api.post(`/miauto/solicitudes/${id}/pago-manual`, { monto, moneda });
      toast.success('Pago manual registrado.');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al registrar pago');
      throw e;
    }
  };

  const handleConfirmarAsistencia = async () => {
    try {
      setActionLoading(true);
      await api.post(`/miauto/solicitudes/${id}/marcar-llegada`);
      toast.success('Llegada registrada. Elige Aprobar o Desistió.');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al registrar llegada');
    } finally {
      setActionLoading(false);
    }
  };

  const ultimaCitaLlego =
    solicitud?.status === 'citado' &&
    Array.isArray(solicitud?.citas_historial) &&
    solicitud.citas_historial.length > 0 &&
    (solicitud.citas_historial[solicitud.citas_historial.length - 1] as { resultado?: string })?.resultado === 'llego';

  const [showAprobarModal, setShowAprobarModal] = useState(false);
  const handleAprobar = async () => {
    try {
      setActionLoading(true);
      setShowAprobarModal(false);
      await api.patch(`/miauto/solicitudes/${id}`, { status: 'aprobado' });
      toast.success('Solicitud aprobada. Se ha registrado quién la aprobó.');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al aprobar');
    } finally {
      setActionLoading(false);
    }
  };

  const [showDesistirModal, setShowDesistirModal] = useState(false);
  const [desistidoMotivo, setDesistidoMotivo] = useState('');
  const handleDesistir = async () => {
    try {
      setActionLoading(true);
      setShowDesistirModal(false);
      await api.patch(`/miauto/solicitudes/${id}`, {
        status: 'desistido',
        withdrawal_reason: desistidoMotivo.trim() || undefined,
      });
      setDesistidoMotivo('');
      toast.success('Solicitud marcada como Desistido.');
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al actualizar');
    } finally {
      setActionLoading(false);
    }
  };

  const handleChangeStatus = async () => {
    if (newStatus === 'citado') {
      const err = validateCitadoDate(newAppointmentDate, newAppointmentTime);
      if (err) {
        toast.error(err);
        return;
      }
    }
    try {
      setActionLoading(true);
      const payload: any = { status: newStatus };
      if (newStatus === 'rechazado' && rejectionReason) payload.rejection_reason = rejectionReason;
      if (newStatus === 'citado' && newAppointmentDate) payload.appointment_date = toAppointmentDateTime(newAppointmentDate, newAppointmentTime);
      await api.patch(`/miauto/solicitudes/${id}`, payload);
      toast.success('Estado actualizado');
      closeStatusModal();
      await fetchDetail(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al actualizar estado');
    } finally {
      setActionLoading(false);
    }
  };

  const openAgendarModal = () => {
    setNewStatus('citado');
    const raw = solicitud?.appointment_date;
    setNewAppointmentDate(raw ? String(raw).slice(0, 10) : '');
    const timePart = raw && String(raw).length >= 16 ? String(raw).slice(11, 16) : '09:00';
    setNewAppointmentTime(timePart.length === 5 ? timePart : '09:00');
    setShowStatusModal(true);
  };

  const openRechazarModal = () => {
    setNewStatus('rechazado');
    setRejectionReason(solicitud?.rejection_reason || '');
    setShowStatusModal(true);
  };

  const handleAppointmentChange = (v: string) => {
    if (!v) {
      setNewAppointmentDate('');
      setNewAppointmentTime('09:00');
    } else {
      const [d, t] = v.split('T');
      setNewAppointmentDate(d || '');
      setNewAppointmentTime(t ? t.slice(0, 5) : '09:00');
    }
  };

  const handleEditarCitaAppointmentChange = (v: string) => {
    if (!v) {
      setEditCitaDate('');
      setEditCitaTime('09:00');
    } else {
      const [d, t] = v.split('T');
      setEditCitaDate(d || '');
      setEditCitaTime(t ? t.slice(0, 5) : '09:00');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
      </div>
    );
  }

  if (error || !solicitud) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-700">{error || 'Solicitud no encontrada'}</p>
        <button
          type="button"
          onClick={() => navigate('/admin/yego-mi-auto/requests')}
          className="mt-3 text-sm font-medium text-red-700 hover:underline"
        >
          Volver al listado
        </button>
      </div>
    );
  }

  const isCitado = solicitud.status === 'citado';
  const canReprogramar = isCitado && (solicitud.reagendo_count ?? 0) < MAX_REAGENDOS;
  const flowSteps =
    solicitud.status === 'aprobado'
      ? FLOW_STEPS.filter((s) => s.key !== 'rechazado' && s.key !== 'desistido')
      : solicitud.status === 'rechazado'
        ? FLOW_STEPS.filter((s) => s.key !== 'aprobado' && s.key !== 'desistido')
        : solicitud.status === 'desistido'
          ? FLOW_STEPS.filter((s) => s.key !== 'rechazado')
          : FLOW_STEPS.filter((s) => s.key === 'pendiente' || s.key === 'citado');
  const currentFlowIndex = Math.max(0, flowSteps.findIndex((s) => s.key === solicitud.status));
  const statusModalTitle =
    newStatus === 'citado' ? 'Agendar cita' : newStatus === 'rechazado' ? 'Rechazar solicitud' : 'Cambiar estado';

  return (
    <div className="space-y-4 lg:space-y-6">
      <header className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => navigate('/admin/yego-mi-auto/requests')}
          className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900">Solicitud Mi Auto</h1>
          <p className="text-sm text-gray-600">
            DNI {solicitud.dni} · {STATUS_LABELS[solicitud.status] || solicitud.status}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <FileText className="w-5 h-5 text-[#8B1A1A]" />
                Datos de la solicitud
              </h2>
            </div>
            <dl className="p-4 lg:p-5 space-y-4 text-sm">
              <section className="space-y-2 pb-4 border-b border-gray-100">
                <h3 className={SECTION_HEADING}>Identificación</h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <div><dt className="text-gray-500">País</dt><dd className="font-medium text-gray-900">{COUNTRY_LABELS[solicitud.country] || solicitud.country}</dd></div>
                  <div><dt className="text-gray-500">DNI</dt><dd className="font-medium text-gray-900">{solicitud.dni}</dd></div>
                </div>
              </section>
              <section className="space-y-2 pb-4 border-b border-gray-100">
                <h3 className={SECTION_HEADING}>Contacto</h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <div><dt className="text-gray-500">Celular</dt><dd>{solicitud.phone || '—'}</dd></div>
                  <div><dt className="text-gray-500">Correo</dt><dd>{solicitud.email || '—'}</dd></div>
                </div>
              </section>
              <section className="space-y-2 pb-4 border-b border-gray-100">
                <h3 className={SECTION_HEADING}>Licencia</h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <div><dt className="text-gray-500">N° licencia</dt><dd className="font-mono">{solicitud.license_number || '—'}</dd></div>
                  {solicitud.description ? (
                    <div className="col-span-2"><dt className="text-gray-500">Descripción</dt><dd>{solicitud.description}</dd></div>
                  ) : null}
                </div>
              </section>
              <section className="space-y-2 pb-4 border-b border-gray-100">
                <h3 className={SECTION_HEADING}>Apps en las que ha trabajado</h3>
                <dd className="flex flex-wrap gap-1.5">
                  {Array.isArray(solicitud.apps_trabajadas) && solicitud.apps_trabajadas.length
                    ? solicitud.apps_trabajadas.map((code: string) => {
                        const name = APP_NAMES[code] || code || '—';
                        return <span key={code} className="px-2.5 py-1 bg-gray-100 text-gray-800 rounded-md text-xs">{name}</span>;
                      })
                    : '—'}
                </dd>
              </section>
              <section className="space-y-2">
                <h3 className={SECTION_HEADING}>Estado y fechas</h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <div><dt className="text-gray-500">Estado</dt><dd><span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_PILL_CLASS[solicitud.status] || 'bg-gray-100 text-gray-700'}`}>{STATUS_LABELS[solicitud.status] || solicitud.status}</span></dd></div>
                  <div><dt className="text-gray-500">Fecha de creación</dt><dd>{formatDateFlex(solicitud.created_at)}</dd></div>
                  <div>
                    <dt className="text-gray-500">Citas agendadas</dt>
                    <dd>
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold ${(solicitud.reagendo_count ?? 0) >= MAX_REAGENDOS ? 'bg-amber-100 text-amber-800' : (solicitud.reagendo_count ?? 0) > 0 ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-700'}`}>
                        {solicitud.reagendo_count ?? 0} / {MAX_REAGENDOS}
                      </span>
                    </dd>
                  </div>
                </div>
                <div className="space-y-1 mt-2">
                  {solicitud.rejection_reason && <div><dt className="text-gray-500">Motivo rechazo</dt><dd className="text-red-600">{solicitud.rejection_reason}</dd></div>}
                  {isCitado && (
                    <div><dt className="text-gray-500">Fecha de cita</dt><dd>{formatCitaDisplay(solicitud.appointment_date, solicitud.cited_at)}</dd></div>
                  )}
                </div>
              </section>
              {solicitud.observations && (
                <section className="space-y-2 pt-2 border-t border-gray-100">
                  <h3 className={SECTION_HEADING}>Observaciones</h3>
                  <dd className="whitespace-pre-wrap text-gray-700">{solicitud.observations}</dd>
                </section>
              )}
            </dl>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <ImageIcon className="w-5 h-5 text-[#8B1A1A]" />
                Adjuntos
              </h2>
            </div>
            <div className="p-4 lg:p-5">
              {adjuntos.length === 0 ? (
                <p className="text-sm text-gray-500 py-2">No hay adjuntos en esta solicitud.</p>
              ) : (
                <ul className="flex flex-row flex-wrap gap-4">
                  {adjuntos.map((a: { id: string; tipo: string; file_name: string; file_path: string }) => {
                    const url = getAdjuntoUrl(a.file_path);
                    const isImage = isImageAdjunto(a.file_name || '', a.tipo);
                    return (
                      <li key={a.id} className="flex-shrink-0 w-64 rounded-lg border border-gray-200 bg-gray-50/50 overflow-hidden">
                        <p className="text-sm font-semibold text-gray-700 uppercase tracking-wide px-3 pt-3 whitespace-nowrap truncate" title={TIPO_LABELS[a.tipo] || a.tipo}>{TIPO_LABELS[a.tipo] || a.tipo}</p>
                        {isImage ? (
                          <button type="button" onClick={() => setImagePreviewUrl(url)} className="block border-t border-gray-200 w-full text-left">
                            <img src={url} alt={a.file_name || a.tipo} className="w-full h-52 object-contain bg-gray-100 cursor-pointer hover:opacity-95" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          </button>
                        ) : (
                          <div className="flex items-center gap-2 px-3 pb-3 pt-1">
                            <File className="w-5 h-5 text-gray-500 flex-shrink-0" />
                            <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-[#8B1A1A] hover:underline inline-flex items-center gap-1">
                              <ExternalLink className="w-4 h-4 flex-shrink-0" /> Ver archivo
                            </a>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">Acciones</h2>
            </div>
            <div className="p-4 flex flex-row flex-wrap gap-2">
              {solicitud.status === 'pendiente' && (
                <button type="button" onClick={openAgendarModal} disabled={actionLoading} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] text-sm font-medium disabled:opacity-50 whitespace-nowrap">
                  <Calendar className="w-4 h-4 flex-shrink-0" /> Agendar cita
                </button>
              )}
              {isCitado && canReprogramar && !ultimaCitaLlego && (
                <button
                  type="button"
                  onClick={() => {
                    const raw = looksLikeFullDate(solicitud?.appointment_date) ? solicitud?.appointment_date : solicitud?.cited_at;
                    setNewAppointmentDate(raw ? String(raw).slice(0, 10) : '');
                    setNewAppointmentTime(raw && String(raw).length >= 16 ? String(raw).slice(11, 16) : '09:00');
                    setModalReprogramar(true);
                  }}
                  disabled={actionLoading}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 border border-[#8B1A1A] text-[#8B1A1A] rounded-lg hover:bg-red-50 text-sm font-medium disabled:opacity-50 whitespace-nowrap"
                >
                  <Calendar className="w-4 h-4 flex-shrink-0" /> Reprogramar cita
                </button>
              )}
              {ultimaCitaLlego && (
                <>
                  <button type="button" onClick={() => setShowAprobarModal(true)} disabled={actionLoading} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium disabled:opacity-50 whitespace-nowrap">
                    <CheckCircle className="w-4 h-4 flex-shrink-0" /> Aprobar
                  </button>
                  <button type="button" onClick={() => setShowDesistirModal(true)} disabled={actionLoading} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 border border-gray-500 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-50 whitespace-nowrap">
                    <X className="w-4 h-4 flex-shrink-0" /> Desistió
                  </button>
                </>
              )}
              {isCitado && !ultimaCitaLlego && (
                <button type="button" onClick={handleConfirmarAsistencia} disabled={actionLoading} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium disabled:opacity-50 whitespace-nowrap">
                  <CheckCircle className="w-4 h-4 flex-shrink-0" /> Sí llegó
                </button>
              )}
              {solicitud.status === 'pendiente' && (
                <button type="button" onClick={openRechazarModal} disabled={actionLoading} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50 whitespace-nowrap">
                  <X className="w-4 h-4 flex-shrink-0" /> Rechazar
                </button>
              )}
              {isCitado && (solicitud.reagendo_count ?? 0) >= MAX_REAGENDOS && (
                <button type="button" onClick={handleNoVinoRechazar} disabled={actionLoading} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 border border-red-600 text-red-700 rounded-lg hover:bg-red-50 text-sm font-medium disabled:opacity-50 whitespace-nowrap">
                  <X className="w-4 h-4 flex-shrink-0" /> No llegó
                </button>
              )}
              {solicitud.status === 'aprobado' && solicitud.cronograma_vehiculo && (solicitud.pago_estado === 'completo' || (solicitud.pago_tipo === 'parcial' && (solicitud.total_validado_usd ?? 0) >= 500)) && (
                <button type="button" onClick={() => setShowSimularCuotasModal(true)} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] text-sm font-medium whitespace-nowrap">
                  <Calculator className="w-4 h-4 flex-shrink-0" /> Simular cuotas
                </button>
              )}
            </div>
          </div>

          {showSimularCuotasModal && solicitud?.cronograma_vehiculo && createPortal(
            <div
              className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[9999]"
              onClick={() => { if (!actionLoading) setShowSimularCuotasModal(false); }}
              role="dialog"
              aria-modal="true"
              aria-label="Simulación de cuotas"
            >
              <div className="bg-white rounded-2xl shadow-2xl ring-1 ring-black/5 max-w-lg w-full flex flex-col" onClick={(e) => e.stopPropagation()}>
                <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-[#8B1A1A]/8 via-[#8B1A1A]/4 to-transparent">
                  <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2.5">
                    <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#8B1A1A]/10">
                      <Calculator className="w-5 h-5 text-[#8B1A1A]" />
                    </span>
                    Simulación de cuotas
                  </h3>
                  <button type="button" onClick={() => setShowSimularCuotasModal(false)} disabled={actionLoading} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent" aria-label="Cerrar">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="p-6 space-y-5">
                  <p className="text-sm text-gray-600 leading-relaxed">
                    Resumen del plan de pago según el <strong className="text-gray-800">cronograma y vehículo</strong> asignados a esta solicitud.
                  </p>
                  <div className="rounded-xl border border-gray-200 bg-gray-50/80 p-5 space-y-4 shadow-sm">
                    <div>
                      <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Cronograma</p>
                      <p className="text-base font-semibold text-gray-900">{solicitud.cronograma?.name || '—'}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Vehículo / plan</p>
                      <p className="text-base font-semibold text-gray-900">{solicitud.cronograma_vehiculo?.name || '—'}</p>
                    </div>
                    <div className="pt-1.5 border-t border-gray-200">
                      <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-0.5">
                        {solicitud.pago_estado === 'completo' ? 'Cuota inicial (ya pagada)' : 'Cuota inicial del plan'}
                      </p>
                      <p className={`text-base font-bold ${solicitud.pago_estado === 'completo' ? 'text-green-700' : 'text-gray-900'}`}>
                        {solicitud.cronograma_vehiculo?.inicial_moneda === 'PEN' ? 'S/.' : '$'}{' '}
                        {Number(solicitud.cronograma_vehiculo?.inicial ?? 0).toFixed(2)}
                        {solicitud.cronograma_vehiculo?.inicial_moneda === 'USD' && <span className="text-xs font-normal text-gray-500 ml-1">USD</span>}
                      </p>
                      {solicitud.cronograma_vehiculo?.inicial_moneda === 'USD' && tipoCambio?.valor_usd_a_local && (
                        <p className="text-[11px] text-gray-500 mt-0.5">
                          Equiv. {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'}{' '}
                          {(Number(solicitud.cronograma_vehiculo?.inicial ?? 0) * tipoCambio.valor_usd_a_local).toFixed(2)}
                        </p>
                      )}
                      {solicitud.pago_estado !== 'completo' && (
                        <>
                          <p className="text-xs mt-1.5 text-gray-700">
                            <span className="font-medium text-gray-500">Pagado (validado):</span>{' '}
                            {(solicitud.total_validado_usd != null && solicitud.total_validado_usd > 0) ? (
                              <span className="font-semibold text-green-700">{Number(solicitud.total_validado_usd).toFixed(2)} USD</span>
                            ) : (
                              <span className="font-semibold text-green-700">
                                {solicitud.cronograma_vehiculo?.inicial_moneda === 'PEN' ? 'S/.' : '$'}{' '}
                                {Number(solicitud.total_validado ?? 0).toFixed(2)}
                                {solicitud.cronograma_vehiculo?.inicial_moneda === 'PEN' && tipoCambio?.valor_usd_a_local && (
                                  <span className="text-gray-600 font-normal"> (equiv. ~{(Number(solicitud.total_validado ?? 0) / tipoCambio.valor_usd_a_local).toFixed(2)} USD)</span>
                                )}
                              </span>
                            )}
                          </p>
                          {(() => {
                            const total = Number(solicitud.cronograma_vehiculo?.inicial ?? 0);
                            const validado = Number(solicitud.total_validado ?? 0);
                            const validadoUsd = solicitud.total_validado_usd != null ? Number(solicitud.total_validado_usd) : null;
                            const falta = solicitud.cronograma_vehiculo?.inicial_moneda === 'USD'
                              ? (validadoUsd != null ? total - validadoUsd : total - validado)
                              : total - validado;
                            if (falta <= 0) return null;
                            return (
                              <p className="text-xs mt-0.5 text-gray-700">
                                <span className="font-medium text-gray-500">Falta por pagar:</span>{' '}
                                <span className="font-semibold text-amber-700">
                                  {solicitud.cronograma_vehiculo?.inicial_moneda === 'USD' ? (
                                    <>{falta.toFixed(2)} USD</>
                                  ) : (
                                    <>S/. {falta.toFixed(2)}{tipoCambio?.valor_usd_a_local ? ` (equiv. ~${(falta / tipoCambio.valor_usd_a_local).toFixed(2)} USD)` : ''}</>
                                  )}
                                </span>
                              </p>
                            );
                          })()}
                        </>
                      )}
                    </div>
                    <div className="pt-2 border-t border-gray-200">
                      <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Cuotas semanales</p>
                      <p className="text-base font-semibold text-gray-900">
                        <span className="text-[#8B1A1A]">{solicitud.cronograma_vehiculo?.cuotas_semanales ?? 0}</span> cuotas por semana
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        El conductor pagará esta cantidad de cuotas cada semana según el cronograma. Los montos y fechas específicas de cada cuota se definen en el contrato o en el detalle del plan.
                      </p>
                    </div>
                  </div>
                  <div className="rounded-xl bg-amber-50/90 border border-amber-100 p-4">
                    <p className="text-xs text-amber-900/90 leading-relaxed">
                      {solicitud.pago_estado !== 'completo' && (solicitud.pago_tipo === 'parcial' || (solicitud.total_validado_usd ?? 0) >= 500) ? (
                        <>
                          <strong className="text-amber-900">Nota:</strong> simulación informativa. Si al generar Yego Mi Auto aún <strong>falta saldo</strong> de la cuota inicial, ese monto se repartirá en <strong>26 cuotas</strong> en &quot;Otros gastos&quot;, con vencimientos en <strong>lunes</strong> desde la <strong>semana 2</strong> del plan. La primera cuota del plan semanal vence el mismo día de la generación.
                        </>
                      ) : solicitud.pago_tipo === 'parcial' && solicitud.pago_estado === 'completo' ? (
                        <>
                          <strong className="text-amber-900">Nota:</strong> Cuota inicial completada. Al generar Yego Mi Auto no se crearán cuotas de &quot;Otros gastos&quot; (no hay saldo pendiente de la inicial).
                        </>
                      ) : (
                        <>
                          <strong className="text-amber-900">Nota:</strong> Esta es una simulación informativa con los datos del plan elegido. La cuota inicial ya fue completada. Las cuotas semanales se cobrarán según lo acordado con el conductor.
                        </>
                      )}
                    </p>
                  </div>
                  {solicitud.fecha_inicio_cobro_semanal ? (
                    <div className="rounded-xl bg-green-50/90 border border-green-100 p-4 space-y-1">
                      <p className="text-sm text-green-800/90 leading-relaxed">
                        Cobro semanal iniciado desde el <strong className="text-green-900">{formatDateFlex(solicitud.fecha_inicio_cobro_semanal)}</strong>.
                      </p>
                      {solicitud.placa_asignada ? (
                        <p className="text-sm text-green-800/90">
                          Placa asignada: <strong className="text-green-900 font-mono tracking-wide">{solicitud.placa_asignada}</strong>
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {!solicitud.fecha_inicio_cobro_semanal ? (
                    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-2">
                      <label htmlFor="placa-yego-mi-auto" className="block text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                        Placa asignada (vehículo entregado)
                      </label>
                      <p className="text-xs text-gray-500">
                        Modelo: <span className="font-medium text-gray-700">{solicitud.cronograma_vehiculo?.name || '—'}</span>
                      </p>
                      <input
                        id="placa-yego-mi-auto"
                        type="text"
                        autoComplete="off"
                        value={placaParaGenerar}
                        onChange={(e) => setPlacaParaGenerar(e.target.value.toUpperCase())}
                        placeholder="Ej. ABC123"
                        className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-gray-900 font-mono tracking-wide placeholder:text-gray-400 focus:ring-2 focus:ring-[#8B1A1A]/30 focus:border-[#8B1A1A] outline-none"
                        maxLength={20}
                        disabled={actionLoading}
                      />
                    </div>
                  ) : null}
                </div>
                <div className="px-6 py-5 border-t border-gray-100 bg-gray-50/80 flex flex-col sm:flex-row gap-3">
                  {solicitud.fecha_inicio_cobro_semanal ? (
                    <button type="button" onClick={() => setShowSimularCuotasModal(false)} className="w-full px-4 py-3 bg-[#8B1A1A] text-white rounded-xl hover:bg-[#6B1515] font-medium transition-colors shadow-sm">
                      Entendido
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={actionLoading}
                        onClick={async () => {
                          const placa = placaParaGenerar.trim();
                          if (!placa) {
                            toast.error('Indica la placa asignada del vehículo');
                            return;
                          }
                          try {
                            setActionLoading(true);
                            await api.patch(`/miauto/solicitudes/${id}/generar-yego-mi-auto`, { placa_asignada: placa });
                            toast.success('Yego Mi Auto generado; cobro semanal iniciado');
                            setShowSimularCuotasModal(false);
                            await fetchDetail(true);
                          } catch (e: any) {
                            toast.error(e.response?.data?.message || 'Error al generar Yego Mi Auto');
                          } finally {
                            setActionLoading(false);
                          }
                        }}
                        className="flex-1 px-4 py-3 bg-[#8B1A1A] text-white rounded-xl hover:bg-[#6B1515] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm inline-flex items-center justify-center gap-2"
                      >
                        {actionLoading ? (
                          <>
                            <Loader2 className="w-5 h-5 animate-spin flex-shrink-0" aria-hidden />
                            <span>Generando…</span>
                          </>
                        ) : (
                          'Generar Yego Mi Auto'
                        )}
                      </button>
                      <button type="button" onClick={() => setShowSimularCuotasModal(false)} disabled={actionLoading} className="px-4 py-3 border border-gray-200 text-gray-700 rounded-xl hover:bg-white hover:border-gray-300 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        Cerrar
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>,
            document.body
          )}

          {solicitud.status === 'aprobado' && (
            <CronogramaPagoSection
              solicitud={solicitud}
              cronogramasList={cronogramasList}
              loadingCronogramas={loadingCronogramas}
              tipoCambio={tipoCambio}
              selectedCronogramaForVehicles={selectedCronogramaForVehicles}
              setSelectedCronogramaForVehicles={setSelectedCronogramaForVehicles}
              selectedVehiculoId={selectedVehiculoId}
              setSelectedVehiculoId={setSelectedVehiculoId}
              pendingPagoTipo={pendingPagoTipo}
              setPendingPagoTipo={setPendingPagoTipo}
              pasoCronogramaPago={pasoCronogramaPago}
              setPasoCronogramaPago={setPasoCronogramaPago}
              pagoSectionOpen={pagoSectionOpen}
              setPagoSectionOpen={setPagoSectionOpen}
              actionLoading={actionLoading}
              onGuardarCronogramaPago={handleGuardarCronogramaPago}
              onValidarComprobante={handleValidarComprobante}
              onRechazarComprobante={handleRechazarComprobante}
              onAgregarComprobante={handleAgregarComprobante}
              onAgregarPagoManual={handleAgregarPagoManual}
              validandoComprobanteId={validandoComprobanteId}
              rechazandoComprobanteId={rechazandoComprobanteId}
              getAdjuntoUrl={getAdjuntoUrl}
            />
          )}

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">Flujo de la solicitud</h2>
            </div>
            <div className="p-4">
              <div className="flex flex-col">
                {flowSteps.map((step, index) => {
                  const Icon = step.icon;
                  const isActive = index === currentFlowIndex;
                  const isPast = index < currentFlowIndex;
                  const isAprobadoPath = solicitud.status === 'aprobado';
                  const isDesistidoStep = step.key === 'desistido';
                  const stepBg = isDesistidoStep
                    ? (isActive ? 'bg-gray-500 text-white' : isPast ? 'bg-gray-100 text-gray-700' : 'bg-gray-200 text-gray-500')
                    : isActive
                      ? (isAprobadoPath ? 'bg-green-600 text-white' : 'bg-[#8B1A1A] text-white')
                      : isPast
                        ? (isAprobadoPath ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800')
                        : 'bg-gray-200 text-gray-500';
                  const lineBg = index < currentFlowIndex ? (isDesistidoStep ? 'bg-gray-200' : isAprobadoPath ? 'bg-green-200' : 'bg-red-200') : 'bg-gray-200';
                  const textCl = isDesistidoStep ? (isActive ? 'text-gray-800' : isPast ? 'text-gray-700' : 'text-gray-500') : isActive ? (isAprobadoPath ? 'text-green-700' : 'text-[#8B1A1A]') : isPast ? (isAprobadoPath ? 'text-green-700' : 'text-red-700') : 'text-gray-500';
                  return (
                    <div key={step.key} className="flex items-start gap-3">
                      <div className="flex flex-col items-center">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${stepBg}`}>
                          <Icon className="w-5 h-5" />
                        </div>
                        {index < flowSteps.length - 1 && <div className={`w-0.5 h-8 ${lineBg}`} />}
                      </div>
                      <div className={index < flowSteps.length - 1 ? 'pb-1' : ''}>
                        <span className={`text-sm font-medium ${textCl}`}>
                          {step.label}
                          {isActive && <span className="ml-1.5 text-gray-400">←</span>}
                        </span>
                        {step.key === 'pendiente' && (isPast || isActive) && solicitud?.created_at && (
                          <p className="text-xs text-gray-500 mt-0.5">
                            Creada: {formatDateFlex(solicitud.created_at)}
                          </p>
                        )}
                        {step.key === 'citado' && (isPast || isActive) && (
                          <>
                            {Array.isArray(solicitud.citas_historial) && solicitud.citas_historial.length > 0 ? (
                              solicitud.citas_historial.map((c: { id: string; tipo: string; appointment_date: string; resultado?: string }, idx: number) => {
                                const isLast = idx === solicitud.citas_historial.length - 1;
                                const esCitaReagendada = c.tipo === 'cita_reagendada';
                                return (
                                  <p key={c.id} className={`text-xs mt-0.5 flex items-center gap-1 ${esCitaReagendada ? 'text-amber-700' : 'text-gray-500'}`}>
                                    {esCitaReagendada ? 'Cita reagendada' : 'Cita programada'}: {formatDateFlex(c.appointment_date)}
                                    {c.resultado === 'no_llego' && <span className="text-red-600 font-medium"> (no llegó)</span>}
                                    {c.resultado === 'llego' && <span className="text-green-700 font-medium"> (llegó)</span>}
                                    {isLast && solicitud.status === 'citado' && !ultimaCitaLlego && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const raw = looksLikeFullDate(solicitud?.appointment_date) ? solicitud?.appointment_date : solicitud?.cited_at;
                                          const { date, time } = isoToLocalDateAndTime(raw ?? undefined);
                                          setEditCitaDate(date);
                                          setEditCitaTime(time);
                                          setModalEditarCita(true);
                                        }}
                                        disabled={actionLoading}
                                        className="p-0.5 rounded hover:bg-gray-100 text-gray-400 hover:text-[#8B1A1A] disabled:opacity-50"
                                        title="Editar fecha de cita"
                                        aria-label="Editar fecha de cita"
                                      >
                                        <Pencil className="w-3 h-3" />
                                      </button>
                                    )}
                                  </p>
                                );
                              })
                            ) : (solicitud?.cited_at || solicitud?.appointment_date) ? (
                              <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                                Cita: {formatCitaDisplay(solicitud.appointment_date, solicitud.cited_at)}
                                {solicitud.status === 'citado' && !ultimaCitaLlego && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const raw = looksLikeFullDate(solicitud?.appointment_date) ? solicitud?.appointment_date : solicitud?.cited_at;
                                      const { date, time } = isoToLocalDateAndTime(raw ?? undefined);
                                      setEditCitaDate(date);
                                      setEditCitaTime(time);
                                      setModalEditarCita(true);
                                    }}
                                    disabled={actionLoading}
                                    className="p-0.5 rounded hover:bg-gray-100 text-gray-400 hover:text-[#8B1A1A] disabled:opacity-50"
                                    title="Editar fecha de cita"
                                    aria-label="Editar fecha de cita"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                )}
                              </p>
                            ) : null}
                          </>
                        )}
                        {step.key === 'aprobado' && (isPast || isActive) && solicitud?.reviewed_at && (
                          <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                            Aprobado: {formatDateFlex(solicitud.reviewed_at)}
                            {solicitud.status === 'aprobado' && (
                              <button
                                type="button"
                                onClick={() => setShowDesistirModal(true)}
                                disabled={actionLoading}
                                className="p-0.5 rounded hover:bg-gray-100 text-gray-400 hover:text-[#8B1A1A] disabled:opacity-50"
                                title="Conductor ya no quiere – marcar como Desistido"
                                aria-label="Marcar como Desistido"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                            )}
                          </p>
                        )}
                        {step.key === 'desistido' && (isPast || isActive) && (solicitud?.withdrawn_at || solicitud?.reviewed_at) && (
                          <div className="text-xs text-gray-500 mt-0.5 space-y-0.5">
                            <p>Desistido: {formatDateFlex((solicitud as any).withdrawn_at || solicitud.reviewed_at)}</p>
                            {(solicitud as any).withdrawal_reason && (
                              <p className="text-gray-600">Motivo: {(solicitud as any).withdrawal_reason}</p>
                            )}
                          </div>
                        )}
                        {step.key === 'rechazado' && (isPast || isActive) && solicitud?.reviewed_at && (
                          <p className="text-xs text-gray-500 mt-0.5">
                            {formatDateFlex(solicitud.reviewed_at)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {imagePreviewUrl &&
        createPortal(
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4" style={{ zIndex: 9999 }} onClick={() => setImagePreviewUrl(null)} role="dialog" aria-modal="true" aria-label="Vista previa de imagen">
            <button type="button" onClick={() => setImagePreviewUrl(null)} className="absolute top-4 right-4 p-2 rounded-full bg-white/90 text-gray-800 hover:bg-white z-10" aria-label="Cerrar">
              <X className="w-6 h-6" />
            </button>
            <img src={imagePreviewUrl} alt="Vista previa" className="max-w-full max-h-[90vh] object-contain" onClick={(e) => e.stopPropagation()} />
          </div>,
          document.body
        )}

      {showStatusModal &&
        createPortal(
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4" style={{ zIndex: 9999 }} role="dialog" aria-modal="true" aria-label={statusModalTitle}>
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 mb-4">{statusModalTitle}</h3>
              <div className="space-y-3">
                {newStatus === 'citado' && (
                  <DateTimePicker
                    label="Fecha y hora de cita"
                    value={newAppointmentDate && newAppointmentTime ? `${newAppointmentDate}T${newAppointmentTime}` : ''}
                    onChange={handleAppointmentChange}
                    minDate={getTodayISO()}
                    placeholder="Elegir fecha y hora"
                  />
                )}
                {newStatus === 'rechazado' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Motivo (opcional)</label>
                    <textarea value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg mt-1" rows={2} />
                  </div>
                )}
              </div>
              <div className="flex gap-2 mt-6">
                <button type="button" onClick={closeStatusModal} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg">Cancelar</button>
                <button type="button" onClick={handleChangeStatus} disabled={actionLoading || (newStatus === 'citado' && (!newAppointmentDate?.trim() || !newAppointmentTime?.trim()))} className="flex-1 px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] disabled:opacity-50">Guardar</button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {modalReprogramar &&
        createPortal(
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4" style={{ zIndex: 9999 }} role="dialog" aria-modal="true" aria-label="Reprogramar cita">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 mb-4">Reprogramar cita</h3>
              <p className="text-sm mb-3">
                <span className="text-gray-600">Citas agendadas: </span>
                <span className={`font-semibold ${(solicitud.reagendo_count ?? 0) >= MAX_REAGENDOS ? 'text-amber-700' : 'text-gray-900'}`}>{solicitud.reagendo_count ?? 0} / {MAX_REAGENDOS}</span>
              </p>
              <div className="space-y-3">
                <DateTimePicker
                  label="Nueva fecha y hora de cita"
                  value={newAppointmentDate && newAppointmentTime ? `${newAppointmentDate}T${newAppointmentTime}` : ''}
                  onChange={handleAppointmentChange}
                  minDate={getTodayISO()}
                  placeholder="Elegir fecha y hora"
                />
              </div>
              <div className="flex gap-2 mt-6">
                <button type="button" onClick={() => { setModalReprogramar(false); setNewAppointmentDate(''); setNewAppointmentTime('09:00'); }} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg">Cancelar</button>
                <button type="button" onClick={handleReprogramar} disabled={actionLoading || !newAppointmentDate?.trim() || !newAppointmentTime?.trim()} className="flex-1 px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] disabled:opacity-50">Reprogramar</button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {modalEditarCita &&
        createPortal(
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4" style={{ zIndex: 9999 }} role="dialog" aria-modal="true" aria-label="Editar fecha de cita">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 mb-4">Editar fecha de cita</h3>
              <p className="text-sm text-gray-600 mb-3">Corrige la fecha u hora si te equivocaste. No cuenta como reprogramación.</p>
              <div className="space-y-3">
                <DateTimePicker
                  label="Fecha y hora de cita"
                  value={editCitaDate && editCitaTime ? `${editCitaDate}T${editCitaTime}` : ''}
                  onChange={handleEditarCitaAppointmentChange}
                  minDate={getTodayISO()}
                  placeholder="Elegir fecha y hora"
                />
              </div>
              <div className="flex gap-2 mt-6">
                <button type="button" onClick={() => { setModalEditarCita(false); setEditCitaDate(''); setEditCitaTime('09:00'); }} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg">Cancelar</button>
                <button type="button" onClick={handleEditarCita} disabled={actionLoading || !editCitaDate?.trim() || !editCitaTime?.trim()} className="flex-1 px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] disabled:opacity-50">Guardar</button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {showAprobarModal &&
        createPortal(
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4" style={{ zIndex: 9999 }} role="dialog" aria-modal="true" aria-label="Confirmar aprobación">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 mb-2">Confirmar aprobación</h3>
              <p className="text-sm text-gray-600 mb-4">
                ¿Aprobar esta solicitud? Se registrará que <strong>{userName}</strong> realizó la aprobación.
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowAprobarModal(false)} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
                  Cancelar
                </button>
                <button type="button" onClick={handleAprobar} disabled={actionLoading} className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50">
                  Sí, aprobar
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {showDesistirModal &&
        createPortal(
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4" style={{ zIndex: 9999 }} role="dialog" aria-modal="true" aria-label="Marcar como Desistido">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 mb-2">¿El conductor ya no quiere?</h3>
              <p className="text-sm text-gray-600 mb-4">Se marcará la solicitud como <strong>Desistido</strong>. El conductor podrá crear otra solicitud más adelante si lo desea.</p>
              <div className="mb-5">
                <label htmlFor="desistido-motivo" className="block text-sm font-medium text-gray-700 mb-1">¿Por qué desistió?</label>
                <textarea
                  id="desistido-motivo"
                  value={desistidoMotivo}
                  onChange={(e) => setDesistidoMotivo(e.target.value)}
                  placeholder="Motivo (opcional)"
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A] text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => { setShowDesistirModal(false); setDesistidoMotivo(''); }} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg">Cancelar</button>
                <button type="button" onClick={handleDesistir} disabled={actionLoading} className="flex-1 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50">Sí, desistido</button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
