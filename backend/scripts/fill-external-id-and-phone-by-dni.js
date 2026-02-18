/**
 * Para conductores en module_rapidin_drivers con phone y external_driver_id NULL:
 * busca en la tabla drivers por DNI con similitud (license_number/document_number:
 * exacto, solo dígitos, o LIKE %dígitos% si >= 6). Si hay match (y opcionalmente mismo park_id),
 * actualiza en rapidin: external_driver_id = drivers.driver_id y phone = drivers.phone.
 *
 * Uso (desde backend/):
 *   node scripts/fill-external-id-and-phone-by-dni.js
 *   node scripts/fill-external-id-and-phone-by-dni.js --dry-run
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

function getLicenseCountry(country) {
  return country === 'PE' ? 'per' : country === 'CO' ? 'col' : (country || '').toLowerCase().slice(0, 3);
}

function truncatePhone(val) {
  const s = (val || '').toString().trim();
  return s.length > 20 ? s.slice(0, 20) : s;
}

/**
 * Busca en drivers por DNI (similitud: license_number/document_number).
 * Devuelve { driver_id, phone } o null.
 * Si parkIdOptional está definido, primero busca con ese park_id; si no hay resultado, intenta sin filtrar por park (cualquier flota).
 */
async function findInDriversByDni(dni, country, parkIdOptional = null) {
  const trimmed = (dni || '').toString().trim();
  if (!trimmed || trimmed.length < 4) return null;
  const digits = digitsOnly(trimmed);
  if (digits.length < 4) return null;
  const licenseCountry = getLicenseCountry(country);
  const parkNorm = (parkIdOptional || '').toString().trim();

  let r = await query(
    `SELECT driver_id, phone, park_id FROM drivers
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
     ORDER BY COALESCE(TRIM(phone), '') <> '' DESC, park_id NULLS LAST
     LIMIT 1`,
    [licenseCountry, trimmed, digits, parkNorm]
  );
  if (!r.rows?.length && parkNorm !== '') {
    r = await query(
      `SELECT driver_id, phone, park_id FROM drivers
       WHERE license_country = $1
         AND (
           TRIM(COALESCE(license_number, '')) = $2
           OR REGEXP_REPLACE(COALESCE(license_number, ''), '[^0-9]', '', 'g') = $3
           OR TRIM(COALESCE(document_number, '')) = $2
           OR REGEXP_REPLACE(COALESCE(document_number, ''), '[^0-9]', '', 'g') = $3
           OR (LENGTH($3) >= 6 AND REGEXP_REPLACE(COALESCE(license_number, ''), '[^0-9]', '', 'g') LIKE '%' || $3 || '%')
           OR (LENGTH($3) >= 6 AND REGEXP_REPLACE(COALESCE(document_number, ''), '[^0-9]', '', 'g') LIKE '%' || $3 || '%')
         )
       ORDER BY COALESCE(TRIM(phone), '') <> '' DESC, park_id NULLS LAST
       LIMIT 1`,
      [licenseCountry, trimmed, digits]
    );
  }
  const row = r.rows && r.rows[0];
  if (!row || (row.driver_id == null && !(row.phone && String(row.phone).trim()))) return null;
  return {
    driver_id: row.driver_id != null ? String(row.driver_id).trim() : null,
    phone: row.phone && String(row.phone).trim() ? String(row.phone).trim() : null
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const res = await query(`
    SELECT id, dni, country, park_id, first_name, last_name
    FROM module_rapidin_drivers
    WHERE (phone IS NULL OR TRIM(COALESCE(phone, '')) = '')
      AND (external_driver_id IS NULL OR TRIM(COALESCE(external_driver_id, '')) = '')
    ORDER BY country, dni
  `);
  const rows = res.rows || [];
  console.log('Conductores con phone y external_driver_id NULL:', rows.length);

  let updated = 0;
  let notFound = 0;
  let skipped = 0;

  for (const row of rows) {
    const match = await findInDriversByDni(row.dni, row.country, row.park_id || null);
    if (!match || (!match.driver_id && !match.phone)) {
      notFound++;
      console.log('  No match:', row.dni, row.country, row.park_id || '', '|', row.first_name, row.last_name);
      continue;
    }
    const extId = match.driver_id || null;
    const phoneNorm = match.phone ? truncatePhone(normalizePhoneForDb(match.phone, row.country)) : null;
    if (!dryRun) {
      try {
        if (extId && phoneNorm) {
          await query(
            `UPDATE module_rapidin_drivers SET external_driver_id = $1, phone = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
            [extId, phoneNorm, row.id]
          );
        } else if (extId) {
          await query(
            `UPDATE module_rapidin_drivers SET external_driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [extId, row.id]
          );
        } else if (phoneNorm) {
          await query(
            `UPDATE module_rapidin_drivers SET phone = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [phoneNorm, row.id]
          );
        } else {
          continue;
        }
        updated++;
      } catch (e) {
        if (e.code === '23505' && e.message && e.message.includes('idx_rapidin_drivers_phone_country_park')) {
          skipped++;
          console.log('  Omitido (duplicado phone+country+park):', row.dni, row.country, '->', phoneNorm);
          continue;
        }
        throw e;
      }
    } else {
      updated++;
    }
    console.log('  OK:', row.dni, row.country, '-> external_driver_id:', extId || '—', '| phone:', phoneNorm || '—', dryRun ? '(dry-run)' : '');
  }

  console.log('\nResumen:');
  console.log('  Actualizados:', updated);
  console.log('  No encontrados en drivers (por DNI/park):', notFound);
  if (skipped > 0) console.log('  Omitidos por duplicado (phone+country+park):', skipped);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
