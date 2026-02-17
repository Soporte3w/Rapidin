/**
 * Para cada conductor en module_rapidin_drivers con external_driver_id IS NULL, busca en la
 * tabla drivers y copia driver_id → external_driver_id.
 *
 * Orden de búsqueda: 1) Licencia (license_number ≈ dni), 2) Teléfono, 3) Nombre. No se usa DNI ni document_number.
 *
 * Uso (desde backend/):
 *   node excel/sync-rapidin-drivers-external-id.js
 *   node excel/sync-rapidin-drivers-external-id.js --dry-run   # solo muestra qué se actualizaría
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NO_ENCONTRADOS_PATH = path.join(__dirname, 'no-encontrados-sync-external-id.csv');
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { query } = await import('../config/database.js');
const { logger } = await import('../utils/logger.js');

const DRY_RUN = process.argv.includes('--dry-run');

function normalizePhoneDigits(phone) {
  return (phone || '').toString().replace(/\D/g, '');
}

async function findInDriversByPhone(phone, country) {
  const digitsOnly = normalizePhoneDigits(phone);
  if (!digitsOnly || digitsOnly.length < 8) return null;
  const c = (country || '').toUpperCase();
  // Variantes solo dígitos para comparar con REGEXP_REPLACE(phone) en drivers
  let digitVariants = [digitsOnly];
  // Variantes con prefijo +51 / +57 y sin + para match por string (ej. "+51 987654321", "+573001234567")
  let stringVariants = [];
  if (c === 'PE') {
    const nine = digitsOnly.length >= 9 ? digitsOnly.slice(-9) : digitsOnly;
    digitVariants = [digitsOnly, '51' + nine, nine];
    stringVariants = ['+51' + nine, '51' + nine, nine, '+51 ' + nine, '51 ' + nine];
  } else if (c === 'CO') {
    const ten = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;
    digitVariants = [digitsOnly, '57' + ten, ten];
    stringVariants = ['+57' + ten, '57' + ten, ten, '+57 ' + ten, '57 ' + ten];
  }
  digitVariants = [...new Set(digitVariants)].filter(Boolean);
  stringVariants = [...new Set(stringVariants)].filter(Boolean);
  const r = await query(
    `SELECT driver_id, park_id FROM drivers
     WHERE REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = ANY($1::text[])
        OR TRIM(COALESCE(phone,'')) = ANY($2::text[])
     LIMIT 1`,
    [digitVariants, stringVariants]
  );
  return r.rows[0] || null;
}

/** Normaliza a solo dígitos para comparar cadenas tipo licencia vs DNI. */
function digitsOnly(str) {
  return (str || '').toString().replace(/\D/g, '');
}

/**
 * Busca en drivers por license_number: coincidencia exacta o similitud con dni (rapidin).
 * - Igualdad exacta (trim)
 * - Solo dígitos iguales (ej. licencia "12345678" y dni "12345678")
 * - Uno contiene al otro (solo si la longitud del más corto >= 6 para evitar falsos positivos)
 */
async function findInDriversByLicenseNumber(dni) {
  const trimmed = (dni || '').toString().trim();
  if (!trimmed || trimmed.length < 4) return null;
  const digits = digitsOnly(trimmed);
  const r = await query(
    `SELECT driver_id, park_id FROM drivers
     WHERE TRIM(COALESCE(license_number, '')) != ''
       AND (
         TRIM(COALESCE(license_number, '')) = $1
         OR REGEXP_REPLACE(COALESCE(license_number, ''), '[^0-9]', '', 'g') = $2
         OR (LENGTH(TRIM(license_number)) >= 6 AND (TRIM(license_number) LIKE '%' || $1 || '%' OR $1 LIKE '%' || TRIM(license_number) || '%'))
         OR (LENGTH($2) >= 6 AND REGEXP_REPLACE(COALESCE(license_number, ''), '[^0-9]', '', 'g') LIKE '%' || $2 || '%')
       )
     LIMIT 1`,
    [trimmed, digits]
  );
  return r.rows[0] || null;
}

async function findInDriversByName(firstName, lastName) {
  const first = (firstName || '').toString().trim();
  const last = (lastName || '').toString().trim();
  if (!first && !last) return null;
  const r = await query(
    `SELECT driver_id, park_id FROM drivers
     WHERE LOWER(TRIM(COALESCE(first_name, ''))) = LOWER($1)
       AND LOWER(TRIM(COALESCE(last_name, ''))) = LOWER($2)
     LIMIT 1`,
    [first || '', last || '']
  );
  return r.rows[0] || null;
}

async function run() {
  logger.info('Sincronizando external_driver_id: module_rapidin_drivers → drivers (license_number, teléfono, nombre)...');
  if (DRY_RUN) logger.info('Modo --dry-run: no se modificará la base de datos.');

  const rapidin = await query(`
    SELECT id, first_name, last_name, dni, phone, country, external_driver_id, park_id
    FROM module_rapidin_drivers
    WHERE external_driver_id IS NULL
    ORDER BY country, dni
  `);

  const rows = rapidin.rows || [];
  logger.info(`Conductores sin external_driver_id: ${rows.length}`);

  let byLicense = 0, byPhone = 0, byName = 0, notFound = 0;
  const noEncontrados = [];

  for (const d of rows) {
    let match = null;
    let via = '';

    if (d.dni) {
      match = await findInDriversByLicenseNumber(d.dni);
      if (match) {
        via = 'license_number';
        byLicense++;
      }
    }
    if (!match && d.phone) {
      match = await findInDriversByPhone(d.phone, d.country);
      if (match) {
        via = 'phone';
        byPhone++;
      }
    }
    if (!match && (d.first_name || d.last_name)) {
      match = await findInDriversByName(d.first_name, d.last_name);
      if (match) {
        via = 'name';
        byName++;
      }
    }

    if (!match) {
      notFound++;
      noEncontrados.push({ dni: d.dni, nombre: `${(d.first_name || '').trim()} ${(d.last_name || '').trim()}`.trim(), phone: d.phone || '' });
      logger.info(`[NO ENCONTRADO] ${d.first_name} ${d.last_name} | dni=${d.dni} | phone=${d.phone || '(vacío)'} | ${d.country}`);
      continue;
    }

    // Copiar drivers.driver_id → module_rapidin_drivers.external_driver_id (solo esta columna para no violar unique phone+country+park_id)
    const externalDriverId = match.driver_id != null ? String(match.driver_id) : null;

    if (!DRY_RUN && externalDriverId) {
      await query(`
        UPDATE module_rapidin_drivers
        SET external_driver_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [externalDriverId, d.id]);
    }
    logger.info(`[${DRY_RUN ? 'DRY-RUN ' : ''}OK] ${d.first_name} ${d.last_name} (${d.dni}) → external_driver_id=${externalDriverId} (por ${via})`);
  }

  logger.info('--- Resumen ---');
  logger.info(`Por license_number: ${byLicense} | Por teléfono: ${byPhone} | Por nombre: ${byName} | No encontrados: ${notFound}`);
  if (noEncontrados.length > 0) {
    const header = 'dni;nombre;phone\n';
    const lines = noEncontrados.map((r) => {
      const nom = (r.nombre || '').replace(/;/g, ',');
      const ph = (r.phone || '').replace(/;/g, ',');
      return `${r.dni || ''};${nom};${ph}`;
    });
    const content = header + lines.join('\n');
    fs.writeFileSync(NO_ENCONTRADOS_PATH, content, 'utf8');
    logger.info(`Lista de no encontrados guardada en: ${NO_ENCONTRADOS_PATH}`);
  }
  if (DRY_RUN && (byLicense + byPhone + byName) > 0) {
    logger.info('Ejecuta sin --dry-run para aplicar los cambios.');
  }
  logger.info('Listo.');
  process.exit(0);
}

run().catch((err) => {
  logger.error(err);
  process.exit(1);
});
