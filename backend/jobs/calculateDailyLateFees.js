import cron from 'node-cron';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { updateLoanBalance } from '../services/paymentService.js';

async function runLateFeesUpdate() {
  // Cuotas no pagadas y vencidas (pending u overdue): recalculamos mora cada día para que incremente.
  // Incluye active y defaulted para que todos los préstamos con cuotas vencidas se actualicen.
  const installments = await query(
    `SELECT i.id, i.loan_id, i.due_date, i.installment_amount, i.paid_amount, i.status,
            COALESCE(i.paid_late_fee, 0)::numeric AS paid_late_fee
     FROM module_rapidin_installments i
     JOIN module_rapidin_loans l ON l.id = i.loan_id
     WHERE i.status IN ('pending', 'overdue')
       AND i.due_date::date <= CURRENT_DATE
       AND (i.paid_amount IS NULL OR i.paid_amount < i.installment_amount)
       AND l.status IN ('active', 'defaulted')`
  );

  for (const installment of installments.rows) {
    const daysOverdue = Math.max(0, Math.floor((new Date() - new Date(installment.due_date)) / (1000 * 60 * 60 * 24)));
    const paidLateFee = parseFloat(installment.paid_late_fee || 0) || 0;

    let lateFee = 0;
    try {
      const lateFeeResult = await query(
        'SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee',
        [installment.id]
      );
      const totalMora = parseFloat(lateFeeResult.rows[0]?.late_fee) || 0;
      // Mora pendiente = total calculada − lo ya pagado (para respetar paid_late_fee)
      lateFee = Math.max(0, totalMora - paidLateFee);
    } catch (err) {
      logger.warn(`Mora no calculada para cuota ${installment.id}, se marca vencida con mora 0:`, err.message);
    }

    await query(
      `UPDATE module_rapidin_installments 
       SET late_fee = $1, 
           days_overdue = $2,
           status = 'overdue'
       WHERE id = $3`,
      [lateFee, daysOverdue, installment.id]
    );
  }
  // Actualizar pending_balance de cada préstamo afectado (incluye mora: cuota pendiente + late_fee)
  const loanIds = [...new Set(installments.rows.map((i) => i.loan_id))];
  for (const loanId of loanIds) {
    await updateLoanBalance(loanId);
  }
  return installments.rows.length;
}

export const startDailyLateFeesJob = () => {
  // No ejecutar mora al arranque (evita muchos logs/broadcasts cada vez que recargas el servidor)
  cron.schedule('0 1 * * *', async () => {
    logger.info('Iniciando cálculo diario de mora...');
    try {
      const n = await runLateFeesUpdate();
      logger.info(`Mora calculada para ${n} cuotas`);
    } catch (error) {
      logger.error('Error calculando mora:', error);
    }
    logger.info('Cálculo diario de mora completado');
  }, {
    scheduled: true,
    timezone: 'America/Lima'
  });

  logger.info('Job de cálculo diario de mora programado');
};







