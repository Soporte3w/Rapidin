/**
 * Rellena phone en module_rapidin_drivers desde la tabla drivers (Yego).
 * 1) Por external_driver_id: busca en drivers por driver_id y toma phone.
 * 2) Por DNI: busca en drivers por license_number/document_number (coincidencia parcial,
 *    igual que con DNI: dígitos, con/sin ceros, LIKE parcial si >= 6 dígitos).
 *
 * Solo actualiza filas donde phone está vacío o NULL.
 * Uso (desde backend/):
 *   node scripts/fill-phone-from-drivers.js
 *   node scripts/fill-phone-from-drivers.js --dry-run
 *   node scripts/fill-phone-from-drivers.js --country PE
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizePhoneForDb } from '../utils/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

const { query } = await import('../config/database.js');

function digitsOnly(str) {
  return (str || '').toString().replace(/\D/g, '');
}

/** Código país en tabla drivers: PE → per, CO → col. */
function getLicenseCountryForDrivers(country) {
  return country === 'PE' ? 'per' : country === 'CO' ? 'col' : (country || '').toLowerCase().slice(0, 3);
}

/** Trunca a 20 caracteres (VARCHAR(20) en module_rapidin_drivers). */
function truncatePhone(val) {
  const s = (val || '').toString().trim();
  return s.length > 20 ? s.slice(0, 20) : s;
}

/**
 * Obtiene phone de drivers por external_driver_id (driver_id en drivers).
 * Comparación flexible: driver_id puede ser numérico o texto.
 */
async function getPhoneByExternalDriverId(externalDriverId, country) {
  if (!externalDriverId || !country) return null;
  const extTrim = String(externalDriverId).trim();
  const licenseCountry = getLicenseCountryForDrivers(country);
  const r = await query(
    `SELECT phone FROM drivers
     WHERE license_country = $1
       AND (driver_id::text = $2 OR TRIM(driver_id::text) = $2)
       AND COALESCE(TRIM(phone), '') <> ''
     LIMIT 1`,
    [licenseCountry, extTrim]
  );
  const row = r.rows && r.rows[0];
  return row && row.phone ? String(row.phone).trim() : null;
}

/**
 * Obtiene phone de drivers por DNI: búsqueda en license_number y document_number
 * con coincidencia exacta, solo dígitos, o parcial (LIKE %dígitos%) si >= 6 dígitos.
 * Opcionalmente filtra por park_id.
 */
async function getPhoneByDni(dni, country, parkIdOptional = null) {
  const trimmed = (dni || '').toString().trim();
  if (!trimmed || trimmed.length < 4) return null;
  const digits = digitsOnly(trimmed);
  const licenseCountry = getLicenseCountryForDrivers(country);
  const parkNorm = (parkIdOptional || '').toString().trim();
  const r = await query(
    `SELECT phone FROM drivers
     WHERE license_country = $1
       AND (
         TRIM(COALESCE(license_number, '')) = $2
         OR REGEXP_REPLACE(COALESCE(license_number, ''), '[^0-9]', '', 'g') = $3
         OR TRIM(COALESCE(document_number, '')) = $2
         OR REGEXP_REPLACE(COALESCE(document_number, ''), '[^0-9]', '', 'g') = $3
         OR (LENGTH($3) >= 6 AND REGEXP_REPLACE(COALESCE(license_number, ''), '[^0-9]', '', 'g') LIKE '%' || $3 || '%')
         OR (LENGTH($3) >= 6 AND REGEXP_REPLACE(COALESCE(document_number, ''), '[^0-9]', '', 'g') LIKE '%' || $3 || '%')
       )
       AND ($4 = '' OR COALESCE(TRIM(park_id), '') = $4)
       AND COALESCE(TRIM(phone), '') <> ''
     ORDER BY park_id NULLS LAST
     LIMIT 1`,
    [licenseCountry, trimmed, digits, parkNorm]
  );
  const row = r.rows && r.rows[0];
  return row && row.phone ? String(row.phone).trim() : null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const countryArg = process.argv.find((a) => a.startsWith('--country='));
  const countryFilter = countryArg ? countryArg.split('=')[1] : null; // PE | CO

  const whereClause =
    countryFilter === 'PE' || countryFilter === 'CO'
      ? "WHERE (phone IS NULL OR TRIM(COALESCE(phone, '')) = '') AND country = $1"
      : "WHERE (phone IS NULL OR TRIM(COALESCE(phone, '')) = '')";
  const params = countryFilter ? [countryFilter] : [];

  const res = await query(
    `SELECT id, dni, country, park_id, external_driver_id, first_name, last_name
     FROM module_rapidin_drivers ${whereClause}
     ORDER BY country, dni`,
    params
  );
  const rows = res.rows || [];
  console.log(`Conductores sin phone a procesar: ${rows.length}`);

  let byExternal = 0;
  let byDni = 0;
  let notFound = 0;
  let skippedDuplicate = 0;

  for (const row of rows) {
    let phone = null;
    let source = null;

    if (row.external_driver_id) {
      phone = await getPhoneByExternalDriverId(row.external_driver_id, row.country);
      if (phone) {
        source = 'external_driver_id';
        byExternal++;
      }
    }
    if (!phone) {
      phone = await getPhoneByDni(row.dni, row.country, row.park_id || null);
      if (phone) {
        source = 'dni (license_number/document_number)';
        byDni++;
      }
    }
    if (!phone) {
      notFound++;
      console.log(`  Sin phone: dni=${row.dni} country=${row.country} park_id=${row.park_id || ''} external_driver_id=${row.external_driver_id || ''}`);
      continue;
    }

    const normalized = truncatePhone(normalizePhoneForDb(phone, row.country));
    if (!dryRun && normalized) {
      try {
        await query(
          'UPDATE module_rapidin_drivers SET phone = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [normalized, row.id]
        );
      } catch (err) {
        if (err.code === '23505' && err.message && err.message.includes('idx_rapidin_drivers_phone_country_park')) {
          skippedDuplicate++;
          console.log(`  ${row.dni} (${row.country}) → ${normalized} [${source}] OMITIDO (ya existe otro con mismo phone+country+park)`);
          continue;
        }
        throw err;
      }
    }
    console.log(`  ${row.dni} (${row.country}) → ${normalized} [${source}]${dryRun ? ' (dry-run)' : ''}`);
  }

  console.log('\nResumen:');
  console.log(`  Por external_driver_id: ${byExternal}`);
  console.log(`  Por DNI (license_number/document_number): ${byDni}`);
  console.log(`  Sin phone encontrado: ${notFound}`);
  if (skippedDuplicate > 0) console.log(`  Omitidos por duplicado (phone+country+park): ${skippedDuplicate}`);
  if (!dryRun && (byExternal + byDni - skippedDuplicate) > 0) {
    console.log(`  Actualizados: ${byExternal + byDni - skippedDuplicate}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
