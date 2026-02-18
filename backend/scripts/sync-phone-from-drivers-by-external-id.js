/**
 * Copia phone desde la tabla drivers a module_rapidin_drivers por external_driver_id.
 * Para cada fila en rapidin_drivers con external_driver_id, busca drivers.driver_id = external_driver_id
 * y actualiza rapidin_drivers.phone con drivers.phone (normalizado).
 * Si (phone, country, park_id) ya existe en otra fila, se omite ese update.
 *
 * Uso (desde backend/):
 *   node scripts/sync-phone-from-drivers-by-external-id.js
 *   node scripts/sync-phone-from-drivers-by-external-id.js --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizePhoneForDb } from '../utils/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

const { query } = await import('../config/database.js');

function truncatePhone(val) {
  const s = (val || '').toString().trim();
  return s.length > 20 ? s.slice(0, 20) : s;
}

function getLicenseCountry(country) {
  return country === 'PE' ? 'per' : country === 'CO' ? 'col' : (country || '').toLowerCase().slice(0, 3);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const r = await query(`
    SELECT id, dni, country, park_id, external_driver_id
    FROM module_rapidin_drivers
    WHERE external_driver_id IS NOT NULL AND TRIM(COALESCE(external_driver_id, '')) <> ''
    ORDER BY country, dni
  `);
  const rows = r.rows || [];
  console.log('Conductores con external_driver_id:', rows.length);

  let updated = 0;
  let skipped = 0;
  let noPhone = 0;

  for (const row of rows) {
    const lic = getLicenseCountry(row.country);
    const ext = String(row.external_driver_id).trim();
    const ph = await query(
      `SELECT phone FROM drivers
       WHERE license_country = $1 AND (driver_id::text = $2 OR TRIM(driver_id::text) = $2)
         AND COALESCE(TRIM(phone), '') <> ''
       LIMIT 1`,
      [lic, ext]
    );
    const phone = ph.rows?.[0]?.phone ? String(ph.rows[0].phone).trim() : null;
    if (!phone) {
      noPhone++;
      continue;
    }
    const normalized = truncatePhone(normalizePhoneForDb(phone, row.country));
    if (!dryRun) {
      try {
        await query(
          'UPDATE module_rapidin_drivers SET phone = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [normalized, row.id]
        );
        updated++;
      } catch (e) {
        if (e.code === '23505' && e.message?.includes('idx_rapidin_drivers_phone_country_park')) {
          skipped++;
        } else throw e;
      }
    } else {
      updated++;
    }
  }

  console.log('\nResumen:');
  console.log('  Actualizados:', updated);
  console.log('  Omitidos por duplicado (phone+country+park):', skipped);
  console.log('  Sin phone en drivers:', noPhone);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
