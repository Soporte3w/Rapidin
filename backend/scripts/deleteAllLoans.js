/**
 * Script para eliminar TODOS los préstamos (loans), solicitudes (loan_requests) y datos asociados.
 * Respetar FKs: payment_installments → payments → loans; documents → loan_requests; etc.
 *
 * Uso: cd backend && node scripts/deleteAllLoans.js
 * Requiere: .env con DB_HOST, DB_NAME, DB_USER, DB_PASSWORD (o valores por defecto de config/database.js)
 */

import pool from '../config/database.js';

async function deleteAllLoans() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Eliminar distribución de pagos a cuotas (payment_installments)
    const r1 = await client.query(`
      DELETE FROM module_rapidin_payment_installments
      WHERE payment_id IN (SELECT id FROM module_rapidin_payments WHERE loan_id IN (SELECT id FROM module_rapidin_loans))
    `);
    console.log('payment_installments eliminados:', r1.rowCount);

    // 2. Eliminar pagos de préstamos
    const r2 = await client.query(`
      DELETE FROM module_rapidin_payments WHERE loan_id IN (SELECT id FROM module_rapidin_loans)
    `);
    console.log('payments eliminados:', r2.rowCount);

    // 3. Eliminar voucher_installments de vouchers asociados a préstamos
    const r3 = await client.query(`
      DELETE FROM module_rapidin_voucher_installments
      WHERE voucher_id IN (SELECT id FROM module_rapidin_payment_vouchers WHERE loan_id IN (SELECT id FROM module_rapidin_loans))
    `);
    console.log('voucher_installments eliminados:', r3.rowCount);

    // 4. Eliminar vouchers de préstamos
    const r4 = await client.query(`
      DELETE FROM module_rapidin_payment_vouchers WHERE loan_id IN (SELECT id FROM module_rapidin_loans)
    `);
    console.log('payment_vouchers eliminados:', r4.rowCount);

    // 5. Log de cobros automáticos (opcional: borrar filas o dejar loan_id NULL)
    const r5 = await client.query(`
      DELETE FROM module_rapidin_auto_payment_log WHERE loan_id IS NOT NULL
    `);
    console.log('auto_payment_log eliminados:', r5.rowCount);

    // 6. Notificaciones: quitar referencia al préstamo
    const r6 = await client.query(`
      UPDATE module_rapidin_notifications SET loan_id = NULL WHERE loan_id IS NOT NULL
    `);
    console.log('notifications actualizadas (loan_id = NULL):', r6.rowCount);

    // 7. Documentos: quitar referencia al préstamo
    const r7 = await client.query(`
      UPDATE module_rapidin_documents SET loan_id = NULL WHERE loan_id IS NOT NULL
    `);
    console.log('documents actualizados (loan_id = NULL):', r7.rowCount);

    // 8. Eliminar préstamos (CASCADE elimina installments)
    const r8 = await client.query('DELETE FROM module_rapidin_loans');
    console.log('loans eliminados:', r8.rowCount);

    // 9. Documentos: quitar referencia a solicitudes para poder borrarlas
    const r9 = await client.query(`
      UPDATE module_rapidin_documents SET request_id = NULL WHERE request_id IS NOT NULL
    `);
    console.log('documents actualizados (request_id = NULL):', r9.rowCount);

    // 10. Eliminar todas las solicitudes de préstamo (loan_requests)
    const r10 = await client.query('DELETE FROM module_rapidin_loan_requests');
    console.log('loan_requests eliminados:', r10.rowCount);

    await client.query('COMMIT');
    console.log('\nTodos los préstamos, solicitudes y datos asociados se eliminaron correctamente.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

deleteAllLoans().catch(() => process.exit(1));
