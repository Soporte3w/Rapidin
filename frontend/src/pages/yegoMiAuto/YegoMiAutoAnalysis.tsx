import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, ChevronRight, Download, Gauge, ListFilter, RefreshCw, Search } from 'lucide-react';
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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
type SupplyStateCount = Record<SupplyState, number>;

type SupplyStateDatum = {
  state: SupplyState;
  name: string;
  count: number;
  color: string;
};

type SupplyDistributionDatum = {
  name: string;
  count: number;
  color: string;
};

const DEFAULT_HOURS_TARGET = 200;
const HOURS_TARGET_STORAGE_KEY = 'miauto.analysis.monthly-hours-target';
const SUPPLY_STATE_COLORS: Record<SupplyState, string> = {
  on_track: '#16a34a',
  near: '#ca8a04',
  behind: '#dc2626',
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

function targetForPeriod(dateFrom: string, dateTo: string, monthlyTarget: number) {
  const [year, month] = dateFrom.slice(0, 7).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const isSameMonth = dateFrom.slice(0, 7) === dateTo.slice(0, 7);
  const periodDays = isSameMonth ? Math.min(daysInclusive(dateFrom, dateTo), daysInMonth) : daysInMonth;

  return Math.round((monthlyTarget * periodDays / daysInMonth) * 10) / 10;
}

function readHoursTarget() {
  try {
    const saved = Number(window.localStorage.getItem(HOURS_TARGET_STORAGE_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_HOURS_TARGET;
  } catch {
    return DEFAULT_HOURS_TARGET;
  }
}

function persistHoursTarget(target: number) {
  try {
    window.localStorage.setItem(HOURS_TARGET_STORAGE_KEY, String(target));
  } catch {
    // The report remains usable when browser storage is unavailable.
  }
}

function getSupplyState(hours: number, target: number, closedPeriod: boolean): SupplyState {
  if (hours >= target) return 'on_track';
  if (!closedPeriod && hours >= target * 0.75) return 'near';
  return 'behind';
}

function getHeatmapCellColors(hours: number, maxHours: number) {
  if (hours <= 0) return { backgroundColor: '#f9fafb', color: '#9ca3af' };

  const intensity = 0.14 + (hours / maxHours) * 0.76;
  return {
    backgroundColor: `rgba(139, 26, 26, ${intensity})`,
    color: intensity > 0.55 ? '#ffffff' : '#7f1d1d',
  };
}

function getRequestErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object' || !('response' in error)) return fallback;

  const response = (error as { response?: { data?: { message?: unknown } } }).response;
  return typeof response?.data?.message === 'string' ? response.data.message : fallback;
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
      const colors = getHeatmapCellColors(entry.hours, maxHours);
      return `<td style="background:${colors.backgroundColor};color:${colors.color}">${entry.hours ? `${entry.hours.toFixed(1)}h<br><small>${entry.trips} viajes</small>` : '—'}</td>`;
    }).join('');
    return `<tr><th>${escapeHtml(driver.name)}<small>${escapeHtml(driver.plate || driver.license_number)}</small></th>${cells}</tr>`;
  }).join('');

  return `<section class="heatmap"><h2>Mapa de calor de Supply</h2><p class="muted">Cada celda muestra horas Supply y viajes realizados. El color más intenso indica mayor actividad.</p><table><thead><tr><th>Conductor</th>${dates}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

function exportSupplyPdf(
  drivers: SupplyDriver[],
  heatmapData: SupplyHeatmapData | null,
  dateRange: DateRange,
  target: number,
  closedPeriod: boolean,
) {
  const popup = window.open('', '_blank');
  if (!popup) return;

  popup.opener = null;
  const totalHours = drivers.reduce((sum, driver) => sum + driver.supply_hours, 0);
  const totalTrips = drivers.reduce((sum, driver) => sum + driver.completed_trips, 0);
  const compliant = drivers.filter((driver) => driver.supply_hours >= target).length;
  const average = drivers.length ? totalHours / drivers.length : 0;
  const maxHours = Math.max(target * 1.15, ...drivers.map((driver) => driver.supply_hours), 1);
  const thresholdPosition = Math.min(100, (target / maxHours) * 100);
  const driverBars = drivers.map((driver) => {
    const state = getSupplyState(driver.supply_hours, target, closedPeriod);
    const color = SUPPLY_STATE_COLORS[state];
    const width = Math.min(100, (driver.supply_hours / maxHours) * 100);
    return `<div class="driver-row"><div><strong>${escapeHtml(driver.name)}</strong><small>${escapeHtml(driver.plate || driver.license_number)} · ${driver.completed_trips} viajes</small></div><div class="track"><i class="fill" style="width:${width}%;border-color:${color};background:${color}22"></i><i class="threshold" style="left:${thresholdPosition}%"></i></div><b style="color:${color}">${formatHours(driver.supply_hours)}</b></div>`;
  }).join('');
  const heatmap = buildHeatmapPdf(heatmapData, drivers);

  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Supply Mi Auto</title><style>@page{size:landscape;margin:12mm}body{font-family:Arial,sans-serif;color:#111827;margin:28px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 4px}.muted{color:#6b7280;font-size:12px;margin:0 0 20px}.summary{display:flex;gap:12px;margin:0 0 20px}.summary div{border:1px solid #e5e7eb;padding:10px 12px;min-width:120px}.summary strong{display:block;font-size:18px;margin-top:3px}.driver-chart{border:1px solid #e5e7eb;padding:8px 12px}.driver-row{display:grid;grid-template-columns:180px 1fr 64px;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:9px}.driver-row:last-child{border:0}.driver-row strong,.driver-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.driver-row small{color:#6b7280;margin-top:2px}.driver-row>b{text-align:right;font-size:10px}.track{position:relative;height:18px;background:#f3f4f6;border-radius:3px}.fill{display:block;height:100%;border-left:3px solid;border-radius:3px}.threshold{position:absolute;top:-2px;bottom:-2px;width:2px;background:#fbbf24}table{width:100%;border-collapse:collapse;font-size:11px}th{background:#f3f4f6;text-align:left}th,td{border-bottom:1px solid #e5e7eb;padding:8px}.heatmap{break-before:page;page-break-before:always}.heatmap table{font-size:8px;table-layout:fixed}.heatmap th,.heatmap td{padding:4px;text-align:center;border:1px solid #fff}.heatmap th:first-child{text-align:left;width:150px}.heatmap small{display:block;font-size:7px;font-weight:normal;margin-top:2px;opacity:.85}@media print{body{margin:0}}</style></head><body><h1>Yego Mi Auto · Análisis Supply</h1><p class="muted">Período: ${escapeHtml(dateRange.date_from)} a ${escapeHtml(dateRange.date_to)} · Meta: ${formatHours(target)}</p><div class="summary"><div>Conductores<strong>${drivers.length}</strong></div><div>Cumplen<strong>${compliant}</strong></div><div>Promedio<strong>${formatHours(average)}</strong></div><div>Viajes<strong>${totalTrips.toLocaleString('es-PE')}</strong></div></div><h2>Horas por conductor</h2><p class="muted">La línea amarilla marca el mínimo configurado.</p><section class="driver-chart">${driverBars}</section>${heatmap}<script>window.onload=()=>window.print()</script></body></html>`);
  popup.document.close();
}

function SupplyFilters({
  dateRange,
  query,
  stateFilter,
  monthlyTarget,
  periodTarget,
  loading,
  closedPeriod,
  onDateChange,
  onQueryChange,
  onStateChange,
  onMonthlyTargetChange,
  onRefresh,
}: {
  dateRange: DateRange;
  query: string;
  stateFilter: 'all' | SupplyState;
  monthlyTarget: number;
  periodTarget: number;
  loading: boolean;
  closedPeriod: boolean;
  onDateChange: (range: DateRange) => void;
  onQueryChange: (query: string) => void;
  onStateChange: (state: 'all' | SupplyState) => void;
  onMonthlyTargetChange: (target: number) => void;
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
        <label className="flex h-10 items-center gap-2 rounded-full border border-gray-300 bg-white px-3 text-sm text-gray-700 shadow-sm">
          <Gauge className="h-4 w-4 text-[#8B1A1A]" />
          <span className="font-medium">Mínimo</span>
          <input
            type="number"
            min="1"
            max="500"
            step="5"
            value={monthlyTarget}
            onChange={(event) => onMonthlyTargetChange(Math.max(1, Math.min(500, Number(event.target.value) || 1)))}
            className="w-14 bg-transparent text-right font-bold tabular-nums text-gray-900 outline-none"
            aria-label="Mínimo mensual de horas Supply"
          />
          <span className="text-xs text-gray-500">h/mes</span>
        </label>
        <span className="rounded-full bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
          Período: {formatHours(periodTarget)}
        </span>
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

function shortDriverName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length <= 2 ? name : `${parts[0]} ${parts.at(-1)}`;
}

function supplyStateLabel(state: SupplyState, closedPeriod: boolean) {
  if (state === 'on_track') return closedPeriod ? 'Cumple' : 'Al ritmo';
  if (state === 'near') return 'Por acelerar';
  return 'Rezago';
}

function calculateSupplyStats(drivers: SupplyDriver[], target: number, closedPeriod: boolean) {
  const states: SupplyStateCount = { on_track: 0, near: 0, behind: 0 };
  let totalHours = 0;
  let totalTrips = 0;

  drivers.forEach((driver) => {
    states[getSupplyState(driver.supply_hours, target, closedPeriod)] += 1;
    totalHours += driver.supply_hours;
    totalTrips += driver.completed_trips;
  });

  return {
    states,
    totalTrips,
    averageHours: drivers.length ? totalHours / drivers.length : 0,
    compliance: drivers.length ? (states.on_track / drivers.length) * 100 : 0,
  };
}

function buildSupplyStateData(
  states: SupplyStateCount,
  closedPeriod: boolean,
): SupplyStateDatum[] {
  return (['on_track', 'near', 'behind'] as SupplyState[])
    .filter((state) => !closedPeriod || state !== 'near')
    .map((state) => ({
      state,
      name: supplyStateLabel(state, closedPeriod),
      count: states[state],
      color: SUPPLY_STATE_COLORS[state],
    }));
}

function buildSupplyDistribution(drivers: SupplyDriver[], target: number): SupplyDistributionDatum[] {
  const ranges = [
    { name: '<25%', min: 0, max: 0.25, color: '#dc2626' },
    { name: '25–50%', min: 0.25, max: 0.5, color: '#ea580c' },
    { name: '50–75%', min: 0.5, max: 0.75, color: '#ca8a04' },
    { name: '75–100%', min: 0.75, max: 1, color: '#eab308' },
    { name: '≥100%', min: 1, max: Number.POSITIVE_INFINITY, color: '#16a34a' },
  ];

  return ranges.map((range) => ({
    name: range.name,
    color: range.color,
    count: drivers.filter((driver) => {
      const ratio = target > 0 ? driver.supply_hours / target : 0;
      return ratio >= range.min && ratio < range.max;
    }).length,
  }));
}

function SupplyLegend({
  data,
  showCount = false,
  centered = false,
}: {
  data: SupplyStateDatum[];
  showCount?: boolean;
  centered?: boolean;
}) {
  return (
    <div className={`flex flex-wrap gap-x-4 gap-y-2 ${centered ? 'justify-center' : ''}`}>
      {data.map((entry) => (
        <span key={entry.state} className="inline-flex items-center gap-1.5 text-xs text-gray-600">
          <i className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: entry.color }} />
          {entry.name}{showCount && <>: <strong>{entry.count}</strong></>}
        </span>
      ))}
    </div>
  );
}

function SupplyDriverBar({
  driver,
  target,
  maxHours,
  closedPeriod,
}: {
  driver: SupplyDriver;
  target: number;
  maxHours: number;
  closedPeriod: boolean;
}) {
  const state = getSupplyState(driver.supply_hours, target, closedPeriod);
  const color = SUPPLY_STATE_COLORS[state];
  const width = Math.min(100, (driver.supply_hours / maxHours) * 100);
  const targetPosition = Math.min(100, (target / maxHours) * 100);

  return (
    <div className="grid min-w-[660px] grid-cols-[210px_1fr_72px] items-center gap-3 border-b border-gray-100 py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-gray-800" title={driver.name}>{shortDriverName(driver.name)}</p>
        <p className="truncate text-[10px] text-gray-500">{driver.plate || driver.license_number || 'Sin código'} · {driver.completed_trips} viajes</p>
      </div>
      <div className="relative h-7 overflow-visible rounded bg-gray-100">
        <div className="h-full rounded-l border-l-[3px]" style={{ width: `${width}%`, borderColor: color, backgroundColor: `${color}22` }} />
        <i className="absolute -bottom-1 -top-1 z-[1] w-0.5 bg-amber-400" style={{ left: `${targetPosition}%` }} title={`Mínimo ${formatHours(target)}`} />
      </div>
      <div className="text-right">
        <p className="text-sm font-bold tabular-nums" style={{ color }}>{formatHours(driver.supply_hours)}</p>
        <p className="text-[10px] font-medium" style={{ color }}>{supplyStateLabel(state, closedPeriod)}</p>
      </div>
    </div>
  );
}

function SupplyOverview({
  drivers,
  target,
  closedPeriod,
  loading,
}: {
  drivers: SupplyDriver[];
  target: number;
  closedPeriod: boolean;
  loading: boolean;
}) {
  const stats = useMemo(
    () => calculateSupplyStats(drivers, target, closedPeriod),
    [closedPeriod, drivers, target],
  );
  const stateData = useMemo(
    () => buildSupplyStateData(stats.states, closedPeriod),
    [closedPeriod, stats.states],
  );
  const distribution = useMemo(
    () => buildSupplyDistribution(drivers, target),
    [drivers, target],
  );

  const maxChartHours = Math.max(target * 1.15, ...drivers.map((driver) => driver.supply_hours), 1);

  if (loading) {
    return <div className="flex h-72 items-center justify-center border border-gray-200 bg-white text-sm text-gray-500">Cargando análisis...</div>;
  }

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Conductores', value: drivers.length.toLocaleString('es-PE'), detail: `${stats.totalTrips.toLocaleString('es-PE')} viajes`, color: 'text-gray-900' },
          { label: closedPeriod ? 'Cumplen' : 'Al ritmo', value: stats.states.on_track.toLocaleString('es-PE'), detail: `${stats.compliance.toFixed(0)}% de la flota`, color: 'text-green-700' },
          { label: 'En rezago', value: stats.states.behind.toLocaleString('es-PE'), detail: closedPeriod ? 'Bajo el mínimo' : `${stats.states.near} por acelerar`, color: 'text-red-700' },
          { label: 'Promedio', value: formatHours(stats.averageHours), detail: `Meta ${formatHours(target)}`, color: 'text-gray-900' },
        ].map((metric) => (
          <article key={metric.label} className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-[11px] font-semibold uppercase text-gray-500">{metric.label}</p>
            <p className={`mt-1 text-2xl font-bold tabular-nums ${metric.color}`}>{metric.value}</p>
            <p className="mt-0.5 text-xs text-gray-500">{metric.detail}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(280px,0.75fr)_minmax(420px,1.25fr)]">
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div><h2 className="text-sm font-semibold text-gray-900">Cumplimiento</h2><p className="mt-0.5 text-xs text-gray-500">Distribución frente a la meta del período</p></div>
            <span className="text-lg font-bold tabular-nums text-green-700">{stats.compliance.toFixed(0)}%</span>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={stateData} dataKey="count" nameKey="name" innerRadius={52} outerRadius={76} paddingAngle={2}>
                  {stateData.map((entry) => <Cell key={entry.state} fill={entry.color} />)}
                </Pie>
                <Tooltip formatter={(value: number) => [value, 'Conductores']} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <SupplyLegend data={stateData} showCount centered />
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div><h2 className="text-sm font-semibold text-gray-900">Distribución de horas</h2><p className="mt-0.5 text-xs text-gray-500">Conductores agrupados por avance sobre la meta</p></div>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={distribution} margin={{ top: 12, right: 8, left: -22, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(value: number) => [value, 'Conductores']} cursor={{ fill: '#f3f4f6' }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={52}>
                  {distribution.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="text-sm font-semibold text-gray-900">Horas por conductor</h2><p className="mt-0.5 text-xs text-gray-500">La línea amarilla marca el mínimo de {formatHours(target)}.</p></div>
          <SupplyLegend data={stateData} />
        </div>
        {drivers.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-500">No hay conductores para los filtros seleccionados.</div>
        ) : (
          <div className="max-h-[680px] overflow-auto px-3 py-2">
            {drivers.map((driver) => (
              <SupplyDriverBar
                key={driver.driver_id}
                driver={driver}
                target={target}
                maxHours={maxChartHours}
                closedPeriod={closedPeriod}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SupplyHeatmapCell({
  driverName,
  date,
  entry,
  maxHours,
}: {
  driverName: string;
  date: string;
  entry: { hours: number; trips: number };
  maxHours: number;
}) {
  return (
    <td
      className="h-12 min-w-12 rounded-sm text-center font-semibold tabular-nums"
      style={getHeatmapCellColors(entry.hours, maxHours)}
      title={`${driverName} · ${date}: ${formatHours(entry.hours)} · ${entry.trips} viaje(s)`}
    >
      <span className="block">{entry.hours ? `${entry.hours.toFixed(1)}h` : '—'}</span>
      {entry.hours > 0 && <span className="block text-[10px] font-normal opacity-90">{entry.trips} v</span>}
    </td>
  );
}

function SupplyHeatmap({ data, visibleDrivers, loading }: { data: SupplyHeatmapData | null; visibleDrivers: SupplyDriver[]; loading: boolean }) {
  const drivers = useMemo(() => {
    const visibleDriverIds = new Set(visibleDrivers.map((driver) => driver.driver_id));
    return (data?.drivers || []).filter((driver) => visibleDriverIds.has(driver.driver_id));
  }, [data?.drivers, visibleDrivers]);
  const maxHours = useMemo(
    () => Math.max(1, ...drivers.flatMap((driver) => Object.values(driver.supply_by_date).map((entry) => entry.hours))),
    [drivers],
  );

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
            <thead className="sticky top-0 z-10 bg-white">
              <tr>
                <th className="sticky left-0 z-20 min-w-48 bg-white px-2 py-1 text-left font-semibold text-gray-500">Conductor</th>
                {data?.dates.map((date) => <th key={date} className="min-w-12 px-1 py-1 text-center font-semibold capitalize text-gray-500">{formatHeatmapDate(date)}</th>)}
              </tr>
            </thead>
            <tbody>
              {drivers.map((driver) => (
                <tr key={driver.driver_id}>
                  <th className="sticky left-0 z-10 bg-white px-2 py-1 text-left font-medium text-gray-800">
                    <span className="block max-w-48 truncate" title={driver.name}>{driver.name}</span>
                    <span className="font-normal text-gray-500">{driver.plate || driver.license_number || '—'}</span>
                  </th>
                  {data?.dates.map((date) => (
                    <SupplyHeatmapCell
                      key={date}
                      driverName={driver.name}
                      date={date}
                      entry={driver.supply_by_date[date] || { hours: 0, trips: 0 }}
                      maxHours={maxHours}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export default function YegoMiAutoAnalysis() {
  const [dateRange, setDateRange] = useState<DateRange>(defaultDateRange);
  const [monthlyTarget, setMonthlyTarget] = useState(readHoursTarget);
  const [drivers, setDrivers] = useState<SupplyDriver[]>([]);
  const [heatmapData, setHeatmapData] = useState<SupplyHeatmapData | null>(null);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | SupplyState>('all');
  const [loading, setLoading] = useState(true);
  const [heatmapLoading, setHeatmapLoading] = useState(true);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => {
    persistHoursTarget(monthlyTarget);
  }, [monthlyTarget]);

  const refresh = useCallback(() => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
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
    const requestConfig = { params: dateRange, signal: controller.signal };
    const summaryRequest = api.get('/miauto/analysis/supply', requestConfig);
    const heatmapRequest = api.get('/miauto/analysis/supply/heatmap', requestConfig);

    void summaryRequest.then((response) => {
      if (version !== requestVersion.current) return;
      const payload = response.data?.data ?? response.data;
      setDrivers(Array.isArray(payload?.drivers) ? payload.drivers : []);
    }).catch((requestError: unknown) => {
      if (version !== requestVersion.current) return;
      setDrivers([]);
      setError(getRequestErrorMessage(requestError, 'No se pudieron cargar los datos de Supply.'));
    }).finally(() => {
      if (version === requestVersion.current) setLoading(false);
    });

    void heatmapRequest.then((response) => {
      if (version !== requestVersion.current) return;
      setHeatmapData(response.data?.data ?? response.data);
    }).catch((requestError: unknown) => {
      if (version !== requestVersion.current) return;
      setHeatmapData(null);
      setError((current) => current || getRequestErrorMessage(requestError, 'No se pudo cargar el mapa de calor.'));
    }).finally(() => {
      if (version === requestVersion.current) setHeatmapLoading(false);
    });
  }, [dateRange]);

  useEffect(() => {
    refresh();
    return () => {
      requestVersion.current += 1;
      requestController.current?.abort();
    };
  }, [refresh]);

  const target = targetForPeriod(dateRange.date_from, dateRange.date_to, monthlyTarget);
  const closedPeriod = dateRange.date_to.slice(0, 7) < limaYmd().slice(0, 7);

  useEffect(() => {
    if (closedPeriod && stateFilter === 'near') setStateFilter('all');
  }, [closedPeriod, stateFilter]);
  const searchedDrivers = useMemo(() => {
    const search = query.trim().toLowerCase();
    return drivers.filter((driver) => (
      !search || [driver.name, driver.plate, driver.license_number]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search)
    ));
  }, [drivers, query]);
  const filteredDrivers = useMemo(() => {
    return searchedDrivers.filter((driver) => (
      stateFilter === 'all' || getSupplyState(driver.supply_hours, target, closedPeriod) === stateFilter
    )).sort((left, right) => right.supply_hours - left.supply_hours);
  }, [closedPeriod, searchedDrivers, stateFilter, target]);
  const canExportPdf = filteredDrivers.length > 0 && Boolean(heatmapData) && !heatmapLoading;

  return (
    <div className="space-y-5">
      <section className="rounded-lg bg-[#8B1A1A] p-4 lg:p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[#6B1515]"><BarChart3 className="h-5 w-5 text-white" /></div><div><h1 className="text-lg font-bold leading-tight text-white lg:text-xl">Análisis Mi Auto</h1><p className="mt-0.5 text-xs text-white/90 lg:text-sm">Supply y viajes completados de conductores</p></div></div><button type="button" onClick={() => exportSupplyPdf(filteredDrivers, heatmapData, dateRange, target, closedPeriod)} disabled={!canExportPdf} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-white/30 bg-white px-3 text-sm font-semibold text-[#8B1A1A] hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"><Download className="h-4 w-4" />PDF</button></div></section>
      <SupplyFilters dateRange={dateRange} query={query} stateFilter={stateFilter} monthlyTarget={monthlyTarget} periodTarget={target} loading={loading || heatmapLoading} closedPeriod={closedPeriod} onDateChange={setDateRange} onQueryChange={setQuery} onStateChange={setStateFilter} onMonthlyTargetChange={setMonthlyTarget} onRefresh={refresh} />
      {error && <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
      <SupplyOverview drivers={filteredDrivers} target={target} closedPeriod={closedPeriod} loading={loading} />
      <SupplyHeatmap data={heatmapData} visibleDrivers={filteredDrivers} loading={heatmapLoading} />
    </div>
  );
}
