/**
 * Corrige préstamos incoherentes: loan.driver_id debe ser igual a request.driver_id.
 * Actualiza module_rapidin_loans SET driver_id = (driver_id del request) donde no coinciden.
 *
 * Uso (desde backend/):
 *   node excel/fix-incoherent-loans-driver-id.js
 *   node excel/fix-incoherent-loans-driver-id.js --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { query } = await import('../config/database.js');

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  console.log('Buscando préstamos donde loan.driver_id != request.driver_id...');
  if (DRY_RUN) console.log('Modo --dry-run: no se modificará la base de datos.\n');

  const incoherent = await query(`
    SELECT l.id AS loan_id, l.request_id, l.driver_id AS loan_driver_id, l.disbursed_amount, l.status,
           r.driver_id AS request_driver_id
    FROM module_rapidin_loans l
    INNER JOIN module_rapidin_loan_requests r ON r.id = l.request_id
    WHERE l.country IN ('PE', 'CO')
      AND (l.driver_id IS DISTINCT FROM r.driver_id)
    ORDER BY l.disbursed_at DESC
  `);

  if (incoherent.rows.length === 0) {
    console.log('No hay préstamos incoherentes. Nada que corregir.');
    process.exit(0);
    return;
  }

  console.log(`Encontrados ${incoherent.rows.length} préstamo(s) incoherente(s):\n`);
  for (const row of incoherent.rows) {
    console.log(`  loan_id ${row.loan_id} | request_id ${row.request_id}`);
    console.log(`    loan.driver_id   = ${row.loan_driver_id}`);
    console.log(`    request.driver_id = ${row.request_driver_id} (correcto)`);
  }

  if (!DRY_RUN) {
    let updated = 0;
    for (const row of incoherent.rows) {
      await query(
        `UPDATE module_rapidin_loans SET driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [row.request_driver_id, row.loan_id]
      );
      updated++;
      console.log(`\nActualizado loan ${row.loan_id} → driver_id = ${row.request_driver_id}`);
    }
    console.log(`\nTotal actualizados: ${updated}.`);
  } else {
    console.log(`\n[DRY-RUN] Se actualizarían ${incoherent.rows.length} préstamo(s) con el driver_id de su request.`);
  }

  console.log('Listo.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
