/**
 * Inspecciona cuotas y mora de un préstamo.
 * Uso: node scripts/inspect-loan-installments.js <loan_id>
 */
import { query } from '../config/database.js';

const loanId = process.argv[2] || '3771a081-89bf-419a-bee5-7b4d9d5fa885';

async function main() {
  const loan = await query(
    `SELECT id, driver_id, status, total_amount, pending_balance, disbursed_at FROM module_rapidin_loans WHERE id = $1`,
    [loanId]
  );
  if (loan.rows.length === 0) {
    console.log('Préstamo no encontrado.');
    process.exit(1);
  }
  console.log('Préstamo:', loan.rows[0]);
  console.log('');

  const installments = await query(
    `SELECT id, installment_number, installment_amount, paid_amount, due_date, paid_date,
            late_fee, paid_late_fee, late_fee_base_date, status, days_overdue
     FROM module_rapidin_installments
     WHERE loan_id = $1
     ORDER BY installment_number`,
    [loanId]
  );
  console.log('Cuotas:', installments.rows.length);
  console.log('');
  for (const i of installments.rows) {
    console.log({
      cuota: i.installment_number,
      due_date: i.due_date,
      installment_amount: i.installment_amount,
      paid_amount: i.paid_amount,
      late_fee: i.late_fee,
      paid_late_fee: i.paid_late_fee,
      late_fee_base_date: i.late_fee_base_date,
      status: i.status,
      days_overdue: i.days_overdue,
    });
  }
  const sumLateFee = installments.rows.reduce((s, i) => s + parseFloat(i.late_fee || 0), 0);
  const sumPaidLateFee = installments.rows.reduce((s, i) => s + parseFloat(i.paid_late_fee || 0), 0);
  console.log('');
  console.log('Suma late_fee (pendiente):', sumLateFee.toFixed(2));
  console.log('Suma paid_late_fee:', sumPaidLateFee.toFixed(2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
