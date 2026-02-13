/**
 * Elimina todos los préstamos y pagos del conductor Jhajira (DNI Q77221246).
 * Desvincula documentos (loan_id = null), deja solicitudes en approved.
 * Uso: node scripts/delete-all-jhajira-loans-payments.js
 */

import pool from '../config/database.js';

const DNI_JHAJIRA = 'Q77221246';

async function run() {
  const client = await pool.connect();
  try {
    const { rows: [driver] } = await client.query(
      'SELECT id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2',
      [DNI_JHAJIRA, 'PE']
    );
    if (!driver) {
      console.log('Conductor Jhajira no encontrado');
      return;
    }
    const driverId = driver.id;

    const { rows: loans } = await client.query(
      'SELECT id, request_id FROM module_rapidin_loans WHERE driver_id = $1',
      [driverId]
    );
    const loanIds = loans.map((l) => l.id);
    const requestIds = [...new Set(loans.map((l) => l.request_id).filter(Boolean))];

    if (loanIds.length === 0) {
      console.log('No hay préstamos de Jhajira para eliminar.');
      await client.query(
        "UPDATE module_rapidin_loan_requests SET status = 'approved', disbursed_at = NULL WHERE driver_id = $1",
        [driverId]
      );
      console.log('Solicitudes dejadas en estado approved.');
      return;
    }

    await client.query('BEGIN');

    await client.query('UPDATE module_rapidin_documents SET loan_id = NULL WHERE loan_id = ANY($1::uuid[])', [loanIds]);
    await client.query(
      'UPDATE module_rapidin_auto_payment_log SET loan_id = NULL, payment_id = NULL WHERE loan_id = ANY($1::uuid[])',
      [loanIds]
    );
    await client.query('UPDATE module_rapidin_notifications SET loan_id = NULL WHERE loan_id = ANY($1::uuid[])', [loanIds]);

    await client.query(
      'DELETE FROM module_rapidin_payment_installments WHERE payment_id IN (SELECT id FROM module_rapidin_payments WHERE loan_id = ANY($1::uuid[]))',
      [loanIds]
    );
    await client.query('DELETE FROM module_rapidin_payments WHERE loan_id = ANY($1::uuid[])', [loanIds]);

    await client.query(
      'DELETE FROM module_rapidin_voucher_installments WHERE voucher_id IN (SELECT id FROM module_rapidin_payment_vouchers WHERE loan_id = ANY($1::uuid[]))',
      [loanIds]
    );
    await client.query('DELETE FROM module_rapidin_payment_vouchers WHERE loan_id = ANY($1::uuid[])', [loanIds]);

    await client.query('DELETE FROM module_rapidin_installments WHERE loan_id = ANY($1::uuid[])', [loanIds]);
    await client.query('DELETE FROM module_rapidin_loans WHERE id = ANY($1::uuid[])', [loanIds]);

    if (requestIds.length > 0) {
      await client.query(
        "UPDATE module_rapidin_loan_requests SET status = 'approved', disbursed_at = NULL WHERE id = ANY($1::uuid[])",
        [requestIds]
      );
    }

    await client.query('COMMIT');
    console.log('Jhajira: eliminados', loanIds.length, 'préstamo(s) y todos sus pagos. Solicitudes dejadas en estado approved.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    throw e;
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
