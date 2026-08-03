import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  Banknote,
  CheckCircle2,
  ChevronRight,
  Clock3,
  History,
  RefreshCw,
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
  status: 'running' | 'success' | 'partial' | 'failed';
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
  if (attempt.status === 'success') return 'Cobro completado correctamente';
  if (attempt.status === 'partial') return 'Saldo Fleet insuficiente; se realizó un cobro parcial';
  if (attempt.status === 'running') return 'Intento en curso o interrumpido antes de recibir respuesta';
  return 'Fleet no completó el cobro';
}

function statusBadge(status: FleetChargeAttempt['status']) {
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
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');

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

  const loadDetail = useCallback(async (runId: string) => {
    setLoadingDetail(true);
    try {
      const response = await api.get(`/miauto/fleet-charge-runs/${runId}`);
      setDetail(unwrap<FleetChargeDetail>(response));
    } catch (requestError: any) {
      setDetail(null);
      toast.error(requestError.response?.data?.message || 'No se pudo cargar el detalle de la ejecución');
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

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

  const retryPending = useCallback(async () => {
    if (!canRetry || !detail || retryableAttempts.length === 0 || retrying) return;
    const confirmed = window.confirm(
      `Se volverá a consultar Fleet y se intentará retirar saldo para ${retryableAttempts.length} cuota(s) pendiente(s). ¿Deseas continuar?`,
    );
    if (!confirmed) return;
    try {
      setRetrying(true);
      const response = await api.post(`/miauto/fleet-charge-runs/${detail.run.id}/retry`);
      const result = unwrap<{
        run_id: string;
        cuotas_procesadas: number;
        success: number;
        partial: number;
        failed: number;
        pendientes_despues: number;
      }>(response);
      toast.success(
        `Reproceso terminado: ${result.success} completas, ${result.partial} parciales y ${result.failed} fallidas`,
      );
      await loadRuns(result.run_id);
      setSelectedRunId(result.run_id);
    } catch (requestError: any) {
      toast.error(requestError.response?.data?.message || 'No se pudo reprocesar la cola pendiente');
    } finally {
      setRetrying(false);
    }
  }, [canRetry, detail, loadRuns, retryableAttempts.length, retrying]);

  const selectedRun = detail?.run || runs.find((run) => run.id === selectedRunId) || null;

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
              <p className="mt-0.5 text-xs text-white/90 lg:text-sm">Corridas del cobro semanal, pendientes y motivo por conductor</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate('/admin/yego-mi-auto/rent-sale')}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/15 px-3 py-2 text-sm font-medium text-white hover:bg-white/25"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver a Alquiler / Venta
          </button>
        </div>
      </header>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

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
              <p className="text-xs text-gray-500">Últimas 50 corridas registradas</p>
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
            <button
              type="button"
              onClick={() => void retryPending()}
              disabled={!canRetry || !detail || retryableAttempts.length === 0 || retrying || detail.run.status === 'running'}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#8B1A1A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#6B1515] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
              {retrying ? 'Reprocesando...' : canRetry ? `Reprocesar pendientes (${retryableAttempts.length})` : 'Solo administradores'}
            </button>
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
                          <span className={`text-xs font-semibold ${attempt.retryable ? 'text-red-700' : 'text-green-700'}`}>
                            {attempt.retryable ? 'Pendiente' : attempt.cuota_status || 'Cerrada'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {attempt.solicitud_id && (
                            <button type="button" onClick={() => navigate(`/admin/yego-mi-auto/rent-sale/${attempt.solicitud_id}`)} className="inline-flex items-center gap-1 text-xs font-semibold text-[#8B1A1A] hover:underline">
                              <Banknote className="h-3.5 w-3.5" /> Ver contrato
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
              {detail?.run.error || 'Esta corrida no tiene intentos individuales registrados.'}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
