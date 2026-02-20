/**
 * Elimina un préstamo (loan) y todas sus relaciones por ID.
 * Uso: node scripts/delete-loan-and-relations.js <loan_id>
 *      node scripts/delete-loan-and-relations.js --request-only <request_id>   (solo borra la solicitud)
 * Ejemplo: node scripts/delete-loan-and-relations.js 43dce923-6173-40b4-9fef-c7e6b3d9b3c1
 */

import pool from '../config/database.js';

const REQUEST_ONLY = process.argv[2] === '--request-only';
const ID_ARG = REQUEST_ONLY ? process.argv[3] : (process.argv[2] || '43dce923-6173-40b4-9fef-c7e6b3d9b3c1');

async function deleteRequestOnly(client, requestId) {
  await client.query('BEGIN');
  const delDoc = await client.query('DELETE FROM module_rapidin_documents WHERE request_id = $1', [requestId]);
  console.log('documents por request_id eliminados:', delDoc.rowCount);
  const delReq = await client.query('DELETE FROM module_rapidin_loan_requests WHERE id = $1', [requestId]);
  if (delReq.rowCount === 0) {
    console.log('No existía solicitud con id:', requestId);
    await client.query('ROLLBACK');
    return;
  }
  await client.query('COMMIT');
  console.log('Solicitud', requestId, 'eliminada; ya no aparecerá en el listado.');
}

async function run() {
  const client = await pool.connect();
  try {
    if (REQUEST_ONLY) {
      if (!ID_ARG) {
        console.log('Uso: node scripts/delete-loan-and-relations.js --request-only <request_id>');
        process.exit(1);
      }
      await deleteRequestOnly(client, ID_ARG);
      process.exit(0);
      return;
    }

    // Aceptar tanto loan.id como loan.request_id (por si pasan el request_id)
    let loanCheck = await client.query(
      'SELECT id, request_id, driver_id, disbursed_amount, status FROM module_rapidin_loans WHERE id = $1',
      [ID_ARG]
    );
    if (loanCheck.rows.length === 0) {
      loanCheck = await client.query(
        'SELECT id, request_id, driver_id, disbursed_amount, status FROM module_rapidin_loans WHERE request_id = $1',
        [ID_ARG]
      );
    }
    if (loanCheck.rows.length === 0) {
      console.log('No se encontró ningún préstamo con id ni request_id:', ID_ARG);
      process.exit(1);
    }
    const loan = loanCheck.rows[0];
    const LOAN_ID = loan.id;
    console.log('Préstamo encontrado:', loan);

    await client.query('BEGIN');

    // 1. payment_installments (referencian payments e installments; hay que borrarlos antes de borrar payments/loan)
    const delPi = await client.query(
      `DELETE FROM module_rapidin_payment_installments
       WHERE payment_id IN (SELECT id FROM module_rapidin_payments WHERE loan_id = $1)`,
      [LOAN_ID]
    );
    console.log('payment_installments eliminados:', delPi.rowCount);

    // 2. payments
    const delPay = await client.query('DELETE FROM module_rapidin_payments WHERE loan_id = $1', [LOAN_ID]);
    console.log('payments eliminados:', delPay.rowCount);

    // 3. voucher_installments (vía vouchers de este loan; los vouchers se borran después)
    const vouchers = await client.query('SELECT id FROM module_rapidin_payment_vouchers WHERE loan_id = $1', [LOAN_ID]);
    for (const v of vouchers.rows) {
      await client.query('DELETE FROM module_rapidin_voucher_installments WHERE voucher_id = $1', [v.id]);
    }
    console.log('voucher_installments eliminados (vouchers de este loan)');

    // 4. payment_vouchers
    const delVouchers = await client.query('DELETE FROM module_rapidin_payment_vouchers WHERE loan_id = $1', [LOAN_ID]);
    console.log('payment_vouchers eliminados:', delVouchers.rowCount);

    // 5. auto_payment_log (poner null o borrar; tiene ON DELETE SET NULL pero por claridad borramos filas)
    const delAuto = await client.query('DELETE FROM module_rapidin_auto_payment_log WHERE loan_id = $1', [LOAN_ID]);
    console.log('auto_payment_log eliminados:', delAuto.rowCount);

    // 6. notifications (tienen FK a loan_id sin ON DELETE)
    const updNotif = await client.query(
      'UPDATE module_rapidin_notifications SET loan_id = NULL WHERE loan_id = $1',
      [LOAN_ID]
    );
    console.log('notifications actualizados (loan_id = null):', updNotif.rowCount);

    // 7. documents
    const delDoc = await client.query('DELETE FROM module_rapidin_documents WHERE loan_id = $1', [LOAN_ID]);
    console.log('documents eliminados:', delDoc.rowCount);

    // 8. loan (CASCADE borra installments)
    await client.query('DELETE FROM module_rapidin_loans WHERE id = $1', [LOAN_ID]);
    console.log('Préstamo (y cuotas por CASCADE) eliminado.');

    // 9. Eliminar la solicitud (request) para que no aparezca en listado de solicitudes
    if (loan.request_id) {
      const delDocReq = await client.query(
        'DELETE FROM module_rapidin_documents WHERE request_id = $1',
        [loan.request_id]
      );
      console.log('documents por request_id eliminados:', delDocReq.rowCount);
      await client.query('DELETE FROM module_rapidin_loan_requests WHERE id = $1', [loan.request_id]);
      console.log('Solicitud (request) eliminada; ya no aparecerá en el listado.');
    }

    await client.query('COMMIT');
    console.log('Listo. Préstamo', LOAN_ID, 'solicitud y todas sus relaciones eliminados.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
