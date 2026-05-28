/**
 * Yego Rapidín 4.0 — CronLock
 *
 * Mecanismo de lock distribuido para evitar ejecución duplicada de crons.
 * Usa PostgreSQL como backend (row-level lock en module_miauto_cron_lock).
 *
 * Uso:
 *   const lock = await acquireCronLock('miauto_generacion_cuotas', 120);
 *   if (!lock.acquired) return; // otro proceso ya lo está ejecutando
 *   try { ... ejecutar ... } finally { await releaseCronLock(lock); }
 */
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

const LOCK_TIMEOUT_SECONDS = 120; // 2 minutos default

/**
 * Intenta adquirir un lock para un cron job.
 * @param {string} jobName - Nombre único del job (ej. 'miauto_generacion_cuotas')
 * @param {number} [timeoutSeconds=120] - Tiempo máximo de lock antes de considerarlo expirado
 * @returns {{ acquired: boolean, executionId?: string, reason?: string }}
 */
export async function acquireCronLock(jobName, timeoutSeconds = LOCK_TIMEOUT_SECONDS) {
  const executionId = randomUUID();

  try {
    // Intentar adquirir lock con INSERT ON CONFLICT
    const res = await query(
      `INSERT INTO module_miauto_cron_lock (job_name, locked, locked_at, locked_by, execution_id, expires_at)
       VALUES ($1, true, CURRENT_TIMESTAMP, 'cron', $2, CURRENT_TIMESTAMP + INTERVAL '1 second' * $3)
       ON CONFLICT (job_name) DO UPDATE
         SET locked = true,
             locked_at = CURRENT_TIMESTAMP,
             locked_by = 'cron',
             execution_id = $2,
             expires_at = CURRENT_TIMESTAMP + INTERVAL '1 second' * $3
         WHERE module_miauto_cron_lock.locked = false
            OR module_miauto_cron_lock.expires_at < CURRENT_TIMESTAMP
       RETURNING execution_id, locked`,
      [jobName, executionId, timeoutSeconds]
    );

    if (res.rows.length === 0) {
      return {
        acquired: false,
        reason: `Cron '${jobName}' ya está en ejecución (locked). Se omite esta ejecución.`,
      };
    }

    if (!res.rows[0].locked || res.rows[0].execution_id !== executionId) {
      return {
        acquired: false,
        reason: `Cron '${jobName}' ya está bloqueado por otro proceso.`,
      };
    }

    return { acquired: true, executionId };
  } catch (err) {
    logger.error(`CronLock: error adquiriendo lock para '${jobName}':`, err);
    return { acquired: false, reason: `Error de BD: ${err.message}` };
  }
}

/**
 * Libera un lock previamente adquirido.
 */
export async function releaseCronLock(jobName, executionId) {
  try {
    await query(
      `UPDATE module_miauto_cron_lock
       SET locked = false, locked_at = NULL, locked_by = NULL, execution_id = NULL
       WHERE job_name = $1 AND execution_id = $2`,
      [jobName, executionId]
    );
  } catch (err) {
    logger.error(`CronLock: error liberando lock para '${jobName}':`, err);
  }
}
