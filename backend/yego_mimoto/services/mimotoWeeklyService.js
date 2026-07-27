import { query } from '../../config/database.js';
import {
  getDriverIncomeForFleet,
  getFleetSupplySummary,
} from '../../services/yangoService.js';
import { logger } from '../../utils/logger.js';
import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';
import { previewOrGenerateWeeklyQuota } from './mimotoWeeklyBillingService.js';
import { acquireMimotoCronLock, releaseMimotoCronLock } from './mimotoCronLockService.js';
import { mimotoFleetCookie } from './mimotoFleetContext.js';
import {
  normalizeMimotoPlate,
  resolveMimotoFleetIdentity,
} from './mimotoFleetIdentityService.js';
import { mimotoDateOnly, mimotoWeeklyContext } from './mimotoDateUtils.js';
import { assertMimotoIsolationSql, resolveMimotoWeeklyMetrics } from './mimotoFinancialEngine.js';

const q = (sql, params = []) => query(assertMimotoIsolationSql(sql), params);

function generationCandidates(weekMonday) {
  return q(
    `SELECT s.id, s.placa_asignada, s.fecha_inicio_cobro_semanal,
            s.fleet_id, f.park_id,
            COALESCE(NULLIF(s.cronograma_snapshot->>'modo_evaluacion',''), c.modo_evaluacion, 'viajes') AS modo_evaluacion,
            COALESCE(NULLIF(s.cronograma_snapshot->'vehicle'->>'cuotas_semanales','')::int,
                     v.cuotas_semanales, 0) AS cuotas_semanales_plan,
            COALESCE((SELECT MAX(qs.week_number)
                      FROM module_mimoto_cuota_semanal qs
                      WHERE qs.solicitud_id=s.id AND qs.deleted_at IS NULL), 0)::int AS last_week,
            (SELECT qs.id
              FROM module_mimoto_cuota_semanal qs
              WHERE qs.solicitud_id=s.id AND qs.week_start_date=$1::date AND qs.deleted_at IS NULL
              LIMIT 1) AS current_quota_id
     FROM module_mimoto_solicitud s
     JOIN module_mimoto_fleet f
       ON f.id=s.fleet_id AND f.active=TRUE AND f.deleted_at IS NULL
     LEFT JOIN module_mimoto_cronograma c ON c.id=s.cronograma_id
     LEFT JOIN module_mimoto_cronograma_vehiculo v ON v.id=s.cronograma_vehiculo_id
     WHERE s.deleted_at IS NULL
       AND s.status IN ('aprobado','activo')
     ORDER BY f.park_id, s.id`,
    [weekMonday]
  );
}

function candidateReason(candidate, weekMonday) {
  if (!normalizeMimotoPlate(candidate.placa_asignada)) return 'sin_placa';
  if (!candidate.fecha_inicio_cobro_semanal) return 'sin_fecha_inicio';
  if (mimotoDateOnly(candidate.fecha_inicio_cobro_semanal) > weekMonday) return 'aun_no_inicia';
  if (Number(candidate.cuotas_semanales_plan) <= Number(candidate.last_week)) return 'cronograma_completo';
  return null;
}

function duplicatedPlates(rows) {
  const counts = new Map();
  rows.forEach((row) => {
    const plate = normalizeMimotoPlate(row.placa_asignada);
    if (plate) counts.set(plate, (counts.get(plate) || 0) + 1);
  });
  return new Set([...counts].filter(([, count]) => count > 1).map(([plate]) => plate));
}

function groupByFleet(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.fleet_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

export async function runMimotoWeeklyGeneration({ dryRun = true, now = new Date() } = {}) {
  if (!dryRun && (!MIMOTO_CONFIG.enabled || !MIMOTO_CONFIG.automationEnabled)) {
    throw new Error('La generación semanal automática de Mi Moto está desactivada');
  }
  const jobName = 'mimoto_weekly_generation';
  const executionId = await acquireMimotoCronLock(jobName, 90);
  if (!executionId) return { skipped: true, reason: 'job_locked', dry_run: dryRun };

  const period = mimotoWeeklyContext(now);
  const results = [];
  try {
    const candidates = (await generationCandidates(period.cuotaWeekMonday)).rows;
    for (const fleetRows of groupByFleet(candidates).values()) {
      const { park_id: parkId } = fleetRows[0];
      const ambiguousPlates = duplicatedPlates(fleetRows);
      const cookie = mimotoFleetCookie();
      if (!cookie) {
        fleetRows.forEach((row) => results.push({ solicitud_id: row.id, status: 'skipped', reason: 'sin_sesion_fleet' }));
        continue;
      }

      const supply = await getFleetSupplySummary({
        dateFrom: period.incomeWeekMonday,
        dateTo: period.incomeSunday,
        parkId,
        cookie,
      });

      for (const candidate of fleetRows) {
        const skipReason = candidateReason(candidate, period.cuotaWeekMonday);
        if (skipReason) {
          results.push({ solicitud_id: candidate.id, status: 'skipped', reason: skipReason });
          continue;
        }
        if (candidate.current_quota_id) {
          results.push({ solicitud_id: candidate.id, status: 'skipped', reason: 'cuota_existente' });
          continue;
        }

        const normalizedPlate = normalizeMimotoPlate(candidate.placa_asignada);
        if (ambiguousPlates.has(normalizedPlate)) {
          results.push({
            solicitud_id: candidate.id,
            status: 'error',
            reason: 'placa_duplicada_en_flota',
            error: `La placa ${normalizedPlate} está asignada a más de una solicitud activa`,
          });
          continue;
        }

        const identity = await resolveMimotoFleetIdentity({
          plate: normalizedPlate,
          parkId,
          cookie,
          supply,
        });
        if (!identity.success) {
          results.push({
            solicitud_id: candidate.id,
            status: 'error',
            reason: identity.reason || 'fleet_plate',
            error: identity.error,
          });
          continue;
        }

        const income = await getDriverIncomeForFleet({
          dateFrom: period.dateFrom,
          dateTo: period.dateTo,
          driverId: identity.driverId,
          parkId,
          cookie,
        });
        if (!income.success) {
          results.push({ solicitud_id: candidate.id, status: 'error', reason: 'fleet_income', error: income.error });
          continue;
        }
        const metrics = resolveMimotoWeeklyMetrics({
          mode: candidate.modo_evaluacion,
          incomeTrips: income.count_completed,
          supply,
          supplyDriver: identity.supplyDriver,
        });
        if (!metrics.valid) {
          results.push({
            solicitud_id: candidate.id,
            status: 'error',
            reason: 'fleet_supply',
            error: metrics.error,
          });
          continue;
        }
        try {
          const generated = await previewOrGenerateWeeklyQuota(candidate.id, {
            week_start_date: period.cuotaWeekMonday,
            due_date: period.cuotaWeekMonday,
            viajes: metrics.trips,
            horas_conectadas: metrics.connectedHours,
            partner_fees: income.partner_fees,
            dry_run: dryRun,
            generated_by: 'mimoto_cron_lunes',
            metrics_period: {
              date_from: period.incomeWeekMonday,
              date_to: period.incomeSunday,
              park_id: parkId,
              plate: identity.plate,
              resolved_driver_id: identity.driverId,
              identity_source: identity.source,
            },
          }, null);
          results.push({
            solicitud_id: candidate.id,
            status: dryRun ? 'simulated' : 'generated',
            warning: metrics.warning,
            fleet_identity: {
              plate: identity.plate,
              source: identity.source,
            },
            cuota: generated.cuota,
          });
        } catch (error) {
          const duplicate = /ya existe/i.test(error.message);
          results.push({
            solicitud_id: candidate.id,
            status: duplicate ? 'skipped' : 'error',
            reason: duplicate ? 'cuota_existente' : 'generation_failed',
            error: duplicate ? undefined : error.message,
          });
        }
      }
    }

    const summary = results.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {});
    logger.info('Mi Moto: generación semanal finalizada', {
      dryRun,
      weekStart: period.cuotaWeekMonday,
      summary,
    });
    return {
      skipped: false,
      dry_run: dryRun,
      execution_id: executionId,
      period,
      summary,
      results,
    };
  } finally {
    await releaseMimotoCronLock(jobName, executionId);
  }
}
