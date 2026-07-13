import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, Car, Clock3, RefreshCw, Route, Search, Users } from 'lucide-react';
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
  requested_period: { date_from: string; date_to: string };
  reported_period: { date_from: string; date_to: string };
  drivers: SupplyDriver[];
  totals: { drivers: number; active_drivers: number; completed_trips: number; supply_hours: number };
};

const HOURS_TARGET = 200;
const fmtHours = (value: number) => `${Number(value || 0).toFixed(1)} h`;
const ymdToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

function monthRange(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const today = ymdToday();
  const start = `${month}-01`;
  const endOfMonth = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { date_from: start, date_to: month === today.slice(0, 7) ? today : endOfMonth };
}

function targetForMonth(month: string) {
  const today = ymdToday();
  if (month < today.slice(0, 7)) return HOURS_TARGET;
  if (month > today.slice(0, 7)) return HOURS_TARGET;
  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const day = Number(today.slice(8, 10));
  return Math.round((HOURS_TARGET * day / daysInMonth) * 10) / 10;
}

function supplyState(hours: number, target: number, closedMonth: boolean) {
  if (closedMonth) return hours >= target ? 'on_track' : 'behind';
  if (hours >= target) return 'on_track';
  if (hours >= target * 0.75) return 'near';
  return 'behind';
}

const stateMeta = {
  on_track: { label: 'Cumple', color: '#16a34a', badge: 'bg-green-100 text-green-800' },
  near: { label: 'Por acelerar', color: '#eab308', badge: 'bg-yellow-100 text-yellow-800' },
  behind: { label: 'Rezago', color: '#dc2626', badge: 'bg-red-100 text-red-800' },
};

export default function YegoMiAutoAnalysis() {
  const [month, setMonth] = useState(() => ymdToday().slice(0, 7));
  const [data, setData] = useState<SupplyData | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/miauto/analysis/supply', { params: monthRange(month) });
      setData(response.data?.data ?? response.data);
    } catch (err: any) {
      setData(null);
      setError(err.response?.data?.message || 'No se pudieron cargar los datos de Supply.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [month]);

  const target = targetForMonth(month);
  const closedMonth = month < ymdToday().slice(0, 7);
  const drivers = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (data?.drivers || [])
      .filter((driver) => !search || [driver.name, driver.plate, driver.license_number].filter(Boolean).join(' ').toLowerCase().includes(search))
      .sort((a, b) => b.supply_hours - a.supply_hours);
  }, [data, query]);
  const chartData = drivers.slice(0, 15).map((driver) => ({
    ...driver,
    chart_name: driver.name.length > 24 ? `${driver.name.slice(0, 24)}...` : driver.name,
    state: supplyState(driver.supply_hours, target, closedMonth),
  })).reverse();
  const onTrack = drivers.filter((driver) => supplyState(driver.supply_hours, target, closedMonth) === 'on_track').length;

  return (
    <div className="space-y-5">
      <section className="border-b border-gray-200 pb-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[#8B1A1A]">
              <Activity className="h-5 w-5" />
              <span className="text-sm font-semibold">Yego Mi Auto</span>
            </div>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Supply de conductores</h1>
            <p className="mt-1 text-sm text-gray-600">Horas Supply y viajes completados reportados por Fleet.</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="supply-month">Mes</label>
            <input id="supply-month" type="month" value={month} max={ymdToday().slice(0, 7)} onChange={(event) => setMonth(event.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 focus:border-[#8B1A1A] focus:outline-none focus:ring-2 focus:ring-red-100" />
            <button type="button" onClick={load} disabled={loading} title="Actualizar Supply" className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </section>

      {error ? <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Horas Supply', value: fmtHours(data?.totals.supply_hours || 0), icon: Clock3, tint: 'text-blue-700 bg-blue-50' },
          { label: 'Viajes completados', value: (data?.totals.completed_trips || 0).toLocaleString('es-PE'), icon: Route, tint: 'text-[#8B1A1A] bg-red-50' },
          { label: 'Conductores activos', value: String(data?.totals.active_drivers || 0), icon: Users, tint: 'text-green-700 bg-green-50' },
          { label: 'Van cumpliendo meta', value: `${onTrack}/${drivers.length}`, icon: Car, tint: 'text-amber-700 bg-amber-50' },
        ].map((kpi) => {
          const Icon = kpi.icon;
          return <div key={kpi.label} className="border border-gray-200 bg-white p-4 shadow-sm">
            <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-md ${kpi.tint}`}><Icon className="h-4 w-4" /></div>
            <p className="text-xs font-medium text-gray-500">{kpi.label}</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-gray-900">{kpi.value}</p>
          </div>;
        })}
      </section>

      <section className="border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Horas Supply por conductor</h2>
            <p className="mt-0.5 text-xs text-gray-500">Meta {closedMonth ? 'mensual cerrada' : 'proporcional al día de hoy'}: {fmtHours(target)}</p>
          </div>
          <div className="flex items-center gap-3 text-xs font-medium text-gray-600">
            <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-green-600" />Cumple</span>
            {!closedMonth ? <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-yellow-400" />75%-99%</span> : null}
            <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-red-600" />Rezago</span>
          </div>
        </div>
        <div className="h-[min(760px,max(340px,calc(100vh-250px)))] min-h-[340px] p-3">
          {loading ? <div className="flex h-full items-center justify-center text-sm text-gray-500">Cargando Supply...</div> : chartData.length === 0 ? <div className="flex h-full items-center justify-center text-sm text-gray-500">No hay conductores para el período seleccionado.</div> : <ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 34, left: 12, bottom: 8 }}><CartesianGrid horizontal={false} stroke="#e5e7eb" /><XAxis type="number" tick={{ fontSize: 11, fill: '#6b7280' }} tickFormatter={(value) => `${value}h`} /><YAxis type="category" dataKey="chart_name" width={175} tick={{ fontSize: 11, fill: '#374151' }} /><Tooltip cursor={{ fill: '#f9fafb' }} formatter={(value: number) => [fmtHours(value), 'Horas Supply']} labelFormatter={(_, payload) => payload?.[0]?.payload?.name || ''} /><Bar dataKey="supply_hours" radius={[0, 4, 4, 0]} maxBarSize={22}>{chartData.map((driver) => <Cell key={driver.driver_id} fill={stateMeta[driver.state as keyof typeof stateMeta].color} />)}</Bar></BarChart></ResponsiveContainer>}
        </div>
      </section>

      <section className="border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="text-sm font-semibold text-gray-900">Detalle por conductor</h2><p className="mt-0.5 text-xs text-gray-500">{data?.requested_period.date_from || '—'} a {data?.requested_period.date_to || '—'}</p></div>
          <label className="relative block"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar conductor o placa" className="h-9 w-full rounded-md border border-gray-300 pl-9 pr-3 text-sm focus:border-[#8B1A1A] focus:outline-none sm:w-60" /></label>
        </div>
        <div className="overflow-x-auto"><table className="min-w-[760px] w-full text-sm"><thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr><th className="px-4 py-3 font-semibold">Conductor</th><th className="px-4 py-3 font-semibold">Placa</th><th className="px-4 py-3 text-right font-semibold">Viajes</th><th className="px-4 py-3 text-right font-semibold">Horas Supply</th><th className="px-4 py-3 font-semibold">Progreso</th><th className="px-4 py-3 text-right font-semibold">Estado</th></tr></thead><tbody className="divide-y divide-gray-100">{drivers.map((driver) => { const state = supplyState(driver.supply_hours, target, closedMonth); const meta = stateMeta[state]; const progress = Math.min(100, target > 0 ? (driver.supply_hours / target) * 100 : 0); return <tr key={driver.driver_id} className="hover:bg-gray-50"><td className="px-4 py-3"><p className="font-medium text-gray-900">{driver.name}</p><p className="text-xs text-gray-500">{driver.license_number || 'Sin licencia'}</p></td><td className="px-4 py-3 font-mono text-xs text-gray-700">{driver.plate || '—'}</td><td className="px-4 py-3 text-right font-semibold tabular-nums text-gray-900">{driver.completed_trips.toLocaleString('es-PE')}</td><td className="px-4 py-3 text-right font-semibold tabular-nums text-gray-900">{fmtHours(driver.supply_hours)}</td><td className="px-4 py-3"><div className="flex min-w-44 items-center gap-2"><div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full" style={{ width: `${progress}%`, backgroundColor: meta.color }} /></div><span className="w-9 text-right text-xs tabular-nums text-gray-500">{Math.round(progress)}%</span></div></td><td className="px-4 py-3 text-right"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${meta.badge}`}>{meta.label}</span></td></tr>; })}</tbody></table></div>
      </section>
    </div>
  );
}
