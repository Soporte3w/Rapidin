/**
 * Elimina los 2 préstamos activos más recientes (los mismos que modificó
 * set-first-due-feb12.js) para poder volver a probar desembolsos y cronograma.
 *
 * Uso (desde backend/):
 *   node scripts/delete-test-loans.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

async function main() {
  const { query } = await import('../config/database.js');

  // Todos los préstamos (créditos)
  const loansResult = await query(
    `SELECT id, disbursed_amount, number_of_installments, status, created_at
     FROM module_rapidin_loans
     ORDER BY created_at DESC`
  );

  if (loansResult.rows.length === 0) {
    console.log('No hay préstamos para eliminar.');
    process.exit(0);
    return;
  }

  const loanIds = loansResult.rows.map((r) => r.id);
  console.log('Préstamos a eliminar:', loanIds.length);
  loansResult.rows.forEach((r) => {
    console.log('  -', r.id, '| monto', r.disbursed_amount, '| cuotas', r.number_of_installments, '|', r.status);
  });

  for (const loanId of loanIds) {
    // Obtener IDs de cuotas de este préstamo
    const inst = await query(
      'SELECT id FROM module_rapidin_installments WHERE loan_id = $1',
      [loanId]
    );
    const installmentIds = inst.rows.map((r) => r.id);

    if (installmentIds.length > 0) {
      // Quitar referencias a cuotas
      await query(
        'DELETE FROM module_rapidin_payment_installments WHERE installment_id = ANY($1)',
        [installmentIds]
      );
      await query(
        'DELETE FROM module_rapidin_voucher_installments WHERE installment_id = ANY($1)',
        [installmentIds]
      );
    }

    // Quitar referencias al préstamo
    await query('DELETE FROM module_rapidin_documents WHERE loan_id = $1', [loanId]);
    await query('DELETE FROM module_rapidin_payment_vouchers WHERE loan_id = $1', [loanId]);
    await query('DELETE FROM module_rapidin_payments WHERE loan_id = $1', [loanId]);
    await query('DELETE FROM module_rapidin_auto_payment_log WHERE loan_id = $1', [loanId]);

    // Borrar préstamo (CASCADE borra las cuotas)
    await query('DELETE FROM module_rapidin_loans WHERE id = $1', [loanId]);
    console.log('  Eliminado loan', loanId);
  }

  console.log('Listo. Todos los créditos/préstamos eliminados.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
