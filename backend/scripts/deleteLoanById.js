/**
 * Elimina todo lo relacionado con un préstamo o una solicitud (por loan ID o request ID).
 * Uso: node scripts/deleteLoanById.js <loanId|requestId>
 * Acepta: ID del préstamo (module_rapidin_loans.id) o ID de la solicitud (module_rapidin_loan_requests.id).
 */
import { query } from '../config/database.js';

const id = (process.argv[2] || '').trim();

async function deleteLoanAndRelated(loanId) {
  await query(
    `DELETE FROM module_rapidin_voucher_installments WHERE voucher_id IN (SELECT id FROM module_rapidin_payment_vouchers WHERE loan_id = $1)`,
    [loanId]
  );
  await query('DELETE FROM module_rapidin_payment_vouchers WHERE loan_id = $1', [loanId]);
  await query(
    `DELETE FROM module_rapidin_payment_installments WHERE payment_id IN (SELECT id FROM module_rapidin_payments WHERE loan_id = $1)`,
    [loanId]
  );
  await query('DELETE FROM module_rapidin_payments WHERE loan_id = $1', [loanId]);
  await query('DELETE FROM module_rapidin_documents WHERE loan_id = $1', [loanId]);
  await query('DELETE FROM module_rapidin_auto_payment_log WHERE loan_id = $1', [loanId]);
  await query('DELETE FROM module_rapidin_installments WHERE loan_id = $1', [loanId]);
  await query('DELETE FROM module_rapidin_loans WHERE id = $1', [loanId]);
}

async function run() {
  if (!id) {
    console.log('Uso: node scripts/deleteLoanById.js <loanId|requestId>');
    process.exit(1);
  }

  try {
    const loanRow = await query('SELECT id, request_id FROM module_rapidin_loans WHERE id = $1 LIMIT 1', [id]);
    if (loanRow.rows.length > 0) {
      const requestId = loanRow.rows[0].request_id;
      await deleteLoanAndRelated(id);
      if (requestId) {
        await query('DELETE FROM module_rapidin_documents WHERE request_id = $1', [requestId]);
        await query('DELETE FROM module_rapidin_loan_requests WHERE id = $1', [requestId]);
      }
      console.log('Préstamo y solicitud eliminados. Puedes generar uno nuevo.');
      process.exit(0);
      return;
    }

    const requestRow = await query('SELECT id FROM module_rapidin_loan_requests WHERE id = $1 LIMIT 1', [id]);
    if (requestRow.rows.length === 0) {
      console.log('No encontrado ni como préstamo ni como solicitud:', id);
      process.exit(1);
    }

    const loanByRequest = await query('SELECT id FROM module_rapidin_loans WHERE request_id = $1 LIMIT 1', [id]);
    if (loanByRequest.rows.length > 0) {
      const loanId = loanByRequest.rows[0].id;
      await deleteLoanAndRelated(loanId);
    }
    await query('DELETE FROM module_rapidin_documents WHERE request_id = $1', [id]);
    await query('DELETE FROM module_rapidin_loan_requests WHERE id = $1', [id]);
    console.log('Solicitud (y préstamo si existía) eliminados. Puedes generar uno nuevo.');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

run();
