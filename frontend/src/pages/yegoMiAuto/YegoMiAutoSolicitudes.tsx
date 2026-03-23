import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import { MIAUTO_NO_CACHE_HEADERS, isAxiosAbortError } from '../../utils/miautoApiUtils';
import { FileText, Eye, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate } from '../../utils/date';
import { DateRangePicker } from '../../components/DateRangePicker';

interface Solicitud {
  id: string;
  dni: string;
  driver_name?: string | null;
  phone?: string | null;
  email?: string | null;
  license_number: string | null;
  status: string;
  created_at: string;
}

interface FiltersState {
  status: string;
  country: string;
  date_from: string;
  date_to: string;
}

interface PaginationState {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

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

const STATUS_OPTIONS = [{ value: '', label: 'Todos' }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))];

const COUNTRY_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'PE', label: 'Perú' },
  { value: 'CO', label: 'Colombia' },
];

const PAGE_SIZES = [5, 10, 20, 50];
const INPUT_CLASS = 'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm';
const PAGINATION_BTN = 'w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

function getVisiblePageNumbers(pagination: PaginationState): number[] {
  const { page, totalPages } = pagination;
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, i) => i + 1);
  if (page <= 3) return [1, 2, 3, 4, 5];
  if (page >= totalPages - 2) return Array.from({ length: 5 }, (_, i) => totalPages - 4 + i);
  return [page - 2, page - 1, page, page + 1, page + 2];
}

function LoadingSpinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 text-center">
      <FileText className="w-10 h-10 text-gray-400 mx-auto mb-4" />
      <h3 className="text-xl font-bold text-gray-900 mb-2">No hay solicitudes</h3>
      <p className="text-gray-600 text-sm">No se encontraron solicitudes con los filtros seleccionados.</p>
    </div>
  );
}

function SolicitudesFilters({
  filters,
  onFiltersChange,
}: {
  filters: FiltersState;
  onFiltersChange: (f: FiltersState) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
      <p className="text-xs font-semibold text-[#8B1A1A] uppercase tracking-wide mb-3">Filtros</p>
      <div className="flex flex-col sm:flex-row gap-4 flex-wrap">
        <div className="flex-1 min-w-[150px]">
          <label htmlFor="status" className="block text-xs font-semibold text-gray-900 mb-1.5">
            Estado de la solicitud
          </label>
          <select
            id="status"
            value={filters.status}
            onChange={(e) => onFiltersChange({ ...filters, status: e.target.value })}
            className={INPUT_CLASS}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[150px]">
          <label htmlFor="country" className="block text-xs font-semibold text-gray-900 mb-1.5">
            País
          </label>
          <select
            id="country"
            value={filters.country}
            onChange={(e) => onFiltersChange({ ...filters, country: e.target.value })}
            className={INPUT_CLASS}
          >
            {COUNTRY_OPTIONS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <DateRangePicker
            label="Fecha"
            value={{ date_from: filters.date_from, date_to: filters.date_to }}
            onChange={(r) => onFiltersChange({ ...filters, date_from: r.date_from, date_to: r.date_to })}
            placeholder="Filtrar por fecha"
          />
        </div>
      </div>
    </div>
  );
}

function SolicitudesTable({
  solicitudes,
  onViewDetail,
  isLoading,
}: {
  solicitudes: Solicitud[];
  onViewDetail: (id: string) => void;
  isLoading: boolean;
}) {
  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden relative">
      {isLoading && (
        <div className="absolute inset-0 bg-white/60 z-10 flex items-center justify-center rounded-xl">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">DNI</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Conductor</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Licencia</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Estado</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Fecha</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {solicitudes.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{s.dni}</td>
                <td className="px-4 py-3 text-sm text-gray-700">{s.driver_name || (s.phone ? `Tel: ${s.phone}` : s.email) || '—'}</td>
                <td className="px-4 py-3 text-sm text-gray-700">{s.license_number || '—'}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${STATUS_CLASS[s.status] || 'bg-gray-100 text-gray-700'}`}
                  >
                    {STATUS_LABELS[s.status] || s.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {s.created_at ? formatDate(s.created_at, 'es-ES') : '—'}
                </td>
                <td className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => onViewDetail(s.id)}
                    className="inline-flex items-center gap-1 px-2 py-1.5 text-sm font-medium text-[#8B1A1A] hover:bg-red-50 rounded-lg"
                  >
                    <Eye className="w-4 h-4" />
                    Ver más detalle
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PaginationBar({
  pagination,
  onPageChange,
  onLimitChange,
  isLoading,
}: {
  pagination: PaginationState;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  isLoading: boolean;
}) {
  const disabled = isLoading;
  const pageNumbers = getVisiblePageNumbers(pagination);

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-600">Por página:</span>
        <select
          value={pagination.limit}
          onChange={(e) => onLimitChange(Number(e.target.value))}
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 focus:ring-2 focus:ring-red-500 focus:border-red-600"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => onPageChange(1)} disabled={pagination.page <= 1 || disabled} className={PAGINATION_BTN} aria-label="Primera página">
          <ChevronsLeft className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => onPageChange(pagination.page - 1)} disabled={pagination.page <= 1 || disabled} className={PAGINATION_BTN} aria-label="Página anterior">
          <ChevronLeft className="w-4 h-4" />
        </button>
        {pageNumbers.map((pageNum) => {
          const isActive = pagination.page === pageNum;
          return (
            <button
              key={pageNum}
              type="button"
              onClick={() => onPageChange(pageNum)}
              disabled={disabled}
              className={`min-w-[2.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                isActive
                  ? 'bg-red-600 text-white border-2 border-red-600'
                  : 'border-2 border-red-600 text-red-600 hover:bg-red-50'
              }`}
            >
              {pageNum}
            </button>
          );
        })}
        <button type="button" onClick={() => onPageChange(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages || disabled} className={PAGINATION_BTN} aria-label="Página siguiente">
          <ChevronRight className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => onPageChange(pagination.totalPages || 1)} disabled={pagination.page >= pagination.totalPages || disabled} className={PAGINATION_BTN} aria-label="Última página">
          <ChevronsRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export default function YegoMiAutoSolicitudes() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<FiltersState>({
    status: '',
    country: (user?.country as string) || '',
    date_from: '',
    date_to: '',
  });
  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });
  const [paginationLoading, setPaginationLoading] = useState(false);
  const paginationRef = useRef(pagination);
  paginationRef.current = pagination;

  const fetchSolicitudes = useCallback(
    async (page: number, limit: number, isPaginationChange: boolean, signal?: AbortSignal) => {
      try {
        if (isPaginationChange) setPaginationLoading(true);
        else setLoading(true);
        setError('');
        const params = new URLSearchParams();
        params.append('page', String(page));
        params.append('limit', String(limit));
        if (filters.status) params.append('status', filters.status);
        if (filters.country) params.append('country', filters.country);
        if (filters.date_from) params.append('date_from', filters.date_from);
        if (filters.date_to) params.append('date_to', filters.date_to);
        const response = await api.get(`/miauto/solicitudes?${params.toString()}`, {
          signal,
          headers: MIAUTO_NO_CACHE_HEADERS,
        });
        const data = response.data?.data ?? [];
        const pag = response.data?.pagination ?? {};
        setSolicitudes(Array.isArray(data) ? data : []);
        setPagination((p) => ({
          ...p,
          page: pag.page ?? page,
          limit: pag.limit ?? limit,
          total: pag.total ?? 0,
          totalPages: pag.totalPages ?? 1,
        }));
      } catch (e: any) {
        if (isAxiosAbortError(e)) return;
        setError(e.response?.data?.message || 'Error al cargar solicitudes');
        setSolicitudes([]);
      } finally {
        if (signal?.aborted) return;
        setLoading(false);
        setPaginationLoading(false);
      }
    },
    [filters.status, filters.country, filters.date_from, filters.date_to]
  );

  useEffect(() => {
    const ac = new AbortController();
    const lim = paginationRef.current.limit;
    setPagination((p) => ({ ...p, page: 1 }));
    fetchSolicitudes(1, lim, false, ac.signal);
    return () => ac.abort();
  }, [filters.status, filters.country, filters.date_from, filters.date_to, fetchSolicitudes]);

  const goToPage = useCallback(
    (page: number) => {
      const p = Math.max(1, Math.min(page, pagination.totalPages || 1));
      fetchSolicitudes(p, pagination.limit, true);
    },
    [pagination.totalPages, pagination.limit, fetchSolicitudes]
  );

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      setPagination((p) => ({ ...p, limit: newLimit, page: 1 }));
      fetchSolicitudes(1, newLimit, true);
    },
    [fetchSolicitudes]
  );

  const countryLabel = COUNTRY_OPTIONS.find((o) => o.value === filters.country)?.label ?? 'Todos';

  return (
    <div className="space-y-4 lg:space-y-6">
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Solicitudes Mi Auto</h1>
            <p className="text-xs lg:text-sm text-white/90 mt-0.5">
              Conductores que quieren un auto — {countryLabel}
            </p>
          </div>
        </div>
      </header>

      <SolicitudesFilters filters={filters} onFiltersChange={setFilters} />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{pagination.total.toLocaleString('es-PE')}</span>
        <span className="text-sm text-gray-600">solicitudes</span>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : solicitudes.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <SolicitudesTable
            solicitudes={solicitudes}
            onViewDetail={(id) => navigate(`/admin/yego-mi-auto/requests/${id}`)}
            isLoading={paginationLoading}
          />
          {pagination.total > 0 && (
            <PaginationBar
              pagination={pagination}
              onPageChange={goToPage}
              onLimitChange={handleLimitChange}
              isLoading={loading || paginationLoading}
            />
          )}
        </>
      )}
    </div>
  );
}
