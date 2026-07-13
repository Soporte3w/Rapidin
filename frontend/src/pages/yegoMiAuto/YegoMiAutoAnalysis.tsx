import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, CalendarDays, Car, ChevronLeft, ChevronRight, Clock3, Download, ListFilter, RefreshCw, Route, Search, Users } from 'lucide-react';
import api from '../../services/api';

type SupplyDriver = {
  driver_id: string;
  name: string;
  work_rule_id: string | null;
  license_number: string | null;
  plate: string | null;
  completed_trips: number;
  supply_hours: number;
};

type SupplyData = {
  requested_period: { date_from: string; date_to: string };
  reported_period: { date_from: string; date_to: string };
  drivers: SupplyDriver[];
  totals: { drivers: number; active_drivers: number; completed_trips: number; supply_hours: number };
};

type SupplyState = 'on_track' | 'near' | 'behind';

const HOURS_TARGET = 200;
const PAGE_SIZES = [10, 25, 50];
const fmtHours = (value: number) => `${Number(value || 0).toFixed(1)} h`;
const ymdToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

function defaultDateFrom() {
  return `${ymdToday().slice(0, 7)}-01`;
}

function workRuleLabel(id: string) {
  return `Término ${id.slice(0, 8).toUpperCase()}`;
}

function daysInclusive(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

function targetForPeriod(dateFrom: string, dateTo: string) {
  const today = ymdToday();
  const currentMonth = today.slice(0, 7);
  const isCurrentMonthToToday = dateFrom === `${currentMonth}-01` && dateTo === today;
  if (dateTo < currentMonth) return HOURS_TARGET;
  if (isCurrentMonthToToday) {
    const [year, month] = currentMonth.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Math.round((HOURS_TARGET * Number(today.slice(8, 10)) / daysInMonth) * 10) / 10;
  }
  const [year, month] = dateFrom.slice(0, 7).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.round((HOURS_TARGET * Math.min(daysInclusive(dateFrom, dateTo), daysInMonth) / daysInMonth) * 10) / 10;
}

function supplyState(hours: number, target: number, closedPeriod: boolean): SupplyState {
  if (hours >= target) return 'on_track';
  if (!closedPeriod && hours >= target * 0.75) return 'near';
  return 'behind';
}

const stateMeta: Record<SupplyState, { label: string; color: string; badge: string }> = {
  on_track: { label: 'Cumple', color: '#16a34a', badge: 'bg-green-100 text-green-800' },
  near: { label: 'Por acelerar', color: '#eab308', badge: 'bg-yellow-100 text-yellow-800' },
  behind: { label: 'Rezago', color: '#dc2626', badge: 'bg-red-100 text-red-800' },
};

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? '—').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] || char));
}

function exportSupplyPdf(drivers: SupplyDriver[], dateFrom: string, dateTo: string, target: number, closedPeriod: boolean) {
  const popup = window.open('', '_blank');
  if (!popup) return;
  popup.opener = null;
  const rows = drivers.map((driver) => {
    const state = supplyState(driver.supply_hours, target, closedPeriod);
    return `<tr><td>${escapeHtml(driver.name)}</td><td>${escapeHtml(driver.plate)}</td><td class="num">${driver.completed_trips.toLocaleString('es-PE')}</td><td class="num">${fmtHours(driver.supply_hours)}</td><td>${stateMeta[state].label}</td></tr>`;
  }).join('');
  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Supply Mi Auto ${dateFrom} a ${dateTo}</title><style>body{font-family:Arial,sans-serif;color:#111827;margin:28px}h1{font-size:20px;margin:0 0 4px}.muted{color:#6b7280;font-size:12px;margin:0 0 20px}.summary{display:flex;gap:18px;margin:0 0 20px}.summary div{border:1px solid #e5e7eb;padding:10px 12px;min-width:120px}.summary strong{display:block;font-size:18px;margin-top:3px}table{width:100%;border-collapse:collapse;font-size:11px}th{background:#f3f4f6;text-align:left}th,td{border-bottom:1px solid #e5e7eb;padding:8px}.num{text-align:right}@media print{body{margin:16px}}</style></head><body><h1>Yego Mi Auto · Supply de conductores</h1><p class="muted">Período: ${escapeHtml(dateFrom)} a ${escapeHtml(dateTo)} · Meta: ${fmtHours(target)}</p><div class="summary"><div>Conductores<strong>${drivers.length}</strong></div><div>Horas Supply<strong>${fmtHours(drivers.reduce((sum, driver) => sum + driver.supply_hours, 0))}</strong></div><div>Viajes completados<strong>${drivers.reduce((sum, driver) => sum + driver.completed_trips, 0).toLocaleString('es-PE')}</strong></div></div><table><thead><tr><th>Conductor</th><th>Placa</th><th class="num">Viajes</th><th class="num">Horas Supply</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>window.print()</script></body></html>`);
  popup.document.close();
}

export default function YegoMiAutoAnalysis() {
  const [dateFrom, setDateFrom] = useState(defaultDateFrom);
  const [dateTo, setDateTo] = useState(ymdToday);
  const [data, setData] = useState<SupplyData | null>(null);
  const [query, setQuery] = useState('');
  const [workRuleId, setWorkRuleId] = useState('');
  const [workRules, setWorkRules] = useState<string[]>([]);
  const [stateFilter, setStateFilter] = useState<'all' | SupplyState>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async (selectedWorkRuleId = workRuleId) => {
    if (dateFrom > dateTo) {
      setError('La fecha inicial no puede ser posterior a la fecha final.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/miauto/analysis/supply', {
        params: {
          date_from: dateFrom,
          date_to: dateTo,
          ...(selectedWorkRuleId ? { work_rule_id: selectedWorkRuleId } : {}),
        },
      });
      const supplyData = response.data?.data ?? response.data;
      setData(supplyData);
      setWorkRules((current) => [...new Set([
        ...current,
        ...(supplyData.drivers || [])
          .map((driver: SupplyDriver) => driver.work_rule_id)
          .filter((id: string | null): id is string => Boolean(id)),
      ])].sort());
      setPage(1);
    } catch (err: any) {
      setData(null);
      setError(err.response?.data?.message || 'No se pudieron cargar los datos de Supply.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const target = targetForPeriod(dateFrom, dateTo);
  const closedPeriod = dateTo < ymdToday().slice(0, 7);
  const filteredDrivers = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (data?.drivers || [])
      .filter((driver) => !search || [driver.name, driver.plate, driver.license_number].filter(Boolean).join(' ').toLowerCase().includes(search))
      .filter((driver) => stateFilter === 'all' || supplyState(driver.supply_hours, target, closedPeriod) === stateFilter)
      .sort((a, b) => b.supply_hours - a.supply_hours);
  }, [closedPeriod, data, query, stateFilter, target]);
  const totalPages = Math.max(1, Math.ceil(filteredDrivers.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageDrivers = filteredDrivers.slice((safePage - 1) * pageSize, safePage * pageSize);
  const chartData = filteredDrivers.slice(0, 15).map((driver) => ({
    ...driver,
    chart_name: driver.name.length > 24 ? `${driver.name.slice(0, 24)}...` : driver.name,
    state: supplyState(driver.supply_hours, target, closedPeriod),
  })).reverse();
  const onTrack = filteredDrivers.filter((driver) => supplyState(driver.supply_hours, target, closedPeriod) === 'on_track').length;

  return (
    <div className="space-y-5">
      <section className="border-b border-gray-200 pb-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[#8B1A1A]"><Activity className="h-5 w-5" /><span className="text-sm font-semibold">Yego Mi Auto</span></div>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Supply de conductores</h1>
            <p className="mt-1 text-sm text-gray-600">Horas Supply y viajes completados reportados por Fleet.</p>
          </div>
          <button type="button" onClick={() => exportSupplyPdf(filteredDrivers, dateFrom, dateTo, target, closedPeriod)} disabled={filteredDrivers.length === 0} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#8B1A1A] px-3 text-sm font-semibold text-white hover:bg-[#6B1515] disabled:cursor-not-allowed disabled:opacity-50"><Download className="h-4 w-4" />PDF</button>
        </div>
      </section>

      <section className="border border-gray-200 bg-gray-50 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 items-center gap-2 rounded-full border border-gray-300 bg-white px-3 text-sm text-gray-700 shadow-sm">
            <CalendarDays className="h-4 w-4 text-gray-500" />
            <label className="sr-only" htmlFor="supply-date-from">Desde</label>
            <input id="supply-date-from" type="date" value={dateFrom} max={dateTo} onChange={(event) => setDateFrom(event.target.value)} className="w-[122px] bg-transparent text-sm outline-none" />
            <span className="text-gray-300">—</span>
            <label className="sr-only" htmlFor="supply-date-to">Hasta</label>
            <input id="supply-date-to" type="date" value={dateTo} max={ymdToday()} onChange={(event) => setDateTo(event.target.value)} className="w-[122px] bg-transparent text-sm outline-none" />
          </div>
          <label className="relative flex h-10 min-w-[240px] flex-1 items-center rounded-full border border-gray-300 bg-white pl-9 pr-3 text-sm shadow-sm sm:flex-none">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-gray-500" />
            <span className="sr-only">Conductor, licencia o placa</span>
            <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Conductor, licencia o placa" className="w-full bg-transparent text-gray-800 outline-none placeholder:text-gray-500" />
          </label>
          <label className="relative flex h-10 items-center gap-2 rounded-full border border-gray-300 bg-white pl-3 pr-8 text-sm text-gray-700 shadow-sm">
            <ListFilter className="h-4 w-4 text-gray-500" />
            <span className="sr-only">Términos de trabajo</span>
            <select value={workRuleId} onChange={(event) => { const next = event.target.value; setWorkRuleId(next); load(next); }} className="appearance-none bg-transparent pr-1 text-sm font-medium outline-none"><option value="">Términos de trabajo</option>{workRules.map((ruleId) => <option key={ruleId} value={ruleId}>{workRuleLabel(ruleId)}</option>)}</select>
            <ChevronRight className="pointer-events-none absolute right-3 h-4 w-4 rotate-90 text-gray-500" />
          </label>
          <label className="relative flex h-10 items-center gap-2 rounded-full border border-gray-300 bg-white pl-3 pr-8 text-sm text-gray-700 shadow-sm">
            <ListFilter className="h-4 w-4 text-gray-500" />
            <span className="sr-only">Estado</span>
            <select value={stateFilter} onChange={(event) => { setStateFilter(event.target.value as 'all' | SupplyState); setPage(1); }} className="appearance-none bg-transparent pr-1 text-sm font-medium outline-none"><option value="all">Todos</option><option value="on_track">Cumple meta</option>{!closedPeriod ? <option value="near">Por acelerar</option> : null}<option value="behind">Rezago</option></select>
            <ChevronRight className="pointer-events-none absolute right-3 h-4 w-4 rotate-90 text-gray-500" />
          </label>
          <button type="button" onClick={() => load()} disabled={loading} title="Actualizar Supply" className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 shadow-sm hover:bg-gray-100 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </section>

      {error ? <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Horas Supply', value: fmtHours(data?.totals.supply_hours || 0), icon: Clock3, tint: 'text-blue-700 bg-blue-50' },
          { label: 'Viajes completados', value: (data?.totals.completed_trips || 0).toLocaleString('es-PE'), icon: Route, tint: 'text-[#8B1A1A] bg-red-50' },
          { label: 'Conductores activos', value: String(data?.totals.active_drivers || 0), icon: Users, tint: 'text-green-700 bg-green-50' },
          { label: 'Cumplen meta', value: `${onTrack}/${filteredDrivers.length}`, icon: Car, tint: 'text-amber-700 bg-amber-50' },
        ].map((kpi) => { const Icon = kpi.icon; return <div key={kpi.label} className="border border-gray-200 bg-white p-4 shadow-sm"><div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-md ${kpi.tint}`}><Icon className="h-4 w-4" /></div><p className="text-xs font-medium text-gray-500">{kpi.label}</p><p className="mt-1 text-xl font-bold tabular-nums text-gray-900">{kpi.value}</p></div>; })}
      </section>

      <section className="border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 lg:flex-row lg:items-center lg:justify-between"><div><h2 className="text-sm font-semibold text-gray-900">Horas Supply por conductor</h2><p className="mt-0.5 text-xs text-gray-500">Meta {closedPeriod ? 'cerrada' : 'proporcional al período'}: {fmtHours(target)}</p></div><div className="flex items-center gap-3 text-xs font-medium text-gray-600"><span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-green-600" />Cumple</span>{!closedPeriod ? <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-yellow-400" />75%-99%</span> : null}<span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-red-600" />Rezago</span></div></div>
        <div className="h-[min(760px,max(340px,calc(100vh-250px)))] min-h-[340px] p-3">{loading ? <div className="flex h-full items-center justify-center text-sm text-gray-500">Cargando Supply...</div> : chartData.length === 0 ? <div className="flex h-full items-center justify-center text-sm text-gray-500">No hay conductores para los filtros seleccionados.</div> : <ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 34, left: 12, bottom: 8 }}><CartesianGrid horizontal={false} stroke="#e5e7eb" /><XAxis type="number" tick={{ fontSize: 11, fill: '#6b7280' }} tickFormatter={(value) => `${value}h`} /><YAxis type="category" dataKey="chart_name" width={175} tick={{ fontSize: 11, fill: '#374151' }} /><Tooltip cursor={{ fill: '#f9fafb' }} formatter={(value: number) => [fmtHours(value), 'Horas Supply']} labelFormatter={(_, payload) => payload?.[0]?.payload?.name || ''} /><Bar dataKey="supply_hours" radius={[0, 4, 4, 0]} maxBarSize={22}>{chartData.map((driver) => <Cell key={driver.driver_id} fill={stateMeta[driver.state].color} />)}</Bar></BarChart></ResponsiveContainer>}</div>
      </section>

      <section className="border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-sm font-semibold text-gray-900">Detalle por conductor</h2><p className="mt-0.5 text-xs text-gray-500">{dateFrom} a {dateTo} · {filteredDrivers.length} resultado(s) de {data?.drivers.length || 0} recibidos por Fleet{data && data.totals.drivers > data.drivers.length ? ` (${data.totals.drivers} reportados)` : ''}</p></div><label className="flex items-center gap-2 text-xs font-semibold text-gray-600">Filas<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} className="h-8 rounded-md border border-gray-300 bg-white px-2 text-sm font-normal text-gray-800">{PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select></label></div>
        <div className="overflow-x-auto"><table className="min-w-[760px] w-full text-sm"><thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr><th className="px-4 py-3 font-semibold">Conductor</th><th className="px-4 py-3 font-semibold">Placa</th><th className="px-4 py-3 text-right font-semibold">Viajes</th><th className="px-4 py-3 text-right font-semibold">Horas Supply</th><th className="px-4 py-3 font-semibold">Progreso</th><th className="px-4 py-3 text-right font-semibold">Estado</th></tr></thead><tbody className="divide-y divide-gray-100">{pageDrivers.map((driver) => { const state = supplyState(driver.supply_hours, target, closedPeriod); const meta = stateMeta[state]; const progress = Math.min(100, target > 0 ? (driver.supply_hours / target) * 100 : 0); return <tr key={driver.driver_id} className="hover:bg-gray-50"><td className="px-4 py-3"><p className="font-medium text-gray-900">{driver.name}</p><p className="text-xs text-gray-500">{driver.license_number || 'Sin licencia'}</p></td><td className="px-4 py-3 font-mono text-xs text-gray-700">{driver.plate || '—'}</td><td className="px-4 py-3 text-right font-semibold tabular-nums text-gray-900">{driver.completed_trips.toLocaleString('es-PE')}</td><td className="px-4 py-3 text-right font-semibold tabular-nums text-gray-900">{fmtHours(driver.supply_hours)}</td><td className="px-4 py-3"><div className="flex min-w-44 items-center gap-2"><div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full" style={{ width: `${progress}%`, backgroundColor: meta.color }} /></div><span className="w-9 text-right text-xs tabular-nums text-gray-500">{Math.round(progress)}%</span></div></td><td className="px-4 py-3 text-right"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${meta.badge}`}>{meta.label}</span></td></tr>; })}</tbody></table></div>
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3"><span className="text-xs text-gray-500">Página {safePage} de {totalPages}</span><div className="flex gap-2"><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={safePage <= 1} title="Página anterior" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-300 text-gray-600 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button><button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={safePage >= totalPages} title="Página siguiente" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-300 text-gray-600 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button></div></div>
      </section>
    </div>
  );
}
