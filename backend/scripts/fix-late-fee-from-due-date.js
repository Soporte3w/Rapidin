/**
 * Recalcula la mora de las cuotas de un préstamo desde la fecha de vencimiento (due_date)
 * y resta lo ya pagado (paid_late_fee), para que "mora pendiente" quede bien.
 *
 * Uso: node backend/scripts/fix-late-fee-from-due-date.js <loan_id>
 * Ejemplo: node backend/scripts/fix-late-fee-from-due-date.js 6550ece6-022d-4b38-b414-181fc45324e7
 */

import { query } from '../config/database.js';
import { updateLoanBalance } from '../services/paymentService.js';

const loanId = process.argv[2];
if (!loanId) {
  console.error('Uso: node fix-late-fee-from-due-date.js <loan_id>');
  process.exit(1);
}

async function main() {
  const installments = await query(
    `SELECT i.id, i.installment_number, i.installment_amount, i.paid_amount, i.due_date,
            i.late_fee, i.paid_late_fee, i.late_fee_base_date, i.status,
            l.interest_rate
     FROM module_rapidin_installments i
     JOIN module_rapidin_loans l ON l.id = i.loan_id
     WHERE i.loan_id = $1
     ORDER BY i.installment_number`,
    [loanId]
  );

  if (installments.rows.length === 0) {
    console.log('No hay cuotas para este préstamo.');
    return;
  }

  const todayRes = await query('SELECT CURRENT_DATE AS d');
  const today = new Date(todayRes.rows[0].d);

  console.log(`Préstamo ${loanId}: ${installments.rows.length} cuotas.\n`);

  for (const i of installments.rows) {
    const paid = parseFloat(i.paid_late_fee || 0);
    const installmentAmount = parseFloat(i.installment_amount || 0);
    const paidAmount = parseFloat(i.paid_amount || 0);
    const base = Math.max(0, installmentAmount - paidAmount);
    const tasaSemanal = parseFloat(i.interest_rate || 0);
    const dueDate = i.due_date ? new Date(i.due_date) : null;
    const daysOverdue = dueDate ? Math.max(0, Math.floor((today - dueDate) / (1000 * 60 * 60 * 24))) : 0;

    // Calcular mora desde due_date (temporalmente NULL para que la función use due_date)
    await query(
      `UPDATE module_rapidin_installments SET late_fee_base_date = NULL WHERE id = $1`,
      [i.id]
    );

    const res = await query('SELECT calculate_late_fee($1, CURRENT_DATE) AS late_fee', [i.id]);
    const totalMora = parseFloat(res.rows[0]?.late_fee || 0);
    const newLateFee = Math.max(0, totalMora - paid);

    // Si ya pagó parte de la mora, dejar late_fee_base_date en el rango del vencimiento (día siguiente: 2 o 3)
    // para que no quede NULL y refleje que hubo pago (mora desde due_date+1 en adelante).
    const baseDateToSet =
      paid > 0 && i.due_date
        ? new Date(i.due_date)
        : null;
    if (baseDateToSet) {
      baseDateToSet.setDate(baseDateToSet.getDate() + 1); // día siguiente al vencimiento (ej. 2 mar → 3 mar)
    }

    // Mostrar números del cálculo (fórmula linear: mora_semanal = base × tasa% / 100; mora_día = mora_semanal/7; total = mora_día × días)
    if (totalMora > 0 || paid > 0) {
      const moraSemanal = base * (tasaSemanal / 100);
      const moraPorDia = moraSemanal / 7;
      const totalFormula = moraPorDia * daysOverdue;
      console.log(`--- Cuota ${i.installment_number} (números del cálculo) ---`);
      console.log(`  Saldo cuota (base)     = installment_amount - paid_amount = ${installmentAmount.toFixed(2)} - ${paidAmount.toFixed(2)} = ${base.toFixed(2)}`);
      console.log(`  Tasa semanal (préstamo)= ${tasaSemanal}%`);
      console.log(`  Días vencido           = desde ${i.due_date} hasta hoy = ${daysOverdue} días`);
      console.log(`  Mora semanal           = base × (tasa/100) = ${base.toFixed(2)} × ${(tasaSemanal / 100).toFixed(4)} = ${moraSemanal.toFixed(4)}`);
      console.log(`  Mora por día           = mora_semanal / 7 = ${(moraSemanal / 7).toFixed(4)}`);
      console.log(`  Total mora (fórmula)    = mora_por_día × días = ${moraPorDia.toFixed(4)} × ${daysOverdue} = ${totalFormula.toFixed(2)}`);
      console.log(`  Total mora (BD)        = ${totalMora.toFixed(2)}  |  Ya pagada = ${paid.toFixed(2)}`);
      console.log(`  Mora pendiente         = total_mora - pagada = ${totalMora.toFixed(2)} - ${paid.toFixed(2)} = ${newLateFee.toFixed(2)}`);
      console.log('');
    }

    const baseDateStr = baseDateToSet ? baseDateToSet.toISOString().slice(0, 10) : null;
    await query(
      `UPDATE module_rapidin_installments
       SET late_fee = $1, days_overdue = GREATEST(0, CURRENT_DATE - due_date),
           late_fee_base_date = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [Math.round(newLateFee * 100) / 100, baseDateStr, i.id]
    );

    console.log(
      `Cuota ${i.installment_number}: due ${i.due_date} | mora total=${totalMora.toFixed(2)} | pagada=${paid.toFixed(2)} | nueva mora pendiente=${newLateFee.toFixed(2)}`
    );
  }

  await updateLoanBalance(loanId);
  console.log('\nSaldo del préstamo actualizado.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
