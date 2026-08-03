import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../../services/api';
import { Banknote, History } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate } from '../../utils/date';
import { MIAUTO_NO_CACHE_HEADERS, isAxiosAbortError } from '../../utils/miautoApiUtils';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { RapidinSearchField } from '../../components/RapidinSearchField';
import { TablePaginationBar } from '../../components/TablePaginationBar';
import {
  ALQUILER_VENTA_CUOTA_ESTADO_OPTIONS,
  conductorDisplay,
  formatInicialList,
  formatTotalPagadoList,
  type AlquilerVentaListItem,
} from '../../utils/miautoAlquilerVentaList';

type AlquilerVentaSearchState = {
  fromDetail?: boolean;
  country?: string;
  driverSearchInput?: string;
  cronogramaId?: string;
  cuotaEstado?: string;
  page?: number;
  pageSize?: number;
};

type AlquilerVentaNavigationItem = {
  id: string;
  driver_name?: string;
};

const COUNTRY_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'PE', label: 'Perú' },
  { value: 'CO', label: 'Colombia' },
];

const PAGE_SIZES = [10, 20, 50];
const PAGE_SIZE_STORAGE_KEY = 'miauto.admin.rentSale.pageSize';
const API_PAGE_CHUNK = 500;

function foldLower(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function alquilerVentaMatchesQuery(row: AlquilerVentaListItem, rawQuery: string): boolean {
  const qTrim = rawQuery.trim();
  if (!qTrim) return true;
  const qFold = foldLower(qTrim);
  const qDigits = qTrim.replace(/\D/g, '');
  const parts = [
    row.dni,
    row.placa_asignada,
    row.driver_name,
    row.phone,
    row.email,
    row.license_number,
    row.cronograma_name,
    row.vehiculo_name,
    conductorDisplay(row),
  ];
  for (const p of parts) {
    if (p == null || p === '') continue;
    const s = String(p);
    if (foldLower(s).includes(qFold)) return true;
    if (qDigits.length >= 2 && s.replace(/\D/g, '').includes(qDigits)) return true;
  }
  return false;
}

export default function YegoMiAutoLoans() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const returnConsumedRef = useRef(false);

  const searchState = location.state as AlquilerVentaSearchState | null;
  const isReturnFromDetail = Boolean(searchState?.fromDetail);

  const [sourceItems, setSourceItems] = useState<AlquilerVentaListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [country, setCountry] = useState(
    isReturnFromDetail ? (searchState?.country ?? ((user?.country as string) || '')) : ((user?.country as string) || '')
  );
  const [page, setPage] = useState(isReturnFromDetail && searchState?.page != null ? searchState.page : 1);
  const [pageSize, setPageSize] = useState(() => {
    if (isReturnFromDetail && searchState?.pageSize != null) return searchState.pageSize;
    try {
      const stored = Number(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
      return PAGE_SIZES.includes(stored) ? stored : 20;
    } catch {
      return 20;
    }
  });
  const [driverSearchInput, setDriverSearchInput] = useState(isReturnFromDetail ? (searchState?.driverSearchInput ?? '') : '');
  const debouncedSearch = useDebouncedValue(driverSearchInput, 400);
  const [cronogramaId, setCronogramaId] = useState(isReturnFromDetail ? (searchState?.cronogramaId ?? '') : '');
  const [cuotaEstado, setCuotaEstado] = useState(isReturnFromDetail ? (searchState?.cuotaEstado ?? '') : '');
  const [cronogramas, setCronogramas] = useState<{ id: string; name: string }[]>([]);

  const filteredItems = useMemo(() => {
    const q = debouncedSearch.trim();
    if (!q) return sourceItems;
    return sourceItems.filter((row) => alquilerVentaMatchesQuery(row, q));
  }, [sourceItems, debouncedSearch]);

  const totalFiltered = filteredItems.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize) || 1);
  const pageClamped = Math.min(Math.max(1, page), totalPages);

  useEffect(() => {
    if (page !== pageClamped) setPage(pageClamped);
  }, [page, pageClamped]);

  const displayItems = useMemo(() => {
    const start = (pageClamped - 1) * pageSize;
    return filteredItems.slice(start, start + pageSize);
  }, [filteredItems, pageClamped, pageSize]);

  const detailNavigationItems = useMemo<AlquilerVentaNavigationItem[]>(
    () => filteredItems.map((row) => ({ id: row.id, driver_name: conductorDisplay(row) })),
    [filteredItems]
  );

  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (isReturnFromDetail) return;
    }
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
        setCronogramas(list.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })));
      })
      .catch((e) => {
        if (isAxiosAbortError(e)) return;
        setCronogramas([]);
      });
    return () => ac.abort();
  }, [country]);

  const fetchAlquilerVentaAllPages = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoading(true);
        setError('');
        const accumulated: AlquilerVentaListItem[] = [];
        let serverTotal = 0;
        let apiPage = 1;
        while (!signal?.aborted) {
          const params = new URLSearchParams();
          params.append('page', String(apiPage));
          params.append('limit', String(API_PAGE_CHUNK));
          if (country) params.append('country', country);
          if (cronogramaId) params.append('cronograma_id', cronogramaId);
          if (cuotaEstado) params.append('cuota_estado', cuotaEstado);
          const response = await api.get(`/miauto/alquiler-venta?${params.toString()}`, {
            signal,
            headers: MIAUTO_NO_CACHE_HEADERS,
          });
          const data = response.data?.data ?? [];
          const pag = response.data?.pagination ?? {};
          serverTotal =
            typeof pag.total === 'number' ? pag.total : accumulated.length + (Array.isArray(data) ? data.length : 0);
          if (!Array.isArray(data) || data.length === 0) break;
          accumulated.push(...data);
          if (accumulated.length >= serverTotal || data.length < API_PAGE_CHUNK) break;
          apiPage += 1;
        }
        if (signal?.aborted) return;
        setSourceItems(accumulated);
        setPage(1);
      } catch (e: any) {
        if (isAxiosAbortError(e)) return;
        setError(e.response?.data?.message || 'Error al cargar Alquiler / Venta');
        setSourceItems([]);
      } finally {
        if (signal?.aborted) return;
        setLoading(false);
      }
    },
    [country, cronogramaId, cuotaEstado]
  );

  useEffect(() => {
    const ac = new AbortController();
    const st = location.state as AlquilerVentaSearchState | null;
    if (!returnConsumedRef.current && Boolean(st?.fromDetail)) {
      returnConsumedRef.current = true;
      navigate(location.pathname, { replace: true, state: {} });
    }
    fetchAlquilerVentaAllPages(ac.signal);
    return () => ac.abort();
  }, [fetchAlquilerVentaAllPages, navigate, location.pathname]);

  const handleLimitChange = useCallback((newLimit: number) => {
    setPageSize(newLimit);
    setPage(1);
    try {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(newLimit));
    } catch {
      // El listado sigue funcionando aunque el navegador bloquee el almacenamiento.
    }
  }, []);

  const openRentSaleDetail = useCallback((row: AlquilerVentaListItem) => {
    navigate(`/admin/yego-mi-auto/rent-sale/${row.id}`, {
      state: {
        fromList: true,
        driver_name: conductorDisplay(row),
        country,
        driverSearchInput,
        cronogramaId,
        cuotaEstado,
        page: pageClamped,
        pageSize,
        navigationItems: detailNavigationItems,
      },
    });
  }, [country, cronogramaId, cuotaEstado, detailNavigationItems, driverSearchInput, navigate, pageClamped, pageSize]);

  const countryLabel = COUNTRY_OPTIONS.find((o) => o.value === country)?.label ?? 'Todos';
  const searchActive = debouncedSearch.trim().length > 0;
  const hasServerFilters = Boolean(country || cronogramaId || cuotaEstado);

  return (
    <div className="space-y-4 lg:space-y-6">
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
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
          <button
            type="button"
            onClick={() => navigate('/admin/yego-mi-auto/fleet-cobros')}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/15 px-3 py-2 text-sm font-medium text-white hover:bg-white/25"
          >
            <History className="h-4 w-4" />
            Historial cobros Fleet
          </button>
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
          <RapidinSearchField
            id="miauto-alquiler-venta-q"
            label="Buscar (placa, nombre, DNI, licencia, teléfono)"
            value={driverSearchInput}
            onChange={setDriverSearchInput}
            placeholder="Ej. ABC123, Juan, Q12345678…"
            className="max-w-lg"
          />
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

      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{totalFiltered.toLocaleString('es-PE')}</span>
        <span className="text-sm text-gray-600">contratos</span>
        {searchActive && sourceItems.length !== totalFiltered && (
          <span className="text-xs text-gray-500 w-full sm:w-auto sm:ml-2">
            (filtrados desde {sourceItems.length.toLocaleString('es-PE')} cargados)
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
        </div>
      ) : sourceItems.length === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 text-center">
          <Banknote className="w-10 h-10 text-gray-400 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-900 mb-2">
            {hasServerFilters ? 'Sin resultados' : 'No hay contratos'}
          </h3>
          <p className="text-gray-600 text-sm">
            {hasServerFilters
              ? 'Prueba otro país, cronograma o estado de cuotas.'
              : 'Aún no hay contratos de Alquiler / Venta. Aparecerán aquí cuando se genere Yego Mi Auto en una solicitud aprobada.'}
          </p>
        </div>
      ) : totalFiltered === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 text-center">
          <Banknote className="w-10 h-10 text-gray-400 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-900 mb-2">Sin coincidencias</h3>
          <p className="text-gray-600 text-sm">
            Ningún contrato coincide con «{debouncedSearch.trim()}». Prueba con otra placa, DNI o nombre.
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
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Cuotas pagadas</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Inicial</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {displayItems.map((row) => (
                  <tr
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openRentSaleDetail(row)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openRentSaleDetail(row);
                      }
                    }}
                    className="cursor-pointer hover:bg-red-50/40 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-red-200"
                    title="Abrir detalle"
                  >
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {conductorDisplay(row)}
                      {row.yango_work_status === 'fired' && row.fired_driver_name && (
                        <div className="text-xs text-red-500">Inactivo: {row.fired_driver_name}</div>
                      )}
                    </td>
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
                    <td className="px-4 py-3 text-sm font-semibold text-gray-800 tabular-nums">
                      {formatInicialList(row)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalFiltered > 0 && (
            <TablePaginationBar
              page={pageClamped}
              setPage={setPage}
              totalPages={totalPages}
              limit={pageSize}
              setLimit={handleLimitChange}
              pageSizes={PAGE_SIZES}
              totalItems={totalFiltered}
              itemLabel="conductores"
              compact
              containerClassName="flex flex-col items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 sm:flex-row"
            />
          )}
        </>
      )}
    </div>
  );
}
