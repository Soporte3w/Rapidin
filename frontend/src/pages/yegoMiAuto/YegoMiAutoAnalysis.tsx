import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, ChevronRight, Download, ListFilter, RefreshCw, Search } from 'lucide-react';
import { DateRangePicker } from '../../components/DateRangePicker';
import api from '../../services/api';

type SupplyDriver = {
  driver_id: string;
  name: string;
  license_number: string | null;
  plate: string | null;
  completed_trips: number;
  supply_hours: number;
};

type SupplyData = {
  drivers: SupplyDriver[];
  totals: {
    drivers: number;
    active_drivers: number;
    completed_trips: number;
    supply_hours: number;
  };
};

type HeatmapDriver = {
  driver_id: string;
  name: string;
  license_number: string | null;
  plate: string | null;
  supply_by_date: Record<string, { hours: number; trips: number }>;
};

type SupplyHeatmapData = {
  dates: string[];
  drivers: HeatmapDriver[];
};

type SupplyState = 'on_track' | 'near' | 'behind';
type DateRange = { date_from: string; date_to: string };

const HOURS_TARGET = 200;

const stateMeta: Record<SupplyState, { label: string; color: string; badge: string }> = {
  on_track: { label: 'Cumple', color: '#16a34a', badge: 'bg-green-100 text-green-800' },
  near: { label: 'Por acelerar', color: '#eab308', badge: 'bg-yellow-100 text-yellow-800' },
  behind: { label: 'Rezago', color: '#dc2626', badge: 'bg-red-100 text-red-800' },
};

function limaYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function defaultDateRange(): DateRange {
  const today = limaYmd();
  return { date_from: `${today.slice(0, 7)}-01`, date_to: today };
}

function formatHours(value: number) {
  return `${Number(value || 0).toFixed(1)} h`;
}

function daysInclusive(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

function targetForPeriod(dateFrom: string, dateTo: string) {
  const today = limaYmd();
  const currentMonth = today.slice(0, 7);
  const isCurrentMonthToToday = dateFrom === `${currentMonth}-01` && dateTo === today;

  if (dateTo < currentMonth) return HOURS_TARGET;

  const [year, month] = dateFrom.slice(0, 7).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const periodDays = isCurrentMonthToToday
    ? Number(today.slice(8, 10))
    : Math.min(daysInclusive(dateFrom, dateTo), daysInMonth);

  return Math.round((HOURS_TARGET * periodDays / daysInMonth) * 10) / 10;
}

function getSupplyState(hours: number, target: number, closedPeriod: boolean): SupplyState {
  if (hours >= target) return 'on_track';
  if (!closedPeriod && hours >= target * 0.75) return 'near';
  return 'behind';
}

function escapeHtml(value: string | number | null | undefined) {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  };
  return String(value ?? '—').replace(/[&<>'"]/g, (character) => entities[character]);
}

function buildHeatmapPdf(data: SupplyHeatmapData | null, visibleDrivers: SupplyDriver[]) {
  if (!data) return '';

  const visibleIds = new Set(visibleDrivers.map((driver) => driver.driver_id));
  const drivers = data.drivers.filter((driver) => visibleIds.has(driver.driver_id));
  const maxHours = Math.max(1, ...drivers.flatMap((driver) => Object.values(driver.supply_by_date).map((entry) => entry.hours)));
  const dates = data.dates.map((date) => `<th>${escapeHtml(formatHeatmapDate(date))}</th>`).join('');
  const rows = drivers.map((driver) => {
    const cells = data.dates.map((date) => {
      const entry = driver.supply_by_date[date] || { hours: 0, trips: 0 };
      const intensity = entry.hours > 0 ? 0.14 + (entry.hours / maxHours) * 0.76 : 0;
      const color = entry.hours ? `rgba(139,26,26,${intensity})` : '#f9fafb';
      const text = intensity > 0.55 ? '#ffffff' : '#7f1d1d';
      return `<td style="background:${color};color:${entry.hours ? text : '#9ca3af'}">${entry.hours ? `${entry.hours.toFixed(1)}h<br><small>${entry.trips} viajes</small>` : '—'}</td>`;
    }).join('');
    return `<tr><th>${escapeHtml(driver.name)}<small>${escapeHtml(driver.plate || driver.license_number)}</small></th>${cells}</tr>`;
  }).join('');

  return `<section class="heatmap"><h2>Mapa de calor de Supply</h2><p class="muted">Cada celda muestra horas Supply y viajes realizados. El color más intenso indica mayor actividad.</p><table><thead><tr><th>Conductor</th>${dates}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

function exportSupplyPdf(drivers: SupplyDriver[], heatmapData: SupplyHeatmapData | null, dateRange: DateRange, target: number, closedPeriod: boolean) {
  const popup = window.open('', '_blank');
  if (!popup) return;

  popup.opener = null;
  const totalHours = drivers.reduce((sum, driver) => sum + driver.supply_hours, 0);
  const totalTrips = drivers.reduce((sum, driver) => sum + driver.completed_trips, 0);
  const rows = drivers.map((driver) => {
    const state = getSupplyState(driver.supply_hours, target, closedPeriod);
    return `<tr><td>${escapeHtml(driver.name)}</td><td>${escapeHtml(driver.plate)}</td><td class="num">${driver.completed_trips.toLocaleString('es-PE')}</td><td class="num">${formatHours(driver.supply_hours)}</td><td>${stateMeta[state].label}</td></tr>`;
  }).join('');
  const heatmap = buildHeatmapPdf(heatmapData, drivers);

  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Supply Mi Auto</title><style>@page{size:landscape;margin:12mm}body{font-family:Arial,sans-serif;color:#111827;margin:28px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 4px}.muted{color:#6b7280;font-size:12px;margin:0 0 20px}.summary{display:flex;gap:18px;margin:0 0 20px}.summary div{border:1px solid #e5e7eb;padding:10px 12px;min-width:120px}.summary strong{display:block;font-size:18px;margin-top:3px}table{width:100%;border-collapse:collapse;font-size:11px}th{background:#f3f4f6;text-align:left}th,td{border-bottom:1px solid #e5e7eb;padding:8px}.num{text-align:right}.heatmap{break-before:page;page-break-before:always}.heatmap table{font-size:8px;table-layout:fixed}.heatmap th,.heatmap td{padding:4px;text-align:center;border:1px solid #fff}.heatmap th:first-child{text-align:left;width:150px}.heatmap small{display:block;font-size:7px;font-weight:normal;margin-top:2px;opacity:.85}@media print{body{margin:0}}</style></head><body><h1>Yego Mi Auto · Análisis Supply</h1><p class="muted">Período: ${escapeHtml(dateRange.date_from)} a ${escapeHtml(dateRange.date_to)} · Meta: ${formatHours(target)}</p><div class="summary"><div>Conductores<strong>${drivers.length}</strong></div><div>Horas Supply<strong>${formatHours(totalHours)}</strong></div><div>Viajes completados<strong>${totalTrips.toLocaleString('es-PE')}</strong></div></div><table><thead><tr><th>Conductor</th><th>Placa</th><th class="num">Viajes</th><th class="num">Horas Supply</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table>${heatmap}<script>window.onload=()=>window.print()</script></body></html>`);
  popup.document.close();
}

function SupplyFilters({
  dateRange,
  query,
  stateFilter,
  loading,
  closedPeriod,
  onDateChange,
  onQueryChange,
  onStateChange,
  onRefresh,
}: {
  dateRange: DateRange;
  query: string;
  stateFilter: 'all' | SupplyState;
  loading: boolean;
  closedPeriod: boolean;
  onDateChange: (range: DateRange) => void;
  onQueryChange: (query: string) => void;
  onStateChange: (state: 'all' | SupplyState) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker
          label=""
          value={dateRange}
          onChange={onDateChange}
          placeholder="Seleccionar período"
          className="min-w-[230px] max-w-[280px]"
          inputClassName="h-10 rounded-full border-gray-300 py-0 shadow-sm"
        />
        <label className="relative flex h-10 min-w-[240px] flex-1 items-center rounded-full border border-gray-300 bg-white pl-9 pr-3 text-sm shadow-sm sm:flex-none">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-gray-500" />
          <span className="sr-only">Conductor, licencia o placa</span>
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Conductor, licencia o placa" className="w-full bg-transparent text-gray-800 outline-none placeholder:text-gray-500" />
        </label>
        <label className="relative flex h-10 items-center gap-2 rounded-full border border-gray-300 bg-white pl-3 pr-8 text-sm text-gray-700 shadow-sm">
          <ListFilter className="h-4 w-4 text-gray-500" />
          <span className="sr-only">Estado</span>
          <select value={stateFilter} onChange={(event) => onStateChange(event.target.value as 'all' | SupplyState)} className="appearance-none bg-transparent pr-1 text-sm font-medium outline-none">
            <option value="all">Todos</option>
            <option value="on_track">Cumple meta</option>
            {!closedPeriod && <option value="near">Por acelerar</option>}
            <option value="behind">Rezago</option>
          </select>
          <ChevronRight className="pointer-events-none absolute right-3 h-4 w-4 rotate-90 text-gray-500" />
        </label>
        <button type="button" onClick={onRefresh} disabled={loading} title="Actualizar Supply" className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 shadow-sm hover:bg-gray-100 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </section>
  );
}

function formatHeatmapDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric' });
}

function SupplyHeatmap({ data, visibleDrivers, loading }: { data: SupplyHeatmapData | null; visibleDrivers: SupplyDriver[]; loading: boolean }) {
  const visibleDriverIds = new Set(visibleDrivers.map((driver) => driver.driver_id));
  const drivers = (data?.drivers || []).filter((driver) => visibleDriverIds.has(driver.driver_id));
  const maxHours = Math.max(1, ...drivers.flatMap((driver) => Object.values(driver.supply_by_date).map((entry) => entry.hours)));

  return (
    <section className="border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Mapa de calor de Supply</h2>
          <p className="mt-0.5 text-xs text-gray-500">Cada celda muestra horas Supply y viajes realizados. La intensidad representa mayor tiempo conectado.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500"><span>0 h</span><i className="h-3 w-3 border border-red-100 bg-red-50" /><i className="h-3 w-3 bg-red-300" /><i className="h-3 w-3 bg-[#8B1A1A]" /><span>{formatHours(maxHours)}</span></div>
      </div>
      <div className="max-h-[560px] overflow-auto">
        {loading ? <div className="flex h-56 items-center justify-center text-sm text-gray-500">Cargando mapa de calor...</div> : drivers.length === 0 ? <div className="flex h-56 items-center justify-center text-sm text-gray-500">No hay datos para el período seleccionado.</div> : (
          <table className="w-full min-w-[760px] border-separate border-spacing-1.5 px-2 py-2 text-xs">
            <thead className="sticky top-0 z-10 bg-white"><tr><th className="sticky left-0 z-20 min-w-48 bg-white px-2 py-1 text-left font-semibold text-gray-500">Conductor</th>{data?.dates.map((date) => <th key={date} className="min-w-12 px-1 py-1 text-center font-semibold capitalize text-gray-500">{formatHeatmapDate(date)}</th>)}</tr></thead>
            <tbody>{drivers.map((driver) => <tr key={driver.driver_id}><th className="sticky left-0 z-10 bg-white px-2 py-1 text-left font-medium text-gray-800"><span className="block max-w-48 truncate" title={driver.name}>{driver.name}</span><span className="font-normal text-gray-500">{driver.plate || driver.license_number || '—'}</span></th>{data?.dates.map((date) => { const entry = driver.supply_by_date[date] || { hours: 0, trips: 0 }; const intensity = entry.hours > 0 ? 0.14 + (entry.hours / maxHours) * 0.76 : 0; const textColor = intensity > 0.55 ? '#ffffff' : '#7f1d1d'; return <td key={date} className="h-12 min-w-12 rounded-sm text-center font-semibold tabular-nums" style={{ backgroundColor: entry.hours ? `rgba(139, 26, 26, ${intensity})` : '#f9fafb', color: entry.hours ? textColor : '#9ca3af' }} title={`${driver.name} · ${date}: ${formatHours(entry.hours)} · ${entry.trips} viaje(s)`}><span className="block">{entry.hours ? `${entry.hours.toFixed(1)}h` : '—'}</span>{entry.hours > 0 && <span className="block text-[10px] font-normal opacity-90">{entry.trips} v</span>}</td>; })}</tr>)}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export default function YegoMiAutoAnalysis() {
  const [dateRange, setDateRange] = useState<DateRange>(defaultDateRange);
  const [data, setData] = useState<SupplyData | null>(null);
  const [heatmapData, setHeatmapData] = useState<SupplyHeatmapData | null>(null);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | SupplyState>('all');
  const [loading, setLoading] = useState(true);
  const [heatmapLoading, setHeatmapLoading] = useState(true);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);

  const refresh = useCallback(() => {
    const version = ++requestVersion.current;
    if (dateRange.date_from > dateRange.date_to) {
      setError('La fecha inicial no puede ser posterior a la fecha final.');
      setLoading(false);
      setHeatmapLoading(false);
      return;
    }
    if (daysInclusive(dateRange.date_from, dateRange.date_to) > 31) {
      setError('El mapa de calor permite consultar como máximo 31 días.');
      setLoading(false);
      setHeatmapLoading(false);
      return;
    }

    setLoading(true);
    setHeatmapLoading(true);
    setError('');
    const summaryRequest = api.get('/miauto/analysis/supply', { params: dateRange });
    const heatmapRequest = api.get('/miauto/analysis/supply/heatmap', { params: dateRange });

    void summaryRequest.then((response) => {
      if (version !== requestVersion.current) return;
      setData(response.data?.data ?? response.data);
    }).catch((requestError: any) => {
      if (version !== requestVersion.current) return;
      setData(null);
      setError(requestError.response?.data?.message || 'No se pudieron cargar los datos de Supply.');
    }).finally(() => {
      if (version === requestVersion.current) setLoading(false);
    });

    void heatmapRequest.then((response) => {
      if (version !== requestVersion.current) return;
      setHeatmapData(response.data?.data ?? response.data);
    }).catch((requestError: any) => {
      if (version !== requestVersion.current) return;
      setHeatmapData(null);
      setError((current) => current || requestError.response?.data?.message || 'No se pudo cargar el mapa de calor.');
    }).finally(() => {
      if (version === requestVersion.current) setHeatmapLoading(false);
    });
  }, [dateRange]);

  useEffect(() => { refresh(); }, [refresh]);

  const target = targetForPeriod(dateRange.date_from, dateRange.date_to);
  const closedPeriod = dateRange.date_to < limaYmd().slice(0, 7);
  const filteredDrivers = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (data?.drivers || []).filter((driver) => {
      const matchesSearch = !search || [driver.name, driver.plate, driver.license_number].filter(Boolean).join(' ').toLowerCase().includes(search);
      const matchesState = stateFilter === 'all' || getSupplyState(driver.supply_hours, target, closedPeriod) === stateFilter;
      return matchesSearch && matchesState;
    }).sort((left, right) => right.supply_hours - left.supply_hours);
  }, [closedPeriod, data, query, stateFilter, target]);
  const canExportPdf = filteredDrivers.length > 0 && Boolean(heatmapData) && !heatmapLoading;

  return (
    <div className="space-y-5">
      <section className="rounded-lg bg-[#8B1A1A] p-4 lg:p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[#6B1515]"><BarChart3 className="h-5 w-5 text-white" /></div><div><h1 className="text-lg font-bold leading-tight text-white lg:text-xl">Análisis Mi Auto</h1><p className="mt-0.5 text-xs text-white/90 lg:text-sm">Supply y viajes completados de conductores</p></div></div><button type="button" onClick={() => exportSupplyPdf(filteredDrivers, heatmapData, dateRange, target, closedPeriod)} disabled={!canExportPdf} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-white/30 bg-white px-3 text-sm font-semibold text-[#8B1A1A] hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"><Download className="h-4 w-4" />PDF</button></div></section>
      <SupplyFilters dateRange={dateRange} query={query} stateFilter={stateFilter} loading={loading || heatmapLoading} closedPeriod={closedPeriod} onDateChange={setDateRange} onQueryChange={setQuery} onStateChange={setStateFilter} onRefresh={refresh} />
      {error && <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
      <SupplyHeatmap data={heatmapData} visibleDrivers={filteredDrivers} loading={heatmapLoading} />
    </div>
  );
}
