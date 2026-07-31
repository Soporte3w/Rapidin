import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { validateMiautoLicense } from '../yego_miauto/services/licencia/miautoLicenseValidationService.js';

const configuredBatchSize = Number(process.env.MIAUTO_LICENSE_VALIDATION_BATCH_SIZE);
const BATCH_SIZE = Number.isInteger(configuredBatchSize) && configuredBatchSize > 0
  ? Math.min(configuredBatchSize, 100)
  : 10;
const configuredDelayMs = Number(process.env.MIAUTO_LICENSE_VALIDATION_DELAY_MS);
const DELAY_MS = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
  ? configuredDelayMs
  : 400;

let started = false;
let missingTokenLogged = false;

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function getInitialBackfillCutoff() {
  const result = await query(
    `SELECT applied_at
     FROM public.rapidin_schema_migrations
     WHERE filename = '042_miauto_license_validation.sql'
     LIMIT 1`
  );
  if (!result.rows[0]?.applied_at) {
    throw new Error('No se encontró la fecha de aplicación de la migración 042');
  }
  return result.rows[0].applied_at;
}

export async function runMiautoLicenseValidationBatch(createdBefore) {
  if (!String(process.env.FACTILIZA_API_TOKEN || '').trim()) {
    if (!missingTokenLogged) {
      logger.warn('Mi Auto: backfill de licencias pausado; falta FACTILIZA_API_TOKEN');
      missingTokenLogged = true;
    }
    return { processed: 0, pending: true };
  }
  missingTokenLogged = false;

  const result = await query(
    `SELECT id, dni, country
     FROM module_miauto_solicitud
     WHERE country = 'PE'
       AND license_validation_status = 'pending'
       AND dni ~ '^\\d{8}$'
       AND created_at <= $2
     ORDER BY created_at ASC, id ASC
     LIMIT $1`,
    [BATCH_SIZE, createdBefore]
  );

  const stats = { valid: 0, invalid: 0, error: 0, persistenceErrors: 0 };
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index];
    const validation = await validateMiautoLicense({
      solicitudId: row.id,
      dni: row.dni,
      country: row.country,
    });
    stats[validation.status] = (stats[validation.status] || 0) + 1;
    if (validation.persisted === false) stats.persistenceErrors += 1;
    if (index + 1 < result.rows.length) await delay(DELAY_MS);
  }

  if (result.rows.length > 0) {
    logger.info('Mi Auto: lote de validación de licencias completado', {
      processed: result.rows.length,
      ...stats,
    });
  }
  return { processed: result.rows.length, ...stats };
}

async function runInitialBackfill() {
  const createdBefore = await getInitialBackfillCutoff();
  let totalProcessed = 0;
  while (true) {
    const result = await runMiautoLicenseValidationBatch(createdBefore);
    totalProcessed += result.processed;
    if (result.persistenceErrors > 0) {
      throw new Error(`No se persistieron ${result.persistenceErrors} validaciones; el backfill se detuvo`);
    }
    if (result.pending || result.processed < BATCH_SIZE) break;
  }
  logger.info('Mi Auto: backfill inicial de licencias finalizado', { processed: totalProcessed });
}

export function startMiautoLicenseValidationJob() {
  if (started) return;
  started = true;

  const initialRun = setTimeout(() => {
    runInitialBackfill().catch((error) => {
      logger.error('Mi Auto: error en el backfill inicial de licencias', { error: error.message });
    });
  }, 5_000);
  initialRun.unref?.();

  logger.info('Mi Auto: backfill inicial de licencias programado', {
    batchSize: BATCH_SIZE,
    delayMs: DELAY_MS,
  });
}
