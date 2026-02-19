/**
 * Sincroniza el ciclo de cada conductor según:
 * - Cantidad de préstamos cancelados (pagados): ciclo = cancelados + 1 (siguiente préstamo).
 * - Si puntualidad de pago < 40%: ciclo = 1 (baja por mal historial).
 * - El ciclo se limita al máximo configurado por país en module_rapidin_cycle_config.
 *
 * IMPORTANTE: Solo actualiza la columna cycle (y updated_at). No modifica dni ni ninguna otra columna.
 */

import dotenv from 'dotenv';
dotenv.config();

import { query } from '../config/database.js';
import { getPaymentPunctuality } from '../services/calculationsService.js';
import { logger } from '../utils/logger.js';

async function getMaxCycleByCountry() {
  const res = await query(
    `SELECT country, MAX(cycle) AS max_cycle
     FROM module_rapidin_cycle_config
     WHERE active = true
     GROUP BY country`
  );
  const map = {};
  for (const row of res.rows) {
    map[row.country] = parseInt(row.max_cycle, 10) || 1;
  }
  return map;
}

async function getCancelledCount(driverId) {
  const res = await query(
    `SELECT COUNT(*) AS total
     FROM module_rapidin_loans
     WHERE driver_id = $1 AND status = 'cancelled'`,
    [driverId]
  );
  return parseInt(res.rows[0]?.total, 10) || 0;
}

async function run() {
  logger.info('Iniciando sincronización de ciclo por conductor (sin modificar dni).');

  const driversRes = await query(
    'SELECT id, country, cycle AS current_cycle FROM module_rapidin_drivers'
  );
  const maxByCountry = await getMaxCycleByCountry();

  let updated = 0;
  let skipped = 0;

  for (const d of driversRes.rows) {
    const driverId = d.id;
    const country = d.country;
    const maxCycle = maxByCountry[country] ?? 7;

    const cancelledCount = await getCancelledCount(driverId);
    const punctuality = await getPaymentPunctuality(driverId);

    let newCycle;
    if (punctuality < 0.4) {
      newCycle = 1;
    } else {
      newCycle = Math.min(cancelledCount + 1, maxCycle);
    }

    const currentCycle = parseInt(d.current_cycle, 10) || 1;
    if (newCycle === currentCycle) {
      skipped++;
      continue;
    }

    await query(
      'UPDATE module_rapidin_drivers SET cycle = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newCycle, driverId]
    );
    updated++;
    logger.info(
      `Driver ${driverId} (${country}): cancelados=${cancelledCount} puntualidad=${(punctuality * 100).toFixed(1)}% -> cycle ${currentCycle} -> ${newCycle}`
    );
  }

  logger.info(`Sync ciclo: ${updated} actualizados, ${skipped} sin cambios.`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Error en sync-driver-cycle', err);
    process.exit(1);
  });
