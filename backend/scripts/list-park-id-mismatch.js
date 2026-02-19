/**
 * Lista los conductores Rapidín que tienen match en drivers por license_number/DNI
 * pero park_id distinto (por eso no se actualiza external_driver_id).
 * No modifica nada.
 *
 * Uso: node scripts/list-park-id-mismatch.js
 */

import dotenv from 'dotenv';
dotenv.config();

import { query } from '../config/database.js';

function digitsOnly(str) {
  return (str || '').toString().replace(/\D/g, '');
}

function normParkId(parkId) {
  const s = (parkId != null && parkId !== '') ? String(parkId).trim() : '';
  return s;
}

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
  const rapidinRows = await query(`
    SELECT id, dni, country, first_name, last_name, park_id
    FROM module_rapidin_drivers
    ORDER BY country, dni
  `);
  const rows = rapidinRows.rows || [];
  const list = [];

  for (const r of rows) {
    const drivers = await findDriversByLicenseLikeDni(r.dni);
    if (drivers.length === 0) continue;
    const rapidinPark = normParkId(r.park_id);
    const match = drivers.find((d) => normParkId(d.park_id) === rapidinPark);
    if (match) continue;
    const driversParks = drivers.map((d) => d.park_id || '(vacío)').join(', ');
    list.push({
      dni: r.dni,
      nombre: `${(r.first_name || '').trim()} ${(r.last_name || '').trim()}`.trim(),
      country: r.country,
      rapidin_park_id: rapidinPark || '(vacío)',
      drivers_park_ids: driversParks,
      license_number: drivers[0].license_number,
    });
  }

  console.log('--- park_id distinto (no actualizado) ---');
  console.log(`Total: ${list.length}\n`);
  list.forEach((item, i) => {
    console.log(
      `${i + 1}. DNI=${item.dni} | ${item.nombre} | ${item.country} | rapidin park_id=${item.rapidin_park_id} | drivers park_id(s)=${item.drivers_park_ids} | license=${item.license_number}`
    );
  });
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
