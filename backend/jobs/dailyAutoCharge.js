import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { getContractorBalance, withdrawFromContractor } from '../services/yangoService.js';
import { registerPaymentAuto, updateLoanBalance } from '../services/paymentService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COBROS_TXT_DIR = path.join(__dirname, '..', 'logs', 'cobros-automaticos');

/** Park ID de Yego Pro: lunes y martes no se hace cobro automático (retiro) a préstamos que pertenecen a Yego Pro. La mora sí les afecta igual que al resto. */
const PARK_ID_YEGO_PRO = '64085dd85e124e2c808806f70d527ea8';

/**
 * Actualiza la mora diaria para todas las cuotas vencidas (due_date < hoy), estén en pending u overdue.
 * Afecta a todos por igual, incluidos préstamos Yego Pro (la restricción de no cobro automático lunes/martes solo aplica al retiro de dinero, no a la mora).
 */
export const updateDailyLateFees = async () => {
  logger.info('Actualizando mora diaria para todas las cuotas vencidas...');

  try {
    const overdueResult = await query(`
     SELECT i.id, i.loan_id, i.due_date, i.installment_amount, i.paid_amount, i.late_fee
     FROM module_rapidin_installments i
     JOIN module_rapidin_loans l ON l.id = i.loan_id
     WHERE l.status IN ('active', 'defaulted')
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
     WHERE l.driver_id = $1 AND l.status IN ('active', 'defaulted')
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
 * Restricción: lunes y martes no se cobra a préstamos que pertenecen a Yego Pro (conductor con park_id = PARK_ID_YEGO_PRO).
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
  // Lunes y martes: excluir conductores de Yego Pro (no cobrarles automáticamente esos días)
  const excludeYegoPro = (dayOfWeek === 1 || dayOfWeek === 2)
    ? 'AND (d.park_id IS NULL OR TRIM(d.park_id) <> $' + (driverIdFilter ? '3' : '2') + ')'
    : '';
  const params = driverIdFilter
    ? [statusFilter, driverIdFilter, PARK_ID_YEGO_PRO]
    : (dayOfWeek === 1 || dayOfWeek === 2)
      ? [statusFilter, PARK_ID_YEGO_PRO]
      : [statusFilter];

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
       d.park_id AS flota,
       l.country AS country
     FROM module_rapidin_loans l
     JOIN module_rapidin_drivers d ON d.id = l.driver_id
     JOIN module_rapidin_installments i ON i.loan_id = l.id
     WHERE l.status IN ('active', 'defaulted')
       AND i.status = $1
       AND ${dateCondition}
       AND (i.installment_amount + COALESCE(i.late_fee, 0) - COALESCE(i.paid_amount, 0)) > 0
       ${excludeYegoPro}
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

  if (dayOfWeek === 1 || dayOfWeek === 2) {
    logger.info('Restricción activa: préstamos que pertenecen a Yego Pro excluidos del cobro automático (lunes y martes)');
  }
  logger.info(`${installments.length} cuotas a procesar`);

  let success = 0, partial = 0, failed = 0;
  /** Líneas para el TXT de seguridad: nombre del conductor | país | monto cobrado (PE y CO) */
  const cobrosTxtLines = [];

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
        cobrosTxtLines.push(`${driverName.trim()} | ${inst.country || 'PE'} | ${amountToCharge.toFixed(2)}`);
        success++;
      } else {
        logger.info(`⚠️ Cobro parcial de ${driverName}: S/ ${amountToCharge.toFixed(2)} de S/ ${pendingAmount.toFixed(2)} (se aplica primero a mora, luego a cuota)`);
        await logAutoPaymentAttempt(inst, pendingAmount, amountToCharge, 'partial', 'Cobro parcial (saldo insuficiente)', balance, paymentResult?.id);
        cobrosTxtLines.push(`${driverName.trim()} | ${inst.country || 'PE'} | ${amountToCharge.toFixed(2)}`);
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

  // Generar TXT de seguridad: nombre del conductor | país | monto cobrado (PE y CO)
  if (cobrosTxtLines.length > 0) {
    try {
      await fs.promises.mkdir(COBROS_TXT_DIR, { recursive: true });
      const now = new Date();
      const fileName = `cobro-automatico-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}.txt`;
      const filePath = path.join(COBROS_TXT_DIR, fileName);
      const header = 'Nombre del conductor | País | Monto cobrado\n';
      const content = header + cobrosTxtLines.join('\n') + '\n';
      await fs.promises.writeFile(filePath, content, 'utf8');
      logger.info(`TXT de cobros generado: ${filePath} (${cobrosTxtLines.length} registro(s))`);
    } catch (err) {
      logger.error('Error generando TXT de cobros automáticos:', err);
    }
  }

  return { success, partial, failed };
};

/** Si está definido, el cobro automático solo hace el barrido de este conductor (driver_id). Ej: AUTO_CHARGE_DRIVER_ID=81aeeff5-25f7-431c-ada2-55fd3faaae8c */
const getAutoChargeDriverFilter = () => {
  const id = (process.env.AUTO_CHARGE_DRIVER_ID || '').trim();
  return id || null;
};

/** A partir de este día se ejecutan cobro automático y mora. Antes no se ejecuta nada (ni mañana ni ningún día hasta el 23). */
const COBRO_AUTOMATICO_DESDE = new Date('2026-02-23T00:00:00.000Z');

const isDentroDeVentana = () => {
  const hoy = new Date();
  if (hoy < COBRO_AUTOMATICO_DESDE) {
    logger.info(`Cobro automático / mora: omitido (inicio programado a partir del 23, hoy ${hoy.toISOString().slice(0, 10)})`);
    return false;
  }
  return true;
};

/**
 * Cobro automático (a partir del 23):
 * - Lunes 7:00am (Lima): cuotas pending que vencen ese día
 * - Martes 7:00am y 12:00 (Lima): cuotas overdue (vencidas)
 * - Mora: diario 00:05. Antes del 23 no se ejecuta nada.
 */
export const startDailyAutoChargeJob = () => {
  const driverFilter = getAutoChargeDriverFilter();

  // Lunes 7:00am - cobrar cuotas que vencen hoy
  cron.schedule('0 7 * * 1', async () => {
    if (!isDentroDeVentana()) return;
    logger.info(`Iniciando job de cobro automático - Lunes 7:00am (cuotas que vencen hoy)${driverFilter ? ' [solo driver: ' + driverFilter + ']' : ''}`);
    await runDailyAutoCharge(1, driverFilter);
  }, {
    timezone: 'America/Lima'
  });

  // Martes 7:00am - cobrar cuotas vencidas
  cron.schedule('0 7 * * 2', async () => {
    if (!isDentroDeVentana()) return;
    logger.info(`Iniciando job de cobro automático - Martes 7:00am (cuotas vencidas/overdue)${driverFilter ? ' [solo driver: ' + driverFilter + ']' : ''}`);
    await runDailyAutoCharge(2, driverFilter);
  }, {
    timezone: 'America/Lima'
  });

  // Martes 12:00 - segundo intento de cobro de cuotas vencidas
  cron.schedule('0 12 * * 2', async () => {
    if (!isDentroDeVentana()) return;
    logger.info(`Iniciando job de cobro automático - Martes 12:00 (cuotas vencidas/overdue)${driverFilter ? ' [solo driver: ' + driverFilter + ']' : ''}`);
    await runDailyAutoCharge(2, driverFilter);
  }, {
    timezone: 'America/Lima'
  });

  // Actualización diaria de mora a las 00:05
  cron.schedule('5 0 * * *', async () => {
    if (!isDentroDeVentana()) return;
    logger.info('Iniciando actualización diaria de mora');
    await updateDailyLateFees();
  }, {
    timezone: 'America/Lima'
  });

  logger.info(`Job de cobro automático: activo a partir del 23. Lunes 7am (pending), Martes 7am y 12:00 (overdue); Mora: diario 00:05 (Lima)${driverFilter ? '; solo driver: ' + driverFilter : ''}`);
};
