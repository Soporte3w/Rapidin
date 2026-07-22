import { createHash, randomUUID } from 'node:crypto';
import { query } from '../../config/database.js';
import {
  getContractorBalanceForFleet,
  withdrawFromContractor,
} from '../../services/yangoService.js';
import { logger } from '../../utils/logger.js';
import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';
import { applyPaymentToQuota } from './mimotoPaymentService.js';
import { acquireMimotoCronLock, releaseMimotoCronLock } from './mimotoCronLockService.js';
import { assertMimotoFleetWriteEnabled, mimotoFleetCookie } from './mimotoFleetContext.js';
import { mimotoToday } from './mimotoDateUtils.js';
import {
  assertMimotoIsolationSql,
  planMimotoFleetCharge,
  roundMoney,
} from './mimotoFinancialEngine.js';

const q = (sql, params = []) => query(assertMimotoIsolationSql(sql), params);

function openQuotas(asOf) {
  return q(
    `SELECT q.*, s.driver_id_fleet, s.fleet_id, f.park_id,
            CONCAT_WS(' ',s.first_name,s.last_name) AS driver_name
     FROM module_mimoto_cuota_semanal q
     JOIN module_mimoto_solicitud s
       ON s.id=q.solicitud_id AND s.deleted_at IS NULL AND s.status IN ('aprobado','activo')
     JOIN module_mimoto_fleet f
       ON f.id=s.fleet_id AND f.active=TRUE AND f.deleted_at IS NULL
     WHERE q.deleted_at IS NULL
       AND q.status IN ('pending','partial','overdue')
       AND q.due_date <= $1::date
       AND GREATEST(0,q.amount_due-q.capital_paid)+q.late_fee+q.mora_extra > 0.005
       AND s.driver_id_fleet IS NOT NULL
     ORDER BY f.park_id, s.driver_id_fleet, q.due_date, q.week_start_date, q.id`,
    [asOf]
  );
}

function groupByDriverAndFleet(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.fleet_id}:${row.driver_id_fleet}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function financialSourceKey(quota, runDate) {
  const state = [
    'mimoto-fleet', runDate, quota.id,
    roundMoney(quota.amount_due), roundMoney(quota.capital_paid),
    roundMoney(quota.late_fee), roundMoney(quota.mora_extra),
  ].join(':');
  return createHash('sha256').update(state).digest('hex');
}

function externalReference(payload) {
  return String(
    payload?.transaction_id
    || payload?.id
    || payload?.transaction?.id
    || payload?.data?.id
    || ''
  ).trim() || null;
}

async function colombianExchangeRate() {
  const result = await q(
    `SELECT valor_usd_a_local FROM module_mimoto_tipo_cambio WHERE country='CO'`
  );
  return Number(result.rows[0]?.valor_usd_a_local) || 0;
}

async function reconcileAppliedEvidence() {
  await q(
    `UPDATE module_mimoto_evidencia_cobro_fleet e
     SET status='success', completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP), error=NULL
     FROM module_mimoto_cuota_semanal q
     WHERE q.id=e.cuota_semanal_id
       AND e.source_key IS NOT NULL
       AND e.status IN ('processing','failed')
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(q.payment_chunks) chunk
         WHERE chunk->>'source_key'=e.source_key
       )`
  );
}

async function reserveEvidence({ quota, sourceKey, amountCop, requestPayload }) {
  const token = randomUUID();
  const result = await q(
    `INSERT INTO module_mimoto_evidencia_cobro_fleet
      (solicitud_id,cuota_semanal_id,fleet_id,monto,moneda,request_payload,response_payload,
       simulated,source_key,idempotency_token,status)
     VALUES ($1,$2,$3,$4,'COP',$5::jsonb,'{}'::jsonb,FALSE,$6,$7,'processing')
     ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO UPDATE SET
       monto=EXCLUDED.monto,
       request_payload=EXCLUDED.request_payload,
       status=CASE
         WHEN module_mimoto_evidencia_cobro_fleet.status='success' THEN 'success'
         ELSE 'processing'
       END,
       error=NULL
     RETURNING *`,
    [quota.solicitud_id, quota.id, quota.fleet_id, amountCop,
      JSON.stringify(requestPayload), sourceKey, token]
  );
  return result.rows[0];
}

async function markEvidenceExternalResponse(evidenceId, response) {
  await q(
    `UPDATE module_mimoto_evidencia_cobro_fleet
     SET response_payload=$1::jsonb, external_reference=$2, error=NULL
     WHERE id=$3`,
    [JSON.stringify(response || {}), externalReference(response), evidenceId]
  );
}

async function markEvidenceSuccess(evidenceId) {
  await q(
    `UPDATE module_mimoto_evidencia_cobro_fleet
     SET status='success', completed_at=CURRENT_TIMESTAMP, error=NULL
     WHERE id=$1`,
    [evidenceId]
  );
}

async function markEvidenceFailure(evidenceId, message, response = null) {
  await q(
    `UPDATE module_mimoto_evidencia_cobro_fleet
     SET status='failed', error=$2,
         response_payload=CASE WHEN $3::jsonb='null'::jsonb THEN response_payload ELSE $3::jsonb END,
         completed_at=CURRENT_TIMESTAMP
     WHERE id=$1`,
    [evidenceId, String(message || 'Error Fleet'), JSON.stringify(response)]
  );
}

export async function runMimotoFleetCharge({ dryRun = true, asOf = mimotoToday() } = {}) {
  if (!dryRun) assertMimotoFleetWriteEnabled();
  const jobName = 'mimoto_fleet_charge';
  const executionId = await acquireMimotoCronLock(jobName, 120);
  if (!executionId) return { skipped: true, reason: 'job_locked', dry_run: dryRun };

  const results = [];
  try {
    if (!dryRun) await reconcileAppliedEvidence();
    const quotas = (await openQuotas(asOf)).rows;
    const needsUsdRate = quotas.some((quota) => quota.moneda === 'USD');
    const usdToCop = needsUsdRate ? await colombianExchangeRate() : 1;
    if (needsUsdRate && usdToCop <= 0) throw new Error('El tipo de cambio USD/COP no está configurado');

    for (const driverQuotas of groupByDriverAndFleet(quotas).values()) {
      const driver = driverQuotas[0];
      const cookie = mimotoFleetCookie();
      if (!cookie) {
        results.push({ solicitud_id: driver.solicitud_id, status: 'error', reason: 'sin_sesion_fleet' });
        continue;
      }
      const balanceResult = await getContractorBalanceForFleet(driver.driver_id_fleet, {
        parkId: driver.park_id,
        cookie,
      });
      if (!balanceResult.success) {
        results.push({
          solicitud_id: driver.solicitud_id,
          status: 'error',
          reason: 'balance_fleet',
          error: balanceResult.error,
        });
        continue;
      }

      let availableCop = roundMoney(Math.max(0, balanceResult.balance));
      for (const quota of driverQuotas) {
        if (availableCop <= 0.005) break;
        const plan = planMimotoFleetCharge(quota, availableCop, usdToCop);
        if (!plan || plan.amount_cop <= 0.005) continue;
        const sourceKey = financialSourceKey(quota, asOf);
        const baseResult = {
          solicitud_id: quota.solicitud_id,
          cuota_id: quota.id,
          week_number: quota.week_number,
          source_key: sourceKey,
          ...plan,
        };
        if (dryRun) {
          results.push({ ...baseResult, status: 'simulated' });
          availableCop = roundMoney(availableCop - plan.amount_cop);
          continue;
        }

        const requestPayload = {
          contractor_profile_id: quota.driver_id_fleet,
          park_id: quota.park_id,
          amount: plan.amount_cop,
          currency: 'COP',
          quota_id: quota.id,
          distribution: plan.distribution,
        };
        const evidence = await reserveEvidence({ quota, sourceKey, amountCop: plan.amount_cop, requestPayload });
        if (evidence.status === 'success') {
          results.push({ ...baseResult, status: 'skipped', reason: 'already_charged' });
          continue;
        }

        const withdrawal = await withdrawFromContractor(
          quota.driver_id_fleet,
          plan.amount_cop,
          `Yego Mi Moto - Semana ${quota.week_number}`,
          cookie,
          quota.park_id,
          { balance_min: '0' },
          evidence.idempotency_token,
        );
        if (!withdrawal.success) {
          await markEvidenceFailure(evidence.id, withdrawal.message, withdrawal);
          results.push({ ...baseResult, status: 'error', reason: 'fleet_withdrawal', error: withdrawal.message });
          break;
        }

        await markEvidenceExternalResponse(evidence.id, withdrawal.data);
        try {
          const applied = await applyPaymentToQuota({
            solicitudId: quota.solicitud_id,
            quotaId: quota.id,
            amount: plan.amount_cop,
            currency: 'COP',
            source: 'fleet',
            sourceKey,
            actorId: null,
          });
          await markEvidenceSuccess(evidence.id);
          availableCop = roundMoney(availableCop - plan.amount_cop);
          results.push({ ...baseResult, status: 'charged', application: applied });
        } catch (error) {
          await markEvidenceFailure(evidence.id, `Retiro confirmado; aplicación local pendiente: ${error.message}`, withdrawal.data);
          results.push({ ...baseResult, status: 'error', reason: 'local_application', error: error.message });
          break;
        }
      }
    }

    const summary = results.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {});
    logger.info('Mi Moto: cobro Fleet finalizado', { dryRun, asOf, summary });
    return {
      skipped: false,
      dry_run: dryRun,
      fleet_write_enabled: MIMOTO_CONFIG.fleetWithdrawEnabled,
      execution_id: executionId,
      as_of: asOf,
      summary,
      results,
    };
  } finally {
    await releaseMimotoCronLock(jobName, executionId);
  }
}
