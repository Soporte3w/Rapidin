import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { validateMiautoLicense } from '../yego_miauto/services/licencia/miautoLicenseValidationService.js';

const configuredBatchSize = Number(process.env.MIAUTO_LICENSE_VALIDATION_BATCH_SIZE);
const BATCH_SIZE = Number.isInteger(configuredBatchSize) && configuredBatchSize > 0
  ? Math.min(configuredBatchSize, 100)
  : 10;
const configuredIntervalMs = Number(process.env.MIAUTO_LICENSE_VALIDATION_INTERVAL_MS);
const INTERVAL_MS = Number.isFinite(configuredIntervalMs) && configuredIntervalMs >= 10_000
  ? configuredIntervalMs
  : 60_000;
const configuredDelayMs = Number(process.env.MIAUTO_LICENSE_VALIDATION_DELAY_MS);
const DELAY_MS = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
  ? configuredDelayMs
  : 400;

let running = false;
let started = false;
let missingTokenLogged = false;

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function runMiautoLicenseValidationBatch() {
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
       AND (
         license_validation_status = 'pending'
         OR (
           license_validation_status = 'error'
           AND license_validation_attempts < 3
           AND license_validation_checked_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes'
         )
       )
       AND dni ~ '^\\d{8}$'
     ORDER BY CASE WHEN license_validation_status = 'pending' THEN 0 ELSE 1 END,
              created_at ASC, id ASC
     LIMIT $1`,
    [BATCH_SIZE]
  );

  const stats = { valid: 0, invalid: 0, error: 0 };
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index];
    const validation = await validateMiautoLicense({
      solicitudId: row.id,
      dni: row.dni,
      country: row.country,
    });
    stats[validation.status] = (stats[validation.status] || 0) + 1;
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

async function guardedRun() {
  if (running) return;
  running = true;
  try {
    await runMiautoLicenseValidationBatch();
  } catch (error) {
    logger.error('Mi Auto: error procesando validaciones de licencia', { error: error.message });
  } finally {
    running = false;
  }
}

export function startMiautoLicenseValidationJob() {
  if (started) return;
  started = true;

  const initialRun = setTimeout(guardedRun, 5_000);
  const interval = setInterval(guardedRun, INTERVAL_MS);
  initialRun.unref?.();
  interval.unref?.();

  logger.info('Mi Auto: validador de licencias iniciado', {
    batchSize: BATCH_SIZE,
    intervalMs: INTERVAL_MS,
    delayMs: DELAY_MS,
  });
}
