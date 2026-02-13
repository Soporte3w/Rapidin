/**
 * Pone la fecha de vencimiento de la PRIMERA cuota en 12 de febrero
 * para los dos préstamos más recientes (activos), y ajusta el resto del cronograma
 * en forma semanal a partir de esa fecha.
 *
 * Uso (desde backend/):
 *   node scripts/set-first-due-feb12.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const FIRST_DUE_DATE = '2026-02-12'; // 12 de febrero

async function main() {
  const { query } = await import('../config/database.js');

  // Obtener los 2 préstamos activos más recientes
  const loansResult = await query(
    `SELECT id, number_of_installments, first_payment_date
     FROM module_rapidin_loans
     WHERE status = 'active'
     ORDER BY created_at DESC
     LIMIT 2`
  );

  if (loansResult.rows.length === 0) {
    console.log('No se encontraron préstamos activos.');
    process.exit(0);
    return;
  }

  console.log('Préstamos a actualizar (2 más recientes):', loansResult.rows.length);

  for (const loan of loansResult.rows) {
    await query(
      `UPDATE module_rapidin_loans
       SET first_payment_date = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [FIRST_DUE_DATE, loan.id]
    );
    console.log('  Loan', loan.id, '- first_payment_date =', FIRST_DUE_DATE);

    // Actualizar todas las cuotas: primera = 12 feb, las demás +7 días por cada número de cuota
    const upd = await query(
      `UPDATE module_rapidin_installments i
       SET due_date = ($1::date + (i.installment_number - 1) * 7)::date,
           updated_at = CURRENT_TIMESTAMP
       WHERE i.loan_id = $2
       RETURNING i.installment_number, i.due_date`,
      [FIRST_DUE_DATE, loan.id]
    );
    upd.rows.forEach((r) => {
      console.log('    Cuota', r.installment_number, '→ vence', r.due_date);
    });
  }

  console.log('Listo. Primera cuota vence el 12 de febrero para los dos préstamos.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
