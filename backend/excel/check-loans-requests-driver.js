/**
 * Diagnóstico: verifica que cada loan tenga request_id y driver_id coherentes (el request debe ser del mismo driver que el loan).
 * Uso: node excel/check-loans-requests-driver.js
 *      node excel/check-loans-requests-driver.js bb95fb13-7afe-48da-8c6e-69ee2c8c9059 b00694e9-c7a4-4dc3-a619-87081d17e6d3
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

const { query } = await import('../config/database.js');

const DRIVER_IDS = process.argv.slice(2).filter((a) => a && a.length > 0);

async function run() {
  console.log('=== 1. Conductores (rapidin_drivers) por ID ===\n');
  const ids = DRIVER_IDS.length > 0 ? DRIVER_IDS : null;
  if (ids && ids.length > 0) {
    for (const did of ids) {
      const r = await query(
        `SELECT id, dni, country, park_id, first_name, last_name FROM module_rapidin_drivers WHERE id = $1`,
        [did]
      );
      if (r.rows.length > 0) {
        console.log('Driver', did, '→', r.rows[0]);
      } else {
        console.log('Driver', did, '→ NO ENCONTRADO');
      }
    }
  } else {
    const all = await query(
      `SELECT id, dni, country, park_id FROM module_rapidin_drivers WHERE country = 'PE' ORDER BY dni, park_id`
    );
    console.log('Todos (PE):', all.rows.length);
    all.rows.forEach((row) => console.log(' ', row.id, '| dni', row.dni, '| park_id', row.park_id));
  }

  console.log('\n=== 2. Solicitudes (loan_requests) por driver_id ===\n');
  const driverList = ids && ids.length > 0 ? ids : (await query(`SELECT id FROM module_rapidin_drivers WHERE country = 'PE'`)).rows.map((r) => r.id);
  for (const did of driverList.slice(0, 10)) {
    const req = await query(
      `SELECT id, driver_id, status, requested_amount, created_at FROM module_rapidin_loan_requests WHERE driver_id = $1 ORDER BY created_at`,
      [did]
    );
    if (req.rows.length > 0) {
      const dr = await query(`SELECT park_id FROM module_rapidin_drivers WHERE id = $1`, [did]);
      const park = dr.rows[0]?.park_id || '—';
      console.log(`Driver ${did} (park ${park}): ${req.rows.length} request(s)`);
      req.rows.forEach((r) => console.log('   ', r.id, '|', r.status, '|', r.requested_amount, '|', r.created_at));
    }
  }
  if (driverList.length > 10 && !ids?.length) console.log('... (solo primeros 10)');

  console.log('\n=== 3. Préstamos (loans): ¿request.driver_id = loan.driver_id? ===\n');
  const loans = await query(`
    SELECT l.id AS loan_id, l.request_id, l.driver_id AS loan_driver_id, l.disbursed_amount, l.status AS loan_status,
           r.driver_id AS request_driver_id
    FROM module_rapidin_loans l
    LEFT JOIN module_rapidin_loan_requests r ON r.id = l.request_id
    WHERE l.country = 'PE'
    ORDER BY l.disbursed_at DESC
  `);
  let incoherent = 0;
  for (const row of loans.rows) {
    const ok = row.request_driver_id && row.loan_driver_id && row.request_driver_id === row.loan_driver_id;
    if (!ok && row.request_id) {
      incoherent++;
      console.log('INCOHERENTE:', {
        loan_id: row.loan_id,
        request_id: row.request_id,
        loan_driver_id: row.loan_driver_id,
        request_driver_id: row.request_driver_id,
        disbursed_amount: row.disbursed_amount
      });
    }
  }
  if (incoherent === 0 && loans.rows.length > 0) {
    console.log('Todos los préstamos tienen request_id y driver_id coherentes.');
  } else if (incoherent > 0) {
    console.log('\nTotal incoherentes:', incoherent);
  }

  console.log('\n=== 4. Cuotas (installments): loan → driver ===\n');
  const instCheck = await query(`
    SELECT i.loan_id, l.driver_id
    FROM module_rapidin_installments i
    JOIN module_rapidin_loans l ON l.id = i.loan_id
    WHERE l.country = 'PE'
    LIMIT 5
  `);
  console.log('Ejemplo: loan_id → driver_id de su loan');
  instCheck.rows.forEach((r) => console.log(' ', r.loan_id, '→', r.driver_id));
  console.log('(Si el loan tiene driver_id correcto, las cuotas heredan por loan_id.)');
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
