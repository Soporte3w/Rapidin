import { useCallback, useEffect, useState } from 'react';
import { Banknote } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { RapidinSearchField } from '../../components/RapidinSearchField';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import api from '../../services/api';
import { formatDate } from '../../utils/date';
import {
  fetchMimotoCronogramas,
  fetchMimotoFleets,
  formatMimotoMoney,
  mimotoApiErrorMessage,
  type MimotoCronograma,
  type MimotoCurrency,
  type MimotoFleet,
  type MimotoSolicitud,
  unwrap,
} from './mimotoApi';
import { MimotoEmpty, MimotoLoading, MimotoPageHeader, MimotoPagination } from './mimotoUi';

type ListResponse = {
  data: MimotoSolicitud[];
  pagination: { page: number; limit: number; total: number };
};

type RentSaleSearchState = {
  searchInput?: string;
  fleetId?: string;
  cronogramaId?: string;
  cuotaEstado?: string;
  page?: number;
  pageSize?: number;
};

const QUOTA_STATUS_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'vencido', label: 'Con mora (cuotas vencidas)' },
  { value: 'pendiente', label: 'Con cuota pendiente (aún no vencida)' },
  { value: 'al_dia', label: 'Al día (sin vencidas, con cuotas)' },
  { value: 'sin_cuotas', label: 'Sin cuotas en sistema' },
];
const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-500';

export default function YegoMiMotoLoans() {
  const navigate = useNavigate();
  const location = useLocation();
  const saved = (location.state || {}) as RentSaleSearchState;
  const [rows, setRows] = useState<MimotoSolicitud[]>([]);
  const [fleets, setFleets] = useState<MimotoFleet[]>([]);
  const [cronogramas, setCronogramas] = useState<MimotoCronograma[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState(saved.searchInput || '');
  const search = useDebouncedValue(searchInput, 400);
  const [fleetId, setFleetId] = useState(saved.fleetId || '');
  const [cronogramaId, setCronogramaId] = useState(saved.cronogramaId || '');
  const [cuotaEstado, setCuotaEstado] = useState(saved.cuotaEstado || '');
  const [page, setPage] = useState(saved.page || 1);
  const [pageSize, setPageSize] = useState(saved.pageSize || 20);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    Promise.all([fetchMimotoFleets(true), fetchMimotoCronogramas()])
      .then(([fleetRows, scheduleRows]) => { setFleets(fleetRows); setCronogramas(scheduleRows); })
      .catch(() => { setFleets([]); setCronogramas([]); });
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/mimoto/solicitudes', {
        signal,
        params: {
          page,
          limit: pageSize,
          status: 'aprobado,activo',
          ...(search.trim() ? { q: search.trim() } : {}),
          ...(fleetId ? { fleet_id: fleetId } : {}),
          ...(cronogramaId ? { cronograma_id: cronogramaId } : {}),
          ...(cuotaEstado ? { cuota_estado: cuotaEstado } : {}),
        },
      });
      const payload = unwrap<ListResponse>(response);
      setRows(payload?.data ?? []);
      setTotal(payload?.pagination?.total ?? 0);
    } catch (requestError: unknown) {
      if (axios.isCancel(requestError)) return;
      setRows([]);
      setTotal(0);
      setError(mimotoApiErrorMessage(requestError, 'Error al cargar Alquiler / Venta'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [cronogramaId, cuotaEstado, fleetId, page, pageSize, search]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const resetPage = () => setPage(1);
  const openDetail = (row: MimotoSolicitud) => navigate(`/admin/yego-mi-moto/rent-sale/${row.id}`, {
    state: { fromList: true, searchInput, fleetId, cronogramaId, cuotaEstado, page, pageSize },
  });
  const hasFilters = Boolean(search.trim() || fleetId || cronogramaId || cuotaEstado);

  return (
    <div className="space-y-4 lg:space-y-6">
      <MimotoPageHeader
        icon={Banknote}
        title="Alquiler / Venta"
        subtitle="Contratos Mi Moto con cobro semanal activo — Colombia"
      />

      <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <label htmlFor="mimoto-rent-fleet" className="mb-1.5 block text-xs font-semibold text-gray-900">Flota</label>
          <select id="mimoto-rent-fleet" value={fleetId} onChange={(event) => { setFleetId(event.target.value); resetPage(); }} className={`${INPUT_CLASS} max-w-xs`}>
            <option value="">Todas las flotas</option>
            {fleets.map((fleet) => <option key={fleet.id} value={fleet.id}>{fleet.name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <RapidinSearchField
            id="mimoto-alquiler-venta-q"
            label="Buscar (placa, nombre, documento, licencia, teléfono)"
            value={searchInput}
            onChange={(value) => { setSearchInput(value); resetPage(); }}
            placeholder="Ej. ABC123, Juan, CC…"
            className="max-w-lg"
          />
          <div>
            <label htmlFor="mimoto-rent-schedule" className="mb-1.5 block text-xs font-semibold text-gray-900">Cronograma</label>
            <select id="mimoto-rent-schedule" value={cronogramaId} onChange={(event) => { setCronogramaId(event.target.value); resetPage(); }} className={`${INPUT_CLASS} max-w-lg`}>
              <option value="">Todos los cronogramas</option>
              {cronogramas.map((cronograma) => <option key={cronograma.id} value={cronograma.id}>{cronograma.name}</option>)}
            </select>
          </div>
          <div className="md:col-span-2 xl:col-span-1">
            <label htmlFor="mimoto-rent-quota-status" className="mb-1.5 block text-xs font-semibold text-gray-900">Estado de cuotas</label>
            <select id="mimoto-rent-quota-status" value={cuotaEstado} onChange={(event) => { setCuotaEstado(event.target.value); resetPage(); }} className={INPUT_CLASS}>
              {QUOTA_STATUS_OPTIONS.map((option) => <option key={option.value || 'all'} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        </div>
      </section>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-gray-200 bg-white px-4 py-3">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{total.toLocaleString('es-CO')}</span>
        <span className="text-sm text-gray-600">contratos</span>
      </div>

      {loading ? (
        <MimotoLoading label="Cargando contratos..." />
      ) : rows.length === 0 ? (
        <MimotoEmpty
          icon={Banknote}
          title={hasFilters ? 'Sin resultados' : 'No hay contratos'}
          description={hasFilters ? 'Prueba otra flota, cronograma, estado o conductor.' : 'Los contratos aparecerán cuando una solicitud Mi Moto sea aprobada.'}
        />
      ) : (
        <>
          <section className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="w-full min-w-[1320px]">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Conductor</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Documento</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Licencia</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Cronograma</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Moto</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Placa</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Inicio cobro</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Cuotas</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Vencidas</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Cuotas pagadas</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Inicial</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {rows.map((row) => {
                  const currency = (row.vehiculo_moneda || 'COP') as MimotoCurrency;
                  return (
                    <tr
                      key={row.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openDetail(row)}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(row); } }}
                      className="cursor-pointer hover:bg-red-50/40 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-red-200"
                      title="Abrir detalle"
                    >
                      <td className="px-4 py-3 text-sm font-medium text-gray-900"><p>{row.first_name} {row.last_name}</p><p className="text-xs font-normal text-gray-500">{row.fleet_name || '—'}</p></td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">{row.document_type} {row.document_number}</td>
                      <td className="px-4 py-3 text-sm font-mono text-gray-800">{row.license_number || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{row.cronograma_name || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{row.vehiculo_name || '—'}</td>
                      <td className="px-4 py-3 text-sm font-mono text-gray-800">{row.placa_asignada || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{row.fecha_inicio_cobro_semanal ? formatDate(row.fecha_inicio_cobro_semanal, 'es-CO') : '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{row.cuotas_pagadas || 0} / {row.cuotas_semanales_plan || row.total_cuotas || 0}</td>
                      <td className="px-4 py-3">{Number(row.cuotas_vencidas || 0) > 0 ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800">{row.cuotas_vencidas}</span> : <span className="text-gray-400">0</span>}</td>
                      <td className="px-4 py-3 text-sm font-medium tabular-nums text-green-700">{formatMimotoMoney(row.total_pagado, currency)}</td>
                      <td className="px-4 py-3 text-sm font-semibold tabular-nums text-gray-800">{Number(row.vehiculo_inicial || 0) > 0 ? formatMimotoMoney(row.vehiculo_inicial, row.vehiculo_inicial_moneda || 'COP') : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <MimotoPagination
            page={page}
            pageSize={pageSize}
            total={total}
            loading={loading}
            onPageChange={setPage}
            onPageSizeChange={(value) => { setPageSize(value); resetPage(); }}
          />
        </>
      )}
    </div>
  );
}
