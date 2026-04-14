/**
 * Borra una solicitud Rapidín y su préstamo asociado (si existe) por UUID de solicitud o de préstamo.
 * Uso: cd backend && node scripts/rapidin-delete-request-loan.js <uuid>
 */
import 'dotenv/config';
import { getClient } from '../config/database.js';

const id = process.argv[2];
if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
  console.error('Uso: node scripts/rapidin-delete-request-loan.js <uuid-solicitud-o-prestamo>');
  process.exit(1);
}

async function main() {
  const client = await getClient();
  try {
    let requestId = null;
    let loanId = null;

    const asLoan = await client.query(`SELECT id, request_id FROM module_rapidin_loans WHERE id = $1`, [id]);
    if (asLoan.rows.length) {
      loanId = asLoan.rows[0].id;
      requestId = asLoan.rows[0].request_id;
    } else {
      const asReq = await client.query(`SELECT id FROM module_rapidin_loan_requests WHERE id = $1`, [id]);
      if (asReq.rows.length) {
        requestId = asReq.rows[0].id;
        const loanByReq = await client.query(`SELECT id FROM module_rapidin_loans WHERE request_id = $1`, [requestId]);
        if (loanByReq.rows.length) loanId = loanByReq.rows[0].id;
      }
    }

    if (!requestId) {
      console.error('No existe solicitud ni préstamo con ese UUID:', id);
      process.exit(1);
    }

    console.log('request_id:', requestId);
    console.log('loan_id:', loanId || '(ninguno)');

    await client.query('BEGIN');

    if (loanId) {
      await client.query(
        `DELETE FROM module_rapidin_payment_installments
         WHERE payment_id IN (SELECT id FROM module_rapidin_payments WHERE loan_id = $1)`,
        [loanId]
      );
      await client.query(`DELETE FROM module_rapidin_payments WHERE loan_id = $1`, [loanId]);
      await client.query(
        `DELETE FROM module_rapidin_voucher_installments WHERE installment_id IN (SELECT id FROM module_rapidin_installments WHERE loan_id = $1)`,
        [loanId]
      );
      await client.query(`DELETE FROM module_rapidin_payment_vouchers WHERE loan_id = $1`, [loanId]);
      await client.query(`DELETE FROM module_rapidin_auto_payment_log WHERE loan_id = $1`, [loanId]);
      await client.query(`DELETE FROM module_rapidin_notifications WHERE loan_id = $1`, [loanId]);
      await client.query(`DELETE FROM module_rapidin_installments WHERE loan_id = $1`, [loanId]);
      await client.query(`DELETE FROM module_rapidin_documents WHERE loan_id = $1`, [loanId]);
      await client.query(`DELETE FROM module_rapidin_loans WHERE id = $1`, [loanId]);
    }

    await client.query(`DELETE FROM module_rapidin_documents WHERE request_id = $1`, [requestId]);
    await client.query(`DELETE FROM module_rapidin_loan_requests WHERE id = $1`, [requestId]);

    await client.query('COMMIT');
    console.log('OK: solicitud y préstamo eliminados.');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
