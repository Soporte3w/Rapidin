/**
 * Yego Rapidín 4.0 — Consistency Check Scheduler
 *
 * Cron diario a las 3:00 AM Lima para verificar integridad de datos.
 */
import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { runConsistencyCheck } from './consistencyChecker.js';
import { auditService } from '../services/auditService.js';

export function startConsistencyCheckJob() {
  // Todos los días a las 3:00 AM Lima
  cron.schedule(
    '0 3 * * *',
    async () => {
      logger.info('ConsistencyChecker: iniciando verificación diaria...');
      try {
        const result = await runConsistencyCheck();
        await auditService.recordBusinessEvent(
          'consistency.check.completed',
          'system',
          null,
          result,
          null
        );
        logger.info(`ConsistencyChecker: ${result.summary.total} hallazgos (${result.summary.critical} críticos)`);
      } catch (err) {
        logger.error('ConsistencyChecker: error en job', { error: err.message });
      }
    },
    { timezone: 'America/Lima' }
  );
  logger.info('ConsistencyChecker: job programado diario 3:00 AM Lima');
}
