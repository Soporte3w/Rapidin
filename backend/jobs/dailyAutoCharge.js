import cron from 'node-cron';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { getContractorBalance, withdrawFromContractor } from '../services/yangoService.js';
import { registerPaymentAuto, updateLoanBalance } from '../services/paymentService.js';

/**
 * Actualiza la mora diaria para todas las cuotas vencidas (due_date < hoy), estén en pending u overdue.
 */
export const updateDailyLateFees = async () => {
  logger.info('Actualizando mora diaria para todas las cuotas vencidas...');

  try {
    const overdueResult = await query(`
     SELECT i.id, i.loan_id, i.due_date, i.installment_amount, i.paid_amount, i.late_fee
     FROM module_rapidin_installments i
     JOIN module_rapidin_loans l ON l.id = i.loan_id
     WHERE l.status = 'active'
       AND i.status IN ('pending', 'overdue')
       AND i.due_date < CURRENT_DATE
       AND (i.installment_amount + COALESCE(i.late_fee, 0) - COALESCE(i.paid_amount, 0)) > 0`);

    let updated = 0;
    for (const inst of overdueResult.rows) {
      const feeResult = await query('SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee', [inst.id]);
      const newLateFee = feeResult.rows[0]?.late_fee || 0;

      await query(`
        UPDATE module_rapidin_installments
        SET late_fee = $1,
            days_overdue = GREATEST(0, CURRENT_DATE - COALESCE(late_fee_base_date, due_date)),
            status = 'overdue',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`, [newLateFee, inst.id]);

      updated++;
    }
    const loanIds = [...new Set(overdueResult.rows.map((i) => i.loan_id))];
    for (const loanId of loanIds) {
      await updateLoanBalance(loanId);
    }
    logger.info(`Mora diaria actualizada: ${updated} cuotas actualizadas`);
    return updated;
  } catch (error) {
    logger.error('Error actualizando mora diaria:', error);
    return 0;
  }
};

/**
 * Actualiza la mora solo para cuotas vencidas del préstamo activo de un conductor (para demo/cobro por conductor sin tocar todo el portafolio).
 */
export const updateLateFeesForDriver = async (driverId) => {
  const overdueResult = await query(`
     SELECT i.id, i.loan_id
     FROM module_rapidin_installments i
     JOIN module_rapidin_loans l ON l.id = i.loan_id
     WHERE l.driver_id = $1 AND l.status = 'active'
       AND i.status IN ('pending', 'overdue')
       AND i.due_date < CURRENT_DATE
       AND (i.installment_amount + COALESCE(i.late_fee, 0) - COALESCE(i.paid_amount, 0)) > 0`,
    [driverId]
  );
  if (overdueResult.rows.length === 0) return 0;
  for (const inst of overdueResult.rows) {
    const feeResult = await query('SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee', [inst.id]);
    const newLateFee = feeResult.rows[0]?.late_fee || 0;
    await query(`
      UPDATE module_rapidin_installments
      SET late_fee = $1,
          days_overdue = GREATEST(0, CURRENT_DATE - COALESCE(late_fee_base_date, due_date)),
          status = 'overdue',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`, [newLateFee, inst.id]);
  }
  const loanIds = [...new Set(overdueResult.rows.map((i) => i.loan_id))];
  for (const loanId of loanIds) {
    await updateLoanBalance(loanId);
  }
  logger.info(`Mora actualizada para ${overdueResult.rows.length} cuota(s) del conductor`);
  return overdueResult.rows.length;
};

/**
 * Lunes (1): solo cuotas pending que vencen HOY (due_date = hoy).
 * Martes (2): cuotas overdue/vencidas que no se cobraron o cobraron parcialmente (due_date < hoy).
 * Resto de días: no se ejecuta cobro automático.
 */
const getDueInstallmentsForAutoCharge = async (dayOfWeek, driverIdFilter = null) => {
  let statusFilter, dateCondition;

  if (dayOfWeek === 1) {
    // Lunes: cuotas pending que vencen hoy
    statusFilter = 'pending';
    dateCondition = 'i.due_date = CURRENT_DATE';
  } else if (dayOfWeek === 2) {
    // Martes: cuotas overdue (vencidas que no se cobraron completas)
    statusFilter = 'overdue';
    dateCondition = 'i.due_date < CURRENT_DATE';
  } else {
    return [];
  }

  const driverFilter = driverIdFilter ? 'AND d.id = $2' : '';
  const params = driverIdFilter ? [statusFilter, driverIdFilter] : [statusFilter];

  const result = await query(`
     SELECT
       i.id AS installment_id,
       i.loan_id,
       i.installment_number,
       i.installment_amount,
       i.paid_amount,
       i.late_fee,
       i.due_date,
       i.status AS installment_status,
       d.id AS driver_id,
       d.dni AS driver_dni,
       d.external_driver_id,
       d.first_name AS driver_first_name,
       d.last_name AS driver_last_name,
       d.park_id AS flota
     FROM module_rapidin_loans l
     JOIN module_rapidin_drivers d ON d.id = l.driver_id
     JOIN module_rapidin_installments i ON i.loan_id = l.id
     WHERE l.status = 'active'
       AND i.status = $1
       AND ${dateCondition}
       AND (i.installment_amount + COALESCE(i.late_fee, 0) - COALESCE(i.paid_amount, 0)) > 0
       ${driverFilter}
     ORDER BY i.due_date ASC, i.installment_number ASC`, params);

  return result.rows;
};

const markInstallmentOverdueAndLateFee = async (installmentId) => {
  const feeResult = await query('SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee', [installmentId]);
  const lateFee = feeResult.rows[0]?.late_fee || 0;

  await query(`
     UPDATE module_rapidin_installments
     SET late_fee = $1,
         days_overdue = GREATEST(0, CURRENT_DATE - due_date),
         status = 'overdue',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`, [lateFee, installmentId]);

  return lateFee;
};

/** Solo marca la cuota como vencida (status, days_overdue). No recalcula mora: queda en 0 hasta el día siguiente (job de mora). */
const markInstallmentOverdueOnly = async (installmentId) => {
  await query(`
     UPDATE module_rapidin_installments
     SET days_overdue = GREATEST(0, CURRENT_DATE - due_date),
         status = 'overdue',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`, [installmentId]);
};

const logAutoPaymentAttempt = async (inst, amountToCharge, amountCharged, status, reason, balance, paymentId = null) => {
  await query(`INSERT INTO module_rapidin_auto_payment_log
     (loan_id, installment_id, driver_id, external_driver_id, driver_first_name, driver_last_name, flota,
      amount_to_charge, amount_charged, installment_number, status, reason, balance_at_attempt, payment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [inst.loan_id, inst.installment_id, inst.driver_id, inst.external_driver_id,
     inst.driver_first_name, inst.driver_last_name, inst.flota,
     amountToCharge, amountCharged, inst.installment_number, status, reason, balance, paymentId]);
};

/**
 * @param {number|null} forceDayOfWeek - 5 = pending, 2 = overdue
 * @param {string|null} driverIdFilter - UUID del conductor (solo ese)
 */
export const runDailyAutoCharge = async (forceDayOfWeek = null, driverIdFilter = null) => {
  const dayOfWeek = forceDayOfWeek !== null ? forceDayOfWeek : new Date().getDay();

  logger.info(`Ejecutando cobro automático diario... Día: ${dayOfWeek}${driverIdFilter ? ' (solo driver: ' + driverIdFilter + ')' : ''}`);

  // Actualizar mora antes de cobrar: si hay filtro por conductor, solo ese conductor (rápido); si no, todo el portafolio.
  if (driverIdFilter) {
    await updateLateFeesForDriver(driverIdFilter);
  } else {
    await updateDailyLateFees();
  }

  const installments = await getDueInstallmentsForAutoCharge(dayOfWeek, driverIdFilter);

  if (installments.length === 0) {
    logger.info('No hay cuotas para cobrar automáticamente hoy');
    return { success: 0, partial: 0, failed: 0 };
  }

  logger.info(`${installments.length} cuotas a procesar`);

  let success = 0, partial = 0, failed = 0;

  for (const inst of installments) {
    try {
      const driverName = `${inst.driver_first_name} ${inst.driver_last_name}`;

      // Total a cobrar = cuota pendiente + mora (si no cobramos con mora, la perderíamos)
      const cuotaPendiente = parseFloat(inst.installment_amount) - parseFloat(inst.paid_amount || 0);
      const moraPendiente = parseFloat(inst.late_fee || 0);
      const totalDue = cuotaPendiente + moraPendiente;
      const pendingAmount = totalDue;

      logger.info(`Procesando cuota #${inst.installment_number} de ${driverName}: S/ ${cuotaPendiente.toFixed(2)} (cuota) + S/ ${moraPendiente.toFixed(2)} (mora) = S/ ${pendingAmount.toFixed(2)} total a cobrar`);

      // Si no tiene external_driver_id, buscarlo por DNI en la tabla drivers
      let externalDriverId = inst.external_driver_id;
      let flota = inst.flota;
      if (!externalDriverId && inst.driver_dni) {
        const driverLookup = await query(
          `SELECT driver_id, park_id FROM drivers WHERE document_number = $1 LIMIT 1`,
          [inst.driver_dni]
        );
        if (driverLookup.rows.length > 0) {
          externalDriverId = driverLookup.rows[0].driver_id;
          flota = driverLookup.rows[0].park_id || flota;
          logger.info(`Conductor ${driverName} encontrado por DNI ${inst.driver_dni}: external_driver_id = ${externalDriverId}`);
          // Actualizar el external_driver_id en module_rapidin_drivers para futuras consultas
          await query(
            `UPDATE module_rapidin_drivers SET external_driver_id = $1, park_id = COALESCE($2, park_id), updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
            [externalDriverId, flota, inst.driver_id]
          );
        }
      }

      if (!externalDriverId) {
        logger.warn(`Conductor ${driverName} DNI ${inst.driver_dni} sin external_driver_id en BD ni en tabla drivers`);
        await logAutoPaymentAttempt(inst, pendingAmount, 0, 'failed', 'Sin external_driver_id (conductor no encontrado en Yango)', null);
        failed++;
        continue;
      }

      const balanceResult = await getContractorBalance(externalDriverId, flota);
      if (!balanceResult.success) {
        logger.warn(`No se pudo obtener saldo de ${driverName}: ${balanceResult.error}`);
        await logAutoPaymentAttempt(inst, pendingAmount, 0, 'failed', balanceResult.error, null);
        failed++;
        continue;
      }

      const balance = balanceResult.balance;
      logger.info(`Saldo disponible de ${driverName}: S/ ${balance.toFixed(2)}`);

      if (balance <= 0) {
        logger.warn(`${driverName} sin saldo disponible`);
        await logAutoPaymentAttempt(inst, pendingAmount, 0, 'failed', 'Sin saldo disponible', balance);
        if (inst.installment_status === 'pending') {
          await markInstallmentOverdueAndLateFee(inst.installment_id);
          await updateLoanBalance(inst.loan_id);
        }
        failed++;
        continue;
      }

      const amountToCharge = Math.min(pendingAmount, balance);
      const withdrawResult = await withdrawFromContractor(externalDriverId, amountToCharge.toFixed(2), 'Cuota Rapidin', null, flota);

      if (!withdrawResult.success) {
        logger.error(`Error al retirar de ${driverName}: ${withdrawResult.message || withdrawResult.error}`);
        await logAutoPaymentAttempt(inst, pendingAmount, 0, 'failed', withdrawResult.message || withdrawResult.error, balance);
        if (inst.installment_status === 'pending') {
          await markInstallmentOverdueAndLateFee(inst.installment_id);
          await updateLoanBalance(inst.loan_id);
        }
        failed++;
        continue;
      }

      const paymentResult = await registerPaymentAuto(inst.loan_id, amountToCharge, new Date());

      if (amountToCharge >= pendingAmount) {
        logger.info(`✅ Cobro completo de ${driverName}: S/ ${amountToCharge.toFixed(2)} (cuota + mora)`);
        await logAutoPaymentAttempt(inst, pendingAmount, amountToCharge, 'success', 'Cobro completo', balance, paymentResult?.id);
        success++;
      } else {
        logger.info(`⚠️ Cobro parcial de ${driverName}: S/ ${amountToCharge.toFixed(2)} de S/ ${pendingAmount.toFixed(2)} (se aplica primero a mora, luego a cuota)`);
        await logAutoPaymentAttempt(inst, pendingAmount, amountToCharge, 'partial', 'Cobro parcial (saldo insuficiente)', balance, paymentResult?.id);
        await markInstallmentOverdueOnly(inst.installment_id);
        await updateLoanBalance(inst.loan_id);
        partial++;
      }

    } catch (error) {
      logger.error(`Error procesando cuota ${inst.installment_id}:`, error);
      await logAutoPaymentAttempt(inst, 0, 0, 'failed', error.message, null);
      failed++;
    }
  }

  logger.info(`Cobro automático completado: ${success} exitosos, ${partial} parciales, ${failed} fallidos`);
  return { success, partial, failed };
};

/** Si está definido, el cobro automático solo hace el barrido de este conductor (driver_id). Ej: AUTO_CHARGE_DRIVER_ID=81aeeff5-25f7-431c-ada2-55fd3faaae8c */
const getAutoChargeDriverFilter = () => {
  const id = (process.env.AUTO_CHARGE_DRIVER_ID || '').trim();
  return id || null;
};

/**
 * Cobro automático:
 * - Lunes 7:00am (Lima): cuotas pending que vencen ese día
 * - Martes 7:00am y 12:00 (Lima): cuotas overdue (vencidas)
 * - Si AUTO_CHARGE_DRIVER_ID está definido, solo se procesa ese conductor
 * - Mora: se actualiza diariamente a las 00:05
 */
export const startDailyAutoChargeJob = () => {
  const driverFilter = getAutoChargeDriverFilter();

  // Lunes 7:00am - cobrar cuotas que vencen hoy
  cron.schedule('0 7 * * 1', async () => {
    logger.info(`Iniciando job de cobro automático - Lunes 7:00am (cuotas que vencen hoy)${driverFilter ? ' [solo driver: ' + driverFilter + ']' : ''}`);
    await runDailyAutoCharge(1, driverFilter);
  }, {
    timezone: 'America/Lima'
  });

  // Martes 7:00am - cobrar cuotas vencidas
  cron.schedule('0 7 * * 2', async () => {
    logger.info(`Iniciando job de cobro automático - Martes 7:00am (cuotas vencidas/overdue)${driverFilter ? ' [solo driver: ' + driverFilter + ']' : ''}`);
    await runDailyAutoCharge(2, driverFilter);
  }, {
    timezone: 'America/Lima'
  });

  // Martes 12:00 - segundo intento de cobro de cuotas vencidas
  cron.schedule('0 12 * * 2', async () => {
    logger.info(`Iniciando job de cobro automático - Martes 12:00 (cuotas vencidas/overdue)${driverFilter ? ' [solo driver: ' + driverFilter + ']' : ''}`);
    await runDailyAutoCharge(2, driverFilter);
  }, {
    timezone: 'America/Lima'
  });

  // Actualización diaria de mora a las 00:05
  cron.schedule('5 0 * * *', async () => {
    logger.info('Iniciando actualización diaria de mora');
    await updateDailyLateFees();
  }, {
    timezone: 'America/Lima'
  });

  logger.info(`Job de cobro automático: Lunes 7am (pending), Martes 7am y 12:00 (overdue); Mora: diario 00:05 (Lima)${driverFilter ? '; solo driver: ' + driverFilter : ''}`);
};
