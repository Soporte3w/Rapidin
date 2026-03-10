/**
 * Elimina un préstamo y todo lo relacionado (pagos, cuotas, vouchers, logs, notificaciones, documentos).
 * Uso: node scripts/delete-loan-and-related.js <loan_id>
 */

import { query } from '../config/database.js';

const loanId = process.argv[2];
if (!loanId) {
  console.error('Uso: node delete-loan-and-related.js <loan_id>');
  process.exit(1);
}

async function main() {
  const check = await query('SELECT id FROM module_rapidin_loans WHERE id = $1', [loanId]);
  if (check.rows.length === 0) {
    console.log('No existe un préstamo con ese ID.');
    process.exit(1);
  }

  console.log(`Eliminando préstamo ${loanId} y todo lo relacionado...\n`);

  // 1. Detalle de pagos (payment_installments) — por payments de este loan
  const r1 = await query(
    `DELETE FROM module_rapidin_payment_installments WHERE payment_id IN (SELECT id FROM module_rapidin_payments WHERE loan_id = $1)`,
    [loanId]
  );
  console.log(`  module_rapidin_payment_installments: ${r1.rowCount} filas`);

  // 2. Pagos del préstamo
  const r2 = await query('DELETE FROM module_rapidin_payments WHERE loan_id = $1', [loanId]);
  console.log(`  module_rapidin_payments: ${r2.rowCount} filas`);

  // 3. Log de cobros automáticos
  const r3 = await query('DELETE FROM module_rapidin_auto_payment_log WHERE loan_id = $1', [loanId]);
  console.log(`  module_rapidin_auto_payment_log: ${r3.rowCount} filas`);

  // 4. Voucher installments (vouchers de este loan; los vouchers referencian installments que se borran con el loan)
  const vouchers = await query('SELECT id FROM module_rapidin_payment_vouchers WHERE loan_id = $1', [loanId]);
  for (const v of vouchers.rows) {
    await query('DELETE FROM module_rapidin_voucher_installments WHERE voucher_id = $1', [v.id]);
  }
  console.log(`  module_rapidin_voucher_installments: ${vouchers.rows.length} voucher(s) limpiados`);

  // 5. Vouchers del préstamo
  const r5 = await query('DELETE FROM module_rapidin_payment_vouchers WHERE loan_id = $1', [loanId]);
  console.log(`  module_rapidin_payment_vouchers: ${r5.rowCount} filas`);

  // 6. Notificaciones
  const r6 = await query('DELETE FROM module_rapidin_notifications WHERE loan_id = $1', [loanId]);
  console.log(`  module_rapidin_notifications: ${r6.rowCount} filas`);

  // 7. Documentos (dejar sin loan o borrar)
  const r7 = await query('UPDATE module_rapidin_documents SET loan_id = NULL WHERE loan_id = $1', [loanId]);
  console.log(`  module_rapidin_documents: ${r7.rowCount} filas (loan_id = NULL)`);

  // 8. Préstamo (CASCADE borra installments)
  await query('DELETE FROM module_rapidin_loans WHERE id = $1', [loanId]);
  console.log(`  module_rapidin_loans: 1 fila (cuotas eliminadas por CASCADE)`);

  console.log('\nPréstamo y datos relacionados eliminados.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
