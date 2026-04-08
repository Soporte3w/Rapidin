import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import {
  CreditCard,
  Eye,
  DollarSign,
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Upload,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate } from '../../utils/date';
import toast from 'react-hot-toast';
import { MIAUTO_NO_CACHE_HEADERS, isAxiosAbortError } from '../../utils/miautoApiUtils';
import {
  ALQUILER_VENTA_CUOTA_ESTADO_OPTIONS,
  conductorDisplay,
  formatTotalPagadoList,
  monedaCuotasLabel,
  symMoneda,
  type AlquilerVentaListItem,
} from '../../utils/miautoAlquilerVentaList';

interface CuotaSemanal {
  id: string;
  due_date: string;
  week_start_date: string;
  amount_due: number;
  paid_amount: number;
  late_fee: number;
  mora_pendiente?: number;
  status: string;
  /** Solo cuota pendiente (sin mora). */
  pending_total: number;
  /** Cuota + mora pendiente (saldo total de la semana). */
  cuota_final?: number;
  moneda?: string | null;
}

const COUNTRY_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'PE', label: 'Perú' },
  { value: 'CO', label: 'Colombia' },
];

interface CronogramaOption {
  id: string;
  name: string;
}

interface PaginationState {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const PAGE_SIZES = [10, 20, 50];
const PAGINATION_BTN =
  'w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

function getVisiblePageNumbers(pagination: PaginationState): number[] {
  const { page, totalPages } = pagination;
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, i) => i + 1);
  if (page <= 3) return [1, 2, 3, 4, 5];
  if (page >= totalPages - 2) return Array.from({ length: 5 }, (_, i) => totalPages - 4 + i);
  return [page - 2, page - 1, page, page + 1, page + 2];
}

export default function YegoMiAutoPayments() {
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
  const paginationRef = useRef(pagination);
  paginationRef.current = pagination;
  const [modalPagar, setModalPagar] = useState<AlquilerVentaListItem | null>(null);
  const [cuotas, setCuotas] = useState<CuotaSemanal[]>([]);
  const [loadingCuotas, setLoadingCuotas] = useState(false);
  const [pagoMonto, setPagoMonto] = useState('');
  const [pagoMoneda, setPagoMoneda] = useState<'PEN' | 'USD'>('PEN');
  const [cuotaSeleccionadaId, setCuotaSeleccionadaId] = useState<string>('');
  const [enviando, setEnviando] = useState(false);
  const [comprobanteFile, setComprobanteFile] = useState<File | null>(null);
  const comprobanteInputRef = useRef<HTMLInputElement>(null);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [cronogramaId, setCronogramaId] = useState('');
  const [cuotaEstado, setCuotaEstado] = useState('');
  const [cronogramas, setCronogramas] = useState<CronogramaOption[]>([]);

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
          list.map((c: { id: string; name: string }) => ({
            id: c.id,
            name: c.name,
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
        setError(e.response?.data?.message || 'Error al cargar');
        setItems([]);
      } finally {
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

  const abrirModalPagar = useCallback(async (row: AlquilerVentaListItem) => {
    setModalPagar(row);
    setCuotaSeleccionadaId('');
    setPagoMonto('');
    setPagoMoneda(monedaCuotasLabel(row.moneda));
    setCuotas([]);
    try {
      setLoadingCuotas(true);
      const res = await api.get(`/miauto/solicitudes/${row.id}/cuotas-semanales`);
      const payload = res.data?.data ?? res.data;
      const lista = Array.isArray(payload) ? payload : (payload?.data ?? []);
      const conPendiente = lista.filter((c: CuotaSemanal) => {
        if (c.status !== 'pending' && c.status !== 'overdue') return false;
        const moraPend = c.mora_pendiente != null ? Number(c.mora_pendiente) : Number(c.late_fee || 0);
        const total =
          c.cuota_final != null
            ? Number(c.cuota_final)
            : Math.max(0, Number(c.amount_due || 0) + moraPend - Number(c.paid_amount || 0));
        return total > 0;
      });
      setCuotas(conPendiente);
      if (conPendiente.length > 0) {
        setCuotaSeleccionadaId(conPendiente[0].id);
      }
    } catch {
      setCuotas([]);
      toast.error('No se pudieron cargar las cuotas');
    } finally {
      setLoadingCuotas(false);
    }
  }, []);

  const cuotaSeleccionada = useMemo(
    () => cuotas.find((c) => c.id === cuotaSeleccionadaId),
    [cuotas, cuotaSeleccionadaId]
  );

  useEffect(() => {
    if (!cuotaSeleccionada) return;
    setPagoMoneda(monedaCuotasLabel(cuotaSeleccionada.moneda));
  }, [cuotaSeleccionada]);

  const cerrarModal = useCallback(() => {
    setModalPagar(null);
    setCuotas([]);
    setCuotaSeleccionadaId('');
    setPagoMonto('');
    setComprobanteFile(null);
  }, []);

  const registrarPago = async () => {
    if (!modalPagar || !cuotaSeleccionadaId) {
      toast.error('Elige una cuota');
      return;
    }
    const monto = parseFloat(pagoMonto);
    if (Number.isNaN(monto) || monto <= 0) {
      toast.error('Indica un monto válido');
      return;
    }
    try {
      setEnviando(true);
      await api.post(
        `/miauto/solicitudes/${modalPagar.id}/cuotas-semanales/${cuotaSeleccionadaId}/pago-manual`,
        { monto, moneda: pagoMoneda }
      );
      if (comprobanteFile) {
        const fd = new FormData();
        fd.append('file', comprobanteFile);
        fd.append('monto', String(monto));
        fd.append('moneda', pagoMoneda);
        try {
          await api.post(
            `/miauto/solicitudes/${modalPagar.id}/cuotas-semanales/${cuotaSeleccionadaId}/comprobantes-conformidad-admin`,
            fd,
            { headers: { 'Content-Type': 'multipart/form-data' } }
          );
        } catch {
          toast.error('Pago registrado, pero falló la subida del comprobante');
        }
      }
      toast.success('Pago manual registrado');
      cerrarModal();
      const ref = paginationRef.current;
      fetchList(ref.page, ref.limit, true);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al registrar pago');
    } finally {
      setEnviando(false);
    }
  };

  const countryLabel = COUNTRY_OPTIONS.find((o) => o.value === country)?.label ?? 'Todos';
  const hasActiveFilters = Boolean(debouncedSearch || cronogramaId || cuotaEstado);

  return (
    <div className="space-y-4 lg:space-y-6">
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
            <CreditCard className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Pagos</h1>
            <p className="text-xs lg:text-sm text-white/90 mt-0.5">
              Registrar pago manual a los contratos de Alquiler / Venta — {countryLabel}
            </p>
          </div>
        </div>
      </header>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 space-y-4">
        <div>
          <label htmlFor="country-pagos" className="block text-xs font-semibold text-gray-900 mb-1.5">
            País
          </label>
          <select
            id="country-pagos"
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
            <label htmlFor="search-pagos" className="block text-xs font-semibold text-gray-900 mb-1.5">
              Buscar conductor, DNI, placa o teléfono
            </label>
            <div className="relative max-w-lg">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                id="search-pagos"
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Ej. nombre, DNI, placa, últimos dígitos del celular…"
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
                autoComplete="off"
              />
            </div>
          </div>
          <div>
            <label htmlFor="cronograma-pagos" className="block text-xs font-semibold text-gray-900 mb-1.5">
              Cronograma
            </label>
            <select
              id="cronograma-pagos"
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
            <label htmlFor="cuota-estado-pagos" className="block text-xs font-semibold text-gray-900 mb-1.5">
              Estado de cuotas
            </label>
            <select
              id="cuota-estado-pagos"
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
          <CreditCard className="w-10 h-10 text-gray-400 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-900 mb-2">
            {hasActiveFilters ? 'Sin resultados' : 'No hay contratos'}
          </h3>
          <p className="text-gray-600 text-sm">
            {hasActiveFilters
              ? 'Prueba a cambiar la búsqueda, el cronograma, el estado de cuotas o el país.'
              : 'No hay contratos de Alquiler / Venta. Para registrar pagos manuales primero deben existir contratos con cobro semanal activo.'}
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
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Cronograma</th>
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
                  <td className="px-4 py-3 text-sm text-gray-700">{row.cronograma_name || '—'}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {row.cuotas_pagadas} / {(row.cuotas_semanales_plan ?? row.total_cuotas) || 0}
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
                  <td className="px-4 py-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/admin/yego-mi-auto/rent-sale/${row.id}`, { state: { driver_name: row.driver_name } })}
                      className="inline-flex items-center gap-1 px-2 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg border border-gray-300"
                    >
                      <Eye className="w-4 h-4" />
                      Ver detalle
                    </button>
                    <button
                      type="button"
                      onClick={() => abrirModalPagar(row)}
                      className="inline-flex items-center gap-1 px-2 py-1.5 text-sm font-medium text-[#8B1A1A] hover:bg-red-50 rounded-lg border border-[#8B1A1A]"
                    >
                      <DollarSign className="w-4 h-4" />
                      Pagar
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

      {/* Modal Registrar pago manual */}
      {modalPagar && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={cerrarModal}>
          <div
            className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[min(90vh,640px)] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-900">Registrar pago manual</h2>
              <button type="button" onClick={cerrarModal} className="p-1 text-gray-500 hover:text-gray-700 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="rounded-xl border border-gray-200 bg-gradient-to-b from-gray-50/90 to-white p-4 mb-4 shadow-sm">
              <p className="text-base font-semibold text-gray-900 leading-snug">{conductorDisplay(modalPagar)}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                DNI {modalPagar.dni}
                {modalPagar.phone ? ` · ${modalPagar.phone}` : ''}
              </p>
              <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-[11px] font-semibold text-[#8B1A1A] uppercase tracking-wide">Cronograma</dt>
                  <dd className="text-gray-900 mt-0.5">{modalPagar.cronograma_name || '—'}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold text-[#8B1A1A] uppercase tracking-wide">Vehículo</dt>
                  <dd className="text-gray-900 mt-0.5">{modalPagar.vehiculo_name || '—'}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold text-[#8B1A1A] uppercase tracking-wide">Placa</dt>
                  <dd className="text-gray-900 mt-0.5 font-mono tracking-wide">{modalPagar.placa_asignada || '—'}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold text-[#8B1A1A] uppercase tracking-wide">Inicio cobro semanal</dt>
                  <dd className="text-gray-900 mt-0.5">
                    {modalPagar.fecha_inicio_cobro_semanal
                      ? formatDate(modalPagar.fecha_inicio_cobro_semanal, 'es-ES')
                      : '—'}
                  </dd>
                </div>
              </dl>
              <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
                <span className="text-gray-600">
                  <span className="text-gray-500">Cuotas:</span>{' '}
                  <span className="font-medium text-gray-800">
                    {modalPagar.cuotas_pagadas} / {(modalPagar.cuotas_semanales_plan ?? modalPagar.total_cuotas) || 0}
                  </span>
                </span>
                <span className="text-green-700 font-medium tabular-nums">{formatTotalPagadoList(modalPagar)} total pagado</span>
                {modalPagar.cuotas_vencidas > 0 && (
                  <span className="text-red-700 font-medium">{modalPagar.cuotas_vencidas} vencida(s)</span>
                )}
              </div>
            </div>

            {loadingCuotas ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-[#8B1A1A] border-t-transparent" />
              </div>
            ) : cuotas.length === 0 ? (
              <div className="rounded-lg bg-amber-50 border border-amber-100 px-3 py-3 text-sm text-amber-900">
                No hay cuotas con saldo pendiente para este contrato. Si debe haber una cuota abierta, revisa el detalle del
                contrato o el cronograma de cobros.
              </div>
            ) : (
              <>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cuota</label>
                <select
                  value={cuotaSeleccionadaId}
                  onChange={(e) => setCuotaSeleccionadaId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4"
                >
                  {cuotas.map((c) => {
                    const moraPendOpt = c.mora_pendiente != null ? Number(c.mora_pendiente) : Number(c.late_fee || 0);
                    const saldoOpt =
                      c.cuota_final != null
                        ? Number(c.cuota_final)
                        : Math.max(0, Number(c.amount_due || 0) + moraPendOpt - Number(c.paid_amount || 0));
                    return (
                    <option key={c.id} value={c.id}>
                      Vence {formatDate(c.due_date || c.week_start_date, 'es-ES')} — {symMoneda(c.moneda)}{' '}
                      {saldoOpt.toFixed(2)}{' '}
                      saldo total
                    </option>
                    );
                  })}
                </select>

                <label className="block text-sm font-medium text-gray-700 mb-1">Monto</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={pagoMonto}
                  onChange={(e) => setPagoMonto(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-2"
                />

                <label className="block text-sm font-medium text-gray-700 mb-1">Moneda</label>
                <select
                  value={pagoMoneda}
                  onChange={(e) => setPagoMoneda(e.target.value as 'PEN' | 'USD')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4"
                >
                  <option value="PEN">S/. Soles</option>
                  <option value="USD">USD Dólares</option>
                </select>

                <label className="block text-sm font-medium text-gray-700 mb-1">Comprobante (opcional)</label>
                <div className="mb-4">
                  <input
                    ref={comprobanteInputRef}
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    onChange={(e) => setComprobanteFile(e.target.files?.[0] ?? null)}
                    className="hidden"
                  />
                  {comprobanteFile ? (
                    <div className="flex items-center gap-2 px-3 py-2 border border-green-300 bg-green-50 rounded-lg text-sm">
                      <Upload className="w-4 h-4 text-green-600 flex-shrink-0" />
                      <span className="truncate text-green-800 flex-1">{comprobanteFile.name}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setComprobanteFile(null);
                          if (comprobanteInputRef.current) comprobanteInputRef.current.value = '';
                        }}
                        className="p-0.5 text-green-600 hover:text-red-600 rounded"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => comprobanteInputRef.current?.click()}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:border-[#8B1A1A] hover:text-[#8B1A1A] transition-colors"
                    >
                      <Upload className="w-4 h-4" />
                      Adjuntar comprobante
                    </button>
                  )}
                </div>

                <div className="flex gap-2 justify-end pt-2">
                  <button
                    type="button"
                    onClick={cerrarModal}
                    className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={enviando}
                    onClick={registrarPago}
                    className="px-4 py-2 text-sm font-medium text-white bg-[#8B1A1A] rounded-lg hover:bg-[#6B1515] disabled:opacity-50"
                  >
                    {enviando ? 'Registrando...' : 'Registrar pago'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
