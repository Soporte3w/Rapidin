import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { MIMOTO_CONFIG } from '../yego_mimoto/config/mimotoConfig.js';
import { processMimotoMessageQueue } from '../yego_mimoto/services/mimotoWhatsAppService.js';
import {
  runMimotoDailyMora,
  runMimotoExpenseMaintenance,
} from '../yego_mimoto/services/mimotoAutomationService.js';
import { runMimotoWeeklyGeneration } from '../yego_mimoto/services/mimotoWeeklyService.js';
import { runMimotoFleetCharge } from '../yego_mimoto/services/mimotoFleetChargeService.js';

const JOBS = [
  { name: 'mora', expressionEnv: 'MIMOTO_MORA_CRON', defaultExpression: '0 1 * * *', run: () => runMimotoDailyMora({ dryRun: false }) },
  { name: 'gastos', expressionEnv: 'MIMOTO_GASTOS_CRON', defaultExpression: '15 1 * * *', run: () => runMimotoExpenseMaintenance({ dryRun: false }) },
  { name: 'cuota_semanal', expressionEnv: 'MIMOTO_WEEKLY_CRON', defaultExpression: '0 6 * * 1', run: () => runMimotoWeeklyGeneration({ dryRun: false }) },
  {
    name: 'cobro_fleet',
    expressionEnv: 'MIMOTO_FLEET_CRON',
    defaultExpression: '10 7 * * 1',
    run: () => runMimotoFleetCharge({ dryRun: !MIMOTO_CONFIG.fleetWithdrawEnabled }),
  },
  { name: 'whatsapp', expressionEnv: 'MIMOTO_WHATSAPP_CRON', run: processMimotoMessageQueue },
];

async function guardedRun(job) {
  try {
    await job.run();
  } catch (error) {
    logger.error(`Mi Moto job ${job.name}:`, error);
  }
}

export function startMimotoJobs() {
  if (!MIMOTO_CONFIG.enabled || !MIMOTO_CONFIG.automationEnabled) {
    logger.info('Mi Moto: jobs desactivados', {
      enabled: MIMOTO_CONFIG.enabled,
      automationEnabled: MIMOTO_CONFIG.automationEnabled,
    });
    return [];
  }

  const scheduled = [];
  for (const job of JOBS) {
    const expression = String(process.env[job.expressionEnv] || job.defaultExpression || '').trim();
    if (!expression) {
      logger.warn(`Mi Moto: ${job.name} sin programación (${job.expressionEnv})`);
      continue;
    }
    if (!cron.validate(expression)) {
      logger.error(`Mi Moto: expresión cron inválida para ${job.name}`, { expression });
      continue;
    }
    scheduled.push(cron.schedule(expression, () => guardedRun(job), { timezone: MIMOTO_CONFIG.timezone }));
  }
  logger.info('Mi Moto: jobs registrados', { count: scheduled.length, timezone: MIMOTO_CONFIG.timezone });
  return scheduled;
}
