/**
 * Recalcula el cronograma de un préstamo a 5 cuotas (elimina las actuales y genera de nuevo).
 * Si el préstamo tiene pagos registrados, los elimina (solo para este script de corrección).
 * Uso: node scripts/recalculate-loan-to-5-installments.js <loan_id>
 */
import { query } from '../config/database.js';
import { generateInstallmentSchedule } from '../services/calculationsService.js';
import { updateLoanBalance } from '../services/paymentService.js';

const loanId = process.argv[2] || 'e081d944-0280-467f-9061-683bbe82a84f';

async function main() {
  const loanRes = await query(
    `SELECT id, disbursed_amount, interest_rate, first_payment_date, number_of_installments, total_amount
     FROM module_rapidin_loans WHERE id = $1`,
    [loanId]
  );
  if (loanRes.rows.length === 0) {
    console.error('Préstamo no encontrado.');
    process.exit(1);
  }
  const loan = loanRes.rows[0];
  const numActual = parseInt(loan.number_of_installments, 10) || 0;
  console.log(`Préstamo ${loanId}: ${numActual} cuotas actuales, disbursed=${loan.disbursed_amount}, tasa=${loan.interest_rate}, primera pago=${loan.first_payment_date}`);
  console.log('');

  // 1. Eliminar detalle de pagos (payment_installments) de los pagos de este préstamo
  const delPi = await query(
    `DELETE FROM module_rapidin_payment_installments WHERE payment_id IN (SELECT id FROM module_rapidin_payments WHERE loan_id = $1)`,
    [loanId]
  );
  console.log('  payment_installments eliminados:', delPi.rowCount);

  // 2. Eliminar pagos del préstamo
  const delPay = await query('DELETE FROM module_rapidin_payments WHERE loan_id = $1', [loanId]);
  console.log('  payments eliminados:', delPay.rowCount);

  // 3. Eliminar cuotas actuales
  const delInst = await query('DELETE FROM module_rapidin_installments WHERE loan_id = $1', [loanId]);
  console.log('  installments eliminados:', delInst.rowCount);

  // 4. Generar nuevo cronograma con 5 cuotas
  const firstPaymentDate = loan.first_payment_date
    ? new Date(loan.first_payment_date).toISOString().split('T')[0]
    : null;
  if (!firstPaymentDate) {
    console.error('El préstamo no tiene first_payment_date.');
    process.exit(1);
  }
  await generateInstallmentSchedule(
    loanId,
    loan.disbursed_amount,
    loan.interest_rate,
    5,
    firstPaymentDate
  );
  console.log('  Nuevo cronograma generado: 5 cuotas.');

  // 5. Actualizar loan: total_amount y number_of_installments según el nuevo cronograma
  const sumRes = await query(
    `SELECT SUM(installment_amount) AS total FROM module_rapidin_installments WHERE loan_id = $1`,
    [loanId]
  );
  const newTotal = parseFloat(sumRes.rows[0]?.total || 0) || 0;
  await query(
    `UPDATE module_rapidin_loans 
     SET total_amount = $1, number_of_installments = 5, pending_balance = $1, updated_at = CURRENT_TIMESTAMP 
     WHERE id = $2`,
    [Math.round(newTotal * 100) / 100, loanId]
  );
  console.log('  Loan actualizado: total_amount =', newTotal.toFixed(2), ', number_of_installments = 5');

  await updateLoanBalance(loanId);
  console.log('');
  console.log('Listo. Préstamo con 5 cuotas.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
