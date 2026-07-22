import { getClient, query } from '../../config/database.js';
import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';
import { assertMimotoIsolationSql, calculateMimotoMoraAccrual, roundMoney } from './mimotoFinancialEngine.js';
import { acquireMimotoCronLock, releaseMimotoCronLock } from './mimotoCronLockService.js';

const q = (sql, params = []) => query(assertMimotoIsolationSql(sql), params);

function dateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const from = Date.parse(`${dateOnly(start)}T12:00:00Z`);
  const to = Date.parse(`${dateOnly(end)}T12:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.floor((to - from) / 86400000)) : 0;
}

function bogotaToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MIMOTO_CONFIG.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export async function runMimotoDailyMora({ dryRun = true, asOf = bogotaToday() } = {}) {
  const jobName = 'mimoto_daily_mora';
  const executionId = await acquireMimotoCronLock(jobName);
  if (!executionId) return { skipped: true, reason: 'job_locked', dry_run: dryRun };
  try {
    const result = await q(
      `SELECT q.id, q.solicitud_id, q.week_start_date, q.due_date, q.week_number,
              q.amount_due, q.capital_paid, q.late_fee_total, q.late_fee_paid,
              q.mora_extra_total, q.mora_extra_paid, q.fecha_ultimo_abono,
              q.mora_extra_desde, q.mora_calculated_through,
              q.mora_extra_calculated_through, q.paid_amount, q.status,
              COALESCE(q.tasa_interes_mora_snapshot,
                       NULLIF(s.cronograma_snapshot->>'tasa_interes_mora','')::numeric,
                       c.tasa_interes_mora, 0) AS tasa_interes_mora,
              MIN(cp.created_at) FILTER (WHERE cp.estado='pendiente') AS freeze_at
       FROM module_mimoto_cuota_semanal q
       JOIN module_mimoto_solicitud s ON s.id=q.solicitud_id AND s.deleted_at IS NULL
       LEFT JOIN module_mimoto_cronograma c ON c.id=s.cronograma_id
       LEFT JOIN module_mimoto_comprobante_cuota_semanal cp
         ON cp.cuota_semanal_id=q.id AND cp.deleted_at IS NULL
       WHERE q.deleted_at IS NULL AND q.status IN ('pending','partial','overdue')
         AND q.due_date < $1::date
       GROUP BY q.id, s.cronograma_snapshot, c.tasa_interes_mora
       ORDER BY q.due_date, q.id`,
      [asOf]
    );
    const changes = [];
    for (const quota of result.rows) {
      const capitalBalance = roundMoney(Math.max(0, Number(quota.amount_due) - Number(quota.capital_paid)));
      if (capitalBalance <= 0.005) continue;
      const cutoff = quota.freeze_at && dateOnly(quota.freeze_at) < asOf ? dateOnly(quota.freeze_at) : asOf;
      const weeklyRate = Number(quota.tasa_interes_mora) || 0;
      const hasPayment = Number(quota.paid_amount) > 0.005;
      const normalStart = quota.mora_calculated_through || quota.due_date;
      const extraStart = quota.mora_extra_calculated_through
        || quota.mora_extra_desde
        || quota.fecha_ultimo_abono;
      const mora = calculateMimotoMoraAccrual({
        capitalBalance,
        weeklyRate,
        hasPayment,
        normalDays: daysBetween(normalStart, cutoff),
        extraDays: extraStart ? daysBetween(extraStart, cutoff) : 0,
        normalTotal: quota.late_fee_total,
        normalPaid: quota.late_fee_paid,
        extraTotal: quota.mora_extra_total,
        extraPaid: quota.mora_extra_paid,
      });
      changes.push({
        cuota_id: quota.id,
        solicitud_id: quota.solicitud_id,
        cutoff,
        frozen: Boolean(quota.freeze_at),
        calculated_through: quota.freeze_at ? asOf : cutoff,
        has_payment: hasPayment,
        capital_balance: capitalBalance,
        ...mora,
      });
    }
    if (!dryRun && changes.length > 0) {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        for (const change of changes) {
          await client.query(
            assertMimotoIsolationSql(
              `UPDATE module_mimoto_cuota_semanal SET late_fee_total=$1, late_fee=$2,
                 mora_extra_total=$3, mora_extra=$4,
                 mora_calculated_through=CASE WHEN $5 THEN mora_calculated_through ELSE $6::date END,
                 mora_extra_calculated_through=CASE WHEN $5 THEN $6::date ELSE mora_extra_calculated_through END,
                 status='overdue', updated_at=CURRENT_TIMESTAMP
               WHERE id=$7`
            ),
            [change.late_fee_total, change.late_fee, change.mora_extra_total, change.mora_extra,
              change.has_payment, change.calculated_through, change.cuota_id]
          );
          await client.query(
            assertMimotoIsolationSql(
              `INSERT INTO module_mimoto_billing_audit_trail
                (cuota_semanal_id,solicitud_id,event_type,billing_context,generated_by,correlation_id)
               VALUES ($1,$2,'mora.daily',$3::jsonb,'mimoto_cron',$4)`
            ),
            [change.cuota_id, change.solicitud_id, JSON.stringify(change), executionId]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    return { skipped: false, dry_run: dryRun, as_of: asOf, affected: changes.length, changes };
  } finally {
    await releaseMimotoCronLock(jobName, executionId);
  }
}

export async function runMimotoExpenseMaintenance({ dryRun = true, asOf = bogotaToday() } = {}) {
  const jobName = 'mimoto_expense_maintenance';
  const executionId = await acquireMimotoCronLock(jobName);
  if (!executionId) return { skipped: true, reason: 'job_locked', dry_run: dryRun };
  try {
    const candidates = await q(
      `SELECT id FROM module_mimoto_otros_gastos
       WHERE deleted_at IS NULL AND due_date < $1::date
         AND status IN ('pending','partial') AND paid_amount < amount_due`,
      [asOf]
    );
    if (!dryRun && candidates.rowCount > 0) {
      await q(
        `UPDATE module_mimoto_otros_gastos SET status='overdue', updated_at=CURRENT_TIMESTAMP
         WHERE id=ANY($1::uuid[])`,
        [candidates.rows.map((row) => row.id)]
      );
    }
    return { skipped: false, dry_run: dryRun, as_of: asOf, affected: candidates.rowCount };
  } finally {
    await releaseMimotoCronLock(jobName, executionId);
  }
}

export async function getMimotoAutomationReadiness() {
  const fleets = await q(
    `SELECT id FROM module_mimoto_fleet
     WHERE active=TRUE AND deleted_at IS NULL`
  );
  const hasFleetSession = Boolean(String(process.env.MIMOTO_FLEET_COOKIE || '').trim());
  const missingFleetSessions = hasFleetSession ? 0 : fleets.rowCount;
  const blockedReasons = [];
  if (!MIMOTO_CONFIG.enabled) blockedReasons.push('MIMOTO_ENABLED está desactivado.');
  if (!MIMOTO_CONFIG.automationEnabled) blockedReasons.push('MIMOTO_AUTOMATION_ENABLED está desactivado.');
  if (missingFleetSessions > 0) blockedReasons.push('MIMOTO_FLEET_COOKIE no está configurada.');
  if (!MIMOTO_CONFIG.fleetWithdrawEnabled) blockedReasons.push('El retiro real está bloqueado; el job de Fleet corre solamente en simulación.');
  return {
    module_enabled: MIMOTO_CONFIG.enabled,
    automation_enabled: MIMOTO_CONFIG.automationEnabled,
    mora_ready: true,
    expense_status_ready: true,
    weekly_generation_ready: missingFleetSessions === 0 && fleets.rows.length > 0,
    fleet_withdrawal_ready: missingFleetSessions === 0
      && fleets.rows.length > 0
      && MIMOTO_CONFIG.fleetWithdrawEnabled,
    active_fleets: fleets.rows.length,
    fleets_without_session: missingFleetSessions,
    blocked_reasons: blockedReasons,
  };
}
