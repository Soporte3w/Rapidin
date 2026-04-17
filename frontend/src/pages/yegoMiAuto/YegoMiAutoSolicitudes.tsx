import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import { MIAUTO_NO_CACHE_HEADERS, isAxiosAbortError } from '../../utils/miautoApiUtils';
import { FileText, Eye, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate } from '../../utils/date';
import { DateRangePicker } from '../../components/DateRangePicker';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { RapidinSearchField } from '../../components/RapidinSearchField';

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

/** Texto de la columna Conductor (misma lógica que la tabla). */
function conductorCellText(s: Solicitud): string {
  return s.driver_name || (s.phone ? `Tel: ${s.phone}` : s.email) || '';
}

function foldLower(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Filtro solo en front: DNI, nombre, teléfono, email, licencia (sin llamar al backend). */
function solicitudMatchesQuery(s: Solicitud, rawQuery: string): boolean {
  const qTrim = rawQuery.trim();
  if (!qTrim) return true;
  const qDigits = qTrim.replace(/\D/g, '');
  const qFold = foldLower(qTrim);
  const dniNorm = String(s.dni ?? '').toLowerCase();
  const dniDigits = String(s.dni ?? '').replace(/\D/g, '');
  if (dniNorm.includes(qTrim.toLowerCase()) || (qDigits.length >= 2 && dniDigits.includes(qDigits))) return true;
  const name = foldLower(s.driver_name ?? '');
  if (name && name.includes(qFold)) return true;
  const phone = (s.phone ?? '').toLowerCase();
  if (phone && (phone.includes(qTrim.toLowerCase()) || (qDigits.length >= 3 && phone.replace(/\D/g, '').includes(qDigits)))) return true;
  const email = foldLower(s.email ?? '');
  if (email && email.includes(qFold)) return true;
  const lic = foldLower(s.license_number ?? '');
  if (lic && lic.includes(qFold)) return true;
  const display = foldLower(conductorCellText(s));
  return display.includes(qFold);
}

const API_PAGE_CHUNK = 100;

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
  driverSearch,
  onDriverSearchChange,
}: {
  filters: FiltersState;
  onFiltersChange: (f: FiltersState) => void;
  driverSearch: string;
  onDriverSearchChange: (v: string) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
      <p className="text-xs font-semibold text-[#8B1A1A] uppercase tracking-wide mb-3">Filtros</p>
      <div className="flex flex-col sm:flex-row gap-4 flex-wrap">
        <RapidinSearchField
          id="miauto-solicitud-driver"
          label="Buscar por conductor"
          value={driverSearch}
          onChange={onDriverSearchChange}
          placeholder="Nombre, apellido o DNI"
          className="flex-1 min-w-[200px]"
        />
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
                <td className="px-4 py-3 text-sm text-gray-700">{conductorCellText(s) || '—'}</td>
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
  /** Lista completa para los filtros actuales (estado, país, fechas); la búsqueda por conductor se aplica aquí en el cliente. */
  const [sourceSolicitudes, setSourceSolicitudes] = useState<Solicitud[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<FiltersState>({
    status: '',
    country: (user?.country as string) || '',
    date_from: '',
    date_to: '',
  });
  const [driverSearchInput, setDriverSearchInput] = useState('');
  const debouncedDriverSearch = useDebouncedValue(driverSearchInput, 400);
  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });

  const filteredSolicitudes = useMemo(() => {
    const q = debouncedDriverSearch.trim();
    if (!q) return sourceSolicitudes;
    return sourceSolicitudes.filter((s) => solicitudMatchesQuery(s, q));
  }, [sourceSolicitudes, debouncedDriverSearch]);

  const totalFiltered = filteredSolicitudes.length;
  const totalPagesClient = Math.max(1, Math.ceil(totalFiltered / pagination.limit) || 1);
  const pageClamped = Math.min(Math.max(1, pagination.page), totalPagesClient);
  const displaySolicitudes = useMemo(() => {
    const start = (pageClamped - 1) * pagination.limit;
    return filteredSolicitudes.slice(start, start + pagination.limit);
  }, [filteredSolicitudes, pageClamped, pagination.limit]);

  useEffect(() => {
    if (pagination.page !== pageClamped) {
      setPagination((p) => ({ ...p, page: pageClamped }));
    }
  }, [pageClamped, pagination.page]);

  const fetchSolicitudesAllPages = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoading(true);
        setError('');
        const accumulated: Solicitud[] = [];
        let serverTotal = 0;
        let page = 1;
        while (!signal?.aborted) {
          const params = new URLSearchParams();
          params.append('page', String(page));
          params.append('limit', String(API_PAGE_CHUNK));
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
          serverTotal = typeof pag.total === 'number' ? pag.total : accumulated.length + (Array.isArray(data) ? data.length : 0);
          if (!Array.isArray(data) || data.length === 0) break;
          accumulated.push(...data);
          if (accumulated.length >= serverTotal || data.length < API_PAGE_CHUNK) break;
          page += 1;
        }
        if (signal?.aborted) return;
        setSourceSolicitudes(accumulated);
        setPagination((p) => ({ ...p, page: 1 }));
      } catch (e: any) {
        if (isAxiosAbortError(e)) return;
        setError(e.response?.data?.message || 'Error al cargar solicitudes');
        setSourceSolicitudes([]);
      } finally {
        if (signal?.aborted) return;
        setLoading(false);
      }
    },
    [filters.status, filters.country, filters.date_from, filters.date_to]
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchSolicitudesAllPages(ac.signal);
    return () => ac.abort();
  }, [fetchSolicitudesAllPages]);

  const goToPage = useCallback((page: number) => {
    setPagination((p) => {
      const tp = Math.max(1, Math.ceil(totalFiltered / p.limit) || 1);
      return { ...p, page: Math.max(1, Math.min(page, tp)) };
    });
  }, [totalFiltered]);

  const handleLimitChange = useCallback((newLimit: number) => {
    setPagination((p) => ({ ...p, limit: newLimit, page: 1 }));
  }, []);

  const countryLabel = COUNTRY_OPTIONS.find((o) => o.value === filters.country)?.label ?? 'Todos';
  const searchActive = debouncedDriverSearch.trim().length > 0;

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

      <SolicitudesFilters
        filters={filters}
        onFiltersChange={setFilters}
        driverSearch={driverSearchInput}
        onDriverSearchChange={setDriverSearchInput}
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{totalFiltered.toLocaleString('es-PE')}</span>
        <span className="text-sm text-gray-600">solicitudes</span>
        {searchActive && sourceSolicitudes.length !== totalFiltered && (
          <span className="text-xs text-gray-500 w-full sm:w-auto sm:ml-2">
            (filtradas desde {sourceSolicitudes.length.toLocaleString('es-PE')} cargadas)
          </span>
        )}
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : sourceSolicitudes.length === 0 ? (
        <EmptyState />
      ) : totalFiltered === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 text-center">
          <FileText className="w-10 h-10 text-gray-400 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-900 mb-2">Sin coincidencias</h3>
          <p className="text-gray-600 text-sm">Ninguna fila coincide con «{debouncedDriverSearch.trim()}». Prueba con otro DNI o nombre.</p>
        </div>
      ) : (
        <>
          <SolicitudesTable
            solicitudes={displaySolicitudes}
            onViewDetail={(id) => navigate(`/admin/yego-mi-auto/requests/${id}`)}
            isLoading={false}
          />
          {totalFiltered > 0 && (
            <PaginationBar
              pagination={{
                ...pagination,
                page: pageClamped,
                total: totalFiltered,
                totalPages: totalPagesClient,
              }}
              onPageChange={goToPage}
              onLimitChange={handleLimitChange}
              isLoading={loading}
            />
          )}
        </>
      )}
    </div>
  );
}
