/**
 * Jala driver_id de la tabla drivers y lo copia en external_driver_id de module_rapidin_drivers
 * cuando hay match por:
 *   - rapidin: dni (ej. "77221246")
 *   - drivers: license_number que se parece al DNI (ej. "Q77221246" → mismos dígitos o prefijo Q + DNI)
 *
 * Solo actualiza si park_id coincide en ambas tablas (misma flota). Si park_id no es igual, no actualiza.
 *
 * Uso (desde backend/):
 *   node scripts/sync-external-id-by-dni-license.js 77221246
 *   node scripts/sync-external-id-by-dni-license.js 77221246 --dry-run
 *   node scripts/sync-external-id-by-dni-license.js   # procesa todos los rapidin sin external_driver_id y con match por licencia
 */

import dotenv from 'dotenv';
dotenv.config();

import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

const DRY_RUN = process.argv.includes('--dry-run');

function digitsOnly(str) {
  return (str || '').toString().replace(/\D/g, '');
}

/** Normaliza park_id para comparar (null/undefined/'' como ''). */
function normParkId(parkId) {
  const s = (parkId != null && parkId !== '') ? String(parkId).trim() : '';
  return s;
}

/**
 * Busca en drivers filas donde license_number coincida con el DNI:
 * - Igualdad exacta (trim)
 * - Solo dígitos iguales (ej. license "Q77221246" → 77221246, dni "77221246")
 * - license_number = prefijo + dni (ej. "Q" + "77221246")
 */
async function findDriversByLicenseLikeDni(dni) {
  const trimmed = (dni || '').toString().trim();
  if (!trimmed || trimmed.length < 4) return [];
  const digits = digitsOnly(trimmed);
  const r = await query(
    `SELECT driver_id, park_id, license_number
     FROM drivers
     WHERE TRIM(COALESCE(license_number, '')) != ''
       AND (
         TRIM(COALESCE(license_number, '')) = $1
         OR REGEXP_REPLACE(COALESCE(license_number, ''), '[^0-9]', '', 'g') = $2
         OR TRIM(COALESCE(license_number, '')) = 'Q' || $1
         OR TRIM(COALESCE(license_number, '')) = 'Q' || $2
         OR (LENGTH($2) >= 6 AND REGEXP_REPLACE(COALESCE(license_number, ''), '[^0-9]', '', 'g') = $2)
       )
     ORDER BY park_id NULLS LAST`,
    [trimmed, digits]
  );
  return r.rows || [];
}

async function run() {
  const dniArg = process.argv.find((a) => a && !a.startsWith('-') && /^\d+$/.test(a));
  if (DRY_RUN) logger.info('Modo --dry-run: no se modificará la base de datos.');

  let rapidinRows;
  if (dniArg) {
    rapidinRows = await query(
      `SELECT id, dni, country, first_name, last_name, external_driver_id, park_id
       FROM module_rapidin_drivers
       WHERE TRIM(dni) = $1 OR REGEXP_REPLACE(TRIM(dni), '[^0-9]', '', 'g') = $1`,
      [dniArg.trim()]
    );
    rapidinRows = rapidinRows.rows || [];
    logger.info(`Rapidín con DNI ${dniArg}: ${rapidinRows.length} fila(s).`);
  } else {
    rapidinRows = await query(
      `SELECT id, dni, country, first_name, last_name, external_driver_id, park_id
       FROM module_rapidin_drivers
       ORDER BY country, dni`
    );
    rapidinRows = rapidinRows.rows || [];
    logger.info(`Procesando todos los conductores Rapidín: ${rapidinRows.length}. Solo se actualizará si hay match por license_number y mismo park_id.`);
  }

  let updated = 0;
  let skippedNoMatch = 0;
  let skippedParkMismatch = 0;
  /** Lista de casos con park_id distinto (no actualizado) para listar al final. */
  const parkMismatchList = [];

  for (const r of rapidinRows) {
    const drivers = await findDriversByLicenseLikeDni(r.dni);
    if (drivers.length === 0) {
      skippedNoMatch++;
      if (dniArg) logger.info(`[${r.dni}] No hay fila en drivers con license_number que coincida con DNI.`);
      continue;
    }

    const rapidinPark = normParkId(r.park_id);
    const match = drivers.find((d) => normParkId(d.park_id) === rapidinPark);
    if (!match) {
      skippedParkMismatch++;
      const driversParks = drivers.map((d) => d.park_id || '(vacío)').join(', ');
      parkMismatchList.push({
        dni: r.dni,
        nombre: `${(r.first_name || '').trim()} ${(r.last_name || '').trim()}`.trim(),
        country: r.country,
        rapidin_park_id: rapidinPark || '(vacío)',
        drivers_park_ids: driversParks,
        license_number: drivers[0].license_number,
      });
      logger.info(
        `[${r.dni}] Match por licencia en drivers (driver_id=${drivers[0].driver_id}, license=${drivers[0].license_number}) pero park_id no coincide: rapidin=${rapidinPark || '(vacío)'} vs drivers=${driversParks} → no se actualiza.`
      );
      continue;
    }

    // Jalar driver_id de la tabla drivers y copiarlo en external_driver_id (module_rapidin_drivers)
    const driverIdFromDrivers = match.driver_id != null ? String(match.driver_id) : null;
    if (!driverIdFromDrivers) continue;

    if (r.external_driver_id === driverIdFromDrivers) {
      logger.info(`[${r.dni}] Ya tiene external_driver_id=${driverIdFromDrivers} (park_id coincide). Sin cambios.`);
      continue;
    }

    if (!DRY_RUN) {
      await query(
        `UPDATE module_rapidin_drivers SET external_driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [driverIdFromDrivers, r.id]
      );
    }
    updated++;
    logger.info(
      `[${DRY_RUN ? 'DRY-RUN ' : ''}OK] ${r.first_name} ${r.last_name} (dni=${r.dni}) park_id=${rapidinPark || '(vacío)'} → external_driver_id=${driverIdFromDrivers} (copiado de drivers.driver_id; license_number: ${match.license_number})`
    );
  }

  logger.info('--- Resumen ---');
  logger.info(`Actualizados: ${updated} | Sin match en drivers: ${skippedNoMatch} | park_id distinto (no actualizado): ${skippedParkMismatch}`);
  if (parkMismatchList.length > 0) {
    logger.info('--- Listado: park_id distinto (no actualizado) ---');
    parkMismatchList.forEach((item, i) => {
      logger.info(
        `${i + 1}. DNI=${item.dni} | ${item.nombre} | ${item.country} | rapidin park_id=${item.rapidin_park_id} | drivers park_id(s)=${item.drivers_park_ids} | license=${item.license_number}`
      );
    });
  }
  if (DRY_RUN && updated > 0) logger.info('Ejecuta sin --dry-run para aplicar los cambios.');
  logger.info('Listo.');
  process.exit(0);
}

run().catch((err) => {
  logger.error(err);
  process.exit(1);
});
