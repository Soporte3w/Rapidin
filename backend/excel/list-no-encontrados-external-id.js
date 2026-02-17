/**
 * Lista conductores en module_rapidin_drivers con external_driver_id IS NULL.
 * Guarda CSV: dni;nombre;phone en backend/excel/no-encontrados-sync-external-id.csv
 *
 * Uso (desde backend/): node excel/list-no-encontrados-external-id.js
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { query } = await import('../config/database.js');

const OUT_PATH = path.join(__dirname, 'no-encontrados-sync-external-id.csv');

async function run() {
  const r = await query(`
    SELECT dni, first_name, last_name, phone
    FROM module_rapidin_drivers
    WHERE external_driver_id IS NULL
    ORDER BY country, dni
  `);
  const rows = r.rows || [];
  const header = 'dni;nombre;phone\n';
  const lines = rows.map((d) => {
    const nombre = `${(d.first_name || '').trim()} ${(d.last_name || '').trim()}`.trim().replace(/;/g, ',');
    const phone = (d.phone || '').replace(/;/g, ',');
    return `${d.dni || ''};${nombre};${phone}`;
  });
  const content = header + lines.join('\n');
  fs.writeFileSync(OUT_PATH, content, 'utf8');
  console.log(`Total sin external_driver_id: ${rows.length}`);
  console.log(`Guardado: ${OUT_PATH}`);
  console.log('\n--- Lista (dni; nombre; phone) ---');
  console.log(content);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
