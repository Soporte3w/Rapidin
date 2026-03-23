import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import { Banknote, Eye, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Search } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate } from '../../utils/date';
import { MIAUTO_NO_CACHE_HEADERS, isAxiosAbortError } from '../../utils/miautoApiUtils';
import {
  ALQUILER_VENTA_CUOTA_ESTADO_OPTIONS,
  conductorDisplay,
  formatTotalPagadoList,
  type AlquilerVentaListItem,
} from '../../utils/miautoAlquilerVentaList';

interface PaginationState {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const COUNTRY_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'PE', label: 'Perú' },
  { value: 'CO', label: 'Colombia' },
];

const PAGE_SIZES = [10, 20, 50];
const PAGINATION_BTN = 'w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

interface CronogramaOption {
  id: string;
  name: string;
}

function getVisiblePageNumbers(pagination: PaginationState): number[] {
  const { page, totalPages } = pagination;
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, i) => i + 1);
  if (page <= 3) return [1, 2, 3, 4, 5];
  if (page >= totalPages - 2) return Array.from({ length: 5 }, (_, i) => totalPages - 4 + i);
  return [page - 2, page - 1, page, page + 1, page + 2];
}

export default function YegoMiAutoLoans() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [items, setItems] = useState<AlquilerVentaListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [country, setCountry] = useState((user?.country as string) || '');
  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [paginationLoading, setPaginationLoading] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [cronogramaId, setCronogramaId] = useState('');
  const [cuotaEstado, setCuotaEstado] = useState('');
  const [cronogramas, setCronogramas] = useState<CronogramaOption[]>([]);
  const paginationRef = useRef(pagination);
  paginationRef.current = pagination;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setCronogramaId('');
    setCuotaEstado('');
  }, [country]);

  useEffect(() => {
    const ac = new AbortController();
    const qs = new URLSearchParams();
    if (country) qs.set('country', country);
    qs.set('active', 'true');
    qs.set('lite', 'true');
    api
      .get(`/miauto/cronogramas?${qs.toString()}`, { signal: ac.signal, headers: MIAUTO_NO_CACHE_HEADERS })
      .then((res) => {
        const data = res.data?.data ?? res.data;
        const list = Array.isArray(data) ? data : [];
        setCronogramas(
          list.map((c: { id: string; name: string; country?: string }) => ({
            id: c.id,
            name: c.name,
            country: c.country,
          }))
        );
      })
      .catch((e) => {
        if (isAxiosAbortError(e)) return;
        setCronogramas([]);
      });
    return () => ac.abort();
  }, [country]);

  const fetchList = useCallback(
    async (page: number, limit: number, isPaginationChange: boolean, signal?: AbortSignal) => {
      try {
        if (isPaginationChange) setPaginationLoading(true);
        else setLoading(true);
        setError('');
        const params = new URLSearchParams();
        params.append('page', String(page));
        params.append('limit', String(limit));
        if (country) params.append('country', country);
        if (debouncedSearch) params.append('q', debouncedSearch);
        if (cronogramaId) params.append('cronograma_id', cronogramaId);
        if (cuotaEstado) params.append('cuota_estado', cuotaEstado);
        const response = await api.get(`/miauto/alquiler-venta?${params.toString()}`, {
          signal,
          headers: MIAUTO_NO_CACHE_HEADERS,
        });
        const data = response.data?.data ?? [];
        const pag = response.data?.pagination ?? {};
        setItems(Array.isArray(data) ? data : []);
        setPagination((p) => ({
          ...p,
          page: pag.page ?? page,
          limit: pag.limit ?? limit,
          total: pag.total ?? 0,
          totalPages: pag.totalPages ?? 1,
        }));
      } catch (e: any) {
        if (isAxiosAbortError(e)) return;
        setError(e.response?.data?.message || 'Error al cargar Alquiler / Venta');
        setItems([]);
      } finally {
        // Strict Mode aborta la 1.ª petición: no bajar loading o se ve "vacío" hasta la 2.ª.
        if (signal?.aborted) return;
        setLoading(false);
        setPaginationLoading(false);
      }
    },
    [country, debouncedSearch, cronogramaId, cuotaEstado]
  );

  useEffect(() => {
    const ac = new AbortController();
    const lim = paginationRef.current.limit;
    setPagination((p) => ({ ...p, page: 1 }));
    fetchList(1, lim, false, ac.signal);
    return () => ac.abort();
  }, [country, debouncedSearch, cronogramaId, cuotaEstado, fetchList]);

  const goToPage = useCallback(
    (page: number) => {
      const p = Math.max(1, Math.min(page, pagination.totalPages || 1));
      fetchList(p, pagination.limit, true);
    },
    [pagination.totalPages, pagination.limit, fetchList]
  );

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      setPagination((p) => ({ ...p, limit: newLimit, page: 1 }));
      fetchList(1, newLimit, true);
    },
    [fetchList]
  );

  const countryLabel = COUNTRY_OPTIONS.find((o) => o.value === country)?.label ?? 'Todos';
  const hasActiveFilters = Boolean(debouncedSearch || cronogramaId || cuotaEstado);

  return (
    <div className="space-y-4 lg:space-y-6">
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
            <Banknote className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Alquiler / Venta</h1>
            <p className="text-xs lg:text-sm text-white/90 mt-0.5">
              Contratos Mi Auto con cobro semanal activo — {countryLabel}
            </p>
          </div>
        </div>
      </header>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 space-y-4">
        <div>
          <label htmlFor="country-av" className="block text-xs font-semibold text-gray-900 mb-1.5">
            País
          </label>
          <select
            id="country-av"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
          >
            {COUNTRY_OPTIONS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div>
            <label htmlFor="search-av" className="block text-xs font-semibold text-gray-900 mb-1.5">
              Buscar (placa, nombre, DNI, licencia, teléfono)
            </label>
            <div className="relative max-w-lg">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                id="search-av"
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Ej. ABC123, Juan, Q12345678…"
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
                autoComplete="off"
              />
            </div>
          </div>
          <div>
            <label htmlFor="cronograma-av" className="block text-xs font-semibold text-gray-900 mb-1.5">
              Cronograma
            </label>
            <select
              id="cronograma-av"
              value={cronogramaId}
              onChange={(e) => setCronogramaId(e.target.value)}
              className="w-full max-w-lg px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
            >
              <option value="">Todos los cronogramas</option>
              {cronogramas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2 xl:col-span-1">
            <label htmlFor="cuota-estado-av" className="block text-xs font-semibold text-gray-900 mb-1.5">
              Estado de cuotas
            </label>
            <select
              id="cuota-estado-av"
              value={cuotaEstado}
              onChange={(e) => setCuotaEstado(e.target.value)}
              className="w-full max-w-lg xl:max-w-none px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
            >
              {ALQUILER_VENTA_CUOTA_ESTADO_OPTIONS.map((o) => (
                <option key={o.value || 'all'} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{pagination.total.toLocaleString('es-PE')}</span>
        <span className="text-sm text-gray-600">contratos</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 text-center">
          <Banknote className="w-10 h-10 text-gray-400 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-900 mb-2">
            {hasActiveFilters ? 'Sin resultados' : 'No hay contratos'}
          </h3>
          <p className="text-gray-600 text-sm">
            {hasActiveFilters
              ? 'Prueba a cambiar la búsqueda, el cronograma o el país.'
              : 'Aún no hay contratos de Alquiler / Venta. Aparecerán aquí cuando se genere Yego Mi Auto en una solicitud aprobada.'}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto bg-white rounded-lg border border-gray-200 shadow-sm">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Conductor</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">DNI</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Licencia</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Cronograma</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Vehículo</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Placa</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Inicio cobro</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Cuotas</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Vencidas</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Total pagado</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {items.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{conductorDisplay(row)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{row.dni}</td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-800">{row.license_number || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{row.cronograma_name || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{row.vehiculo_name || '—'}</td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-800">{row.placa_asignada || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {row.fecha_inicio_cobro_semanal ? formatDate(row.fecha_inicio_cobro_semanal, 'es-ES') : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {row.cuotas_pagadas} / {(row.cuotas_semanales_plan != null && row.cuotas_semanales_plan > 0) ? row.cuotas_semanales_plan : row.total_cuotas}
                    </td>
                    <td className="px-4 py-3">
                      {row.cuotas_vencidas > 0 ? (
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                          {row.cuotas_vencidas}
                        </span>
                      ) : (
                        <span className="text-gray-400">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-green-700 tabular-nums">
                      {formatTotalPagadoList(row)}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => navigate(`/admin/yego-mi-auto/rent-sale/${row.id}`, { state: { driver_name: row.driver_name } })}
                        className="inline-flex items-center gap-1 px-2 py-1.5 text-sm font-medium text-[#8B1A1A] hover:bg-red-50 rounded-lg"
                      >
                        <Eye className="w-4 h-4" />
                        Ver detalle
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pagination.totalPages > 1 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-4 bg-white rounded-lg border border-gray-200">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-600">Por página:</span>
                <select
                  value={pagination.limit}
                  onChange={(e) => handleLimitChange(Number(e.target.value))}
                  className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 focus:ring-2 focus:ring-red-500"
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
                  disabled={pagination.page <= 1 || paginationLoading}
                  className={PAGINATION_BTN}
                  aria-label="Primera página"
                >
                  <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(pagination.page - 1)}
                  disabled={pagination.page <= 1 || paginationLoading}
                  className={PAGINATION_BTN}
                  aria-label="Anterior"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {getVisiblePageNumbers(pagination).map((pageNum) => (
                  <button
                    key={pageNum}
                    type="button"
                    onClick={() => goToPage(pageNum)}
                    disabled={paginationLoading}
                    className={`min-w-[2.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                      pagination.page === pageNum
                        ? 'bg-red-600 text-white border-2 border-red-600'
                        : 'border-2 border-red-600 text-red-600 hover:bg-red-50'
                    }`}
                  >
                    {pageNum}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => goToPage(pagination.page + 1)}
                  disabled={pagination.page >= pagination.totalPages || paginationLoading}
                  className={PAGINATION_BTN}
                  aria-label="Siguiente"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(pagination.totalPages || 1)}
                  disabled={pagination.page >= pagination.totalPages || paginationLoading}
                  className={PAGINATION_BTN}
                  aria-label="Última página"
                >
                  <ChevronsRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
