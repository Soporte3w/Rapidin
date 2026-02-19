import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText,
  Calendar,
  DollarSign,
  CheckCircle,
  Clock,
  AlertCircle,
  Eye,
  Download,
  Upload,
  PlusCircle,
  ChevronRight,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  X,
  XCircle
} from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { getStoredRapidinDriverId, getStoredSelectedParkId, getStoredFlotaName, persistDriverContextFromResponse } from '../../utils/authStorage';
import { formatCurrency, getCurrencyLabel } from '../../utils/currency';
import { formatDateUTC } from '../../utils/date';
import toast from 'react-hot-toast';

interface Loan {
  id: string;
  amount: number;
  date: string;
  status: 'active' | 'completed' | 'late' | 'defaulted';
  installments: number;
  paidInstallments: number;
  pendingAmount: number;
  totalAmount?: number;
  paymentFrequency?: string;
}

interface ScheduleItem {
  id: string;
  installment_number: number;
  installment_amount: number;
  due_date: string;
  status: string;
  paid_date?: string;
  paid_amount?: number;
  late_fee?: number;
  /** Mora ya pagada (para mostrar que la cuota tuvo mora) */
  paid_late_fee?: number;
  /** Mora que se cobró (cuando la cuota está pagada; para mostrar en columna Mora) */
  mora_cobrada?: number;
}

interface PendingRequest {
  id: string;
  status: string;
  requestedAmount: number;
  createdAt: string;
}

interface RejectedRequest {
  id: string;
  status: string;
  requestedAmount: number;
  createdAt: string;
  rejectionReason: string | null;
}

const PAGE_SIZES = [5, 10, 20, 50];

export default function DriverLoans() {
  const { user } = useAuth();
  const country = user?.country || 'PE';
  const [loans, setLoans] = useState<Loan[]>([]);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  const [rejectedRequests, setRejectedRequests] = useState<RejectedRequest[]>([]);
  const [activeTab, setActiveTab] = useState<'prestamos' | 'rechazados'>('prestamos');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
  const [schedule, setSchedule] = useState<ScheduleItem[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);

  const total = loans.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const paginatedLoans = useMemo(() => {
    const start = (page - 1) * limit;
    return loans.slice(start, start + limit);
  }, [loans, page, limit]);

  const rejectedList = useMemo(() => rejectedRequests, [rejectedRequests]);
  const [rejectedPage, setRejectedPage] = useState(1);
  const [rejectedLimit, setRejectedLimit] = useState(10);
  const rejectedTotal = rejectedList.length;
  const rejectedTotalPages = Math.max(1, Math.ceil(rejectedTotal / rejectedLimit));
  const paginatedRejected = useMemo(() => {
    const start = (rejectedPage - 1) * rejectedLimit;
    return rejectedList.slice(start, start + rejectedLimit);
  }, [rejectedList, rejectedPage, rejectedLimit]);

  // Cargar siempre al montar: así al cambiar de flota y volver se ven los datos de la flota seleccionada (park_id/driver_id desde storage).
  useEffect(() => {
    loadLoans();
  }, []);

  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  useEffect(() => {
    if (rejectedTotalPages > 0 && rejectedPage > rejectedTotalPages) setRejectedPage(rejectedTotalPages);
  }, [rejectedTotalPages, rejectedPage]);

  const loadLoans = async () => {
    try {
      setLoading(true);
      setError('');
      const driverId = getStoredRapidinDriverId();
      const parkId = getStoredSelectedParkId();
      const params: Record<string, string> = {};
      if (driverId) params.driver_id = driverId;
      if (parkId) params.park_id = parkId;
      const { data } = await api.get('/driver/loans', { params });
      const raw = data?.data;
      const loansList = Array.isArray(raw) ? raw : (raw?.loans ?? []);
      const pending = Array.isArray(raw) ? null : (raw?.pendingRequest ?? null);
      const rejectedListFromApi = Array.isArray(raw?.rejectedRequests) ? raw.rejectedRequests : [];
      setLoans(loansList);
      setPendingRequest(pending);
      setRejectedRequests(rejectedListFromApi);
      persistDriverContextFromResponse(raw);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Error al cargar los préstamos');
    } finally {
      setLoading(false);
    }
  };

  const openLoanDetail = async (loan: Loan) => {
    setSelectedLoan(loan);
    setScheduleLoading(true);
    setSchedule([]);
    try {
      const driverId = getStoredRapidinDriverId();
      const parkId = getStoredSelectedParkId();
      const params: Record<string, string> = {};
      if (driverId) params.driver_id = driverId;
      if (parkId) params.park_id = parkId;
      const res = await api.get(`/driver/loans/${loan.id}/schedule`, { params });
      const data = res.data?.data ?? res.data ?? [];
      const scheduleList = Array.isArray(data) ? data : (data?.schedule ?? []);
      const pendingBalance = typeof data === 'object' && data !== null && 'pendingBalance' in data ? Number((data as { pendingBalance?: number }).pendingBalance) : null;
      setSchedule(Array.isArray(scheduleList) ? scheduleList : []);
      if (pendingBalance != null && !Number.isNaN(pendingBalance)) {
        setSelectedLoan((prev) => (prev ? { ...prev, pendingAmount: pendingBalance } : null));
      }
    } catch (err) {
      console.error('Error loading schedule:', err);
      setSchedule([]);
    } finally {
      setScheduleLoading(false);
    }
  };

  const downloadSchedule = async (loan: Loan) => {
    try {
      toast.loading('Preparando descarga...', { id: 'download-schedule' });
      const driverId = getStoredRapidinDriverId();
      const parkId = getStoredSelectedParkId();
      const params: Record<string, string> = {};
      if (driverId) params.driver_id = driverId;
      if (parkId) params.park_id = parkId;
      const res = await api.get(`/driver/loans/${loan.id}/schedule`, { params });
      const data = res.data?.data ?? res.data ?? [];
      const list: ScheduleItem[] = Array.isArray(data) ? data : (data?.schedule ?? []);
      const sym = getCurrencyLabel(country);
      const headers = ['Número', `Monto (${sym})`, 'Vence', `Mora pend. (${sym})`, `Mora pagada (${sym})`, 'Estado', `Pagado (${sym})`, 'Fecha pago'];
      const rows = list.map((row) => [
        row.installment_number,
        Number(row.installment_amount).toFixed(2),
        row.due_date ? formatDateUTC(row.due_date, 'es-PE') : '',
        Number(row.late_fee ?? 0).toFixed(2),
        Number(row.paid_late_fee ?? 0).toFixed(2),
        row.status === 'paid' ? 'Pagada' : row.status === 'overdue' ? 'Vencida' : 'Pendiente',
        (Number(row.paid_amount ?? 0) + Number(row.paid_late_fee ?? 0)) > 0 ? (Number(row.paid_amount ?? 0) + Number(row.paid_late_fee ?? 0)).toFixed(2) : '',
        row.paid_date ? formatDateUTC(row.paid_date, 'es-PE') : ''
      ]);
      const csvContent = [headers.join(','), ...rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
      const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cronograma-prestamo-${loan.id.slice(0, 8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Cronograma descargado', { id: 'download-schedule' });
    } catch (err) {
      console.error('Error downloading schedule:', err);
      toast.error('No se pudo descargar el cronograma', { id: 'download-schedule' });
    }
  };

  const getStatusBadge = (status: string) => {
    // En la BD solo existen: active, cancelled, defaulted. Siempre mostrar Cancelado (gris) para cancelled.
    const config: Record<string, { color: string; icon: typeof Clock; text: string }> = {
      active: { color: 'bg-blue-100 text-blue-700', icon: Clock, text: 'Activo' },
      cancelled: { color: 'bg-gray-100 text-gray-700', icon: XCircle, text: 'Cancelado' },
      defaulted: { color: 'bg-red-100 text-red-700', icon: AlertCircle, text: 'Vencido' }
    };
    const { color, icon: Icon, text } = config[status] ?? config.active;
    return (
      <span className={`inline-flex items-center space-x-1 px-3 py-1 rounded-full text-sm font-medium ${color}`}>
        <Icon className="w-4 h-4" />
        <span>{text}</span>
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh] sm:min-h-[60vh] px-4">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 sm:h-16 sm:w-16 border-4 border-red-600 border-t-transparent mx-auto mb-3 sm:mb-4" />
          <p className="text-sm sm:text-base text-gray-600">Cargando préstamos...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] sm:min-h-[60vh] px-4">
        <div className="bg-red-50 border-2 border-red-200 rounded-full p-3 sm:p-4 mb-3 sm:mb-4">
          <AlertCircle className="w-10 h-10 sm:w-12 sm:h-12 text-red-600" />
        </div>
        <h3 className="text-lg sm:text-xl font-bold text-gray-900 mb-2 text-center">Error al cargar los préstamos</h3>
        <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6 text-center max-w-md">{error}</p>
        <button
          onClick={loadLoans}
          className="bg-[#8B1A1A] text-white min-h-[44px] px-6 py-3 rounded-xl sm:rounded-lg font-medium hover:bg-[#7A1717] active:bg-[#6B1515] transition-all shadow-md touch-manipulation"
        >
          Reintentar
        </button>
      </div>
    );
  }

  const countryName = user?.country === 'PE' ? 'Perú' : user?.country === 'CO' ? 'Colombia' : '';

  return (
    <div className="space-y-3 sm:space-y-4 lg:space-y-6 px-2 sm:px-0">
      {/* Header - compacto en móvil */}
      <div className="bg-[#8B1A1A] rounded-xl sm:rounded-lg p-3 sm:p-4 lg:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <DollarSign className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg lg:text-xl font-bold text-white leading-tight truncate">
                Mis Préstamos
              </h1>
              <p className="text-xs text-white/90 mt-0.5 truncate lg:text-sm">
                {getStoredFlotaName() ? (
                  <>Flota <strong>{getStoredFlotaName()}</strong></>
                ) : (
                  <>Historial - {countryName}</>
                )}
              </p>
            </div>
          </div>

          <Link
            to="/driver/new-loan"
            className="bg-white border-2 border-white text-[#8B1A1A] font-semibold min-h-[44px] py-3 px-4 rounded-xl sm:rounded-lg hover:bg-gray-50 active:bg-gray-100 transition-colors flex items-center justify-center gap-2 text-sm w-full lg:w-auto touch-manipulation"
          >
            <PlusCircle className="w-4 h-4 flex-shrink-0" />
            <span>Nuevo Préstamo</span>
          </Link>
        </div>
      </div>

      {/* Pestañas - full width en móvil, táctiles */}
      <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-full lg:w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('prestamos')}
          className={`flex-1 lg:flex-none min-h-[44px] px-3 sm:px-4 py-2.5 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-2 touch-manipulation ${
            activeTab === 'prestamos'
              ? 'bg-white text-red-600 shadow-sm'
              : 'text-gray-600 hover:text-gray-900 active:bg-gray-200'
          }`}
        >
          <FileText className="w-4 h-4 flex-shrink-0" />
          <span>Mis préstamos</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('rechazados')}
          className={`flex-1 lg:flex-none min-h-[44px] px-3 sm:px-4 py-2.5 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-2 touch-manipulation ${
            activeTab === 'rechazados'
              ? 'bg-white text-red-600 shadow-sm'
              : 'text-gray-600 hover:text-gray-900 active:bg-gray-200'
          }`}
        >
          <XCircle className="w-4 h-4 flex-shrink-0" />
          <span>Rechazados</span>
          {rejectedList.length > 0 && (
            <span className="min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center rounded-full bg-red-100 text-red-700 text-xs font-bold">
              {rejectedList.length}
            </span>
          )}
        </button>
      </div>

      {/* Contenido pestaña: Mis préstamos */}
      {activeTab === 'prestamos' && (
        <>
      {/* Solicitud pendiente o aprobada (aún no desembolsada) */}
      {pendingRequest && (
        <div className={`rounded-xl p-4 sm:p-5 lg:p-6 border-2 ${
          pendingRequest.status === 'approved'
            ? 'bg-green-50 border-green-200'
            : 'bg-amber-50 border-amber-200'
        }`}>
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
              pendingRequest.status === 'approved' ? 'bg-green-100' : 'bg-amber-100'
            }`}>
              {pendingRequest.status === 'approved' ? (
                <CheckCircle className="w-5 h-5 text-green-700" />
              ) : (
                <Clock className="w-5 h-5 text-amber-700" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className={`text-base font-bold mb-1 ${pendingRequest.status === 'approved' ? 'text-green-900' : 'text-amber-900'}`}>
                {pendingRequest.status === 'approved' ? 'Solicitud aprobada – Falta el desembolso' : 'Solicitud en revisión'}
              </h3>
              <p className={`text-sm mb-3 ${pendingRequest.status === 'approved' ? 'text-green-800' : 'text-amber-800'}`}>
                {pendingRequest.status === 'approved' ? (
                  <>
                    Tu solicitud por <strong>{formatCurrency(pendingRequest.requestedAmount, country)}</strong> ya fue aprobada.
                    Falta realizar el desembolso para que puedas ver aquí el detalle de las cuotas y el cronograma de pagos.
                  </>
                ) : (
                  <>
                    Tu solicitud por <strong>{formatCurrency(pendingRequest.requestedAmount, country)}</strong> fue enviada el{' '}
                    {formatDateUTC(pendingRequest.createdAt, 'es-PE')}.
                    Aparecerá aquí cuando sea aprobada y desembolsada.
                  </>
                )}
              </p>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                pendingRequest.status === 'approved'
                  ? 'bg-green-200 text-green-800'
                  : 'bg-amber-200 text-amber-800'
              }`}>
                {pendingRequest.status === 'approved' ? (
                  <CheckCircle className="w-3.5 h-3.5" />
                ) : (
                  <Clock className="w-3.5 h-3.5" />
                )}
                {pendingRequest.status === 'approved' ? 'Aprobada – Pendiente desembolso' : 'En proceso'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Loans list */}
      {loans.length === 0 && !pendingRequest ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6 sm:p-8 lg:p-12 text-center">
          <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6">
            <FileText className="w-8 h-8 sm:w-10 sm:h-10 text-gray-400" />
          </div>
          <h3 className="text-lg sm:text-xl lg:text-2xl font-bold text-gray-900 mb-2">
            No tienes préstamos registrados
          </h3>
          <p className="text-gray-600 mb-4 sm:mb-6 text-sm sm:text-base">
            Cuando solicites un préstamo, aparecerá aquí
          </p>
          <Link
            to="/driver/new-loan"
            className="inline-flex items-center justify-center gap-2 bg-[#8B1A1A] text-white min-h-[44px] px-6 py-3 rounded-xl sm:rounded-lg font-semibold hover:bg-[#7A1717] active:bg-[#6B1515] transition-all shadow-md touch-manipulation"
          >
            <PlusCircle className="w-5 h-5 flex-shrink-0" />
            <span>Solicitar mi primer préstamo</span>
            <ChevronRight className="w-4 h-4 flex-shrink-0" />
          </Link>
        </div>
      ) : (
        <div className="space-y-3 lg:space-y-4">
          {/* Vista móvil: cards */}
          <div className="lg:hidden space-y-3">
            {paginatedLoans.map((loan) => (
              <div key={loan.id} className="bg-white rounded-xl shadow-lg border border-gray-200 p-4">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div>
                    <p className="text-lg font-bold text-gray-900">{formatCurrency(loan.amount, country)}</p>
                    <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                      <Calendar className="w-3.5 h-3.5" />
                      {formatDateUTC(loan.date, 'es-PE')}
                    </p>
                  </div>
                  {getStatusBadge(loan.status)}
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                  <div>
                    <p className="text-xs text-gray-500">Cuotas</p>
                    <p className="font-medium text-gray-900">{loan.paidInstallments} / {loan.installments}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Saldo pendiente</p>
                    <p className="font-semibold text-red-600">{formatCurrency(loan.pendingAmount, country)}</p>
                  </div>
                </div>
                <div className="mb-2">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-500">Progreso</span>
                    <span className="font-semibold text-gray-700">{Math.round((loan.paidInstallments / loan.installments) * 100)}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-[#8B1A1A] h-2 rounded-full transition-all"
                      style={{ width: `${(loan.paidInstallments / loan.installments) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
                  <Link
                    to={`/driver/loans/${loan.id}/vouchers`}
                    className="flex-1 min-h-[44px] flex items-center justify-center gap-1.5 rounded-xl bg-[#8B1A1A] text-white text-sm font-semibold hover:bg-[#7A1717] active:bg-[#6B1515] touch-manipulation"
                  >
                    <Upload className="w-4 h-4" />
                    Pagar
                  </Link>
                  <button
                    type="button"
                    onClick={() => openLoanDetail(loan)}
                    className="min-w-[44px] h-[44px] flex items-center justify-center rounded-xl border-2 border-gray-200 text-gray-600 hover:bg-gray-50 active:bg-gray-100 touch-manipulation"
                    title="Ver detalle"
                  >
                    <Eye className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadSchedule(loan)}
                    className="min-w-[44px] h-[44px] flex items-center justify-center rounded-xl border-2 border-gray-200 text-gray-600 hover:bg-gray-50 active:bg-gray-100 touch-manipulation"
                    title="Descargar cronograma"
                  >
                    <Download className="w-5 h-5" />
                  </button>
                </div>
              </div>
            ))}
            {/* Paginación móvil - compacta */}
            {total > 0 && (
              <div className="lg:hidden flex flex-nowrap items-center justify-between gap-1.5 sm:gap-2 py-2">
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className="text-[10px] sm:text-xs text-gray-500 whitespace-nowrap">Por página:</span>
                  <select
                    value={limit}
                    onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
                    className="text-xs border border-gray-300 rounded-md px-1.5 py-1 bg-white text-gray-700"
                  >
                    {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
                  <button type="button" onClick={() => setPage(1)} disabled={page <= 1} className="w-7 h-7 flex items-center justify-center rounded-full border border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed" aria-label="Primera"><ChevronsLeft className="w-3 h-3" /></button>
                  <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="w-7 h-7 flex items-center justify-center rounded-full border border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50" aria-label="Anterior"><ChevronLeft className="w-3 h-3" /></button>
                  <span className="text-[10px] sm:text-xs font-medium text-gray-700 min-w-[2.5rem] text-center">{page}/{totalPages}</span>
                  <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="w-7 h-7 flex items-center justify-center rounded-full border border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50" aria-label="Siguiente"><ChevronRight className="w-3 h-3" /></button>
                  <button type="button" onClick={() => setPage(totalPages)} disabled={page >= totalPages} className="w-7 h-7 flex items-center justify-center rounded-full border border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50" aria-label="Última"><ChevronsRight className="w-3 h-3" /></button>
                </div>
              </div>
            )}
          </div>

          {/* Vista desktop: tabla */}
          <div className="hidden lg:block bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Monto
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Fecha
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Cuotas
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Saldo pendiente
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Progreso
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Estado
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Acciones
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {paginatedLoans.map((loan) => (
                    <tr key={loan.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-4 whitespace-nowrap">
                        <span className="text-sm font-bold text-gray-900">
                          {formatCurrency(loan.amount, country)}
                        </span>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2 text-sm text-gray-900">
                          <Calendar className="w-4 h-4 text-gray-500 flex-shrink-0" />
                          {formatDateUTC(loan.date, 'es-PE')}
                        </div>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                        {loan.paidInstallments} / {loan.installments} pagadas
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <span className="text-sm font-semibold text-red-600">
                          {formatCurrency(loan.pendingAmount, country)}
                        </span>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2 min-w-[100px]">
                          <div className="flex-1 bg-gray-200 rounded-full h-2 max-w-[80px]">
                            <div
                              className="bg-gradient-to-r from-red-600 to-red-700 h-2 rounded-full transition-all"
                              style={{
                                width: `${(loan.paidInstallments / loan.installments) * 100}%`
                              }}
                            />
                          </div>
                          <span className="text-xs font-semibold text-gray-700">
                            {Math.round((loan.paidInstallments / loan.installments) * 100)}%
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        {getStatusBadge(loan.status)}
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            to={`/driver/loans/${loan.id}/vouchers`}
                            className="p-2 text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors border border-red-200"
                            title="Subir voucher"
                          >
                            <Upload className="w-4 h-4" />
                          </Link>
                          <button
                            type="button"
                            onClick={() => openLoanDetail(loan)}
                            className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200"
                            title="Ver detalle del préstamo"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadSchedule(loan)}
                            className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200"
                            title="Descargar cronograma de pagos"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > 0 && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-3 border-t border-gray-200">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-500">Por página:</span>
                <select
                  value={limit}
                  onChange={(e) => {
                    setLimit(Number(e.target.value));
                    setPage(1);
                  }}
                  className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:ring-2 focus:ring-red-500 focus:border-red-600"
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPage(1)}
                  disabled={page <= 1}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Primera página"
                >
                  <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum: number;
                      if (totalPages <= 5) pageNum = i + 1;
                      else if (page <= 3) pageNum = i + 1;
                      else if (page >= totalPages - 2) pageNum = totalPages - 4 + i;
                      else pageNum = page - 2 + i;
                      const isActive = page === pageNum;
                      return (
                        <button
                          key={pageNum}
                          type="button"
                          onClick={() => setPage(pageNum)}
                          className={`min-w-[2.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                            isActive ? 'bg-red-600 text-white border-2 border-red-600' : 'border-2 border-red-600 text-red-600 hover:bg-red-50'
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
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Página siguiente"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setPage(totalPages)}
                  disabled={page >= totalPages}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Última página"
                >
                  <ChevronsRight className="w-4 h-4" />
                </button>
              </div>
              </div>
            )}
          </div>
        </div>
      )}
        </>
      )}

      {/* Pestaña: Rechazados */}
      {activeTab === 'rechazados' && (
        <div className="space-y-3 lg:space-y-4">
          {rejectedList.length === 0 ? (
            <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6 sm:p-8 lg:p-12 text-center">
              <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6">
                <CheckCircle className="w-8 h-8 sm:w-10 sm:h-10 text-gray-400" />
              </div>
              <h3 className="text-lg sm:text-xl font-bold text-gray-900 mb-2">
                Sin solicitudes rechazadas
              </h3>
              <p className="text-gray-600 text-xs sm:text-sm max-w-sm mx-auto">
                No tienes solicitudes rechazadas. Si alguna es rechazada, aparecerá aquí con el motivo.
              </p>
            </div>
          ) : (
            <>
              {/* Vista móvil: cards rechazados */}
              <div className="lg:hidden space-y-3">
                {paginatedRejected.map((req) => (
                  <div key={req.id} className="bg-white rounded-xl shadow-lg border border-gray-200 p-4">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="text-lg font-bold text-gray-900">{formatCurrency(req.requestedAmount, country)}</p>
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                        <XCircle className="w-3.5 h-3.5" />
                        Rechazada
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mb-2">{formatDateUTC(req.createdAt, 'es-PE')}</p>
                    <p className="text-sm text-gray-900">
                      {req.rejectionReason ? <span className="text-red-900">{req.rejectionReason}</span> : <span className="text-gray-500">No se indicó motivo.</span>}
                    </p>
                  </div>
                ))}
                {rejectedTotal > 0 && (
                  <div className="lg:hidden flex flex-nowrap items-center justify-between gap-1.5 sm:gap-2 py-2">
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] sm:text-xs text-gray-500 whitespace-nowrap">Por página:</span>
                      <select value={rejectedLimit} onChange={(e) => { setRejectedLimit(Number(e.target.value)); setRejectedPage(1); }} className="text-xs border border-gray-300 rounded-md px-1.5 py-1 bg-white text-gray-700">
                        {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
                      <button type="button" onClick={() => setRejectedPage(1)} disabled={rejectedPage <= 1} className="w-7 h-7 flex items-center justify-center rounded-full border border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50" aria-label="Primera"><ChevronsLeft className="w-3 h-3" /></button>
                      <button type="button" onClick={() => setRejectedPage((p) => Math.max(1, p - 1))} disabled={rejectedPage <= 1} className="w-7 h-7 flex items-center justify-center rounded-full border border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50" aria-label="Anterior"><ChevronLeft className="w-3 h-3" /></button>
                      <span className="text-[10px] sm:text-xs font-medium text-gray-700 min-w-[2.5rem] text-center">{rejectedPage}/{rejectedTotalPages}</span>
                      <button type="button" onClick={() => setRejectedPage((p) => Math.min(rejectedTotalPages, p + 1))} disabled={rejectedPage >= rejectedTotalPages} className="w-7 h-7 flex items-center justify-center rounded-full border border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50" aria-label="Siguiente"><ChevronRight className="w-3 h-3" /></button>
                      <button type="button" onClick={() => setRejectedPage(rejectedTotalPages)} disabled={rejectedPage >= rejectedTotalPages} className="w-7 h-7 flex items-center justify-center rounded-full border border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50" aria-label="Última"><ChevronsRight className="w-3 h-3" /></button>
                    </div>
                  </div>
                )}
              </div>

              {/* Vista desktop: tabla rechazados */}
              <div className="hidden lg:block bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                          Monto solicitado
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                          Fecha
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                          Motivo
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                          Estado
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {paginatedRejected.map((req) => (
                        <tr key={req.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-4 whitespace-nowrap">
                            <span className="text-sm font-bold text-gray-900">
                              {formatCurrency(req.requestedAmount, country)}
                            </span>
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                            {formatDateUTC(req.createdAt, 'es-PE')}
                          </td>
                          <td className="px-4 py-4 text-sm text-gray-900 max-w-md">
                            {req.rejectionReason ? (
                              <span className="text-red-900">{req.rejectionReason}</span>
                            ) : (
                              <span className="text-gray-500">No se indicó motivo.</span>
                            )}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                              <XCircle className="w-3.5 h-3.5" />
                              Rechazada
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              {rejectedTotal > 0 && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-3 border-t border-gray-200">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-500">Por página:</span>
                    <select
                      value={rejectedLimit}
                      onChange={(e) => {
                        setRejectedLimit(Number(e.target.value));
                        setRejectedPage(1);
                      }}
                      className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:ring-2 focus:ring-red-500 focus:border-red-600"
                    >
                      {PAGE_SIZES.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setRejectedPage(1)}
                      disabled={rejectedPage <= 1}
                      className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      aria-label="Primera página"
                    >
                      <ChevronsLeft className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRejectedPage((p) => Math.max(1, p - 1))}
                      disabled={rejectedPage <= 1}
                      className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      aria-label="Página anterior"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    {rejectedTotalPages > 1 && (
                      <div className="flex items-center gap-1">
                        {Array.from({ length: Math.min(5, rejectedTotalPages) }, (_, i) => {
                          let pageNum: number;
                          if (rejectedTotalPages <= 5) pageNum = i + 1;
                          else if (rejectedPage <= 3) pageNum = i + 1;
                          else if (rejectedPage >= rejectedTotalPages - 2) pageNum = rejectedTotalPages - 4 + i;
                          else pageNum = rejectedPage - 2 + i;
                          const isActive = rejectedPage === pageNum;
                          return (
                            <button
                              key={pageNum}
                              type="button"
                              onClick={() => setRejectedPage(pageNum)}
                              className={`min-w-[2.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                                isActive ? 'bg-red-600 text-white border-2 border-red-600' : 'border-2 border-red-600 text-red-600 hover:bg-red-50'
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
                      onClick={() => setRejectedPage((p) => Math.min(rejectedTotalPages, p + 1))}
                      disabled={rejectedPage >= rejectedTotalPages}
                      className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      aria-label="Página siguiente"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRejectedPage(rejectedTotalPages)}
                      disabled={rejectedPage >= rejectedTotalPages}
                      className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      aria-label="Última página"
                    >
                      <ChevronsRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
            </>
          )}
        </div>
      )}

      {/* Modal detalle del préstamo - responsive */}
      {selectedLoan && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50" onClick={() => setSelectedLoan(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-xl shadow-2xl max-w-2xl w-full max-h-[92vh] sm:max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center p-3 sm:p-4 border-b border-gray-200 bg-[#8B1A1A]">
              <h2 className="text-base sm:text-lg font-bold text-white">Detalle del préstamo</h2>
              <button type="button" onClick={() => setSelectedLoan(null)} className="min-w-[44px] min-h-[44px] flex items-center justify-center text-white hover:text-gray-200 -mr-2 touch-manipulation" aria-label="Cerrar">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-3 sm:p-4 overflow-y-auto flex-1 min-h-0">
              <div className="grid grid-cols-2 gap-2 sm:gap-4 mb-4 sm:mb-6">
                <div className="bg-gray-50 rounded-lg p-2.5 sm:p-3">
                  <p className="text-xs text-gray-500 font-semibold uppercase">Monto desembolsado</p>
                  <p className="text-base sm:text-lg font-bold text-gray-900">{formatCurrency(Number(selectedLoan.amount), country)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-2.5 sm:p-3">
                  <p className="text-xs text-gray-500 font-semibold uppercase">Fecha</p>
                  <p className="text-xs sm:text-sm font-medium text-gray-900">
                    {formatDateUTC(selectedLoan.date, 'es-PE')}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-2.5 sm:p-3">
                  <p className="text-xs text-gray-500 font-semibold uppercase">Estado</p>
                  <div className="mt-0.5">{getStatusBadge(selectedLoan.status)}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-2.5 sm:p-3">
                  <p className="text-xs text-gray-500 font-semibold uppercase">Saldo pendiente</p>
                  <p className="text-base sm:text-lg font-bold text-red-600">{formatCurrency(Number(selectedLoan.pendingAmount), country)}</p>
                </div>
              </div>
              <p className="text-xs sm:text-sm font-semibold text-gray-700 mb-2">Cuotas: {selectedLoan.paidInstallments} / {selectedLoan.installments} pagadas</p>

              <h3 className="text-xs sm:text-sm font-semibold text-gray-900 mb-2">Cronograma de pagos</h3>
              {scheduleLoading ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-red-600 border-t-transparent" />
                </div>
              ) : schedule.length === 0 ? (
                <p className="text-gray-500 text-sm py-4">No hay cronograma disponible.</p>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-x-auto">
                  <table className="w-full text-xs sm:text-sm min-w-[480px]">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-1.5 sm:px-2 py-2 text-left font-semibold text-gray-700">#</th>
                        <th className="px-1.5 sm:px-2 py-2 text-left font-semibold text-gray-700">Monto</th>
                        <th className="px-1.5 sm:px-2 py-2 text-left font-semibold text-gray-700">Vence</th>
                        <th className="px-1.5 sm:px-2 py-2 text-left font-semibold text-gray-700">Mora</th>
                        <th className="px-1.5 sm:px-2 py-2 text-left font-semibold text-gray-700">Estado</th>
                        <th className="px-1.5 sm:px-2 py-2 text-left font-semibold text-gray-700">Pagado</th>
                        <th className="px-1.5 sm:px-2 py-2 text-left font-semibold text-gray-700">Fecha pago</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {schedule.map((row) => (
                        <tr key={row.id} className="hover:bg-gray-50">
                          <td className="px-2 py-2 font-medium text-gray-900">{row.installment_number}</td>
                          <td className="px-2 py-2 text-gray-700">{formatCurrency(Number(row.installment_amount), country)}</td>
                          <td className="px-2 py-2 text-gray-700">
                            {row.due_date ? formatDateUTC(row.due_date, 'es-PE') : '—'}
                          </td>
                          <td className="px-2 py-2 text-gray-700">
                            {row.status === 'pending' && Number(row.late_fee ?? 0) === 0 && Number(row.paid_late_fee ?? 0) === 0 && Number(row.mora_cobrada ?? 0) === 0 ? (
                              '—'
                            ) : (
                              <span className="block">
                                {Number(row.late_fee ?? 0) > 0 && (
                                  <span className="text-red-600 font-medium block">
                                    {formatCurrency(Number(row.late_fee), country)} <span className="text-xs font-normal text-red-500">(pendiente)</span>
                                  </span>
                                )}
                                {(row.status === 'paid' && Number(row.mora_cobrada ?? 0) > 0) && (
                                  <span className="text-amber-700 font-medium block">
                                    {formatCurrency(Number(row.mora_cobrada), country)} <span className="text-xs font-normal">(cobrada)</span>
                                  </span>
                                )}
                                {Number(row.paid_late_fee ?? 0) > 0 && row.status !== 'paid' && (
                                  <span className={`text-amber-700 text-xs ${Number(row.late_fee ?? 0) > 0 ? 'mt-0.5' : ''}`}>
                                    {formatCurrency(Number(row.paid_late_fee), country)} (pagada)
                                  </span>
                                )}
                                {Number(row.late_fee ?? 0) === 0 && Number(row.paid_late_fee ?? 0) === 0 && Number(row.mora_cobrada ?? 0) === 0 && (
                                  formatCurrency(0, country)
                                )}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                              row.status === 'paid' ? 'bg-green-100 text-green-800' :
                              row.status === 'overdue' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                            }`}>
                              {row.status === 'paid' ? 'Pagada' : row.status === 'overdue' ? 'Vencida' : 'Pendiente'}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-gray-700">
                            {(() => {
                              const totalPagado = Number(row.paid_amount ?? 0) + Number(row.paid_late_fee ?? 0);
                              return totalPagado > 0 ? (
                                <span className="font-medium text-green-700">{formatCurrency(totalPagado, country)}</span>
                              ) : (
                                '—'
                              );
                            })()}
                          </td>
                          <td className="px-2 py-2 text-gray-600">
                            {row.paid_date ? formatDateUTC(row.paid_date, 'es-PE') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
