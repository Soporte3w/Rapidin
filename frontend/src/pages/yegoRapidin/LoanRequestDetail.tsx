import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, User, FileText, Calculator, CheckCircle, AlertCircle, Copy, Clock, XCircle, Image as ImageIcon, CreditCard, Loader2, RefreshCw } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { useAuth } from '../../contexts/AuthContext';
import { AdminModalPortal } from '../../components/AdminModalPortal';
import { formatCurrency, getCurrencyLabel } from '../../utils/currency';
import { formatDateTimeLocal } from '../../utils/date';

const DOC_LABELS: Record<string, string> = {
  id_document: 'Foto DNI del conductor (parte frontal)',
  contract_signature: 'Firma del conductor (contrato)',
  contact_front_photo: 'Foto DNI del garante (parte frontal)',
  contact_signature: 'Firma del garante'
};

const DOC_ORDER_ALL: string[] = ['id_document', 'contract_signature', 'contact_front_photo', 'contact_signature'];
const DOC_ORDER_SIN_GARANTE: string[] = ['id_document', 'contract_signature'];

const documentFileCache = new Map<string, string>();
const documentFetchPending = new Map<string, Promise<string>>();

function DataRow({ label, value = '—', mono, highlight, custom, copyable }: { label: string; value?: string; mono?: boolean; highlight?: boolean; custom?: React.ReactNode; copyable?: boolean }) {
  const strValue = value != null ? String(value) : '—';
  const canCopy = copyable && strValue && strValue !== '—';
  const handleCopy = () => {
    if (!canCopy) return;
    navigator.clipboard.writeText(strValue).then(() => toast.success('Copiado al portapapeles')).catch(() => toast.error('No se pudo copiar'));
  };
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</dt>
      <dd className={`text-sm flex items-center gap-1.5 min-w-0 ${highlight ? 'font-semibold text-gray-900' : 'text-gray-900'} ${mono ? 'font-mono' : ''}`}>
        <span className="min-w-0 truncate">{custom !== undefined ? custom : strValue}</span>
        {canCopy && (
          <button type="button" onClick={handleCopy} className="flex-shrink-0 p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors" title="Copiar">
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
      </dd>
    </div>
  );
}

const LIGHTBOX_ZOOM_MIN = 0.25;
const LIGHTBOX_ZOOM_MAX = 5;

function clampLightboxZoom(z: number) {
  return Math.min(LIGHTBOX_ZOOM_MAX, Math.max(LIGHTBOX_ZOOM_MIN, z));
}

function DocumentThumb({ requestId, doc }: { requestId: string; doc: { id: string; type: string; file_name: string } }) {
  const cacheKey = `${requestId}-${doc.id}`;
  const cachedUrl = documentFileCache.get(cacheKey);
  const [src, setSrc] = useState<string | null>(cachedUrl ?? null);
  const [loading, setLoading] = useState(!cachedUrl);
  const [error, setError] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const objectUrlRef = useRef<string | null>(cachedUrl ?? null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const lightboxTouchAreaRef = useRef<HTMLDivElement>(null);
  const lightboxZoomRef = useRef(1);
  const pinchRef = useRef<{ d0: number; z0: number } | null>(null);
  const isPdf = /\.pdf$/i.test(doc.file_name);

  lightboxZoomRef.current = lightboxZoom;

  useEffect(() => {
    if (!lightboxOpen) {
      setLightboxZoom(1);
      pinchRef.current = null;
      return;
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [lightboxOpen]);

  useEffect(() => {
    if (!lightboxOpen) return;
    const el = lightboxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
        setLightboxZoom((z) => clampLightboxZoom(z * factor));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [lightboxOpen]);

  useEffect(() => {
    if (!lightboxOpen) return;
    const el = lightboxTouchAreaRef.current;
    if (!el) return;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchRef.current = { d0: Math.hypot(dx, dy), z0: lightboxZoomRef.current };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !pinchRef.current) return;
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const d = Math.hypot(dx, dy);
      const { d0, z0 } = pinchRef.current;
      if (d0 > 0) setLightboxZoom(clampLightboxZoom(z0 * (d / d0)));
    };
    const onTouchEnd = () => {
      pinchRef.current = null;
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [lightboxOpen]);

  useEffect(() => {
    if (documentFileCache.has(cacheKey)) {
      const url = documentFileCache.get(cacheKey)!;
      setSrc(url);
      setLoading(false);
      objectUrlRef.current = url;
      return;
    }
    let cancelled = false;
    const load = async () => {
      const existing = documentFetchPending.get(cacheKey);
      if (existing) {
        try {
          const url = await existing;
          if (!cancelled) {
            setSrc(url);
            setLoading(false);
            objectUrlRef.current = url;
          }
        } catch {
          if (!cancelled) setError(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }
      const promise = (async () => {
        const res = await api.get(`/loan-requests/${requestId}/documents/${doc.id}/file`, { responseType: 'blob' });
        const url = URL.createObjectURL(res.data);
        documentFileCache.set(cacheKey, url);
        documentFetchPending.delete(cacheKey);
        return url;
      })();
      documentFetchPending.set(cacheKey, promise);
      try {
        const url = await promise;
        if (cancelled) return;
        objectUrlRef.current = url;
        setSrc(url);
      } catch {
        documentFetchPending.delete(cacheKey);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (objectUrlRef.current && !documentFileCache.has(cacheKey)) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = null;
    };
  }, [requestId, doc.id, cacheKey]);

  const label = DOC_LABELS[doc.type] || doc.type;

  const cardClass = 'border border-gray-200 rounded-md p-2 bg-gray-50';
  const labelClass = 'text-xs font-medium text-gray-700 mb-1';
  const thumbClass = 'aspect-[4/3] max-h-[100px] bg-gray-200 rounded flex items-center justify-center overflow-hidden';
  if (loading) {
    return (
      <div className={cardClass}>
        <p className={labelClass}>{label}</p>
        <div className={thumbClass}>
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-red-600 border-t-transparent" />
        </div>
      </div>
    );
  }
  if (error || !src) {
    return (
      <div className={cardClass}>
        <p className={labelClass}>{label}</p>
        <div className="aspect-[4/3] max-h-[100px] bg-gray-100 rounded flex items-center justify-center text-gray-500 text-xs">
          No disponible
        </div>
      </div>
    );
  }
  if (isPdf) {
    return (
      <div className={cardClass}>
        <p className={labelClass}>{label}</p>
        <a href={src} target="_blank" rel="noopener noreferrer" className="text-red-600 text-xs font-medium hover:underline">
          Ver PDF
        </a>
      </div>
    );
  }
  return (
    <>
      <div className={cardClass}>
        <p className={labelClass}>{label}</p>
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="aspect-[4/3] max-h-[100px] w-full rounded border border-gray-200 bg-white overflow-hidden flex items-center justify-center cursor-pointer hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
        >
          <img src={src} alt={label} className="max-w-full max-h-[100px] w-auto h-auto object-contain pointer-events-none" />
        </button>
      </div>
      {lightboxOpen && (
        <div
          ref={lightboxRef}
          className="fixed inset-0 z-50 flex flex-col bg-black/80 overscroll-contain select-none"
          onClick={() => setLightboxOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Ver imagen"
        >
          <button
            type="button"
            onClick={() => setLightboxOpen(false)}
            className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-white"
            aria-label="Cerrar"
          >
            <XCircle className="w-8 h-8" />
          </button>
          <p className="absolute top-4 left-4 right-16 z-10 text-white/70 text-xs sm:text-sm pointer-events-none">
            Zoom: Ctrl + rueda (o pellizco en el móvil)
          </p>
          <div
            ref={lightboxTouchAreaRef}
            className="flex-1 min-h-0 w-full flex items-center justify-center overflow-auto overscroll-contain touch-pan-x touch-pan-y p-4 pt-14"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={src}
              alt={label}
              className="max-w-[min(100%,95vw)] max-h-[min(90vh,100%)] w-auto h-auto object-contain rounded shadow-2xl origin-center will-change-transform"
              style={{ transform: `scale(${lightboxZoom})` }}
              onClick={(e) => e.stopPropagation()}
              draggable={false}
            />
          </div>
        </div>
      )}
    </>
  );
}

const requestDetailCache = new Map<string, { request: any; simulationOptions: any }>();

function parseRequestObservations(request: any): Record<string, any> {
  if (!request?.observations) return {};
  try {
    return typeof request.observations === 'string' ? JSON.parse(request.observations) : { ...request.observations };
  } catch {
    return {};
  }
}

function getSimulationOption(simulationOptions: any): any {
  if (!simulationOptions) return null;
  const option = simulationOptions?.option ?? (Array.isArray(simulationOptions) ? simulationOptions[0] : Object.values(simulationOptions || {}).find((o: any) => o && typeof o === 'object' && 'weeks' in o));
  return option && typeof option === 'object' ? option : null;
}

type LoanRequestsSearchState = {
  fromLoanRequestsSearch?: boolean;
  fromRequestDetail?: boolean;
  driver?: string;
  driverSearchInput?: string;
  status?: string;
  country?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
};

const LoanRequestDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user: authUser } = useAuth();

  const getBackToRequestsState = (): LoanRequestsSearchState | undefined => {
    const s = location.state as LoanRequestsSearchState | null;
    if (!s?.fromLoanRequestsSearch) return undefined;
    return {
      fromRequestDetail: true,
      driver: s.driver ?? '',
      driverSearchInput: s.driverSearchInput ?? s.driver ?? '',
      status: s.status ?? '',
      country: s.country ?? '',
      date_from: s.date_from ?? '',
      date_to: s.date_to ?? '',
      page: s.page ?? 1,
      limit: s.limit ?? 10,
    };
  };
  const [request, setRequest] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [simulationOptions, setSimulationOptions] = useState<any>(null);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [loadingSendMessage, setLoadingSendMessage] = useState(false);
  const [showConfirmApproveModal, setShowConfirmApproveModal] = useState(false);
  const [showConfirmDisburseModal, setShowConfirmDisburseModal] = useState(false);
  const [showConfirmDisburseBankModal, setShowConfirmDisburseBankModal] = useState(false);
  const [firstPaymentToday, setFirstPaymentToday] = useState(false);
  const [disburseComment, setDisburseComment] = useState('');
  const [disburseAmount, setDisburseAmount] = useState<string>('');
  const [rechargeSuccess, setRechargeSuccess] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [loadingApprove, setLoadingApprove] = useState(false);
  const [loadingDisburse, setLoadingDisburse] = useState(false);
  const [loadingRecharge, setLoadingRecharge] = useState(false);
  const [fleetRechargeUseManual, setFleetRechargeUseManual] = useState(false);
  const [fleetRechargeErrorMessage, setFleetRechargeErrorMessage] = useState('');
  const fetchedIdRef = useRef<string | null>(null);
  const isApprovingRef = useRef(false);
  const isDisbursingRef = useRef(false);

  const currentUserName = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || 'Usuario';
  const isSunday = new Date().getDay() === 0;

  const fetchPlan = async (requestId: string) => {
    try {
      const response = await api.post('/loan-simulation/simulate', { request_id: requestId });
      const data = response.data.data || response.data;
      setSimulationOptions(data);
      return data;
    } catch (error: any) {
      console.error('Error loading plan:', error);
      setSimulationOptions(null);
      return null;
    }
  };

  useEffect(() => {
    if (!id) return;
    const cached = requestDetailCache.get(id);
    if (cached) {
      setRequest(cached.request);
      setSimulationOptions(cached.simulationOptions);
      setLoading(false);
      return;
    }
    if (fetchedIdRef.current === id) return;
    fetchedIdRef.current = id;
    setLoading(true);
    (async () => {
      const currentId = id;
      try {
        const response = await api.get(`/loan-requests/${currentId}`);
        const data = response.data.data || response.data;
        if (fetchedIdRef.current !== currentId) return;
        setRequest(data);
        let planData: any = null;
        if (data?.status === 'pending') {
          planData = await fetchPlan(currentId);
          if (fetchedIdRef.current !== currentId) return;
        }
        requestDetailCache.set(currentId, { request: data, simulationOptions: planData ?? null });
      } catch (error) {
        if (fetchedIdRef.current !== currentId) return;
        console.error('Error fetching request:', error);
        setRequest(null);
        setSimulationOptions(null);
      } finally {
        if (fetchedIdRef.current === currentId) fetchedIdRef.current = null;
        setLoading(false);
      }
    })();
  }, [id]);

  const prevIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = prevIdRef.current;
    prevIdRef.current = id ?? null;
    if (prevId && prevId !== id) {
      requestDetailCache.delete(prevId);
      for (const key of Array.from(documentFileCache.keys())) {
        if (key.startsWith(`${prevId}-`)) {
          const url = documentFileCache.get(key);
          if (url) URL.revokeObjectURL(url);
          documentFileCache.delete(key);
          documentFetchPending.delete(key);
        }
      }
    }
    return () => {
      if (id) {
        requestDetailCache.delete(id);
        for (const key of Array.from(documentFileCache.keys())) {
          if (key.startsWith(`${id}-`)) {
            const url = documentFileCache.get(key);
            if (url) URL.revokeObjectURL(url);
            documentFileCache.delete(key);
            documentFetchPending.delete(key);
          }
        }
      }
    };
  }, [id]);

  const handleConfirmApply = async () => {
    if (isApprovingRef.current) return;
    const rawOption = getSimulationOption(simulationOptions);
    if (!rawOption) {
      toast.error('No hay plan cargado');
      return;
    }
    const principal = parseFloat(request?.requested_amount || 0) || 0;
    const totalInt = rawOption.totalInterest != null ? parseFloat(rawOption.totalInterest) : 0;
    const totalAmt = rawOption.totalAmount != null ? parseFloat(rawOption.totalAmount) : 0;
    const correctedTotal = totalAmt >= principal + totalInt ? totalAmt : principal + totalInt;
    const selectedOption = { ...rawOption, totalAmount: correctedTotal };

    isApprovingRef.current = true;
    setLoadingApprove(true);
    try {
      await api.post('/loan-simulation/apply-option', {
        request_id: id,
        option: selectedOption,
      });
      toast.success('Solicitud aprobada. Realice el desembolso cuando corresponda.');
      const res = await api.get(`/loan-requests/${id}`);
      setRequest(res.data.data || res.data);
      setShowConfirmApproveModal(false);
    } catch (error: any) {
      console.error('Error applying option:', error);
      toast.error(error.response?.data?.message || 'Error al aplicar la opción');
    } finally {
      isApprovingRef.current = false;
      setLoadingApprove(false);
    }
  };

  const handleDisburse = async () => {
    if (isDisbursingRef.current) return;
    isDisbursingRef.current = true;
    setLoadingDisburse(true);
    try {
      await api.post('/loan-simulation/disburse', {
        request_id: id,
        ...(firstPaymentToday && { first_payment_today: true }),
      });
      toast.success('Desembolso realizado. Cronograma generado.');
      const res = await api.get(`/loan-requests/${id}`);
      setRequest(res.data.data || res.data);
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Error al desembolsar');
    } finally {
      isDisbursingRef.current = false;
      setLoadingDisburse(false);
    }
  };

  const handleRejectSubmit = async () => {
    const reason = rejectReason.trim();
    if (!reason) {
      toast.error('Indica el motivo del rechazo');
      return;
    }
    try {
      await api.post(`/loan-requests/${id}/reject`, { reason });
      toast.success('Solicitud rechazada');
      navigate('/admin/loan-requests', { state: getBackToRequestsState() });
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Error al rechazar la solicitud');
    }
  };

  const handleConfirmRejectWithChannels = async () => {
    const reason = rejectReason.trim();
    if (!reason) {
      toast.error('Indica el motivo del rechazo');
      return;
    }
    setLoadingSendMessage(true);
    try {
      await sendMessageViaRapidin(reason);
      await handleRejectSubmit();
    } catch {
      // sendMessageViaRapidin o handleRejectSubmit ya muestran toast
    } finally {
      setLoadingSendMessage(false);
    }
  };

  const sendMessageViaRapidin = async (message: string) => {
    const msg = message.trim();
    if (!msg) {
      toast.error('Escribe el mensaje a enviar');
      return;
    }
    if (!id) return;
    setLoadingSendMessage(true);
    try {
      await api.post(`/loan-requests/${id}/send-message`, { message: msg });
      toast.success('Mensaje enviado por Rapidín');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Error al enviar el mensaje');
      throw error;
    } finally {
      setLoadingSendMessage(false);
    }
  };

  const handleCopyId = async (requestId: string) => {
    try {
      await navigator.clipboard.writeText(requestId);
      toast.success('ID copiado con éxito');
    } catch (error) {
      // Fallback para navegadores que no soportan clipboard API
      const textArea = document.createElement('textarea');
      textArea.value = requestId;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      toast.success('ID copiado con éxito');
    }
  };

  const getStatusBadge = (status: string) => {
    const badges: Record<string, { color: string; icon: any; text: string }> = {
      pending: {
        color: 'bg-yellow-100 text-yellow-800',
        icon: Clock,
        text: 'Pendiente'
      },
      approved: {
        color: 'bg-purple-100 text-purple-800',
        icon: CheckCircle,
        text: 'Aprobado'
      },
      rejected: {
        color: 'bg-red-100 text-red-800',
        icon: XCircle,
        text: 'Rechazado'
      },
      disbursed: {
        color: 'bg-green-100 text-green-800',
        icon: CheckCircle,
        text: 'Desembolsado'
      },
      cancelled: {
        color: 'bg-gray-100 text-gray-800',
        icon: XCircle,
        text: 'Cancelado'
      }
    };
    const badge = badges[status] || badges.pending;
    const Icon = badge.icon;
    return (
      <span className={`inline-flex items-center space-x-1 px-3 py-1 rounded-full text-sm font-medium ${badge.color}`}>
        <Icon className="w-4 h-4" />
        <span>{badge.text}</span>
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-red-600 border-t-transparent mx-auto mb-4" />
          <p className="text-gray-600">Cargando detalles de la solicitud...</p>
        </div>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="bg-red-50 border-2 border-red-200 rounded-full p-4 mb-4">
          <AlertCircle className="w-12 h-12 text-red-600" />
        </div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Solicitud no encontrada</h3>
        <p className="text-gray-600 mb-6 text-center max-w-md">No se pudo cargar la información de la solicitud</p>
        <button
          onClick={() => navigate('/admin/loan-requests', { state: getBackToRequestsState() })}
          className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-lg font-medium hover:from-red-700 hover:to-red-800 transition-all shadow-md"
        >
          Volver a Solicitudes
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Botón Volver */}
      <button
        onClick={() => navigate('/admin/loan-requests', { state: getBackToRequestsState() })}
        className="inline-flex items-center gap-2 text-gray-600 hover:text-red-600 transition-colors text-sm font-medium"
      >
        <ArrowLeft className="h-4 w-4" />
        Volver a Solicitudes
      </button>

      {/* Header */}
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
                Detalle de Solicitud
              </h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                Información completa de la solicitud de préstamo
              </p>
            </div>
          </div>
          {request.id && (
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-xs text-white/70 mb-1">ID</p>
                <button
                  onClick={() => handleCopyId(request.id)}
                  className="flex items-center gap-2 text-white hover:text-gray-200 transition-colors group"
                  title="Click para copiar ID"
                >
                  <span className="text-sm font-mono">{request.id.substring(0, 8)}...</span>
                  <Copy className="w-3.5 h-3.5 opacity-70 group-hover:opacity-100" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Cards de información */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 border-b border-gray-100">
            <div className="w-9 h-9 bg-red-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <User className="h-4 w-4 text-red-600" />
            </div>
            <h2 className="text-sm font-semibold text-gray-900">Información del Conductor</h2>
          </div>
          <dl className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <DataRow label="Nombre" value={`${request.driver_first_name || ''} ${request.driver_last_name || ''}`.trim() || '—'} />
            <DataRow label="Licencia" value={String(request.driver_licencia || request.dni || '—')} mono copyable />
            <DataRow label="DNI" value={request.dni || '—'} mono copyable />
            <DataRow label="Ciclo" value={(request.cycle ?? request.driver_cycle) != null ? `Ciclo ${request.cycle ?? request.driver_cycle}` : '—'} highlight />
            <DataRow label="Flota" value={request.driver_partner_name || '—'} />
            <DataRow label="Teléfono" value={request.phone ? (request.phone.startsWith('+') ? request.phone : `+${request.phone}`) : '—'} copyable />
            <DataRow label="Email" value={request.email || '—'} />
          </dl>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 border-b border-gray-100">
            <div className="w-9 h-9 bg-red-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <FileText className="h-4 w-4 text-red-600" />
            </div>
            <h2 className="text-sm font-semibold text-gray-900">Información de la Solicitud</h2>
          </div>
          <dl className="p-4 space-y-3">
            <DataRow label="Monto solicitado" value={formatCurrency(parseFloat(request.requested_amount || 0), request.country || 'PE')} highlight />
            <DataRow label="País" value={request.country || '—'} />
            <DataRow label="Estado" value="" custom={<div className="mt-0.5">{getStatusBadge(request.status)}</div>} />
            {(() => {
              const purpose = parseRequestObservations(request).purpose;
              return purpose ? <DataRow label="Propósito" value={purpose} /> : null;
            })()}
            <DataRow label="Fecha de creación" value={request.created_at ? formatDateTimeLocal(request.created_at, 'es-PE') : '—'} />
            {request.approved_at && <DataRow label="Fecha de aprobación" value={formatDateTimeLocal(request.approved_at, 'es-PE')} />}
            {request.disbursed_at && <DataRow label="Fecha de desembolso" value={formatDateTimeLocal(request.disbursed_at, 'es-PE')} />}
          </dl>
        </div>

        {/* Cuenta para desembolso */}
        {(() => {
          const obs = parseRequestObservations(request);
          const depositType = obs.deposit_type || '';
          const bank = obs.bank || '';
          const accountNumber = obs.account_number || '';
          const bankAccountInputType = obs.bank_account_input_type || '';
          const accountType = (obs.account_type || '').toLowerCase();
          const savingsAccountCci = obs.savings_account_cci || '';
          if (!depositType && !bank && !accountNumber && !savingsAccountCci) return null;
          // Tipo de dato: prioridad bank_account_input_type (formulario) o account_type (import: savings/checking)
          const isCci = bankAccountInputType === 'cci' || !!savingsAccountCci;
          const isAhorros = bankAccountInputType === 'ahorros' || accountType === 'savings' || accountType === 'ahorros';
          const isCorriente = accountType === 'checking' || accountType === 'corriente';
          const tipoDatoLabel = isCci ? 'CCI' : isAhorros ? 'Cuenta de ahorro' : isCorriente ? 'Cuenta corriente' : accountType || '—';
          const showAccountNumber = accountNumber && (bankAccountInputType === 'ahorros' || isAhorros || isCorriente || !isCci);
          return (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 border-b border-gray-100">
                <div className="w-9 h-9 bg-red-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <CreditCard className="h-4 w-4 text-red-600" />
                </div>
                <h2 className="text-sm font-semibold text-gray-900">Cuenta para desembolso</h2>
              </div>
              <dl className="p-4 space-y-3">
                <DataRow label="Tipo de recepción" value={depositType === 'yango' ? 'Yango' : depositType === 'bank' ? 'Banco' : depositType || '—'} />
                {depositType === 'bank' && (
                  <>
                    <DataRow label="Banco" value={bank || '—'} />
                    <DataRow label="Tipo de cuenta" value={tipoDatoLabel === '—' ? '—' : tipoDatoLabel} />
                    {showAccountNumber && <DataRow label="Número de cuenta" value={accountNumber || '—'} mono copyable />}
                    {isCci && savingsAccountCci && <DataRow label="CCI (20 dígitos)" value={savingsAccountCci || '—'} mono copyable />}
                  </>
                )}
              </dl>
            </div>
          );
        })()}

        {/* Contacto / Garante */}
        {(() => {
          const obs = parseRequestObservations(request);
          const contactName = obs.contact_name || '';
          const contactDni = obs.contact_dni || '';
          const contactPhone = obs.contact_phone || '';
          const contactRelationship = obs.contact_relationship || '';
          if (!contactName && !contactDni && !contactPhone && !contactRelationship) return null;
          const formatContactPhone = (v: string) => {
            if (!v || typeof v !== 'string') return v;
            const trimmed = v.trim();
            if (trimmed.startsWith('+')) return trimmed;
            const digits = trimmed.replace(/\D/g, '');
            if (!digits) return trimmed;
            if (request.country === 'CO') {
              const d = digits.startsWith('57') && digits.length > 10 ? digits.slice(2) : digits;
              return `+57 ${d}`;
            }
            const d = digits.startsWith('51') && digits.length > 10 ? digits.slice(2) : digits;
            return `+51 ${d}`;
          };
          return (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 border-b border-gray-100">
                <div className="w-9 h-9 bg-red-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <User className="h-4 w-4 text-red-600" />
                </div>
                <h2 className="text-sm font-semibold text-gray-900">Contacto / Garante</h2>
              </div>
              <dl className="p-4 space-y-3">
                {contactName && <DataRow label="Nombre" value={contactName} />}
                {contactDni && <DataRow label="DNI" value={contactDni} mono copyable />}
                {contactPhone && <DataRow label="Teléfono" value={formatContactPhone(contactPhone)} copyable />}
                {contactRelationship && <DataRow label="Parentesco / Relación" value={contactRelationship} />}
              </dl>
            </div>
          );
        })()}
      </div>

      {/* Documentos y firmas: garante solo si la configuración del ciclo del conductor lo requiere (requires_guarantor) */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="border-b border-gray-200 px-3 py-2 bg-gray-50 flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-red-600" />
          <h2 className="text-sm font-semibold text-gray-900">Documentos y firmas</h2>
        </div>
        <div className={`p-3 grid grid-cols-2 ${request.requires_guarantor ? 'sm:grid-cols-4' : ''} gap-2`}>
          {(request.requires_guarantor ? DOC_ORDER_ALL : DOC_ORDER_SIN_GARANTE).map((type) => {
            const doc = request.documents?.find((d: { type: string }) => d.type === type);
            const label = DOC_LABELS[type] || type;
            if (doc) {
              return <DocumentThumb key={doc.id} requestId={request.id} doc={doc} />;
            }
            return (
              <div key={type} className="border border-dashed border-gray-300 rounded-md p-2 bg-gray-50">
                <p className="text-xs font-medium text-gray-700 mb-1">{label}</p>
                <div className="aspect-[4/3] max-h-[100px] bg-gray-100 rounded flex items-center justify-center text-gray-500 text-xs text-center px-1">
                  No enviado
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Plan de pago del conductor (mismo que vio al solicitar) */}
      {request.status === 'pending' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="border-b border-gray-200 px-4 py-3 bg-gray-50">
            <div className="flex items-center gap-2">
              <Calculator className="h-5 w-5 text-red-600" />
              <h2 className="text-base font-semibold text-gray-900">Plan de pago del conductor</h2>
            </div>
          </div>

          {!simulationOptions && (
            <div className="p-4">
              <p className="text-center text-sm text-gray-500 mb-4">No se pudo cargar el plan.</p>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowRejectForm(true)}
                  className="px-5 py-2.5 text-sm font-semibold text-gray-700 bg-white border-2 border-gray-300 hover:border-gray-400 rounded-lg flex items-center gap-2"
                >
                  <XCircle className="h-4 w-4" /> Rechazar
                </button>
              </div>
            </div>
          )}
          {simulationOptions && (() => {
            const option = getSimulationOption(simulationOptions);
            if (!option) return null;
            const principal = parseFloat(request.requested_amount || 0) || 0;
            const totalInterestVal = option.totalInterest != null ? parseFloat(option.totalInterest) : 0;
            const totalAmountVal = option.totalAmount != null ? parseFloat(option.totalAmount) : (principal + totalInterestVal);
            const displayTotal = totalAmountVal >= principal + totalInterestVal ? totalAmountVal : principal + totalInterestVal;
            const country = request.country || 'PE';
            return (
              <div className="p-4">
                <p className="text-sm text-gray-600 mb-4">Mismo plan que vio el conductor al solicitar. Revisa y confirma para aprobar el préstamo.</p>
                <div className="grid grid-cols-1 gap-4">
                  <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
                    <div className="border-b border-gray-200 pb-3 mb-3">
                      <h3 className="text-sm font-semibold text-gray-900">
                        Ciclo {request.driver_cycle ?? '—'} – {option.weeks} semanas
                      </h3>
                    </div>
                    <div className="space-y-2.5 mb-4">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-medium text-gray-600">Semanas:</span>
                        <span className="text-xs font-semibold text-gray-900">{option.weeks}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-medium text-gray-600">Cuota Semanal:</span>
                        <span className="text-xs font-semibold text-gray-900">{formatCurrency(parseFloat(option.weeklyInstallment || 0), country)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-medium text-gray-600">Última Cuota:</span>
                        <span className="text-xs font-semibold text-gray-900">{formatCurrency(parseFloat(option.lastInstallment || 0), country)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-medium text-gray-600">Tasa interés semanal:</span>
                        <span className="text-xs font-semibold text-gray-900">{option.interestRate ?? '—'}%</span>
                      </div>
                      {option.totalInterest != null && (
                        <div className="flex justify-between items-center">
                          <span className="text-xs font-medium text-gray-600">Interés total:</span>
                          <span className="text-xs font-semibold text-gray-900">{formatCurrency(parseFloat(option.totalInterest), country)}</span>
                        </div>
                      )}
                      <div className="flex justify-between items-center pt-2.5 border-t border-gray-200">
                        <span className="text-xs font-semibold text-gray-700">Monto Total:</span>
                        <span className="text-sm font-bold text-red-600">{formatCurrency(Number(displayTotal), country)}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-gray-200 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowRejectForm(true)}
                    className="px-5 py-2.5 text-sm font-semibold text-gray-700 bg-white border-2 border-gray-300 hover:border-gray-400 rounded-lg flex items-center gap-2"
                  >
                    <XCircle className="h-4 w-4" />
                    Rechazar
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowConfirmApproveModal(true)}
                    disabled={loadingApprove}
                    className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-semibold py-2.5 px-6 rounded-lg transition-all shadow-md flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loadingApprove ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                    {loadingApprove ? 'Procesando...' : 'Confirmar y aprobar préstamo'}
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Aprobado: botón Desembolsar (cronograma aún no existe) */}
      {request.status === 'approved' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="border-b border-gray-200 px-4 py-3 bg-amber-50">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-amber-600" />
              <h2 className="text-base font-semibold text-gray-900">Desembolso pendiente</h2>
            </div>
          </div>
          <div className="p-4">
            <p className="text-sm text-gray-600 mb-4">
              La solicitud está aprobada. Realice el desembolso para generar el préstamo y el cronograma de cuotas (lunes a sábado; los domingos no se puede desembolsar).
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowRejectForm(true)}
                className="px-5 py-2.5 text-sm font-semibold text-gray-700 bg-white border-2 border-gray-300 hover:border-gray-400 rounded-lg flex items-center gap-2"
              >
                <XCircle className="h-4 w-4" />
                Rechazar
              </button>
              <button
                type="button"
                onClick={() => {
                  const obs = parseRequestObservations(request);
                  const isBank = obs.deposit_type === 'bank';
                  if (isBank) {
                    setShowConfirmDisburseBankModal(true);
                    return;
                  }
                  setDisburseAmount(String(parseFloat(request?.requested_amount || '0') || ''));
                  setDisburseComment('');
                  setRechargeSuccess(false);
                  setFleetRechargeUseManual(false);
                  setFleetRechargeErrorMessage('');
                  setShowConfirmDisburseModal(true);
                }}
                disabled={loadingDisburse || isSunday}
                className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-semibold py-2.5 px-6 rounded-lg transition-all shadow-md flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingDisburse ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                {loadingDisburse ? 'Procesando...' : isSunday ? 'Desembolsar (no disponible domingos)' : 'Desembolsar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal confirmar desembolso a cuenta bancaria (solo confirmación) */}
      {showConfirmDisburseBankModal && request && (
        <AdminModalPortal>
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50" onClick={() => setShowConfirmDisburseBankModal(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                <CreditCard className="h-5 w-5 text-amber-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900">Confirmar desembolso</h3>
            </div>
            <p className="text-sm text-gray-600 mb-2">
              El desembolso se realizará a la <span className="font-semibold text-gray-900">cuenta bancaria</span> indicada por el conductor. Se generará el préstamo y el cronograma de cuotas.
            </p>
            <p className="text-sm text-gray-600 mb-6">
              Vas a realizar el desembolso como <span className="font-semibold text-gray-900">{currentUserName}</span>. ¿Continuar?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirmDisburseBankModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowConfirmDisburseBankModal(false);
                  setFirstPaymentToday(false);
                  await handleDisburse();
                }}
                disabled={loadingDisburse || isSunday}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingDisburse ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                {loadingDisburse ? 'Procesando...' : 'Confirmar desembolso'}
              </button>
            </div>
          </div>
        </div>
        </AdminModalPortal>
      )}

      {/* Modal confirmar desembolso: conductor, comentario, monto y Recargar (solo Yango Pro) */}
      {showConfirmDisburseModal && request && (() => {
        const obs = parseRequestObservations(request);
        const isYangoPro = obs.deposit_type === 'yango';
        return (
        <AdminModalPortal>
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50"
          onClick={() => {
            if (!rechargeSuccess && !loadingDisburse) {
              setShowConfirmDisburseModal(false);
              setFirstPaymentToday(false);
              setDisburseComment('');
              setDisburseAmount('');
              setRechargeSuccess(false);
              setFleetRechargeUseManual(false);
              setFleetRechargeErrorMessage('');
            }
          }}
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                <CreditCard className="h-5 w-5 text-amber-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900">Confirmar desembolso</h3>
            </div>

            <div className="space-y-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Conductor</label>
                <p className="text-sm font-semibold text-gray-900">
                  {[request.driver_first_name, request.driver_last_name].filter(Boolean).join(' ') || '—'}
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Monto</label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">{getCurrencyLabel(request.country || 'PE')}</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={disburseAmount}
                    readOnly
                    disabled
                    className="flex-1 border rounded-lg px-3 py-2 text-sm border-gray-200 bg-gray-100 text-gray-700 cursor-not-allowed"
                    placeholder={String(parseFloat(request.requested_amount || '0') || '')}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Comentario</label>
                <textarea
                  value={disburseComment}
                  onChange={(e) => setDisburseComment(e.target.value)}
                  placeholder="Comentario opcional para el desembolso..."
                  disabled={isYangoPro && rechargeSuccess}
                  className={`w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 resize-none ${isYangoPro && rechargeSuccess ? 'border-gray-200 bg-gray-100 text-gray-600 cursor-not-allowed' : 'border-gray-300'}`}
                  rows={3}
                />
              </div>
            </div>

            {isYangoPro ? (
                <div className="mb-4">
                  {rechargeSuccess ? (
                    <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                      <CheckCircle className="h-5 w-5 flex-shrink-0" />
                      Recarga lista (Yango Pro o registro manual). Ya puedes proceder con el desembolso.
                    </div>
                  ) : (
                    <>
                      {fleetRechargeUseManual && (
                        <p className="text-xs text-amber-700 mb-2">
                          Fleet tiene una transacción en curso o similar. Puedes registrar la recarga solo en el sistema con el botón de abajo (no se llama de nuevo a Yango).
                        </p>
                      )}
                      <button
                        type="button"
                        disabled={loadingRecharge || rechargeSuccess || !disburseAmount || Number(disburseAmount) <= 0}
                        onClick={async (e) => {
                          if (loadingRecharge || rechargeSuccess) return;
                          const amount = Number(disburseAmount);
                          if (!id || !amount || amount <= 0) {
                            toast.error('Indica un monto válido para recargar');
                            return;
                          }
                          setLoadingRecharge(true);
                          (e.currentTarget as HTMLButtonElement).blur();
                          try {
                            if (fleetRechargeUseManual) {
                              await api.post('/yango/recharge-manual', {
                                request_id: id,
                                amount: amount.toFixed(2),
                                note: disburseComment?.trim() || undefined,
                                fleet_error_snapshot: fleetRechargeErrorMessage || undefined,
                              });
                              toast.success('Recarga registrada en el sistema. Confirmando desembolso automáticamente...');
                            } else {
                              await api.post('/yango/recharge', {
                                request_id: id,
                                amount: amount.toFixed(2),
                                description: (disburseComment && disburseComment.trim()) ? disburseComment.trim() : 'Recarga Rapidín'
                              });
                              toast.success('Recarga enviada a Yango Pro. Confirmando desembolso automáticamente...');
                            }
                            setRechargeSuccess(true);
                            setLoadingRecharge(false);
                            await handleDisburse();
                            setShowConfirmDisburseModal(false);
                            setFirstPaymentToday(false);
                            setDisburseComment('');
                            setDisburseAmount('');
                            setRechargeSuccess(false);
                            setFleetRechargeUseManual(false);
                            setFleetRechargeErrorMessage('');
                          } catch (err: any) {
                            const code = err.response?.data?.code;
                            const msg = err.response?.data?.message || 'Error al recargar en Yango Pro';
                            // Solo esta solicitud (aprobada + Yango Pro): no activar modo manual en otros contextos
                            if (
                              !fleetRechargeUseManual &&
                              code === 'FLEET_PENDING_TRANSACTION' &&
                              request?.status === 'approved' &&
                              isYangoPro
                            ) {
                              setFleetRechargeUseManual(true);
                              setFleetRechargeErrorMessage(String(err.response?.data?.message || ''));
                            }
                            toast.error(msg);
                          } finally {
                            setLoadingRecharge(false);
                          }
                        }}
                        className={`w-full px-4 py-2.5 text-sm font-medium rounded-lg flex items-center justify-center gap-2 transition-colors ${
                          loadingRecharge
                            ? 'bg-amber-100 text-amber-600 cursor-not-allowed opacity-70 pointer-events-none'
                            : fleetRechargeUseManual
                              ? 'text-slate-800 bg-slate-200 hover:bg-slate-300 disabled:opacity-50 disabled:cursor-not-allowed'
                              : 'text-amber-800 bg-amber-100 hover:bg-amber-200 disabled:opacity-50 disabled:cursor-not-allowed'
                        }`}
                      >
                        {loadingRecharge ? <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" /> : <RefreshCw className="h-4 w-4" />}
                        {loadingRecharge
                          ? (fleetRechargeUseManual ? 'Registrando...' : 'Enviando recarga...')
                          : fleetRechargeUseManual
                            ? 'Registrar recarga manual (solo sistema)'
                            : 'Recargar a Yango Pro'}
                      </button>
                    </>
                  )}
                </div>
              ) : null}

            <p className="text-sm text-gray-600 mb-4">
              Vas a realizar el desembolso como <span className="font-semibold text-gray-900">{currentUserName}</span>.
              Se generará el préstamo y el cronograma de cuotas. Los domingos no se puede desembolsar. ¿Continuar?
            </p>
            {request?.country === 'PE' && new Date().getDay() === 1 && (
              <label className="flex items-center gap-2 mb-4 p-3 bg-amber-50 rounded-lg border border-amber-200">
                <input
                  type="checkbox"
                  checked={firstPaymentToday}
                  onChange={(e) => setFirstPaymentToday(e.target.checked)}
                  className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm text-gray-700">Primer pago hoy (cuota 1 vence hoy; cobro automático a las 15:31)</span>
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (isYangoPro && rechargeSuccess) return;
                  setShowConfirmDisburseModal(false);
                  setFirstPaymentToday(false);
                  setDisburseComment('');
                  setDisburseAmount('');
                  setRechargeSuccess(false);
                  setFleetRechargeUseManual(false);
                  setFleetRechargeErrorMessage('');
                }}
                disabled={(isYangoPro && rechargeSuccess) || loadingDisburse}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowConfirmDisburseModal(false);
                  setDisburseComment('');
                  setDisburseAmount('');
                  setRechargeSuccess(false);
                  setFleetRechargeUseManual(false);
                  setFleetRechargeErrorMessage('');
                  await handleDisburse();
                  setFirstPaymentToday(false);
                }}
                disabled={loadingDisburse || (isYangoPro && !rechargeSuccess) || isSunday}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingDisburse ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                {loadingDisburse ? 'Procesando...' : 'Confirmar desembolso'}
              </button>
            </div>
          </div>
        </div>
        </AdminModalPortal>
        );
      })()}

      {/* Modal confirmar aprobación */}
      {showConfirmApproveModal && (
        <AdminModalPortal>
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50" onClick={() => setShowConfirmApproveModal(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle className="h-5 w-5 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900">Confirmar aprobación</h3>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              Vas a aprobar esta solicitud como <span className="font-semibold text-gray-900">{currentUserName}</span>. 
              Quedará registrado en el sistema que tú realizaste esta aprobación. ¿Continuar?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirmApproveModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowConfirmApproveModal(false);
                  await handleConfirmApply();
                }}
                disabled={loadingApprove}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingApprove ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                {loadingApprove ? 'Procesando...' : 'Confirmar aprobación'}
              </button>
            </div>
          </div>
        </div>
        </AdminModalPortal>
      )}

      {/* Modal confirmar rechazo */}
      {showRejectForm && request && (
        <AdminModalPortal>
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50" onClick={() => { setShowRejectForm(false); setRejectReason(''); }}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <XCircle className="h-5 w-5 text-red-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900">Rechazar solicitud</h3>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              Rechazarás esta solicitud como <span className="font-semibold text-gray-900">{currentUserName}</span>. Quedará registrado quién la rechazó.
            </p>
            <label className="block text-xs font-medium text-gray-700 mb-1">Motivo del rechazo</label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Escribe el motivo del rechazo..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 resize-none mb-4"
              rows={3}
              autoFocus
            />

            <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200">
              <p className="text-sm font-medium text-amber-800">
                Al confirmar, el conductor recibirá el mensaje por Rapidín.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-gray-200">
              <button
                type="button"
                onClick={() => { setShowRejectForm(false); setRejectReason(''); }}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmRejectWithChannels}
                disabled={!rejectReason.trim() || loadingSendMessage}
                className="px-4 py-2 text-sm font-semibold text-white bg-gray-700 hover:bg-gray-800 rounded-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingSendMessage ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                {loadingSendMessage ? 'Enviando...' : 'Confirmar rechazo'}
              </button>
            </div>
          </div>
        </div>
        </AdminModalPortal>
      )}
    </div>
  );
};

export default LoanRequestDetail;







