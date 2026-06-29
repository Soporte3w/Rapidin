/**
 * Backup (solo lectura) de Yego Mi Auto:
 *   - Préstamos de alquiler/venta  -> module_miauto_solicitud
 *   - Cuotas de cada conductor     -> module_miauto_cuota_semanal
 *
 * Solo ejecuta SELECT, NO modifica la base de datos.
 *
 * Uso:
 *   cd backend && node scripts/miauto-backup-prestamos-cuotas.js
 *
 * Salida:
 *   backend/backups/miauto-prestamos-cuotas-<timestamp>.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import dotenv from 'dotenv';

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

function stampLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function buildPool() {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    return new Pool({ connectionString: url, connectionTimeoutMillis: 30000 });
  }
  const host = process.env.DB_HOST;
  const name = process.env.DB_NAME;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  if (!host || !name || !user || password == null || password === '') {
    console.error('Configuración DB incompleta: defina DATABASE_URL o DB_HOST, DB_NAME, DB_USER y DB_PASSWORD en backend/.env');
    process.exit(1);
  }
  return new Pool({
    host,
    port: Number(process.env.DB_PORT || 5432),
    database: name,
    user,
    password,
    connectionTimeoutMillis: 30000,
  });
}

async function main() {
  const pool = buildPool();
  try {
    const solicitudesRes = await pool.query(
      'SELECT * FROM module_miauto_solicitud ORDER BY created_at ASC'
    );
    const cuotasRes = await pool.query(
      'SELECT * FROM module_miauto_cuota_semanal ORDER BY solicitud_id ASC, week_start_date ASC'
    );
    const driversRes = await pool.query(
      'SELECT id, first_name, last_name, dni FROM module_rapidin_drivers'
    );

    const driverNameById = new Map();
    for (const d of driversRes.rows) {
      const nombre = [d.first_name, d.last_name].filter(Boolean).join(' ').trim();
      driverNameById.set(String(d.id), nombre || null);
    }

    const solicitudes = solicitudesRes.rows.map((s) => ({
      ...s,
      _conductor_nombre: s.driver_id_fleet ? driverNameById.get(String(s.driver_id_fleet)) ?? null : null,
    }));

    const cuotas = cuotasRes.rows;

    const payload = {
      _meta: {
        sistema: 'yego_mi_auto',
        descripcion: 'Préstamos alquiler/venta (module_miauto_solicitud) + cuotas por conductor (module_miauto_cuota_semanal). Solo lectura, sin afectar la BD.',
        generado_en: new Date().toISOString(),
        total_solicitudes: solicitudes.length,
        total_cuotas: cuotas.length,
        tablas: ['module_miauto_solicitud', 'module_miauto_cuota_semanal'],
      },
      solicitudes,
      cuotas,
    };

    const outDir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `miauto-prestamos-cuotas-${stampLocal()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');

    console.log('Backup generado correctamente (solo lectura, sin afectar la BD):');
    console.log(`  Préstamos (alquiler/venta): ${solicitudes.length}`);
    console.log(`  Cuotas:                     ${cuotas.length}`);
    console.log(`  Archivo:                    ${outFile}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error generando el backup:', err.message);
  process.exit(1);
});
