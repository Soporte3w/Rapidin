/**
 * Script de utilidad: pone la fecha de vencimiento de la PRIMERA cuota
 * del préstamo activo en HOY, para poder probar el cobro automático.
 *
 * Uso: desde backend/
 *   node scripts/set-first-installment-due-today.js
 *
 * Alternativa manual en PostgreSQL:
 *   UPDATE module_rapidin_installments i
 *   SET due_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
 *   FROM module_rapidin_loans l
 *   WHERE l.id = i.loan_id AND l.status = 'active' AND i.installment_number = 1;
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

async function main() {
  const { query } = await import('../config/database.js');
  // Primera cuota (installment_number = 1) de préstamos activos → due_date = hoy
  const r = await query(
    `UPDATE module_rapidin_installments i
     SET due_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
     FROM module_rapidin_loans l
     WHERE l.id = i.loan_id
       AND l.status = 'active'
       AND i.installment_number = 1
     RETURNING i.id AS installment_id, i.loan_id, i.due_date, i.installment_number`
  );

  if (r.rows.length === 0) {
    console.log('No se encontró ninguna primera cuota de préstamo activo para actualizar.');
    process.exit(0);
    return;
  }

  console.log('Actualizado: primera cuota con vencimiento hoy para', r.rows.length, 'préstamo(s).');
  r.rows.forEach((row) => {
    console.log('  loan_id:', row.loan_id, 'installment_id:', row.installment_id, 'due_date:', row.due_date);
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
