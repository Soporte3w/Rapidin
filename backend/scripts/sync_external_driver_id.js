import { query } from '../config/database.js';
import fs from 'fs';
import path from 'path';

const REPORT_PATH = path.join(process.cwd(), 'scripts', 'sync_external_driver_id_report.txt');

async function syncExternalDriverIds() {
  const lines = [];
  const log = (msg) => {
    console.log(msg);
    lines.push(msg);
  };

  log('=== Sincronización external_driver_id (module_rapidin_drivers → drivers por PHONE +51/+57) ===');
  log(`Fecha: ${new Date().toISOString()}\n`);

  // Normalizar teléfono para búsqueda: PE → +51 (9 dígitos que empiezan en 9), CO → +57
  function normalizePhoneForSearch(phone, country) {
    const digits = (phone || '').toString().replace(/\D/g, '');
    if (!digits.length) return null;
    const c = (country || '').toUpperCase();
    if (c === 'PE') {
      if (digits.length === 11 && digits.startsWith('51')) return '+51' + digits.slice(2);
      if (digits.length === 9 && digits[0] === '9') return '+51' + digits;
      return '+51' + digits;
    }
    if (c === 'CO') {
      if (digits.length === 12 && digits.startsWith('57')) return '+57' + digits.slice(2);
      return '+57' + digits;
    }
    return null;
  }

  try {
    const rapidinDrivers = await query(`
      SELECT id, first_name, last_name, dni, phone, country, external_driver_id, park_id
      FROM module_rapidin_drivers
      ORDER BY phone, country
    `);

    log(`Total conductores en module_rapidin_drivers: ${rapidinDrivers.rows.length}\n`);

    let updated = 0;
    let skippedNoMatch = 0;
    let skippedMultiple = 0;
    let skippedAlreadySet = 0;
    const multipleMatches = [];
    const noMatch = [];

    for (const d of rapidinDrivers.rows) {
      const phone = (d.phone || '').toString().trim();
      const searchPhone = normalizePhoneForSearch(phone, d.country);

      if (!searchPhone) {
        log(`[SKIP] id=${d.id} ${d.first_name} ${d.last_name} - phone vacío o no normalizable`);
        noMatch.push({ id: d.id, name: `${d.first_name} ${d.last_name}`, phone: phone || '(vacío)', country: d.country, reason: 'phone vacío o no normalizable' });
        skippedNoMatch++;
        continue;
      }

      if (d.external_driver_id) {
        skippedAlreadySet++;
        continue;
      }

      // Buscar en drivers por phone normalizado (+51 o +57); probar con y sin +
      const driversByPhone = await query(`
        SELECT driver_id, park_id FROM drivers WHERE phone = $1 OR phone = $2
      `, [searchPhone, searchPhone.replace(/^\+/, '')]);

      if (driversByPhone.rows.length === 0) {
        skippedNoMatch++;
        noMatch.push({
          id: d.id,
          name: `${d.first_name} ${d.last_name}`,
          phone: searchPhone,
          country: d.country
        });
        log(`[SIN COINCIDENCIA] id=${d.id} ${d.first_name} ${d.last_name} phone=${searchPhone} (${d.country})`);
        continue;
      }

      if (driversByPhone.rows.length > 1) {
        skippedMultiple++;
        const driverIds = driversByPhone.rows.map(r => r.driver_id).join(', ');
        multipleMatches.push({
          id: d.id,
          name: `${d.first_name} ${d.last_name}`,
          phone: searchPhone,
          country: d.country,
          driver_ids: driverIds,
          count: driversByPhone.rows.length
        });
        log(`[MÚLTIPLES COINCIDENCIAS - NO TOCADO] id=${d.id} ${d.first_name} ${d.last_name} phone=${searchPhone} → drivers: ${driverIds} (${driversByPhone.rows.length} registros)`);
        continue;
      }

      const extId = driversByPhone.rows[0].driver_id;
      const parkId = driversByPhone.rows[0].park_id || null;

      await query(`
        UPDATE module_rapidin_drivers
        SET external_driver_id = $1, park_id = COALESCE($2, park_id), updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `, [extId, parkId, d.id]);

      updated++;
      log(`[ACTUALIZADO] id=${d.id} ${d.first_name} ${d.last_name} phone=${searchPhone} → external_driver_id=${extId}`);
    }

    // Resumen
    log('\n--- RESUMEN ---');
    log(`Actualizados: ${updated}`);
    log(`Ya tenían external_driver_id (omitidos): ${skippedAlreadySet}`);
    log(`Sin coincidencia en drivers: ${skippedNoMatch}`);
    log(`Múltiples coincidencias (no tocados): ${skippedMultiple}`);

    log('\n--- DETALLE: MÚLTIPLES COINCIDENCIAS (no tocados) ---');
    if (multipleMatches.length === 0) {
      log('(ninguno)');
    } else {
      multipleMatches.forEach(m => {
        log(`  rapidin id=${m.id} | ${m.name} | phone=${m.phone} | country=${m.country} | drivers.driver_id: ${m.driver_ids} (${m.count} registros)`);
      });
    }

    log('\n--- DETALLE: SIN COINCIDENCIA EN drivers ---');
    if (noMatch.length === 0) {
      log('(ninguno)');
    } else {
      noMatch.forEach(m => {
        log(`  rapidin id=${m.id} | ${m.name} | phone=${m.phone || '(vacío)'} | ${m.country || ''} ${m.reason || ''}`);
      });
    }

    fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
    log(`\nReporte guardado en: ${REPORT_PATH}`);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    lines.push('\nError: ' + error.message);
    fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
    process.exit(1);
  }
}

syncExternalDriverIds();
