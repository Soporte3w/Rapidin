import { query } from '../../../config/database.js';
import { getLimaYmd } from '../../../utils/miautoLimaWeekRange.js';
import {
  decideMiautoFleetRetry,
  isMiautoFleetRetryWindow,
  normalizeMiautoAutomationConfig,
} from '../config/miautoAutomationConfig.js';

export function filterMiautoFleetRetryCuotas(cuotas, requestedIds) {
  const ids = requestedIds instanceof Set
    ? requestedIds
    : new Set((requestedIds || []).map((id) => String(id)));
  return (cuotas || []).filter((cuota) => (
    ids.has(String(cuota?.id))
    && ['pending', 'overdue', 'partial'].includes(String(cuota?.status || ''))
  ));
}

export async function claimMiautoFleetChargeRun({
  executionType,
  attemptNumber,
  executionId = null,
  sourceRunId = null,
  triggeredBy = null,
  now = new Date(),
}) {
  const businessDate = getLimaYmd(now);
  const result = await query(
    `INSERT INTO module_miauto_fleet_charge_run
       (business_date, execution_type, attempt_number, execution_id, source_run_id, triggered_by)
     VALUES ($1::date, $2, $3, $4::uuid, $5::uuid, $6::uuid)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [businessDate, executionType, attemptNumber, executionId, sourceRunId, triggeredBy],
  );
  return result.rows[0] || null;
}

export async function beginMiautoFleetChargeAttempt(runId, cuotaRow, context = {}) {
  const cuotaId = cuotaRow?.id ? String(cuotaRow.id) : null;
  if (!cuotaId) throw new Error('No se puede auditar un cobro Fleet sin cuota_semanal_id');

  const existing = await query(
    `SELECT id, idempotency_token
       FROM module_miauto_fleet_charge_attempt
      WHERE cuota_semanal_id = $1::uuid AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1`,
    [cuotaId],
  );
  if (existing.rows[0]) return existing.rows[0];

  try {
    const inserted = await query(
      `INSERT INTO module_miauto_fleet_charge_attempt
         (run_id, cuota_semanal_id, solicitud_id, external_driver_id, park_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
       RETURNING id, idempotency_token`,
      [
        runId,
        cuotaId,
        cuotaRow.solicitud_id || null,
        context.externalDriverId || cuotaRow.external_driver_id || null,
        context.parkId || cuotaRow.park_id || null,
      ],
    );
    return inserted.rows[0];
  } catch (error) {
    if (error?.code !== '23505') throw error;
    const concurrent = await query(
      `SELECT id, idempotency_token
         FROM module_miauto_fleet_charge_attempt
        WHERE cuota_semanal_id = $1::uuid AND status = 'running'
        ORDER BY started_at DESC
        LIMIT 1`,
      [cuotaId],
    );
    if (concurrent.rows[0]) return concurrent.rows[0];
    throw error;
  }
}

export async function finishMiautoFleetChargeAttempt(attemptId, result = {}) {
  const status = result.failed ? 'failed' : (result.partial ? 'partial' : 'success');
  await query(
    `UPDATE module_miauto_fleet_charge_attempt
        SET status = $2,
            reason = $3,
            external_driver_id = COALESCE($4, external_driver_id),
            park_id = COALESCE($5, park_id),
            balance_fleet = $6,
            amount_charged_fleet = $7,
            amount_credited_cuota = $8,
            finished_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid`,
    [
      attemptId,
      status,
      result.reason || result.error || null,
      result.externalDriverId || null,
      result.parkId || null,
      result.balance == null ? null : Number(result.balance),
      Math.max(0, Number(result.amountChargedFleet) || 0),
      Math.max(0, Number(result.amountCreditedCuota) || 0),
    ],
  );
}

export async function finishMiautoFleetChargeRun(runId, summary = {}) {
  const status = summary.error ? 'failed' : 'completed';
  let persistedSummary = summary;
  if (summary.error && summary.queueCount == null) {
    const attempts = await query(
      `SELECT COUNT(*)::int AS queue_count,
              COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
              COUNT(*) FILTER (WHERE status = 'partial')::int AS partial_count,
              COUNT(*) FILTER (WHERE status IN ('failed', 'running'))::int AS failed_count
         FROM module_miauto_fleet_charge_attempt
        WHERE run_id = $1::uuid`,
      [runId],
    );
    const counts = attempts.rows[0] || {};
    persistedSummary = {
      ...summary,
      queueCount: counts.queue_count,
      success: counts.success_count,
      partial: counts.partial_count,
      failed: counts.failed_count,
    };
  }
  await query(
    `UPDATE module_miauto_fleet_charge_run
        SET status = $2,
            queue_count = $3,
            success_count = $4,
            partial_count = $5,
            failed_count = $6,
            remaining_count = $7,
            error = $8,
            finished_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid`,
    [
      runId,
      status,
      Math.max(0, Number(persistedSummary.queueCount) || 0),
      Math.max(0, Number(persistedSummary.success) || 0),
      Math.max(0, Number(persistedSummary.partial) || 0),
      Math.max(0, Number(persistedSummary.failed) || 0),
      Math.max(0, Number(persistedSummary.remainingCount) || 0),
      persistedSummary.error || null,
    ],
  );
}

export async function getMiautoFleetRetryDecision(configValue, now = new Date()) {
  const config = normalizeMiautoAutomationConfig(configValue);
  if (!isMiautoFleetRetryWindow(config, now)) return { due: false, reason: 'fuera_de_ventana' };

  const businessDate = getLimaYmd(now);
  const result = await query(
    `SELECT attempt_number, status, remaining_count, failed_count,
            COALESCE(finished_at, started_at) AS reference_at
       FROM module_miauto_fleet_charge_run
      WHERE business_date = $1::date
        AND execution_type IN ('scheduled', 'retry')
      ORDER BY attempt_number DESC
      LIMIT 1`,
    [businessDate],
  );
  const latest = result.rows[0];
  return decideMiautoFleetRetry(config, latest, now);
}

export async function listMiautoFleetChargeRuns(limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const result = await query(
    `SELECT id, business_date, execution_type, attempt_number, source_run_id,
            triggered_by, status,
            queue_count, success_count, partial_count, failed_count,
            remaining_count, error, started_at, finished_at
       FROM module_miauto_fleet_charge_run
      ORDER BY business_date DESC, started_at DESC
      LIMIT $1`,
    [safeLimit],
  );
  return result.rows;
}

export async function getMiautoFleetChargeRunDetail(runId) {
  const runResult = await query(
    `SELECT id, business_date, execution_type, attempt_number, source_run_id,
            triggered_by, status, queue_count, success_count, partial_count,
            failed_count, remaining_count, error, started_at, finished_at
       FROM module_miauto_fleet_charge_run
      WHERE id = $1::uuid`,
    [runId],
  );
  const run = runResult.rows[0];
  if (!run) return null;

  const attemptsResult = await query(
    `SELECT a.id, a.run_id, a.cuota_semanal_id, a.solicitud_id,
            a.external_driver_id, a.park_id, a.status, a.reason,
            a.balance_fleet, a.amount_charged_fleet, a.amount_credited_cuota,
            a.started_at, a.finished_at,
            c.week_start_date, c.due_date, c.amount_due, c.paid_amount,
            c.status AS cuota_status,
            s.license_number, s.dni, s.placa_asignada,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', d.first_name, d.last_name)), ''),
              NULLIF(TRIM(d.full_name), ''),
              s.license_number,
              s.dni,
              'Conductor'
            ) AS driver_name,
            (
              a.status IN ('failed', 'partial', 'running')
              AND c.status IN ('pending', 'overdue', 'partial')
            ) AS retryable
       FROM module_miauto_fleet_charge_attempt a
       LEFT JOIN module_miauto_cuota_semanal c ON c.id = a.cuota_semanal_id
       LEFT JOIN module_miauto_solicitud s ON s.id = a.solicitud_id
       LEFT JOIN LATERAL (
         SELECT candidate.first_name, candidate.last_name, candidate.full_name
           FROM drivers candidate
          WHERE candidate.driver_id = a.external_driver_id
            AND TRIM(COALESCE(candidate.park_id::text, '')) = TRIM(COALESCE(a.park_id, ''))
          LIMIT 1
       ) d ON true
      WHERE a.run_id = $1::uuid
      ORDER BY a.started_at ASC, a.id ASC`,
    [runId],
  );
  return { run, attempts: attemptsResult.rows };
}

export async function getMiautoFleetRetryableCuotaIds(runId) {
  const result = await query(
    `SELECT DISTINCT a.cuota_semanal_id::text AS cuota_id
       FROM module_miauto_fleet_charge_attempt a
       INNER JOIN module_miauto_cuota_semanal c ON c.id = a.cuota_semanal_id
      WHERE a.run_id = $1::uuid
        AND a.status IN ('failed', 'partial', 'running')
        AND c.status IN ('pending', 'overdue', 'partial')
        AND c.deleted_at IS NULL`,
    [runId],
  );
  return result.rows.map((row) => String(row.cuota_id));
}
