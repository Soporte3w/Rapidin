import { useCallback, useEffect, useState } from 'react';
import { Eye, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { DateRangePicker } from '../../components/DateRangePicker';
import { RapidinSearchField } from '../../components/RapidinSearchField';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import api from '../../services/api';
import { formatDate } from '../../utils/date';
import {
  fetchMimotoFleets,
  mimotoApiErrorMessage,
  MIMOTO_STATUS_LABEL,
  type MimotoFleet,
  type MimotoSolicitud,
  unwrap,
} from './mimotoApi';
import {
  MimotoEmpty,
  MimotoLoading,
  MimotoPageHeader,
  MimotoPagination,
  MimotoStatusBadge,
} from './mimotoUi';

type ListResponse = {
  data: MimotoSolicitud[];
  pagination: { page: number; limit: number; total: number };
};

const STATUS_OPTIONS = [
  '',
  'pendiente',
  'citado',
  'en_revision',
  'aprobado',
  'activo',
  'rechazado',
  'retirado',
  'cancelado',
];
const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-500';

export default function YegoMiMotoDashboard() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<MimotoSolicitud[]>([]);
  const [fleets, setFleets] = useState<MimotoFleet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 400);
  const [status, setStatus] = useState('');
  const [fleetId, setFleetId] = useState('');
  const [dateRange, setDateRange] = useState({ date_from: '', date_to: '' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    fetchMimotoFleets(true).then(setFleets).catch(() => setFleets([]));
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
          ...(search.trim() ? { q: search.trim() } : {}),
          ...(status ? { status } : {}),
          ...(fleetId ? { fleet_id: fleetId } : {}),
          ...(dateRange.date_from ? { date_from: dateRange.date_from } : {}),
          ...(dateRange.date_to ? { date_to: dateRange.date_to } : {}),
        },
      });
      const payload = unwrap<ListResponse>(response);
      setRows(payload?.data ?? []);
      setTotal(payload?.pagination?.total ?? 0);
    } catch (requestError: unknown) {
      if (axios.isCancel(requestError)) return;
      setRows([]);
      setTotal(0);
      setError(mimotoApiErrorMessage(requestError, 'Error al cargar solicitudes'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [dateRange.date_from, dateRange.date_to, fleetId, page, pageSize, search, status]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const resetPage = () => setPage(1);

  return (
    <div className="space-y-4 lg:space-y-6">
      <MimotoPageHeader
        icon={FileText}
        title="Solicitudes Mi Moto"
        subtitle="Conductores que quieren una moto — Colombia"
      />

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#8B1A1A]">Filtros</p>
        <div className="flex flex-col flex-wrap gap-4 sm:flex-row">
          <RapidinSearchField
            id="mimoto-solicitud-driver"
            label="Buscar por conductor"
            value={searchInput}
            onChange={(value) => { setSearchInput(value); resetPage(); }}
            placeholder="Nombre, documento o licencia"
            className="min-w-[220px] flex-1"
          />
          <div className="min-w-[180px] flex-1">
            <label htmlFor="mimoto-status" className="mb-1.5 block text-xs font-semibold text-gray-900">Estado de la solicitud</label>
            <select id="mimoto-status" value={status} onChange={(event) => { setStatus(event.target.value); resetPage(); }} className={INPUT_CLASS}>
              {STATUS_OPTIONS.map((value) => <option key={value || 'all'} value={value}>{value ? MIMOTO_STATUS_LABEL[value] || value : 'Todos'}</option>)}
            </select>
          </div>
          <div className="min-w-[180px] flex-1">
            <label htmlFor="mimoto-fleet" className="mb-1.5 block text-xs font-semibold text-gray-900">Flota</label>
            <select id="mimoto-fleet" value={fleetId} onChange={(event) => { setFleetId(event.target.value); resetPage(); }} className={INPUT_CLASS}>
              <option value="">Todas</option>
              {fleets.map((fleet) => <option key={fleet.id} value={fleet.id}>{fleet.name}</option>)}
            </select>
          </div>
          <div className="min-w-[220px] flex-1">
            <DateRangePicker
              label="Fecha"
              value={dateRange}
              onChange={(value) => { setDateRange(value); resetPage(); }}
              placeholder="Filtrar por fecha"
            />
          </div>
        </div>
      </section>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-gray-200 bg-white px-4 py-3">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{total.toLocaleString('es-CO')}</span>
        <span className="text-sm text-gray-600">solicitudes</span>
      </div>

      {loading ? (
        <MimotoLoading label="Cargando solicitudes..." />
      ) : rows.length === 0 ? (
        <MimotoEmpty icon={FileText} title="No hay solicitudes" description="No se encontraron solicitudes con los filtros seleccionados." />
      ) : (
        <>
          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Documento</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Conductor</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Licencia</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Flota</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Estado</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Fecha</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-700">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {rows.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">{row.document_type} {row.document_number}</td>
                      <td className="px-4 py-3 text-sm text-gray-700"><p className="font-medium text-gray-900">{row.first_name} {row.last_name}</p><p className="text-xs text-gray-500">+{row.phone}</p></td>
                      <td className="px-4 py-3 text-sm font-mono text-gray-700">{row.license_number || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{row.fleet_name || '—'}</td>
                      <td className="px-4 py-3"><MimotoStatusBadge status={row.status} label={MIMOTO_STATUS_LABEL[row.status] || row.status} /></td>
                      <td className="px-4 py-3 text-sm text-gray-600">{row.created_at ? formatDate(row.created_at, 'es-CO') : '—'}</td>
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => navigate(`/admin/yego-mi-moto/requests/${row.id}`)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-[#8B1A1A] hover:bg-red-50">
                          <Eye className="h-4 w-4" />Ver más detalle
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <MimotoPagination
            page={page}
            pageSize={pageSize}
            total={total}
            loading={loading}
            pageSizes={[5, 10, 20, 50]}
            onPageChange={setPage}
            onPageSizeChange={(value) => { setPageSize(value); resetPage(); }}
          />
        </>
      )}
    </div>
  );
}
