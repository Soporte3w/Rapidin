/**
 * Recalcula la mora de un préstamo con la lógica corregida: si la cuota tiene late_fee_base_date (pago parcial),
 * la mora pendiente = total calculada (no se resta paid_late_fee).
 * Ejecutar: node scripts/recalc-mora-loan-6550ece6.js [loan_id]
 * Sin argumentos usa 6550ece6-022d-4b38-b414-181fc45324e7
 */

import { query } from '../config/database.js';
import { updateLoanBalance } from '../services/paymentService.js';

const DEFAULT_LOAN_ID = '6550ece6-022d-4b38-b414-181fc45324e7';
const LOAN_ID = process.argv[2]?.trim() || DEFAULT_LOAN_ID;

async function run() {
  console.log('Recalculando mora del préstamo', LOAN_ID, '...');

  const rows = await query(
    `SELECT i.id, i.installment_number, i.late_fee, i.late_fee_base_date,
            COALESCE(i.paid_late_fee, 0)::numeric AS paid_late_fee
     FROM module_rapidin_installments i
     JOIN module_rapidin_loans l ON l.id = i.loan_id
     WHERE i.loan_id = $1
       AND i.status IN ('pending', 'overdue')
       AND i.due_date < CURRENT_DATE
       AND (i.installment_amount + COALESCE(i.late_fee, 0) - COALESCE(i.paid_amount, 0)) > 0
     ORDER BY i.installment_number`,
    [LOAN_ID]
  );

  if (rows.rows.length === 0) {
    console.log('No hay cuotas vencidas con saldo pendiente para este préstamo.');
    process.exit(0);
  }

  await query('BEGIN');
  try {
    for (const row of rows.rows) {
      const feeRes = await query(
        'SELECT calculate_late_fee($1::uuid, CURRENT_DATE) AS late_fee',
        [row.id]
      );
      const totalMora = parseFloat(feeRes.rows[0]?.late_fee || 0) || 0;
      const paidLateFee = parseFloat(row.paid_late_fee || 0) || 0;
      const hasBaseDate = row.late_fee_base_date != null;
      const newLateFee = hasBaseDate ? totalMora : Math.max(0, totalMora - paidLateFee);

      await query(
        `UPDATE module_rapidin_installments
         SET late_fee = $1,
             days_overdue = GREATEST(0, CURRENT_DATE - COALESCE(late_fee_base_date, due_date)),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [newLateFee, row.id]
      );
      console.log(
        `  Cuota ${row.installment_number}: late_fee ${row.late_fee} -> ${newLateFee}${hasBaseDate ? ' (desde base_date, sin restar paid)' : ''}`
      );
    }

    await updateLoanBalance(LOAN_ID);
    await query('COMMIT');
    console.log('OK. Mora recalculada y pending_balance actualizado.');
  } catch (e) {
    await query('ROLLBACK');
    console.error(e);
    process.exit(1);
  }
  process.exit(0);
}

run();
