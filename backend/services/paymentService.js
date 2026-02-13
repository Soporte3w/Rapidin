import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { getPaymentPunctuality } from './calculationsService.js';

export const registerPayment = async (data, userId) => {
  const { loan_id, amount, payment_date, payment_method, observations } = data;

  await query('BEGIN');

  try {
    const paymentResult = await query(
      `INSERT INTO module_rapidin_payments 
       (loan_id, amount, payment_date, payment_method, observations, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [loan_id, amount, payment_date, payment_method || 'manual', observations, userId]
    );

    const payment = paymentResult.rows[0];

    await distributePayment(payment.id, loan_id, amount, 'by_date');

    await query('COMMIT');

    return payment;
  } catch (error) {
    await query('ROLLBACK');
    throw error;
  }
};

/** Registra un pago por cobro automático (job diario, sin usuario). */
export const registerPaymentAuto = async (loanId, amount, paymentDate) => {
  await query('BEGIN');
  try {
    const paymentResult = await query(
      `INSERT INTO module_rapidin_payments 
       (loan_id, amount, payment_date, payment_method, observations, registered_by)
       VALUES ($1, $2, $3, 'cobro_automatico', NULL, NULL)
       RETURNING *`,
      [loanId, amount, paymentDate]
    );
    const payment = paymentResult.rows[0];
    await distributePayment(payment.id, loanId, amount, 'by_date');
    await query('COMMIT');
    return payment;
  } catch (error) {
    await query('ROLLBACK');
    throw error;
  }
};

export const distributePayment = async (paymentId, loanId, totalAmount, strategy = 'by_date') => {
  const installments = await query(
    `SELECT * FROM module_rapidin_installments 
     WHERE loan_id = $1 AND status IN ('pending', 'overdue') 
       AND ((installment_amount - COALESCE(paid_amount, 0)) > 0 OR COALESCE(late_fee, 0) > 0)
     ORDER BY due_date ASC`,
    [loanId]
  );

  if (installments.rows.length === 0) {
    throw new Error('No hay cuotas pendientes para este préstamo');
  }

  let remainingAmount = totalAmount;

  if (strategy === 'by_date') {
    for (const installment of installments.rows) {
      if (remainingAmount <= 0) break;

      // Total a pagar = cuota pendiente + mora (si no aplicamos primero a mora, el resto quedaría mal: ej. 15.50 en vez de 15.86)
      const pendingInstallmentAmount = parseFloat(installment.installment_amount) - parseFloat(installment.paid_amount || 0);
      const pendingLateFee = parseFloat(installment.late_fee) || 0;
      const totalToPay = pendingInstallmentAmount + pendingLateFee;

      if (totalToPay <= 0) continue;

      // Primero pagar la mora, luego la cuota (así el resto = 25.50 - (10 - 0.36) = 15.86, no 15.50)
      let lateFeePaid = 0;
      let installmentPaid = 0;

      if (pendingLateFee > 0 && remainingAmount > 0) {
        lateFeePaid = Math.min(remainingAmount, pendingLateFee);
        remainingAmount -= lateFeePaid;
      }

      if (pendingInstallmentAmount > 0 && remainingAmount > 0) {
        installmentPaid = Math.min(remainingAmount, pendingInstallmentAmount);
        remainingAmount -= installmentPaid;
      }

      // Actualizar la cuota: paid_amount, paid_late_fee (mora pagada acumulada), status, paid_date.
      if (lateFeePaid > 0 || installmentPaid > 0) {
        await query(
          `UPDATE module_rapidin_installments 
           SET paid_amount = paid_amount + $2,
               late_fee = GREATEST(0, COALESCE(late_fee, 0) - $1),
               paid_late_fee = COALESCE(paid_late_fee, 0) + $1,
               status = CASE 
                 WHEN (paid_amount + $2) >= installment_amount 
                   AND (COALESCE(late_fee, 0) - $1) <= 0
                 THEN 'paid' 
                 WHEN (paid_amount + $2) >= installment_amount THEN 'pending'
                 ELSE status 
               END,
               paid_date = CASE 
                 WHEN (paid_amount + $2) >= installment_amount 
                   AND (COALESCE(late_fee, 0) - $1) <= 0
                 THEN CURRENT_DATE 
                 ELSE paid_date 
               END
           WHERE id = $3`,
          [lateFeePaid, installmentPaid, installment.id]
        );

        // Recalcular mora solo si la cuota quedó pagada al 100%: si quedó saldo pendiente, no generamos mora nueva el mismo día del pago (el job diario la actualizará al día siguiente).
        const pendingAfterPayment = parseFloat(installment.installment_amount) - (parseFloat(installment.paid_amount || 0) + installmentPaid);
        if (pendingAfterPayment <= 0) {
          const feeRes = await query('SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee', [installment.id]);
          const newLateFee = Math.max(0, parseFloat(feeRes.rows[0]?.late_fee) || 0);
          await query(
            `UPDATE module_rapidin_installments 
             SET late_fee = $1, 
                 days_overdue = GREATEST(0, CURRENT_DATE - due_date),
                 late_fee_base_date = NULL
             WHERE id = $2`,
            [newLateFee, installment.id]
          );
        } else { 
          // Pago parcial: mora en 0 hasta mañana;la mora futura cuenta desde hoy (late_fee_base_date).
          await query(
            `UPDATE module_rapidin_installments 
             SET late_fee = 0, 
                 days_overdue = GREATEST(0, CURRENT_DATE - due_date),
                 late_fee_base_date = CURRENT_DATE
             WHERE id = $1`,
            [installment.id]
          );
        }

        // Registrar el pago total aplicado a esta cuota
        await query(
          `INSERT INTO module_rapidin_payment_installments (payment_id, installment_id, applied_amount)
           VALUES ($1, $2, $3)`,
          [paymentId, installment.id, lateFeePaid + installmentPaid]
        );
      }
    }
  } else if (strategy === 'by_late_fee') {
    const installmentsWithLateFee = installments.rows.filter(i => (i.late_fee || 0) > 0);
    const installmentsWithoutLateFee = installments.rows.filter(i => (i.late_fee || 0) === 0);

    for (const installment of [...installmentsWithLateFee, ...installmentsWithoutLateFee]) {
      if (remainingAmount <= 0) break;

      const pendingInstallmentAmount = installment.installment_amount - (installment.paid_amount || 0);
      const pendingLateFee = (installment.late_fee || 0) - (installment.paid_late_fee || 0);
      const totalToPay = pendingInstallmentAmount + pendingLateFee;

      if (totalToPay <= 0) continue;

      let lateFeePaid = 0;
      let installmentPaid = 0;

      if (pendingLateFee > 0 && remainingAmount > 0) {
        lateFeePaid = Math.min(remainingAmount, pendingLateFee);
        remainingAmount -= lateFeePaid;
      }

      if (pendingInstallmentAmount > 0 && remainingAmount > 0) {
        installmentPaid = Math.min(remainingAmount, pendingInstallmentAmount);
        remainingAmount -= installmentPaid;
      }

      if (lateFeePaid > 0 || installmentPaid > 0) {
        await query(
          `UPDATE module_rapidin_installments 
           SET paid_amount = paid_amount + $2,
               late_fee = GREATEST(0, COALESCE(late_fee, 0) - $1),
               paid_late_fee = COALESCE(paid_late_fee, 0) + $1,
               status = CASE 
                 WHEN (paid_amount + $2) >= installment_amount 
                   AND (COALESCE(late_fee, 0) - $1) <= 0
                 THEN 'paid' 
                 WHEN (paid_amount + $2) >= installment_amount THEN 'pending'
                 ELSE status 
               END,
               paid_date = CASE 
                 WHEN (paid_amount + $2) >= installment_amount 
                   AND (COALESCE(late_fee, 0) - $1) <= 0
                 THEN CURRENT_DATE 
                 ELSE paid_date 
               END
           WHERE id = $3`,
          [lateFeePaid, installmentPaid, installment.id]
        );

        // Recalcular mora sobre el saldo pendiente (monto sobrante)
        const feeRes = await query('SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee', [installment.id]);
        const newLateFee = Math.max(0, parseFloat(feeRes.rows[0]?.late_fee) || 0);
        await query(
          `UPDATE module_rapidin_installments 
           SET late_fee = $1, 
               days_overdue = GREATEST(0, CURRENT_DATE - due_date)
           WHERE id = $2`,
          [newLateFee, installment.id]
        );

        await query(
          `INSERT INTO module_rapidin_payment_installments (payment_id, installment_id, applied_amount)
           VALUES ($1, $2, $3)`,
          [paymentId, installment.id, lateFeePaid + installmentPaid]
        );
      }
    }
  }

  await updateLoanBalance(loanId);
  await checkLoanCompleted(loanId);
};

export const updateLoanBalance = async (loanId) => {
  const result = await query(
    `SELECT SUM((installment_amount - COALESCE(paid_amount, 0)) + COALESCE(late_fee, 0)) as pending_balance
     FROM module_rapidin_installments
     WHERE loan_id = $1 AND status != 'cancelled'`,
    [loanId]
  );

  const pendingBalance = parseFloat(result.rows[0].pending_balance) || 0;

  await query(
    `UPDATE module_rapidin_loans 
     SET pending_balance = $1
     WHERE id = $2`,
    [pendingBalance, loanId]
  );
};

export const checkLoanCompleted = async (loanId) => {
  const result = await query(
    `SELECT COUNT(*) as pending_installments
     FROM module_rapidin_installments
     WHERE loan_id = $1 
       AND ((installment_amount - COALESCE(paid_amount, 0)) > 0 OR COALESCE(late_fee, 0) > 0)`,
    [loanId]
  );

  if (parseInt(result.rows[0].pending_installments) === 0) {
    await query(
      `UPDATE module_rapidin_loans 
       SET status = 'cancelled'
       WHERE id = $1`,
      [loanId]
    );

    // Si el conductor tiene puntualidad de pago < 40%, regresa al ciclo 1
    const loanRow = await query(
      'SELECT driver_id FROM module_rapidin_loans WHERE id = $1',
      [loanId]
    );
    const driverId = loanRow.rows[0]?.driver_id;
    if (driverId) {
      const punctuality = await getPaymentPunctuality(driverId);
      if (punctuality < 0.4) {
        await query(
          'UPDATE module_rapidin_drivers SET cycle = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [driverId]
        );
        logger.info(`Driver ${driverId} puntualidad ${(punctuality * 100).toFixed(1)}% < 40%: ciclo actualizado a 1`);
      }
    }
  }
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const buildPaymentsWhere = (filters, params, paramCountRef) => {
  let sql = '';
  if (filters.country && (filters.country === 'PE' || filters.country === 'CO')) {
    sql += ` AND l.country = $${paramCountRef.current++}`;
    params.push(filters.country);
  }
  if (filters.loan_id && String(filters.loan_id).trim()) {
    const loanId = String(filters.loan_id).trim();
    if (UUID_REGEX.test(loanId)) {
      sql += ` AND p.loan_id = $${paramCountRef.current++}`;
      params.push(loanId);
    } else {
      sql += ` AND p.loan_id::text LIKE $${paramCountRef.current++}`;
      params.push(loanId.replace(/%/g, '\\%') + '%');
    }
  }
  if (filters.date_from) {
    sql += ` AND p.payment_date >= $${paramCountRef.current++}`;
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    sql += ` AND p.payment_date <= $${paramCountRef.current++}`;
    params.push(filters.date_to);
  }
  return sql;
};

export const getPayments = async (filters = {}) => {
  const params = [];
  const paramCountRef = { current: 1 };
  const whereClause = buildPaymentsWhere(filters, params, paramCountRef);

  const baseSql = `
    FROM module_rapidin_payments p
    LEFT JOIN module_rapidin_loans l ON l.id = p.loan_id
    LEFT JOIN module_rapidin_drivers d ON d.id = l.driver_id
    WHERE 1=1 ${whereClause}
  `;

  const selectFields = `
    p.*,
    COALESCE(p.voucher_id,
      (SELECT v.id FROM module_rapidin_payment_vouchers v
       WHERE v.loan_id = p.loan_id AND v.amount = p.amount
         AND v.payment_date = p.payment_date AND v.status = 'approved'
       ORDER BY v.reviewed_at DESC NULLS LAST LIMIT 1)
    ) AS voucher_id_resolved,
    l.id as loan_id, l.disbursed_amount,
    d.dni, d.first_name as driver_first_name, d.last_name as driver_last_name
  `;

  const orderBy = ` ORDER BY p.payment_date DESC, p.created_at DESC`;
  const limit = filters.limit != null ? Math.min(Math.max(1, parseInt(filters.limit, 10) || 10), 100) : null;
  const offset = filters.offset != null ? Math.max(0, parseInt(filters.offset, 10) || 0) : null;

  if (limit != null) {
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM module_rapidin_payments p LEFT JOIN module_rapidin_loans l ON l.id = p.loan_id WHERE 1=1 ${whereClause}`, params);
    const total = countResult.rows[0]?.total ?? 0;
    const dataSql = `SELECT ${selectFields} ${baseSql} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
    const result = await query(dataSql, params);
    return { data: result.rows, total };
  }

  const sql = `SELECT ${selectFields} ${baseSql} ${orderBy}`;
  const result = await query(sql, params);
  return result.rows;
};

/** Lista el log de cobros automáticos (tabla module_rapidin_auto_payment_log) con filtros y paginación */
export const getAutoPaymentLog = async (filters = {}) => {
  const params = [];
  let n = 1;
  let where = ' WHERE 1=1 ';
  if (filters.date_from) {
    where += ` AND created_at >= $${n}`;
    params.push(filters.date_from);
    n += 1;
  }
  if (filters.date_to) {
    where += ` AND created_at::date <= $${n}`;
    params.push(filters.date_to);
    n += 1;
  }
  if (filters.status && (filters.status === 'success' || filters.status === 'failed')) {
    where += ` AND status = $${n}`;
    params.push(filters.status);
    n += 1;
  }
  if (filters.driver && String(filters.driver).trim()) {
    where += ` AND (driver_first_name ILIKE $${n} OR driver_last_name ILIKE $${n + 1})`;
    const term = `%${String(filters.driver).trim()}%`;
    params.push(term, term);
    n += 2;
  }
  const limit = filters.limit != null ? Math.min(100, Math.max(1, parseInt(filters.limit, 10) || 20)) : 20;
  const offset = filters.offset != null ? Math.max(0, parseInt(filters.offset, 10) || 0) : 0;

  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM module_rapidin_auto_payment_log ${where}`,
    params
  );
  const total = countResult.rows[0]?.total ?? 0;

  const dataResult = await query(
    `SELECT * FROM module_rapidin_auto_payment_log ${where}
     ORDER BY created_at DESC
     LIMIT $${n} OFFSET $${n + 1}`,
    [...params, limit, offset]
  );
  return { data: dataResult.rows, total };
};



