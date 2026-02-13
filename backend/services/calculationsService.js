import { query } from '../config/database.js';
import { getNextMondayFrom } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export const validateDNI = async (dni) => {
  // Aceptar DNI (8 dígitos) o Cédula (10 dígitos), independientemente del país donde trabaja
  const len = (dni || '').replace(/\D/g, '').length;
  if (len !== 8 && len !== 10) {
    return { valid: false, message: 'El documento debe tener 8 dígitos (DNI) o 10 dígitos (Cédula)' };
  }
  return { valid: true };
};

export const getDriver = async (dni, country) => {
  const result = await query(
    'SELECT * FROM module_rapidin_drivers WHERE dni = $1 AND country = $2',
    [dni, country]
  );

  return result.rows[0] || null;
};

/** Busca en module_rapidin_drivers por dni + country + park_id (una fila por flota). */
export const getDriverByPark = async (dni, country, park_id) => {
  if (park_id == null || park_id === '') return null;
  const result = await query(
    'SELECT * FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 AND COALESCE(park_id, \'\') = $3 LIMIT 1',
    [dni, country, String(park_id).trim()]
  );
  return result.rows[0] || null;
};

/** Busca en module_rapidin_drivers por (phone, country, park_id) — clave del índice único idx_rapidin_drivers_phone_country_park. */
export const getDriverByPhoneAndPark = async (phone, country, park_id) => {
  if (!phone) return null;
  const parkNorm = (park_id == null || park_id === '') ? '' : String(park_id).trim();
  const result = await query(
    `SELECT * FROM module_rapidin_drivers 
     WHERE country = $1 AND COALESCE(park_id, '') = $2 
       AND (phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = REGEXP_REPLACE($4, '[^0-9]', '', 'g'))
     LIMIT 1`,
    [country, parkNorm, (phone || '').trim(), (phone || '').trim()]
  );
  return result.rows[0] || null;
};

/** Inserta una nueva fila en module_rapidin_drivers (rapidin_drivers). Una fila por (phone, country, park_id); distinto park_id = nueva fila. */
export const createDriverForPark = async (data) => {
  const { dni, country, first_name, last_name, phone, email, yego_premium, park_id } = data;
  const result = await query(
    `INSERT INTO module_rapidin_drivers (dni, country, first_name, last_name, phone, email, yego_premium, park_id, cycle, credit_line)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 0)
     RETURNING *`,
    [dni, country, first_name || '', last_name || '', phone || '', email || '', yego_premium ?? false, park_id || null]
  );
  return result.rows[0];
};

/** Crea o actualiza en module_rapidin_drivers. Si viene park_id: solo esa flota (buscar por phone+country+park_id; si no existe → INSERT nueva fila). Sin park_id: lógica por dni+country. */
export const createOrUpdateDriver = async (data) => {
  const { dni, country, first_name, last_name, phone, email, yego_premium, park_id } = data;
  const parkVal = park_id ?? null;

  // Si eligió flota (park_id): NUNCA actualizar la fila de otra flota. Buscar solo (phone, country, park_id); si no existe → INSERT (registrar nueva flota).
  if (parkVal !== null && parkVal !== '') {
    const existingByPhonePark = phone ? await getDriverByPhoneAndPark(phone, country, parkVal) : null;
    if (existingByPhonePark) {
      await query(
        `UPDATE module_rapidin_drivers 
         SET first_name = $1, last_name = $2, dni = $3, phone = $4, email = $5, yego_premium = $6, updated_at = CURRENT_TIMESTAMP
         WHERE id = $7`,
        [first_name, last_name, dni, phone, email, yego_premium ?? false, existingByPhonePark.id]
      );
      const updated = await query('SELECT * FROM module_rapidin_drivers WHERE id = $1 LIMIT 1', [existingByPhonePark.id]);
      return updated.rows[0] || null;
    }
    // No existe Julio+Barranquilla → INSERT nueva fila (no tocar la de Bogotá).
    const result = await query(
      `INSERT INTO module_rapidin_drivers (dni, country, first_name, last_name, phone, email, yego_premium, park_id, cycle, credit_line)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 0)
       RETURNING *`,
      [dni, country, first_name, last_name, phone, email, yego_premium ?? false, parkVal]
    );
    return result.rows[0];
  }

  // Sin park_id: buscar por dni+country y actualizar, o por (phone, country, null) para no duplicar.
  const existingByDni = await getDriver(dni, country);
  if (existingByDni) {
    await query(
      `UPDATE module_rapidin_drivers 
       SET first_name = $1, last_name = $2, phone = $3, email = $4, yego_premium = $5, updated_at = CURRENT_TIMESTAMP
       WHERE dni = $6 AND country = $7`,
      [first_name, last_name, phone, email, yego_premium, dni, country]
    );
    return await getDriver(dni, country);
  }

  const existingByPhonePark = phone ? await getDriverByPhoneAndPark(phone, country, null) : null;
  if (existingByPhonePark) {
    await query(
      `UPDATE module_rapidin_drivers 
       SET first_name = $1, last_name = $2, dni = $3, phone = $4, email = $5, yego_premium = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7`,
      [first_name, last_name, dni, phone, email, yego_premium ?? false, existingByPhonePark.id]
    );
    const updated = await query('SELECT * FROM module_rapidin_drivers WHERE id = $1 LIMIT 1', [existingByPhonePark.id]);
    return updated.rows[0] || null;
  }

  const result = await query(
    `INSERT INTO module_rapidin_drivers (dni, country, first_name, last_name, phone, email, yego_premium, park_id, cycle, credit_line)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 0)
     RETURNING *`,
    [dni, country, first_name, last_name, phone, email, yego_premium ?? false, null]
  );

  return result.rows[0];
};

export const calculateCycle = async (driverId) => {
  const result = await query(
    `SELECT COUNT(*) as total_paid_loans 
     FROM module_rapidin_loans 
     WHERE driver_id = $1 AND status = 'cancelled'`,
    [driverId]
  );

  const paidLoans = parseInt(result.rows[0].total_paid_loans) || 0;
  return Math.min(paidLoans + 1, 5);
};

/**
 * Puntualidad de pago del conductor: % de cuotas pagadas a tiempo.
 * A tiempo = paid_date <= due_date. Tardío = paid_date > due_date o status overdue.
 * Si no tiene cuotas resueltas, devuelve 1 (no penalizar).
 * @param {string} driverId - UUID del conductor
 * @returns {Promise<number>} Valor entre 0 y 1 (ej. 0.35 = 35%)
 */
export const getPaymentPunctuality = async (driverId) => {
  const result = await query(
    `SELECT 
       COUNT(*) FILTER (WHERE i.status = 'paid' AND i.paid_date IS NOT NULL AND i.paid_date <= i.due_date) AS on_time,
       COUNT(*) FILTER (WHERE (i.status = 'paid' AND i.paid_date IS NOT NULL AND i.paid_date > i.due_date) OR i.status = 'overdue') AS late_or_overdue
     FROM module_rapidin_installments i
     JOIN module_rapidin_loans l ON l.id = i.loan_id
     WHERE l.driver_id = $1`,
    [driverId]
  );
  const row = result.rows[0];
  const onTime = parseInt(row?.on_time, 10) || 0;
  const lateOrOverdue = parseInt(row?.late_or_overdue, 10) || 0;
  const total = onTime + lateOrOverdue;
  if (total === 0) return 1;
  return onTime / total;
};

export const getCreditLine = async (driverId, country) => {
  const driver = await query(
    'SELECT cycle FROM module_rapidin_drivers WHERE id = $1',
    [driverId]
  );

  if (driver.rows.length === 0) {
    return 0;
  }

  const cycle = driver.rows[0].cycle;

  const conditions = await query(
    'SELECT max_credit_line FROM module_rapidin_cycle_config WHERE country = $1 AND cycle = $2 AND active = true',
    [country, cycle]
  );

  if (conditions.rows.length === 0) {
    return 0;
  }

  return parseFloat(conditions.rows[0].max_credit_line);
};

export const getInterestRate = async (country, cycle) => {
  const result = await query(
    'SELECT interest_rate FROM module_rapidin_cycle_config WHERE country = $1 AND cycle = $2 AND active = true',
    [country, cycle]
  );

  if (result.rows.length === 0) {
    return 5.0; // solo si no hay fila en module_rapidin_cycle_config para este country/ciclo
  }

  return parseFloat(result.rows[0].interest_rate);
};

/**
 * Cuota fija (interés sobre saldo): Cuota = P × [i × (1+i)^n] / [(1+i)^n - 1]
 * P = capital, i = tasa por periodo (ej. 0.05 = 5% semanal), n = número de cuotas.
 */
function fixedInstallmentFormula(P, iPerPeriod, n) {
  if (n <= 0 || P <= 0) return 0;
  if (iPerPeriod === 0) return Math.round((P / n) * 100) / 100;
  const onePlusI = 1 + iPerPeriod;
  const factor = Math.pow(onePlusI, n);
  const numerator = iPerPeriod * factor;
  const denominator = factor - 1;
  const cuota = P * (numerator / denominator);
  return Math.round(cuota * 100) / 100;
}

/**
 * Genera el cronograma cuota a cuota: interés sobre saldo insoluto.
 * Devuelve array de { installment_number, installment_amount, principal_amount, interest_amount }.
 */
function buildScheduleFromFixedCuota(P, iPerPeriod, n, fixedCuota) {
  const schedule = [];
  let balance = P;
  const roundedCuota = Math.round(fixedCuota * 100) / 100;

  for (let k = 1; k <= n; k++) {
    const interestAmount = Math.round(balance * iPerPeriod * 100) / 100;
    let principalAmount;
    let installmentAmount;
    if (k === n) {
      principalAmount = Math.round(balance * 100) / 100;
      installmentAmount = Math.round((principalAmount + interestAmount) * 100) / 100;
    } else {
      principalAmount = Math.round((roundedCuota - interestAmount) * 100) / 100;
      installmentAmount = roundedCuota;
    }
    schedule.push({
      installment_number: k,
      installment_amount: installmentAmount,
      principal_amount: principalAmount,
      interest_amount: interestAmount
    });
    balance -= principalAmount;
    balance = Math.round(balance * 100) / 100;
  }
  return schedule;
}

export const simulateLoanOptions = async (amount, country, cycle, conditions) => {
  const interestRate = await getInterestRate(country, cycle);
  const i = (interestRate / 100);
  const weeks = cycle < 7 ? 5 : 3;

  const cuotaFija = fixedInstallmentFormula(amount, i, weeks);
  const totalAmount = Math.round(cuotaFija * weeks * 100) / 100;
  const totalInterest = Math.round((totalAmount - amount) * 100) / 100;

  const firstPaymentDate = getNextMondayFrom(new Date());
  const y = firstPaymentDate.getFullYear();
  const m = String(firstPaymentDate.getMonth() + 1).padStart(2, '0');
  const day = String(firstPaymentDate.getDate()).padStart(2, '0');
  const firstPaymentDateStr = `${y}-${m}-${day}`;

  const schedule = buildScheduleFromFixedCuota(amount, i, weeks, cuotaFija);

  return {
    option: {
      weeks,
      weeklyInstallment: cuotaFija,
      lastInstallment: schedule[schedule.length - 1]?.installment_amount ?? cuotaFija,
      totalAmount,
      totalInterest,
      interestRate,
      type: 'STANDARD',
      firstPaymentDate: firstPaymentDateStr,
      schedule
    }
  };
};

/**
 * Genera y persiste el cronograma de cuotas con interés sobre saldo.
 * Usa la misma fórmula: cuota fija = P × [i×(1+i)^n]/[(1+i)^n-1] y reparto cuota a cuota.
 */
export const generateInstallmentSchedule = async (loanId, disbursedAmount, interestRatePercent, numberOfInstallments, firstPaymentDate) => {
  const P = parseFloat(disbursedAmount) || 0;
  const i = (parseFloat(interestRatePercent) || 0) / 100;
  const n = Math.max(1, parseInt(numberOfInstallments, 10) || 1);

  const cuotaFija = fixedInstallmentFormula(P, i, n);
  const schedule = buildScheduleFromFixedCuota(P, i, n, cuotaFija);

  const startDate = new Date(firstPaymentDate);
  const installments = [];

  for (let k = 0; k < schedule.length; k++) {
    const row = schedule[k];
    const dueDate = new Date(startDate);
    dueDate.setDate(startDate.getDate() + k * 7);
    const dueDateStr = dueDate.toISOString().split('T')[0];

    await query(
      `INSERT INTO module_rapidin_installments 
       (loan_id, installment_number, installment_amount, principal_amount, interest_amount, due_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [loanId, row.installment_number, row.installment_amount, row.principal_amount, row.interest_amount, dueDateStr]
    );

    installments.push({
      installment_number: row.installment_number,
      installment_amount: row.installment_amount,
      due_date: dueDateStr
    });
  }

  return installments;
};







