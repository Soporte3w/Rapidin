import { query } from '../config/database.js';
import { getCreditLine, getInterestRate, simulateLoanOptions, generateInstallmentSchedule } from './calculationsService.js';
import { getNextMondayFrom, isSunday } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export const createLoanRequest = async (data, userId = null, options = {}) => {
  const { driver_id, country, requested_amount, observations } = data;
  const createdByAdmin = options.createdByAdmin === true;

  // El flujo del conductor: no puede tener préstamo activo ni solicitud en proceso. El admin puede crear otra solicitud igual.
  if (!createdByAdmin) {
    // Verificar si el conductor tiene un préstamo activo. Solo bloquear si la última fecha del cronograma aún no ha pasado (aunque haya adelantado pagos).
    const activeLoan = await query(
      `SELECT l.id, l.status, MAX(i.due_date) as last_schedule_due_date
       FROM module_rapidin_loans l
       LEFT JOIN module_rapidin_installments i ON i.loan_id = l.id
       WHERE l.driver_id = $1 AND l.status = 'active'
       GROUP BY l.id, l.status
       LIMIT 1`,
      [driver_id]
    );

    if (activeLoan.rows.length > 0) {
      const lastScheduleDueDate = activeLoan.rows[0].last_schedule_due_date;
      if (lastScheduleDueDate) {
        const lastDate = new Date(lastScheduleDueDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        lastDate.setHours(0, 0, 0, 0);
        if (lastDate > today) {
          const fechaStr = lastDate.toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' });
          throw new Error(`Debes esperar hasta el ${fechaStr} (última fecha de tu cronograma) para solicitar un nuevo préstamo. Aunque hayas adelantado tus pagos, podrás solicitar a partir de esa fecha.`);
        }
      } else {
        throw new Error('Ya tienes un préstamo activo. Debes completar o cancelar tu préstamo actual antes de solicitar uno nuevo.');
      }
    }

    // Si tiene préstamo cancelado pero la última fecha del cronograma aún no ha llegado (pagó adelantado), debe esperar
    const cancelledWithFutureDate = await query(
      `SELECT MAX(i.due_date) as last_schedule_due_date
       FROM module_rapidin_loans l
       JOIN module_rapidin_installments i ON i.loan_id = l.id
       WHERE l.driver_id = $1 AND l.status = 'cancelled'
       GROUP BY l.id
       HAVING MAX(i.due_date) > CURRENT_DATE
       LIMIT 1`,
      [driver_id]
    );
    if (cancelledWithFutureDate.rows.length > 0 && cancelledWithFutureDate.rows[0].last_schedule_due_date) {
      const lastDate = new Date(cancelledWithFutureDate.rows[0].last_schedule_due_date);
      const fechaStr = lastDate.toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' });
      throw new Error(`No puedes solicitar un nuevo préstamo hasta cumplir la última fecha de tu cronograma. Podrás solicitar a partir del ${fechaStr}.`);
    }

    // Verificar si el conductor tiene una solicitud que bloquea (disbursed con préstamo cancelado no bloquea)
    const pendingRequest = await query(
      `SELECT r.id, r.status 
       FROM module_rapidin_loan_requests r
       LEFT JOIN module_rapidin_loans l ON l.request_id = r.id
       WHERE r.driver_id = $1 
         AND (
           r.status IN ('pending', 'approved', 'signed')
           OR (r.status = 'disbursed' AND (l.id IS NULL OR l.status != 'cancelled'))
         )
       LIMIT 1`,
      [driver_id]
    );

    if (pendingRequest.rows.length > 0) {
      const status = pendingRequest.rows[0].status;
      const statusMessages = {
        'pending': 'Ya tienes una solicitud de préstamo pendiente. Espera a que sea procesada.',
        'approved': 'Ya tienes una solicitud de préstamo aprobada. Completa el proceso actual antes de solicitar uno nuevo.',
        'signed': 'Ya tienes una solicitud de préstamo firmada. Completa el proceso actual antes de solicitar uno nuevo.',
        'disbursed': 'Ya tienes una solicitud de préstamo desembolsada. Completa el proceso actual antes de solicitar uno nuevo.'
      };
      throw new Error(statusMessages[status] || 'Ya tienes una solicitud de préstamo en proceso.');
    }
  }

  const creditLine = await getCreditLine(driver_id, country);

  if (requested_amount > creditLine) {
    throw new Error(`El monto solicitado excede la línea de crédito disponible (${creditLine})`);
  }

  const result = await query(
    `INSERT INTO module_rapidin_loan_requests 
     (driver_id, country, requested_amount, status, observations, created_by)
     VALUES ($1, $2, $3, 'pending', $4, $5)
     RETURNING *`,
    [driver_id, country, requested_amount, observations, userId]
  );

  return result.rows[0];
};

export const getLoanRequests = async (filters = {}) => {
  let sql = `
    SELECT r.*,
           l.disbursed_amount AS disbursed_amount,
           d.dni, d.first_name as driver_first_name, d.last_name as driver_last_name,
           d.cycle AS driver_cycle,
           u.first_name as created_by_first_name
    FROM module_rapidin_loan_requests r
    LEFT JOIN module_rapidin_loans l ON l.request_id = r.id
    LEFT JOIN module_rapidin_drivers d ON d.id = r.driver_id
    LEFT JOIN module_rapidin_users u ON u.id = r.created_by
    WHERE 1=1
  `;
  const params = [];
  let paramCount = 1;

  if (filters.status) {
    sql += ` AND r.status = $${paramCount++}`;
    params.push(filters.status);
  }

  if (filters.country) {
    sql += ` AND r.country = $${paramCount++}`;
    params.push(filters.country);
  }

  if (filters.driver_id) {
    sql += ` AND r.driver_id = $${paramCount++}`;
    params.push(filters.driver_id);
  }

  if (filters.driver && filters.driver.trim()) {
    const driverTerm = `%${filters.driver.trim()}%`;
    sql += ` AND (d.first_name ILIKE $${paramCount} OR d.last_name ILIKE $${paramCount} OR d.dni ILIKE $${paramCount})`;
    params.push(driverTerm);
    paramCount += 1;
  }

  sql += ` ORDER BY r.created_at DESC`;

  if (filters.limit != null) {
    const fromWhere = sql.substring(sql.indexOf('FROM'), sql.indexOf('ORDER BY'));
    const countResult = await query('SELECT COUNT(*)::int AS total ' + fromWhere, params);
    const total = countResult.rows[0]?.total ?? 0;
    sql += ` LIMIT $${paramCount++}`;
    params.push(filters.limit);
    if (filters.offset != null) {
      sql += ` OFFSET $${paramCount++}`;
      params.push(filters.offset);
    }
    const result = await query(sql, params);
    return { data: result.rows, total };
  }

  if (filters.offset != null) {
    sql += ` OFFSET $${paramCount++}`;
    params.push(filters.offset);
  }

  const result = await query(sql, params);
  return result.rows;
};

export const getLoanRequestById = async (id) => {
  const result = await query(
    `SELECT r.*, 
            d.dni, d.first_name as driver_first_name, d.last_name as driver_last_name, d.phone, d.email, d.cycle as driver_cycle,
            u.first_name as created_by_first_name
     FROM module_rapidin_loan_requests r
     LEFT JOIN module_rapidin_drivers d ON d.id = r.driver_id
     LEFT JOIN module_rapidin_users u ON u.id = r.created_by
     WHERE r.id = $1`,
    [id]
  );

  return result.rows[0] || null;
};

export const rejectLoanRequest = async (id, reason, userId) => {
  await query(
    `UPDATE module_rapidin_loan_requests 
     SET status = 'rejected', rejection_reason = $1, approved_by = $2, approved_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [reason, userId, id]
  );

  return await getLoanRequestById(id);
};

export const applySimulationOption = async (requestId, option, userId) => {
  const request = await getLoanRequestById(requestId);

  if (!request) {
    throw new Error('Solicitud no encontrada');
  }

  if (request.status !== 'pending') {
    throw new Error('La solicitud no puede ser aprobada en su estado actual');
  }

  const driver = await query(
    'SELECT * FROM module_rapidin_drivers WHERE id = $1',
    [request.driver_id]
  );

  if (driver.rows.length === 0) {
    throw new Error('Conductor no encontrado');
  }

  const cycleFromDb = request.driver_cycle ?? driver.rows[0]?.cycle ?? 1;
  const interestRate = option.interestRate != null ? parseFloat(option.interestRate) : await getInterestRate(request.country, cycleFromDb);

  const conditions = await query(
    'SELECT * FROM module_rapidin_loan_conditions WHERE country = $1 AND active = true ORDER BY version DESC LIMIT 1',
    [request.country]
  );

  if (conditions.rows.length === 0) {
    throw new Error('No hay condiciones de préstamo configuradas');
  }

  const condition = conditions.rows[0];

  const approvedOption = {
    weeks: option.weeks,
    weeklyInstallment: option.weeklyInstallment,
    lastInstallment: option.lastInstallment,
    totalAmount: option.totalAmount,
    interestRate: interestRate,
  };

  let observationsJson = {};
  try {
    if (request.observations) {
      observationsJson = typeof request.observations === 'string' ? JSON.parse(request.observations) : request.observations;
    }
  } catch (_) {}
  observationsJson.approvedOption = approvedOption;
  const observationsStr = JSON.stringify(observationsJson);

  await query(
    `UPDATE module_rapidin_loan_requests 
     SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, observations = $2
     WHERE id = $3`,
    [userId, observationsStr, requestId]
  );

  return { request: await getLoanRequestById(requestId) };
};

export const disburseRequest = async (requestId, userId, options = {}) => {
  const request = await getLoanRequestById(requestId);
  if (!request) throw new Error('Solicitud no encontrada');
  const existingLoan = await getLoanByRequestId(requestId);
  if (existingLoan) {
    if (request.status !== 'disbursed') {
      await query(
        `UPDATE module_rapidin_loan_requests 
         SET status = 'disbursed', disbursed_at = COALESCE(disbursed_at, CURRENT_TIMESTAMP) 
         WHERE id = $1`,
        [requestId]
      );
    }
    return { loan: existingLoan, request: await getLoanRequestById(requestId) };
  }
  if (request.status !== 'approved') {
    throw new Error('Solo se puede desembolsar una solicitud en estado Aprobado');
  }

  let option = null;
  let observationsJson = {};
  try {
    if (request.observations) {
      observationsJson = typeof request.observations === 'string' ? JSON.parse(request.observations) : request.observations;
    }
  } catch (_) {}
  option = observationsJson?.approvedOption;
  if (option && option.weeks != null && option.weeklyInstallment != null) {
    option = { ...option, totalAmount: option.totalAmount ?? (option.weeklyInstallment * (option.weeks - 1) + (option.lastInstallment ?? option.weeklyInstallment)) };
  } else {
    option = null;
  }

  if (!option) {
    const driver = await query('SELECT * FROM module_rapidin_drivers WHERE id = $1', [request.driver_id]);
    if (driver.rows.length === 0) throw new Error('Conductor no encontrado');
    const cycleFromDb = request.driver_cycle ?? driver.rows[0]?.cycle ?? 1;
    const conditions = await query(
      'SELECT * FROM module_rapidin_loan_conditions WHERE country = $1 AND active = true ORDER BY version DESC LIMIT 1',
      [request.country]
    );
    if (conditions.rows.length === 0) throw new Error('No hay condiciones de préstamo configuradas');
    const sim = await simulateLoanOptions(
      parseFloat(request.requested_amount) || 0,
      request.country,
      cycleFromDb,
      conditions.rows[0]
    );
    const simOption = sim?.option;
    if (!simOption || simOption.weeks == null || simOption.weeklyInstallment == null) {
      throw new Error('No se pudo calcular la opción de préstamo. Verifique monto y condiciones.');
    }
    option = {
      weeks: simOption.weeks,
      weeklyInstallment: simOption.weeklyInstallment,
      lastInstallment: simOption.lastInstallment,
      totalAmount: simOption.totalAmount,
      interestRate: simOption.interestRate,
    };
  }

  const disbursementDate = new Date();
  if (isSunday(disbursementDate)) {
    throw new Error('No se puede desembolsar los domingos. El desembolso está disponible de lunes a sábado.');
  }

  let firstPaymentDateStr;
  if (options.first_payment_today) {
    firstPaymentDateStr = `${disbursementDate.getFullYear()}-${String(disbursementDate.getMonth() + 1).padStart(2, '0')}-${String(disbursementDate.getDate()).padStart(2, '0')}`;
  } else if (options.first_payment_date && /^\d{4}-\d{2}-\d{2}$/.test(options.first_payment_date)) {
    firstPaymentDateStr = options.first_payment_date;
  } else {
    const firstPaymentDateObj = getNextMondayFrom(disbursementDate);
    firstPaymentDateStr = `${firstPaymentDateObj.getFullYear()}-${String(firstPaymentDateObj.getMonth() + 1).padStart(2, '0')}-${String(firstPaymentDateObj.getDate()).padStart(2, '0')}`;
  }

  const driver = await query('SELECT * FROM module_rapidin_drivers WHERE id = $1', [request.driver_id]);
  if (driver.rows.length === 0) throw new Error('Conductor no encontrado');
  const cycleFromDb = request.driver_cycle ?? driver.rows[0]?.cycle ?? 1;
  const interestRate = option.interestRate != null ? parseFloat(option.interestRate) : await getInterestRate(request.country, cycleFromDb);

  await query('BEGIN');
  try {
    const loanResult = await query(
      `INSERT INTO module_rapidin_loans 
       (request_id, driver_id, country, disbursed_amount, total_amount, interest_rate, 
        number_of_installments, disbursed_at, first_payment_date, pending_balance, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, $8, $5, 'active')
       RETURNING *`,
      [
        requestId,
        request.driver_id,
        request.country,
        request.requested_amount,
        option.totalAmount,
        interestRate,
        option.weeks,
        firstPaymentDateStr,
      ]
    );
    const loan = loanResult.rows[0];

    await query(
      `UPDATE module_rapidin_loan_requests 
       SET status = 'disbursed', disbursed_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [requestId]
    );

    await query(
      `UPDATE module_rapidin_documents 
       SET loan_id = $1 
       WHERE loan_id IS NULL 
       AND (request_id = $2 OR file_path LIKE $3 OR file_name LIKE $3)`,
      [loan.id, requestId, `%${requestId}%`]
    );

    await generateInstallmentSchedule(
      loan.id,
      request.requested_amount,
      option.interestRate ?? interestRate,
      option.weeks,
      firstPaymentDateStr
    );

    await query('COMMIT');
    return { loan, request: await getLoanRequestById(requestId) };
  } catch (error) {
    await query('ROLLBACK');
    throw error;
  }
};

export const getLoanByRequestId = async (requestId) => {
  const result = await query(
    'SELECT * FROM module_rapidin_loans WHERE request_id = $1 LIMIT 1',
    [requestId]
  );
  return result.rows[0] || null;
};

export const getLoans = async (filters = {}) => {
  let sql = `
    SELECT l.*, 
           d.dni, d.first_name as driver_first_name, d.last_name as driver_last_name,
           d.external_driver_id,
           COALESCE((SELECT SUM(COALESCE(i.late_fee, 0)) FROM module_rapidin_installments i WHERE i.loan_id = l.id), 0)::numeric AS total_late_fee
    FROM module_rapidin_loans l
    LEFT JOIN module_rapidin_drivers d ON d.id = l.driver_id
    WHERE 1=1
  `;
  const params = [];
  let paramCount = 1;

  if (filters.status) {
    sql += ` AND l.status = $${paramCount++}`;
    params.push(filters.status);
  }

  if (filters.country) {
    sql += ` AND l.country = $${paramCount++}`;
    params.push(filters.country);
  }

  if (filters.driver && filters.driver.trim()) {
    const driverTerm = `%${filters.driver.trim()}%`;
    sql += ` AND (d.first_name ILIKE $${paramCount} OR d.last_name ILIKE $${paramCount} OR d.dni ILIKE $${paramCount})`;
    params.push(driverTerm);
    paramCount += 1;
  }

  if (filters.loan_id && filters.loan_id.trim()) {
    const loanIdTerm = `%${filters.loan_id.trim()}%`;
    sql += ` AND l.id::text ILIKE $${paramCount}`;
    params.push(loanIdTerm);
    paramCount += 1;
  }

  sql += ` ORDER BY l.created_at DESC`;

  const limit = filters.limit != null ? Math.min(Math.max(1, parseInt(filters.limit, 10) || 10), 100) : null;
  const offset = filters.offset != null ? Math.max(0, parseInt(filters.offset, 10) || 0) : null;

  if (limit != null) {
    // Usar lastIndexOf('FROM') para el FROM principal (el SELECT tiene un subquery con FROM)
    const fromWhere = sql.substring(sql.lastIndexOf('FROM'), sql.indexOf('ORDER BY'));
    const countResult = await query('SELECT COUNT(*)::int AS total ' + fromWhere, params);
    const total = countResult.rows[0]?.total ?? 0;
    sql += ` LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(limit, offset ?? 0);
    const result = await query(sql, params);
    return { data: result.rows, total };
  }

  const result = await query(sql, params);
  return result.rows;
};

export const getLoanById = async (id) => {
  const result = await query(
    `SELECT l.*, 
            d.dni, d.first_name as driver_first_name, d.last_name as driver_last_name, d.phone, d.email,
            d.external_driver_id,
            COALESCE((SELECT SUM(COALESCE(i.late_fee, 0)) FROM module_rapidin_installments i WHERE i.loan_id = l.id), 0)::numeric AS total_late_fee,
            (SELECT (i.installment_amount - COALESCE(i.paid_amount, 0)) + COALESCE(i.late_fee, 0)
             FROM module_rapidin_installments i
             WHERE i.loan_id = l.id AND i.status IN ('pending', 'overdue')
             ORDER BY i.due_date ASC
             LIMIT 1) AS next_installment_amount,
            (SELECT COALESCE(i.late_fee, 0)
             FROM module_rapidin_installments i
             WHERE i.loan_id = l.id AND i.status IN ('pending', 'overdue')
             ORDER BY i.due_date ASC
             LIMIT 1) AS next_installment_late_fee
     FROM module_rapidin_loans l
     LEFT JOIN module_rapidin_drivers d ON d.id = l.driver_id
     WHERE l.id = $1`,
    [id]
  );

  const row = result.rows[0];
  if (!row) return null;
  if (row.next_installment_amount != null) row.next_installment_amount = parseFloat(row.next_installment_amount);
  if (row.next_installment_late_fee != null) row.next_installment_late_fee = parseFloat(row.next_installment_late_fee);
  if (row.total_late_fee != null) row.total_late_fee = parseFloat(row.total_late_fee);
  return row;
};

export const getInstallmentSchedule = async (loanId) => {
  // Recalcular mora de cuotas vencidas de este préstamo para que la pantalla siempre muestre mora al día
  const overdueForLoan = await query(
    `SELECT i.id FROM module_rapidin_installments i
     JOIN module_rapidin_loans l ON l.id = i.loan_id
     WHERE i.loan_id = $1 AND l.status = 'active'
       AND i.status IN ('pending', 'overdue')
       AND i.due_date < CURRENT_DATE
       AND (i.installment_amount + COALESCE(i.late_fee, 0) - COALESCE(i.paid_amount, 0)) > 0`,
    [loanId]
  );
  for (const row of overdueForLoan.rows) {
    const feeRes = await query('SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee', [row.id]);
    const newLateFee = Math.max(0, parseFloat(feeRes.rows[0]?.late_fee) || 0);
    await query(
      `UPDATE module_rapidin_installments
       SET late_fee = $1, days_overdue = GREATEST(0, CURRENT_DATE - COALESCE(late_fee_base_date, due_date)), status = 'overdue', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [newLateFee, row.id]
    );
  }
  if (overdueForLoan.rows.length > 0) {
    const sumRes = await query(
      `SELECT SUM((installment_amount - COALESCE(paid_amount, 0)) + COALESCE(late_fee, 0)) AS pending_balance
       FROM module_rapidin_installments WHERE loan_id = $1 AND status != 'cancelled'`,
      [loanId]
    );
    const pendingBalance = sumRes.rows[0]?.pending_balance ?? 0;
    await query(`UPDATE module_rapidin_loans SET pending_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [pendingBalance, loanId]);
  }

  const result = await query(
    `SELECT 
       id, loan_id, installment_number, installment_amount, principal_amount, interest_amount,
       due_date, paid_date, paid_amount,
       GREATEST(0, COALESCE(late_fee, 0))::numeric AS late_fee,
       COALESCE(paid_late_fee, 0)::numeric AS paid_late_fee,
       days_overdue, status, created_at, updated_at
     FROM module_rapidin_installments 
     WHERE loan_id = $1 
     ORDER BY installment_number`,
    [loanId]
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rows = result.rows.map((r) => {
    const lateFee = Math.max(0, parseFloat(r.late_fee) || 0);
    const paidLateFee = Math.max(0, parseFloat(r.paid_late_fee) || 0);
    const paid = r.status === 'paid' || (parseFloat(r.paid_amount) || 0) >= (parseFloat(r.installment_amount) || 0);
    const dueDate = r.due_date ? new Date(r.due_date) : null;
    dueDate && dueDate.setHours(0, 0, 0, 0);
    const isOverdue = !paid && dueDate && dueDate.getTime() < today.getTime();
    const effectiveStatus = paid ? r.status : (isOverdue ? 'overdue' : (r.status || 'pending'));
    return { ...r, late_fee: lateFee, paid_late_fee: paidLateFee, status: effectiveStatus };
  });
  return rows;
};







