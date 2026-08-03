import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  History,
  RefreshCw,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';

type FleetChargeRun = {
  id: string;
  business_date: string;
  execution_type: 'scheduled' | 'retry' | 'manual';
  attempt_number: number | null;
  source_run_id: string | null;
  status: 'running' | 'completed' | 'failed';
  queue_count: number;
  success_count: number;
  partial_count: number;
  failed_count: number;
  remaining_count: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

type FleetChargeAttempt = {
  id: string;
  cuota_semanal_id: string | null;
  solicitud_id: string | null;
  status: 'queued' | 'running' | 'success' | 'partial' | 'failed';
  reason: string | null;
  balance_fleet: string | number | null;
  amount_charged_fleet: string | number;
  amount_credited_cuota: string | number;
  started_at: string;
  finished_at: string | null;
  week_start_date: string | null;
  due_date: string | null;
  amount_due: string | number | null;
  paid_amount: string | number | null;
  cuota_status: string | null;
  license_number: string | null;
  dni: string | null;
  placa_asignada: string | null;
  driver_name: string;
  retryable: boolean;
};

type FleetChargeDetail = {
  run: FleetChargeRun;
  attempts: FleetChargeAttempt[];
};

type FleetChargeStartResult = {
  run_id: string;
  cuotas_procesadas: number;
  accepted: boolean;
  status: 'running';
};

type FleetConfirmation = {
  kind: 'week' | 'today' | 'driver';
  title: string;
  description: string;
  confirmLabel: string;
  endpoint: string;
  solicitudId?: string;
};

type FleetPendingItem = {
  cuota_semanal_id: string;
  solicitud_id: string;
  week_start_date: string | null;
  due_date: string | null;
  status: string;
  pending_amount: number;
  moneda: string;
  license_number: string | null;
  placa_asignada: string | null;
  driver_name: string;
};

type FleetPendingSummary = {
  cuotas_count: number;
  conductores_count: number;
  items: FleetPendingItem[];
  truncated: boolean;
};

function unwrap<T>(response: { data?: { data?: T } | T }): T {
  const body = response.data as { data?: T } | T | undefined;
  if (body && typeof body === 'object' && 'data' in body) return body.data as T;
  return body as T;
}

function formatNumber(value: string | number | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : '—';
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function runLabel(run: FleetChargeRun) {
  if (run.execution_type === 'retry') return `Reintento automático ${run.attempt_number}`;
  if (run.execution_type === 'manual') return 'Reproceso administrativo';
  return 'Cobro programado';
}

function attemptReason(attempt: FleetChargeAttempt) {
  if (attempt.reason) return attempt.reason;
  if (attempt.status === 'queued') return 'En espera de su turno dentro del proceso';
  if (attempt.status === 'success') return 'Cobro completado correctamente';
  if (attempt.status === 'partial') return 'Saldo Fleet insuficiente; se realizó un cobro parcial';
  if (attempt.status === 'running') return 'Intento en curso o interrumpido antes de recibir respuesta';
  return 'Fleet no completó el cobro';
}

function statusBadge(status: FleetChargeAttempt['status']) {
  if (status === 'queued') return { label: 'En cola', className: 'bg-gray-100 text-gray-700' };
  if (status === 'success') return { label: 'Cobrado', className: 'bg-green-100 text-green-800' };
  if (status === 'partial') return { label: 'Parcial', className: 'bg-amber-100 text-amber-800' };
  if (status === 'running') return { label: 'En curso', className: 'bg-blue-100 text-blue-800' };
  return { label: 'No cobrado', className: 'bg-red-100 text-red-800' };
}

export default function YegoMiAutoFleetChargeReport() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canRetry = user?.role === 'admin' || user?.base_role === 'admin';
  const [runs, setRuns] = useState<FleetChargeRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FleetChargeDetail | null>(null);
  const [pending, setPending] = useState<FleetPendingSummary | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingPending, setLoadingPending] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [retrying, setRetrying] = useState<'week' | 'today' | null>(null);
  const [chargingSolicitudId, setChargingSolicitudId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<FleetConfirmation | null>(null);
  const [error, setError] = useState('');
  const trackedRunIdRef = useRef<string | null>(null);
  const completedRunIdRef = useRef<string | null>(null);

  const loadRuns = useCallback(async (preferredRunId?: string | null) => {
    setLoadingRuns(true);
    setError('');
    try {
      const response = await api.get('/miauto/fleet-charge-runs', { params: { limit: 50 } });
      const rows = unwrap<FleetChargeRun[]>(response) || [];
      setRuns(Array.isArray(rows) ? rows : []);
      setSelectedRunId((current) => {
        const preferred = preferredRunId || current;
        if (preferred && rows.some((run) => run.id === preferred)) return preferred;
        return rows[0]?.id || null;
      });
    } catch (requestError: any) {
      setRuns([]);
      setError(requestError.response?.data?.message || 'No se pudo cargar el historial de cobros Fleet');
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  const loadDetail = useCallback(async (runId: string, silent = false) => {
    if (!silent) setLoadingDetail(true);
    try {
      const response = await api.get(`/miauto/fleet-charge-runs/${runId}`);
      const next = unwrap<FleetChargeDetail>(response);
      setDetail(next);
      setRuns((current) => {
        const index = current.findIndex((run) => run.id === next.run.id);
        if (index < 0) return [next.run, ...current].slice(0, 50);
        const copy = [...current];
        copy[index] = next.run;
        return copy;
      });
    } catch (requestError: any) {
      if (!silent) {
        setDetail(null);
        toast.error(requestError.response?.data?.message || 'No se pudo cargar el detalle de la ejecución');
      }
    } finally {
      if (!silent) setLoadingDetail(false);
    }
  }, []);

  const loadPending = useCallback(async () => {
    setLoadingPending(true);
    try {
      const response = await api.get('/miauto/fleet-charge-runs/pending', { params: { limit: 500 } });
      setPending(unwrap<FleetPendingSummary>(response));
    } catch (requestError: any) {
      setPending(null);
      setError(requestError.response?.data?.message || 'No se pudo consultar la cola pendiente Fleet');
    } finally {
      setLoadingPending(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
    void loadPending();
  }, [loadPending, loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedRunId);
  }, [loadDetail, selectedRunId]);

  const retryableAttempts = useMemo(
    () => detail?.attempts.filter((attempt) => attempt.retryable) || [],
    [detail],
  );

  const selectedRun = detail?.run || runs.find((run) => run.id === selectedRunId) || null;
  const runningRun = runs.find((run) => run.status === 'running')
    || (selectedRun?.status === 'running' ? selectedRun : null);
  const processActive = !!runningRun;
  const processedCount = selectedRun
    ? selectedRun.success_count + selectedRun.partial_count + selectedRun.failed_count
    : 0;
  const progressPercent = selectedRun?.queue_count
    ? Math.min(100, Math.round((processedCount / selectedRun.queue_count) * 100))
    : 0;
  const estimatedRemainingMinutes = useMemo(() => {
    if (!selectedRun || selectedRun.status !== 'running' || processedCount <= 0) return null;
    const elapsedMs = Math.max(1000, Date.now() - new Date(selectedRun.started_at).getTime());
    const remaining = Math.max(0, selectedRun.queue_count - processedCount);
    if (remaining === 0) return null;
    return Math.max(1, Math.ceil(((elapsedMs / processedCount) * remaining) / 60000));
  }, [processedCount, selectedRun]);
  const queuedCount = detail?.attempts.filter((attempt) => attempt.status === 'queued').length || 0;
  const runningCount = detail?.attempts.filter((attempt) => attempt.status === 'running').length || 0;
  const attemptByCuotaId = useMemo(
    () => new Map((detail?.attempts || []).map((attempt) => [attempt.cuota_semanal_id, attempt])),
    [detail],
  );

  useEffect(() => {
    if (runningRun?.id && selectedRunId !== runningRun.id) setSelectedRunId(runningRun.id);
  }, [runningRun?.id, selectedRunId]);

  const showStartedProcess = useCallback(async (result: FleetChargeStartResult) => {
    trackedRunIdRef.current = result.run_id;
    completedRunIdRef.current = null;
    setSelectedRunId(result.run_id);
    toast.success(`Proceso iniciado: ${result.cuotas_procesadas} cuota(s) en cola`);
    await Promise.all([loadRuns(result.run_id), loadDetail(result.run_id, true)]);
  }, [loadDetail, loadRuns]);

  useEffect(() => {
    if (!selectedRunId || detail?.run.id !== selectedRunId || detail.run.status !== 'running') return undefined;
    const timer = window.setInterval(() => {
      void loadDetail(selectedRunId, true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [detail?.run.id, detail?.run.status, loadDetail, selectedRunId]);

  useEffect(() => {
    if (!detail || detail.run.status === 'running') return;
    if (completedRunIdRef.current === detail.run.id) return;
    completedRunIdRef.current = detail.run.id;
    void Promise.all([loadRuns(detail.run.id), loadPending()]);
    if (trackedRunIdRef.current === detail.run.id) {
      const completed = detail.run.success_count + detail.run.partial_count + detail.run.failed_count;
      if (detail.run.status === 'failed') {
        toast.error(detail.run.error || 'El proceso de cobro terminó con error');
      } else {
        toast.success(`Proceso terminado: ${completed} de ${detail.run.queue_count} cuota(s) procesadas`);
      }
      trackedRunIdRef.current = null;
    }
  }, [detail, loadPending, loadRuns]);

  const retryWeek = useCallback(() => {
    if (!canRetry || !detail || retryableAttempts.length === 0 || retrying || processActive) return;
    setConfirmation({
      kind: 'week',
      title: 'Reintentar pendientes del proceso',
      description: `Se pondrán en cola ${retryableAttempts.length} cuota(s) pendientes del proceso seleccionado.`,
      confirmLabel: 'Iniciar reproceso',
      endpoint: `/miauto/fleet-charge-runs/${detail.run.id}/retry`,
    });
  }, [canRetry, detail, processActive, retryableAttempts.length, retrying]);

  const chargeToday = useCallback(() => {
    if (!canRetry || retrying || processActive || pending?.cuotas_count === 0) return;
    const queueLabel = pending
      ? `${pending.conductores_count} conductor(es) y ${pending.cuotas_count} cuota(s)`
      : 'todos los conductores con cuotas pendientes';
    setConfirmation({
      kind: 'today',
      title: 'Cobrar pendientes de hoy',
      description: `Se pondrán en cola ${queueLabel}. El proceso continuará en el servidor aunque salgas de esta pantalla.`,
      confirmLabel: 'Iniciar cobro',
      endpoint: '/miauto/fleet-charge-runs/retry-today',
    });
  }, [canRetry, pending, processActive, retrying]);

  const chargeDriverToday = useCallback((item: FleetPendingItem) => {
    if (!canRetry || retrying || chargingSolicitudId || processActive) return;
    setConfirmation({
      kind: 'driver',
      title: `Cobrar a ${item.driver_name}`,
      description: 'Se procesará únicamente la cuota pendiente de hoy de este conductor.',
      confirmLabel: 'Cobrar conductor',
      endpoint: `/miauto/fleet-charge-runs/pending/${item.solicitud_id}/charge`,
      solicitudId: item.solicitud_id,
    });
  }, [canRetry, chargingSolicitudId, processActive, retrying]);

  const executeConfirmedAction = useCallback(async () => {
    if (!confirmation) return;
    const action = confirmation;
    setConfirmation(null);
    try {
      if (action.kind === 'driver') setChargingSolicitudId(action.solicitudId || null);
      else setRetrying(action.kind);
      const response = await api.post(action.endpoint);
      await showStartedProcess(unwrap<FleetChargeStartResult>(response));
    } catch (requestError: any) {
      toast.error(requestError.response?.data?.message || 'No se pudo iniciar el proceso de cobro');
    } finally {
      setRetrying(null);
      setChargingSolicitudId(null);
    }
  }, [confirmation, showStartedProcess]);

  return (
    <div className="space-y-4 lg:space-y-6">
      <header className="rounded-lg bg-[#8B1A1A] p-4 lg:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg bg-[#6B1515]">
              <History className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight text-white lg:text-xl">Historial de cobros Fleet</h1>
              <p className="mt-0.5 text-xs text-white/90 lg:text-sm">Procesos de cobro semanal, pendientes y motivo por conductor</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {canRetry && (
              <button
                type="button"
                onClick={() => void chargeToday()}
                disabled={retrying !== null || chargingSolicitudId !== null || processActive || pending?.cuotas_count === 0 || loadingPending}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-[#8B1A1A] hover:bg-red-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${retrying === 'today' ? 'animate-spin' : ''}`} />
                {retrying === 'today'
                  ? 'Iniciando...'
                  : processActive
                    ? 'Hay un cobro en proceso'
                  : `Cobrar pendientes de hoy${pending ? ` (${pending.cuotas_count})` : ''}`}
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate('/admin/yego-mi-auto/rent-sale')}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/15 px-3 py-2 text-sm font-medium text-white hover:bg-white/25"
            >
              <ArrowLeft className="h-4 w-4" />
              Volver a Alquiler / Venta
            </button>
          </div>
        </div>
      </header>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {selectedRun?.status === 'running' && (
        <section className="rounded-xl border border-blue-200 bg-blue-50 p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-blue-100 text-blue-700">
                <RefreshCw className="h-5 w-5 animate-spin" />
              </span>
              <div>
                <h2 className="font-semibold text-blue-950">Cobro procesándose en el servidor</h2>
                <p className="mt-1 text-sm text-blue-800">
                  {processedCount} de {selectedRun.queue_count} completadas · {Math.max(0, selectedRun.queue_count - processedCount)} pendientes
                  {estimatedRemainingMinutes ? ` · aproximadamente ${estimatedRemainingMinutes} min restantes` : ''}
                </p>
                <p className="mt-1 text-xs text-blue-700">Puedes salir de esta pantalla: el proceso continuará y el avance quedará guardado.</p>
              </div>
            </div>
            <span className="text-lg font-bold text-blue-900">{progressPercent}%</span>
          </div>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-blue-100">
            <div className="h-full rounded-full bg-blue-600 transition-all duration-500" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
            <span className="rounded-lg bg-white/80 px-3 py-2 text-green-700">Completas: <strong>{selectedRun.success_count}</strong></span>
            <span className="rounded-lg bg-white/80 px-3 py-2 text-amber-700">Parciales: <strong>{selectedRun.partial_count}</strong></span>
            <span className="rounded-lg bg-white/80 px-3 py-2 text-red-700">Fallidas: <strong>{selectedRun.failed_count}</strong></span>
            <span className="rounded-lg bg-white/80 px-3 py-2 text-blue-700">Procesando: <strong>{runningCount}</strong></span>
            <span className="rounded-lg bg-white/80 px-3 py-2 text-gray-700">En cola: <strong>{queuedCount}</strong></span>
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold text-gray-900">Pendientes de hoy · cobro 7:10</h2>
            <p className="text-xs text-gray-500">
              {loadingPending
                ? 'Consultando cuotas que debieron procesarse hoy a las 7:10...'
                : `${pending?.conductores_count || 0} conductores · ${pending?.cuotas_count || 0} cuotas pendientes de hoy`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadPending()}
            disabled={loadingPending || retrying !== null || chargingSolicitudId !== null || processActive}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            <RefreshCw className={`h-4 w-4 ${loadingPending ? 'animate-spin' : ''}`} />
            Actualizar pendientes
          </button>
        </div>
        {!loadingPending && pending?.items.length ? (
          <div className="max-h-72 overflow-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Conductor</th>
                  <th className="px-4 py-3 font-semibold">Cuota exigible</th>
                  <th className="px-4 py-3 font-semibold">Pendiente</th>
                  <th className="px-4 py-3 font-semibold">Estado</th>
                  <th className="px-4 py-3 font-semibold">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pending.items.map((item) => {
                  const liveAttempt = attemptByCuotaId.get(item.cuota_semanal_id);
                  const liveBadge = liveAttempt ? statusBadge(liveAttempt.status) : null;
                  return (
                  <tr key={item.cuota_semanal_id} className="text-gray-700">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-gray-900">{item.driver_name}</p>
                      <p className="text-xs text-gray-500">{item.license_number || 'Sin licencia'} · {item.placa_asignada || 'Sin placa'}</p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">{item.due_date || item.week_start_date || '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-[#8B1A1A]">
                      {item.pending_amount > 0.005 ? `${item.moneda} ${formatNumber(item.pending_amount)}` : 'Por calcular'}
                    </td>
                    <td className="px-4 py-3">
                      {liveBadge ? (
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${liveBadge.className}`}>{liveBadge.label}</span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">Pendiente de cobro</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        {canRetry && (
                          <button
                            type="button"
                            onClick={() => void chargeDriverToday(item)}
                            disabled={retrying !== null || chargingSolicitudId !== null || processActive || !!liveAttempt}
                            className="inline-flex items-center gap-1 rounded-md bg-[#8B1A1A] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#6B1515] disabled:opacity-40"
                          >
                            <RefreshCw className={`h-3.5 w-3.5 ${chargingSolicitudId === item.solicitud_id ? 'animate-spin' : ''}`} />
                            {chargingSolicitudId === item.solicitud_id ? 'Cobrando...' : 'Cobrar conductor'}
                          </button>
                        )}
                        <button type="button" onClick={() => navigate(`/admin/yego-mi-auto/rent-sale/${item.solicitud_id}`, { state: { driver_name: item.driver_name } })} className="inline-flex items-center gap-1 text-xs font-semibold text-[#8B1A1A] hover:underline">
                          <FileText className="h-3.5 w-3.5" /> Abrir contrato
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {pending.truncated && <p className="border-t border-gray-100 px-4 py-2 text-xs text-amber-700">La vista muestra los primeros 500 registros; el botón procesa la cola completa.</p>}
          </div>
        ) : !loadingPending ? (
          <p className="px-4 py-8 text-center text-sm text-gray-500">No hay cuotas pendientes con vencimiento de hoy.</p>
        ) : null}
      </section>

      {selectedRun && (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ['Entraron', selectedRun.queue_count, 'text-gray-900'],
            ['Completas', selectedRun.success_count, 'text-green-700'],
            ['Parciales', selectedRun.partial_count, 'text-amber-700'],
            ['Fallidas', selectedRun.failed_count, 'text-red-700'],
            ['Pendientes', selectedRun.remaining_count, 'text-[#8B1A1A]'],
          ].map(([label, value, color]) => (
            <div key={String(label)} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
              <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </section>
      )}

      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
            <div>
              <h2 className="font-semibold text-gray-900">Ejecuciones</h2>
              <p className="text-xs text-gray-500">Últimos 50 procesos registrados</p>
            </div>
            <button type="button" onClick={() => void loadRuns()} disabled={loadingRuns} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-40" title="Actualizar">
              <RefreshCw className={`h-4 w-4 ${loadingRuns ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="max-h-[680px] divide-y divide-gray-100 overflow-y-auto">
            {!loadingRuns && runs.length === 0 && <p className="p-6 text-center text-sm text-gray-500">Aún no hay ejecuciones registradas.</p>}
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                disabled={processActive && run.id !== runningRun?.id}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 ${selectedRunId === run.id ? 'bg-red-50' : ''}`}
              >
                <span className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-full ${
                  run.status === 'failed' ? 'bg-red-100 text-red-700' : run.status === 'running' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                }`}>
                  {run.status === 'failed' ? <AlertCircle className="h-4 w-4" /> : run.status === 'running' ? <Clock3 className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-gray-900">{runLabel(run)}</span>
                  <span className="block text-xs text-gray-500">{formatDateTime(run.started_at)}</span>
                  <span className="mt-1 block text-xs text-gray-600">{run.success_count} completas · {run.partial_count} parciales · {run.failed_count} fallidas</span>
                </span>
                <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400" />
              </button>
            ))}
          </div>
        </section>

        <section className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-gray-900">Detalle por conductor</h2>
              <p className="text-xs text-gray-500">{detail ? `${runLabel(detail.run)} · ${formatDateTime(detail.run.started_at)}` : 'Selecciona una ejecución'}</p>
            </div>
            {detail && (
              <button
                type="button"
                onClick={() => void retryWeek()}
                disabled={!canRetry || retryableAttempts.length === 0 || retrying !== null || processActive || detail.run.status === 'running'}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#8B1A1A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#6B1515] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw className={`h-4 w-4 ${retrying === 'week' ? 'animate-spin' : ''}`} />
                {retrying === 'week'
                  ? 'Reprocesando semana...'
                  : canRetry
                    ? `Reintentar faltantes de esta ejecución (${retryableAttempts.length})`
                    : 'Solo administradores'}
              </button>
            )}
          </div>

          {loadingDetail ? (
            <div className="grid min-h-64 place-items-center"><RefreshCw className="h-6 w-6 animate-spin text-[#8B1A1A]" /></div>
          ) : detail?.attempts.length ? (
            <div className="overflow-x-auto">
              <table className="min-w-[1100px] w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Conductor</th>
                    <th className="px-4 py-3 font-semibold">Cuota</th>
                    <th className="px-4 py-3 font-semibold">Saldo Fleet</th>
                    <th className="px-4 py-3 font-semibold">Retirado</th>
                    <th className="px-4 py-3 font-semibold">Resultado</th>
                    <th className="px-4 py-3 font-semibold">Motivo</th>
                    <th className="px-4 py-3 font-semibold">Estado actual</th>
                    <th className="px-4 py-3 font-semibold">Acción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {detail.attempts.map((attempt) => {
                    const badge = statusBadge(attempt.status);
                    return (
                      <tr key={attempt.id} className="align-top text-gray-700">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-gray-900">{attempt.driver_name}</p>
                          <p className="text-xs text-gray-500">{attempt.license_number || attempt.dni || 'Sin documento'} · {attempt.placa_asignada || 'Sin placa'}</p>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <p className="font-medium">{String(attempt.due_date || attempt.week_start_date || '').slice(0, 10) || '—'}</p>
                          <p className="text-xs text-gray-500">Cuota {formatNumber(attempt.amount_due)} · pagado {formatNumber(attempt.paid_amount)}</p>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 font-medium">{formatNumber(attempt.balance_fleet)}</td>
                        <td className="whitespace-nowrap px-4 py-3 font-medium text-green-700">{formatNumber(attempt.amount_charged_fleet)}</td>
                        <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${badge.className}`}>{badge.label}</span></td>
                        <td className="max-w-xs px-4 py-3 text-xs leading-relaxed text-gray-600">{attemptReason(attempt)}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-semibold ${attempt.status === 'queued' || attempt.status === 'running' ? 'text-blue-700' : attempt.retryable ? 'text-red-700' : 'text-green-700'}`}>
                            {attempt.status === 'queued'
                              ? 'Esperando turno'
                              : attempt.status === 'running'
                                ? 'Procesando'
                                : attempt.retryable
                                  ? 'Pendiente'
                                  : attempt.cuota_status || 'Cerrada'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {attempt.solicitud_id && (
                            <button type="button" onClick={() => navigate(`/admin/yego-mi-auto/rent-sale/${attempt.solicitud_id}`, { state: { driver_name: attempt.driver_name } })} className="inline-flex items-center gap-1 text-xs font-semibold text-[#8B1A1A] hover:underline">
                              <FileText className="h-3.5 w-3.5" /> Abrir contrato
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid min-h-64 place-items-center px-6 text-center text-sm text-gray-500">
              {detail?.run.error || (runs.length === 0
                ? 'Todavía no hay un proceso de cobro registrado. Los pendientes de hoy se muestran arriba.'
                : 'Este proceso no tiene intentos individuales registrados.')}
            </div>
          )}
        </section>
      </div>

      {confirmation && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="fleet-confirm-title">
          <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-red-50 text-[#8B1A1A]">
                  <RefreshCw className="h-5 w-5" />
                </span>
                <div>
                  <h2 id="fleet-confirm-title" className="font-bold text-gray-900">{confirmation.title}</h2>
                  <p className="mt-1 text-sm leading-relaxed text-gray-600">{confirmation.description}</p>
                </div>
              </div>
              <button type="button" onClick={() => setConfirmation(null)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700" aria-label="Cerrar">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="border-b border-amber-100 bg-amber-50 px-5 py-3 text-xs leading-relaxed text-amber-800">
              Los resultados se guardarán uno por uno. Cerrar o abandonar esta pantalla no detendrá el proceso del servidor.
            </div>
            <div className="flex flex-col-reverse gap-2 px-5 py-4 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setConfirmation(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
                Cancelar
              </button>
              <button type="button" onClick={() => void executeConfirmedAction()} className="rounded-lg bg-[#8B1A1A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#6B1515]">
                {confirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
