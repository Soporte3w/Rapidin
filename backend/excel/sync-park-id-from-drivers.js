/**
 * Actualiza park_id en module_rapidin_drivers usando solo la API de flotas (partners).
 * Si park_id tiene el nombre de una flota, lo reemplaza por el id de esa flota.
 * No usa la tabla drivers.
 *
 * Uso (desde backend/):
 *   node excel/sync-park-id-from-drivers.js
 *   node excel/sync-park-id-from-drivers.js --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { query } = await import('../config/database.js');
const { fetchPartners } = await import('../services/partnersService.js');

const DRY_RUN = process.argv.includes('--dry-run');

function normalizeName(s) {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeId(s) {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/-/g, '');
}

async function run() {
  console.log('Sincronizando park_id: nombre → id (solo API de flotas)...');
  if (DRY_RUN) console.log('Modo --dry-run: no se modificará la base de datos.');

  const partners = await fetchPartners();
  if (!partners?.length) {
    console.error('No se obtuvieron flotas de la API.');
    process.exit(1);
  }
  console.log(`Flotas desde API: ${partners.length}`);

  // Mapa: nombre normalizado -> id del partner
  const nameToId = new Map();
  const idSet = new Set();
  for (const p of partners) {
    const id = p?.id != null ? String(p.id).trim() : '';
    const name = normalizeName(p?.name);
    if (id) idSet.add(normalizeId(id));
    if (name && id) nameToId.set(name, id);
  }

  const rapidin = await query(`
    SELECT id, park_id, first_name, last_name, phone, country
    FROM module_rapidin_drivers
    WHERE park_id IS NOT NULL AND TRIM(park_id) != ''
    ORDER BY country, phone
  `);

  const rows = rapidin.rows || [];
  console.log(`Filas con park_id no vacío: ${rows.length}`);

  let updated = 0;
  let skipped = 0;
  let noMatch = 0;
  let duplicateKey = 0;

  for (const d of rows) {
    const current = (d.park_id != null && String(d.park_id).trim() !== '') ? String(d.park_id).trim() : null;
    if (!current) continue;

    const currentNorm = normalizeName(current);
    const currentIdNorm = normalizeId(current);

    if (idSet.has(currentIdNorm)) {
      skipped++;
      continue;
    }

    const partnerId = nameToId.get(currentNorm);
    if (!partnerId) {
      noMatch++;
      continue;
    }

    const parkNorm = (partnerId || '').toString().trim();
    const existing = await query(
      `SELECT 1 FROM module_rapidin_drivers WHERE country = $1 AND phone = $2 AND COALESCE(park_id, '') = $3 AND id != $4 LIMIT 1`,
      [d.country, d.phone, parkNorm, d.id]
    );
    if (existing.rows?.length > 0) {
      duplicateKey++;
      continue;
    }

    if (!DRY_RUN) {
      await query(
        `UPDATE module_rapidin_drivers SET park_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [partnerId, d.id]
      );
    }
    updated++;
    console.log(`[${DRY_RUN ? 'DRY-RUN ' : ''}OK] ${d.first_name} ${d.last_name} | "${current}" → id=${partnerId}`);
  }

  console.log('--- Resumen ---');
  console.log(`Actualizados (nombre→id): ${updated} | Ya era id (omitidos): ${skipped} | Sin coincidencia: ${noMatch} | Duplicado phone+country+park (omitidos): ${duplicateKey}`);
  if (DRY_RUN && updated > 0) console.log('Ejecuta sin --dry-run para aplicar los cambios.');
  console.log('Listo.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
