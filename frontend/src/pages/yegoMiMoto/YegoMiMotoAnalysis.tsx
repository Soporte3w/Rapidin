import { useEffect, useMemo, useState } from 'react';
import { Activity, Bike, CheckCircle2, CircleDollarSign, Clock3, FileText, PlayCircle, ShieldCheck, TriangleAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { formatMimotoMoney, mimotoApiErrorMessage, unwrap } from './mimotoApi';
import { MimotoLoading, MimotoPageHeader } from './mimotoUi';

type Summary = { solicitudes: number; contratos_activos: number; cuotas: number; vencidas: number; saldo_total_cop: number | string };
type Readiness = { module_enabled: boolean; automation_enabled: boolean; mora_ready: boolean; expense_status_ready: boolean; weekly_generation_ready: boolean; fleet_withdrawal_ready: boolean; blocked_reasons: string[] };
type DryRun = { as_of?: string; affected?: number; skipped?: boolean; reason?: string; summary?: Record<string, number>; results?: unknown[] };
type DryRunKind = 'mora' | 'gastos' | 'cuotas' | 'fleet';

export default function YegoMiMotoAnalysis() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [dryResults, setDryResults] = useState<Partial<Record<DryRunKind, DryRun>>>({});
  const [running, setRunning] = useState<DryRunKind | null>(null);

  useEffect(() => {
    Promise.all([api.get('/mimoto/analysis/summary'), api.get('/mimoto/automation/readiness')])
      .then(([summaryResponse, readinessResponse]) => {
        setSummary(unwrap<Summary>(summaryResponse));
        setReadiness(unwrap<Readiness>(readinessResponse));
      })
      .catch((error: unknown) => toast.error(mimotoApiErrorMessage(error, 'No se pudo cargar el análisis')));
  }, []);

  const paidOrCurrent = Math.max(0, Number(summary?.cuotas || 0) - Number(summary?.vencidas || 0));
  const overduePct = useMemo(() => Number(summary?.cuotas) > 0 ? Math.round((Number(summary?.vencidas) / Number(summary?.cuotas)) * 100) : 0, [summary]);

  const runDry = async (kind: DryRunKind) => {
    setRunning(kind);
    try {
      const response = await api.post(`/mimoto/automation/${kind}/dry-run`, {});
      const result = unwrap<DryRun>(response);
      setDryResults((current) => ({ ...current, [kind]: result }));
      toast.success('Simulación completada sin modificar datos');
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo ejecutar la simulación'));
    } finally {
      setRunning(null);
    }
  };

  if (!summary || !readiness) return <MimotoLoading label="Cargando análisis Mi Moto..." />;

  const cards = [
    { label: 'Solicitudes', value: summary.solicitudes, icon: FileText, tone: 'text-gray-900' },
    { label: 'Contratos activos', value: summary.contratos_activos, icon: Bike, tone: 'text-green-700' },
    { label: 'Cuotas vencidas', value: summary.vencidas, icon: Clock3, tone: 'text-red-700' },
    { label: 'Saldo pendiente', value: formatMimotoMoney(summary.saldo_total_cop, 'COP'), icon: CircleDollarSign, tone: 'text-orange-700' },
  ];

  return <div className="space-y-4 lg:space-y-6">
    <MimotoPageHeader icon={Activity} title="Análisis Mi Moto" subtitle="Cartera, contratos y preparación operativa de Colombia" />

    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({ label, value, icon: Icon, tone }) => <article key={label} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><p className="text-xs font-semibold uppercase text-gray-500">{label}</p><span className="grid h-9 w-9 place-items-center rounded-lg bg-red-50"><Icon className="h-4 w-4 text-red-700" /></span></div><p className={`mt-3 text-2xl font-bold ${tone}`}>{value}</p></article>)}</section>

    <section className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)]">
      <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4"><div><h2 className="font-bold text-gray-900">Estado de cartera semanal</h2><p className="mt-1 text-sm text-gray-500">Distribución de las cuotas registradas</p></div><span className={`rounded-lg px-3 py-1.5 text-sm font-bold ${overduePct > 20 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>{overduePct}% vencida</span></div>
        <div className="mt-8 flex h-44 items-end gap-5 border-b border-gray-200 px-4">
          <PortfolioBar label="Al día / pagadas" value={paidOrCurrent} total={summary.cuotas} color="bg-green-500" />
          <PortfolioBar label="Vencidas" value={summary.vencidas} total={summary.cuotas} color="bg-red-500" />
        </div>
        <div className="mt-4 flex items-center justify-between text-sm"><span className="text-gray-500">Total de cuotas</span><strong className="text-gray-900">{summary.cuotas}</strong></div>
      </article>

      <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="flex items-center gap-2 font-bold text-gray-900"><ShieldCheck className="h-5 w-5 text-red-700" />Preparación del módulo</h2>
        <div className="mt-4 space-y-3"><ReadinessRow label="Módulo habilitado" ready={readiness.module_enabled} /><ReadinessRow label="Automatización habilitada" ready={readiness.automation_enabled} /><ReadinessRow label="Motor de mora" ready={readiness.mora_ready} /><ReadinessRow label="Estados de otros gastos" ready={readiness.expense_status_ready} /><ReadinessRow label="Generación semanal automática" ready={readiness.weekly_generation_ready} /><ReadinessRow label="Retiros Fleet Colombia" ready={readiness.fleet_withdrawal_ready} /></div>
      </article>
    </section>

    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-amber-50"><TriangleAlert className="h-5 w-5 text-amber-700" /></span><div><h2 className="font-bold text-gray-900">Simulaciones de control</h2><p className="mt-1 text-sm text-gray-500">Estos controles son exclusivamente dry-run: no retiran saldo ni modifican cuotas o gastos.</p></div></div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <DryRunCard title="Mora diaria" result={dryResults.mora || null} running={running === 'mora'} onRun={() => void runDry('mora')} />
        <DryRunCard title="Otros gastos" result={dryResults.gastos || null} running={running === 'gastos'} onRun={() => void runDry('gastos')} />
        <DryRunCard title="Cuota semanal" result={dryResults.cuotas || null} running={running === 'cuotas'} onRun={() => void runDry('cuotas')} />
        <DryRunCard title="Cascada Fleet" result={dryResults.fleet || null} running={running === 'fleet'} onRun={() => void runDry('fleet')} />
      </div>
      {readiness.blocked_reasons.length > 0 && <div className="mt-4 border-t border-gray-100 pt-4"><p className="text-xs font-semibold uppercase text-gray-500">Pendientes para activar producción</p><ul className="mt-2 space-y-1 text-sm text-gray-600">{readiness.blocked_reasons.map((reason) => <li key={reason}>• {reason}</li>)}</ul></div>}
    </section>
  </div>;
}

function PortfolioBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const height = total > 0 ? Math.max(8, Math.round((Number(value) / Number(total)) * 135)) : 8;
  return <div className="flex h-full flex-1 flex-col items-center justify-end"><strong className="mb-2 text-lg text-gray-900">{value}</strong><div className={`w-full max-w-32 rounded-t-md ${color}`} style={{ height }} /><span className="mt-2 text-center text-xs font-medium text-gray-500">{label}</span></div>;
}

function ReadinessRow({ label, ready }: { label: string; ready: boolean }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-sm text-gray-600">{label}</span><span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold ${ready ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock3 className="h-3.5 w-3.5" />}{ready ? 'Listo' : 'Pendiente'}</span></div>;
}

function DryRunCard({ title, result, running, onRun }: { title: string; result: DryRun | null; running: boolean; onRun: () => void }) {
  const affected = result?.affected
    ?? (result?.summary
      ? Object.values(result.summary).reduce((total, value) => total + Number(value || 0), 0)
      : result?.results?.length || 0);
  return <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-4"><div><p className="font-semibold text-gray-900">{title}</p><p className="mt-1 text-xs text-gray-500">{result ? `${affected} registros evaluados` : 'Sin simulación reciente'}</p></div><button type="button" disabled={running} onClick={onRun} title={`Simular ${title.toLowerCase()}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-red-200 px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40"><PlayCircle className="h-4 w-4" />{running ? 'Ejecutando' : 'Simular'}</button></div>;
}
