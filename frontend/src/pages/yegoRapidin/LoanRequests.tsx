import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../../services/api';
import { Eye, FileText, Calendar, AlertCircle, CheckCircle, Clock, XCircle, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { RapidinSearchField } from '../../components/RapidinSearchField';
import { useAuth } from '../../contexts/AuthContext';
import { formatCurrency } from '../../utils/currency';
import { formatDateLocal } from '../../utils/date';
import { DateRangePicker } from '../../components/DateRangePicker';
import { isAxiosAbortError } from '../../utils/miautoApiUtils';

interface LoanRequest {
  id: string;
  dni: string;
  driver_first_name: string;
  driver_last_name: string;
  requested_amount: number;
  disbursed_amount?: number | null;
  cycle?: number | null;
  driver_cycle?: number | null;
  status: string;
  country: string;
  created_at: string;
  approved_at?: string | null;
  disbursed_at?: string | null;
  disbursed_at_display?: string | null;
}

export type LoanRequestsSearchState = {
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

const PAGE_SIZES = [5, 10, 20, 50];

const LoanRequests = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const searchState = location.state as LoanRequestsSearchState | null;
  const isReturnFromDetail = Boolean(searchState?.fromRequestDetail);
  const initialDriverInput = isReturnFromDetail ? (searchState?.driverSearchInput ?? searchState?.driver ?? '') : '';

  const [requests, setRequests] = useState<LoanRequest[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    status: isReturnFromDetail ? (searchState?.status ?? '') : '',
    country: isReturnFromDetail ? (searchState?.country ?? '') : '',
    date_from: isReturnFromDetail ? (searchState?.date_from ?? '') : '',
    date_to: isReturnFromDetail ? (searchState?.date_to ?? '') : '',
  });
  const [driverSearchInput, setDriverSearchInput] = useState(initialDriverInput);
  const debouncedDriver = useDebouncedValue(driverSearchInput, 400);
  const [page, setPage] = useState(isReturnFromDetail && searchState?.page != null ? searchState.page : 1);
  const [pageSize, setPageSize] = useState(isReturnFromDetail && searchState?.limit != null ? searchState.limit : 10);
  const returnConsumedRef = useRef(false);
  const prevDebouncedDriverRef = useRef(debouncedDriver);

  const totalPages = Math.max(1, Math.ceil(serverTotal / pageSize) || 1);
  const pageClamped = Math.min(Math.max(1, page), totalPages);

  useEffect(() => {
    if (page !== pageClamped) setPage(pageClamped);
  }, [page, pageClamped]);

  useEffect(() => {
    if (prevDebouncedDriverRef.current !== debouncedDriver) {
      prevDebouncedDriverRef.current = debouncedDriver;
      setPage(1);
    }
  }, [debouncedDriver]);

  const fetchLoanRequestsPage = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoading(true);
        setError('');
        const params = new URLSearchParams();
        params.append('page', String(page));
        params.append('limit', String(pageSize));
        if (filters.status) params.append('status', filters.status);
        if (filters.country) params.append('country', filters.country);
        if (filters.date_from) params.append('date_from', filters.date_from);
        if (filters.date_to) params.append('date_to', filters.date_to);
        const q = debouncedDriver.trim();
        if (q) params.append('driver', q);

        const response = await api.get(`/loan-requests?${params.toString()}`, {
          signal,
          headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        });
        if (signal?.aborted) return;

        const pag = response.data?.pagination;
        const total = typeof pag?.total === 'number' ? pag.total : 0;
        setServerTotal(total);

        let chunk: LoanRequest[] = [];
        const raw = response.data?.data ?? response.data;
        if (Array.isArray(raw)) chunk = raw;
        else if (raw?.data && Array.isArray(raw.data)) chunk = raw.data;
        else if (response.data?.rows && Array.isArray(response.data.rows)) chunk = response.data.rows;
        setRequests(chunk);
      } catch (err: any) {
        if (isAxiosAbortError(err)) return;
        console.error('Error fetching requests:', err);
        setError(err.response?.data?.message || 'Error al cargar las solicitudes');
        setRequests([]);
        setServerTotal(0);
      } finally {
        if (signal?.aborted) return;
        setLoading(false);
      }
    },
    [page, pageSize, filters.status, filters.country, filters.date_from, filters.date_to, debouncedDriver]
  );

  useEffect(() => {
    const ac = new AbortController();
    const st = location.state as LoanRequestsSearchState | null;
    if (!returnConsumedRef.current && Boolean(st?.fromRequestDetail)) {
      returnConsumedRef.current = true;
      setPage(st?.page ?? 1);
      setPageSize(st?.limit ?? 10);
      navigate(location.pathname, { replace: true, state: {} });
      return () => ac.abort();
    }
    fetchLoanRequestsPage(ac.signal);
    return () => ac.abort();
  }, [fetchLoanRequestsPage, navigate, location.pathname]);

  const goToPage = (p: number) => {
    const tp = Math.max(1, Math.ceil(serverTotal / pageSize) || 1);
    setPage(Math.max(1, Math.min(p, tp)));
  };

  const handleLimitChange = (newLimit: number) => {
    setPageSize(newLimit);
    setPage(1);
  };

  const getStatusBadge = (status: string) => {
    const badges: Record<string, { color: string; icon: typeof Clock; text: string }> = {
      pending: { color: 'bg-yellow-100 text-yellow-800', icon: Clock, text: 'Pendiente' },
      approved: { color: 'bg-purple-100 text-purple-800', icon: CheckCircle, text: 'Aprobado' },
      rejected: { color: 'bg-red-100 text-red-800', icon: XCircle, text: 'Rechazado' },
      disbursed: { color: 'bg-green-100 text-green-800', icon: CheckCircle, text: 'Desembolsado' },
      cancelled: { color: 'bg-gray-100 text-gray-800', icon: XCircle, text: 'Cancelado' },
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

  const countryName = user?.country === 'PE' ? 'Perú' : user?.country === 'CO' ? 'Colombia' : '';
  const hasServerFilters = Boolean(filters.status || filters.country || filters.date_from || filters.date_to);
  const driverQueryActive = Boolean(debouncedDriver.trim());

  if (loading && requests.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-red-600 border-t-transparent mx-auto mb-4" />
          <p className="text-gray-600">Cargando solicitudes...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="bg-red-50 border-2 border-red-200 rounded-full p-4 mb-4">
          <AlertCircle className="w-12 h-12 text-red-600" />
        </div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Error al cargar las solicitudes</h3>
        <p className="text-gray-600 mb-6 text-center max-w-md">{error}</p>
        <button
          type="button"
          onClick={() => void fetchLoanRequestsPage()}
          className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-lg font-medium hover:from-red-700 hover:to-red-800 transition-all shadow-md"
        >
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Solicitudes de Préstamo</h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">Gestiona todas las solicitudes - {countryName || 'Todos los países'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex flex-col sm:flex-row gap-4 flex-wrap">
          <RapidinSearchField
            id="driver"
            label="Buscar por conductor"
            value={driverSearchInput}
            onChange={setDriverSearchInput}
            placeholder="Nombre, apellido o DNI"
            className="flex-1 min-w-0 min-w-[200px]"
          />
          <div className="flex-1 min-w-[150px]">
            <label htmlFor="status" className="block text-xs font-semibold text-gray-900 mb-1.5">Estado</label>
            <select
              id="status"
              value={filters.status}
              onChange={(e) => {
                setFilters({ ...filters, status: e.target.value });
                setPage(1);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
            >
              <option value="">Todos</option>
              <option value="pending">Pendiente</option>
              <option value="approved">Aprobado</option>
              <option value="rejected">Rechazado</option>
              <option value="disbursed">Desembolsado</option>
              <option value="cancelled">Cancelado</option>
            </select>
          </div>
          <div className="flex-1 min-w-[150px]">
            <label htmlFor="country" className="block text-xs font-semibold text-gray-900 mb-1.5">País</label>
            <select
              id="country"
              value={filters.country}
              onChange={(e) => {
                setFilters({ ...filters, country: e.target.value });
                setPage(1);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
            >
              <option value="">Todos</option>
              <option value="PE">Perú</option>
              <option value="CO">Colombia</option>
            </select>
          </div>
          <div className="flex-1 min-w-[200px]">
            <DateRangePicker
              label="Fecha"
              value={{ date_from: filters.date_from, date_to: filters.date_to }}
              onChange={(r) => {
                setFilters((f) => ({ ...f, date_from: r.date_from, date_to: r.date_to }));
                setPage(1);
              }}
              placeholder="Filtrar por fecha"
            />
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{serverTotal.toLocaleString('es-PE')}</span>
        <span className="text-sm text-gray-600">solicitudes</span>
      </div>

      {!loading && serverTotal === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 lg:p-12 text-center">
          <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <FileText className="w-10 h-10 text-gray-400" />
          </div>
          <h3 className="text-xl lg:text-2xl font-bold text-gray-900 mb-2">
            {driverQueryActive ? 'Sin coincidencias' : hasServerFilters ? 'Sin resultados' : 'No hay solicitudes disponibles'}
          </h3>
          <p className="text-gray-600 mb-6 text-base">
            {driverQueryActive
              ? `Ninguna solicitud coincide con «${debouncedDriver.trim()}».`
              : hasServerFilters
                ? 'Prueba otros filtros de estado, país o fechas.'
                : 'No hay solicitudes en el sistema con los criterios actuales.'}
          </p>
        </div>
      ) : (
        <div className={`space-y-4 ${loading ? 'opacity-70 pointer-events-none' : ''}`}>
          <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden relative">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Conductor</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">DNI</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Monto</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">País</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Estado</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Fecha</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Acciones</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {requests.map((request) => (
                    <tr key={request.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">
                          {request.driver_first_name || ''} {request.driver_last_name || ''}
                        </div>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{request.dni || 'N/A'}</div>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <div className="text-sm font-semibold text-gray-900">
                          {formatCurrency(
                            request.disbursed_amount != null && Number(request.disbursed_amount) > 0
                              ? Number(request.disbursed_amount)
                              : request.requested_amount
                                ? Number(request.requested_amount)
                                : 0,
                            request.country || 'PE'
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{request.country || 'N/A'}</div>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">{getStatusBadge(request.status || 'pending')}</td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <div className="flex items-center space-x-2 text-sm text-gray-600">
                          <Calendar className="w-4 h-4 text-gray-400" />
                          <span>
                            {(() => {
                              if (request.status === 'disbursed' && (request.disbursed_at_display || request.disbursed_at)) {
                                return request.disbursed_at_display
                                  ? formatDateLocal(request.disbursed_at_display + 'T12:00:00', 'es-PE')
                                  : formatDateLocal(request.disbursed_at!, 'es-PE');
                              }
                              const date =
                                (request.status === 'approved' || request.status === 'signed') && request.approved_at
                                  ? request.approved_at
                                  : request.created_at;
                              return date ? formatDateLocal(date, 'es-PE') : 'N/A';
                            })()}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() =>
                            navigate(`/admin/loan-requests/${request.id}`, {
                              state: {
                                fromLoanRequestsSearch: true,
                                driverSearchInput,
                                status: filters.status,
                                country: filters.country,
                                date_from: filters.date_from,
                                date_to: filters.date_to,
                                page: pageClamped,
                                limit: pageSize,
                              },
                            })
                          }
                          className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200"
                          title="Ver detalles"
                        >
                          <Eye className="w-5 h-5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {serverTotal > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 pb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-500">Por página:</span>
                <select
                  value={pageSize}
                  onChange={(e) => handleLimitChange(Number(e.target.value))}
                  className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:ring-2 focus:ring-red-500 focus:border-red-600"
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => goToPage(1)}
                  disabled={pageClamped <= 1 || loading}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Primera página"
                >
                  <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(pageClamped - 1)}
                  disabled={pageClamped <= 1 || loading}
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
                      else if (pageClamped <= 3) pageNum = i + 1;
                      else if (pageClamped >= totalPages - 2) pageNum = totalPages - 4 + i;
                      else pageNum = pageClamped - 2 + i;
                      const isActive = pageClamped === pageNum;
                      return (
                        <button
                          key={pageNum}
                          type="button"
                          onClick={() => goToPage(pageNum)}
                          disabled={loading}
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
                  onClick={() => goToPage(pageClamped + 1)}
                  disabled={pageClamped >= totalPages || loading}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Página siguiente"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(totalPages)}
                  disabled={pageClamped >= totalPages || loading}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Última página"
                >
                  <ChevronsRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LoanRequests;
