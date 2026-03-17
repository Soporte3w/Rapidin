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

/** Solo se cobran y se les aplica mora a préstamos con desembolso posterior al 19 de febrero (los “mayores al 19 de febrero”). Los desembolsados on/before 19-feb no se consideran (no cobro ni mora). */
const DISBURSEMENT_CUTOFF_DATE = '2026-02-19';

/**
 * Actualiza la mora diaria para todas las cuotas vencidas (due_date < hoy), estén en pending u overdue.
 * Solo préstamos con desembolso >= 19-Feb (DISBURSEMENT_CUTOFF_DATE).
 */
export const updateDailyLateFees = async () => {
  logger.info('Actualizando mora diaria para cuotas vencidas (desembolso >= ' + DISBURSEMENT_CUTOFF_DATE + ')...');

  try {
    const overdueResult = await query(`
     SELECT i.id, i.loan_id, i.due_date, i.installment_amount, i.paid_amount, i.late_fee,
            COALESCE(i.paid_late_fee, 0)::numeric AS paid_late_fee,
            i.late_fee_base_date
     FROM module_rapidin_installments i
     JOIN module_rapidin_loans l ON l.id = i.loan_id
     WHERE l.status IN ('active', 'defaulted')
       AND l.disbursed_at::date >= $1::date
       AND i.status IN ('pending', 'overdue')
       AND i.due_date::date <= CURRENT_DATE
       AND (i.installment_amount + COALESCE(i.late_fee, 0) - COALESCE(i.paid_amount, 0)) > 0`, [DISBURSEMENT_CUTOFF_DATE]);

    let updated = 0;
    for (const inst of overdueResult.rows) {
      const feeResult = await query('SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee', [inst.id]);
      const totalMora = parseFloat(feeResult.rows[0]?.late_fee || 0) || 0;
      const paidLateFee = parseFloat(inst.paid_late_fee || 0) || 0;
      const hasBaseDate = inst.late_fee_base_date != null;
      const newLateFee = hasBaseDate ? totalMora : Math.max(0, totalMora - paidLateFee);

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
     SELECT i.id, i.loan_id, COALESCE(i.paid_late_fee, 0)::numeric AS paid_late_fee, i.late_fee_base_date
     FROM module_rapidin_installments i
     JOIN module_rapidin_loans l ON l.id = i.loan_id
     WHERE l.driver_id = $1 AND l.status IN ('active', 'defaulted')
       AND l.disbursed_at::date >= $2::date
       AND i.status IN ('pending', 'overdue')
       AND i.due_date::date <= CURRENT_DATE
       AND (i.installment_amount + COALESCE(i.late_fee, 0) - COALESCE(i.paid_amount, 0)) > 0`,
    [driverId, DISBURSEMENT_CUTOFF_DATE]
  );
  if (overdueResult.rows.length === 0) return 0;
  for (const inst of overdueResult.rows) {
    const feeResult = await query('SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee', [inst.id]);
    const totalMora = parseFloat(feeResult.rows[0]?.late_fee || 0) || 0;
    const paidLateFee = parseFloat(inst.paid_late_fee || 0) || 0;
    const hasBaseDate = inst.late_fee_base_date != null;
    const newLateFee = hasBaseDate ? totalMora : Math.max(0, totalMora - paidLateFee);
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
 * Lunes (1): cuotas vencidas (overdue) Y cuotas que vencen HOY (pending). Se cobran primero las vencidas (orden por due_date ASC).
 * Martes (2): cuotas overdue/vencidas que no se cobraron o cobraron parcialmente (due_date < hoy).
 * Resto de días: no se ejecuta cobro automático.
 * Restricción: lunes y martes no se cobra a préstamos que pertenecen a Yego Pro (conductor con park_id = PARK_ID_YEGO_PRO).
 */
const getDueInstallmentsForAutoCharge = async (dayOfWeek, driverIdFilter = null) => {
  let statusCondition, dateCondition;

  if (dayOfWeek === 1) {
    // Lunes: overdue (vencidas) + pending que vencen hoy; orden por due_date para cobrar primero las retrasadas
    statusCondition = "AND i.status IN ('pending', 'overdue')";
    dateCondition = 'AND i.due_date <= CURRENT_DATE';
  } else if (dayOfWeek === 2) {
    // Martes: cuotas overdue (vencidas que no se cobraron completas)
    statusCondition = 'AND i.status = $1';
    dateCondition = 'AND i.due_date < CURRENT_DATE';
  } else {
    return [];
  }

  const params = [];
  let pi = 1;
  if (dayOfWeek === 2) { params.push('overdue'); pi++; }
  const driverFilter = driverIdFilter ? `AND d.id = $${pi++}` : '';
  if (driverIdFilter) params.push(driverIdFilter);
  const excludeYegoPro = (dayOfWeek === 1 || dayOfWeek === 2)
    ? `AND (d.park_id IS NULL OR TRIM(d.park_id) <> $${pi++})`
    : '';
  if (dayOfWeek === 1 || dayOfWeek === 2) params.push(PARK_ID_YEGO_PRO);

  // Solo préstamos desembolsados después del 19 de febrero (cobrar a los “mayores al 19 de febrero”)
  // Formato fecha YYYY-MM-DD (igual que first_payment_date y resto del sistema)
  const disbursementCutoff = `AND l.disbursed_at::date > $${pi++}::date`;
  params.push(DISBURSEMENT_CUTOFF_DATE);

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
       ${disbursementCutoff}
       ${statusCondition}
       ${dateCondition}
       AND (i.installment_amount + COALESCE(i.late_fee, 0) - COALESCE(i.paid_amount, 0)) > 0
       ${excludeYegoPro}
       ${driverFilter}
     ORDER BY i.due_date ASC, i.installment_number ASC`, params);

  return result.rows;
};

/**
 * Cuotas que deben reintentarse: registros del log de hoy con status 'failed' o 'partial'.
 * Solo los que tienen fecha de intento = hoy (p. ej. 02-mar).
 */
const getInstallmentsToRetryFromLog = async (driverIdFilter = null) => {
  const driverFilter = driverIdFilter ? 'AND a.driver_id = $2' : '';
  const params = driverIdFilter
    ? [['failed', 'partial'], driverIdFilter, DISBURSEMENT_CUTOFF_DATE]
    : [['failed', 'partial'], DISBURSEMENT_CUTOFF_DATE];
  const result = await query(`
     SELECT DISTINCT ON (i.id)
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
     FROM module_rapidin_auto_payment_log a
     JOIN module_rapidin_installments i ON i.id = a.installment_id
     JOIN module_rapidin_loans l ON l.id = a.loan_id
     JOIN module_rapidin_drivers d ON d.id = a.driver_id
     WHERE a.status = ANY($1::text[])
       AND a.created_at::date = CURRENT_DATE
       AND l.status IN ('active', 'defaulted')
       AND l.disbursed_at::date > $${params.length}::date
       AND (i.installment_amount + COALESCE(i.late_fee, 0) - COALESCE(i.paid_amount, 0)) > 0
       ${driverFilter}
     ORDER BY i.id, a.created_at DESC`,
    params
  );
  return result.rows;
};

const markInstallmentOverdueAndLateFee = async (installmentId) => {
  const row = await query(
    'SELECT COALESCE(paid_late_fee, 0)::numeric AS paid_late_fee, late_fee_base_date FROM module_rapidin_installments WHERE id = $1',
    [installmentId]
  );
  const r = row.rows[0];
  const paidLateFee = parseFloat(r?.paid_late_fee || 0) || 0;
  const hasBaseDate = r?.late_fee_base_date != null;
  const feeResult = await query('SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee', [installmentId]);
  const totalMora = parseFloat(feeResult.rows[0]?.late_fee || 0) || 0;
  const lateFee = hasBaseDate ? totalMora : Math.max(0, totalMora - paidLateFee);

  await query(`
     UPDATE module_rapidin_installments
     SET late_fee = $1,
         days_overdue = GREATEST(0, CURRENT_DATE - COALESCE(late_fee_base_date, due_date)),
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

/** Escribe el TXT de seguridad con los cobros realizados. */
const writeCobrosTxt = (cobrosTxtLines) => {
  if (cobrosTxtLines.length === 0) return;
  try {
    fs.mkdirSync(COBROS_TXT_DIR, { recursive: true });
    const now = new Date();
    const fileName = `cobro-automatico-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}.txt`;
    const filePath = path.join(COBROS_TXT_DIR, fileName);
    const header = 'Nombre del conductor | País | Monto cobrado\n';
    const content = header + cobrosTxtLines.join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
    logger.info(`TXT de cobros generado: ${filePath} (${cobrosTxtLines.length} registro(s))`);
  } catch (err) {
    logger.error('Error generando TXT de cobros automáticos:', err);
  }
};

/** Pausa entre cobros al mismo conductor (segundos) para evitar "Too many requests" de la API de flota. */
const DELAY_SAME_DRIVER_SEC = 2;

/** Procesa una lista de cuotas (cobro automático): retira saldo, registra pago, log. Retorna { success, partial, failed, cobrosTxtLines }. */
const processInstallmentsList = async (installments) => {
  let success = 0, partial = 0, failed = 0;
  const cobrosTxtLines = [];
  let lastDriverId = null;

  for (const inst of installments) {
    try {
      // Pausa si la cuota anterior era del mismo conductor (evita Too many requests)
      if (lastDriverId === inst.driver_id) {
        await new Promise((r) => setTimeout(r, DELAY_SAME_DRIVER_SEC * 1000));
      }
      lastDriverId = inst.driver_id;

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

      const paymentResult = await registerPaymentAuto(inst.loan_id, amountToCharge, new Date(), inst.installment_id);

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
  return { success, partial, failed, cobrosTxtLines };
};

/**
 * Reintento a las 7:20 (Lunes): cobra solo los que figuran en el log de hoy con estado failed o partial.
 * Las cuotas se ordenan por préstamo y por número de cuota (1, 2, 3…) para cobrar en orden.
 * Entre dos cobros del mismo conductor se espera DELAY_SAME_DRIVER_SEC para evitar "Too many requests" de la API de flota.
 * Tras el reintento, marca como vencido (overdue) todo lo que no se cobró o se cobró parcialmente.
 */
export const runRetryAutoChargeFromLog = async (driverIdFilter = null) => {
  logger.info(`Reintento de cobro automático (log del día: failed/partial)${driverIdFilter ? ' [solo driver: ' + driverIdFilter + ']' : ''}`);

  const installments = await getInstallmentsToRetryFromLog(driverIdFilter);

  if (installments.length === 0) {
    logger.info('No hay cuotas para reintentar hoy (ningún registro en log con estado no cobrado/failed/partial con fecha de hoy)');
    return { success: 0, partial: 0, failed: 0 };
  }

  // Ordenar por préstamo y luego por cuota (1, 2, 3…) para cobrar siempre en orden y reducir "Too many requests" al mismo conductor
  installments.sort((a, b) => {
    if (a.loan_id !== b.loan_id) return a.loan_id.localeCompare(b.loan_id);
    const dA = new Date(a.due_date).getTime();
    const dB = new Date(b.due_date).getTime();
    if (dA !== dB) return dA - dB;
    return (a.installment_number || 0) - (b.installment_number || 0);
  });

  logger.info(`${installments.length} cuota(s) a reintentar (log del día con estado failed/partial)`);
  const result = await processInstallmentsList(installments);

  // Tras el reintento: marcar como vencido (overdue) todo lo que siga con saldo pendiente (no cobrado o cobro parcial)
  const loanIdsToUpdate = new Set();
  for (const inst of installments) {
    const row = await query(
      `SELECT installment_amount, paid_amount, late_fee, status
       FROM module_rapidin_installments WHERE id = $1`,
      [inst.installment_id]
    );
    if (row.rows.length === 0) continue;
    const r = row.rows[0];
    const pending = (parseFloat(r.installment_amount) - parseFloat(r.paid_amount || 0)) + parseFloat(r.late_fee || 0);
    if (pending > 0) {
      await markInstallmentOverdueAndLateFee(inst.installment_id);
      loanIdsToUpdate.add(inst.loan_id);
    }
  }
  for (const loanId of loanIdsToUpdate) {
    await updateLoanBalance(loanId);
  }
  if (loanIdsToUpdate.size > 0) {
    logger.info(`Marcadas como vencidas ${loanIdsToUpdate.size} préstamo(s) con cuotas no cobradas o cobro parcial tras el reintento`);
  }

  writeCobrosTxt(result.cobrosTxtLines);
  return result;
};

/**
 * Ejecuta el cobro automático según el día: lunes = cuotas que vencen hoy (pending), martes = cuotas vencidas (overdue).
 * @param {number|null} forceDayOfWeek - Si se pasa: 1 = lunes (pending), 2 = martes (overdue). Si null, usa el día actual (getDay()).
 * @param {string|null} driverIdFilter - UUID del conductor para procesar solo ese conductor (ej. pruebas).
 */
export const runDailyAutoCharge = async (forceDayOfWeek = null, driverIdFilter = null) => {
  const dayOfWeek = forceDayOfWeek !== null ? forceDayOfWeek : new Date().getDay();

  logger.info(`Ejecutando cobro automático diario... Día: ${dayOfWeek}${driverIdFilter ? ' (solo driver: ' + driverIdFilter + ')' : ''}`);

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
    logger.info(`Restricción activa: solo se cobra a préstamos con desembolso posterior al ${DISBURSEMENT_CUTOFF_DATE}`);
  }
  logger.info(`${installments.length} cuotas a procesar`);

  const result = await processInstallmentsList(installments);
  writeCobrosTxt(result.cobrosTxtLines);
  return result;
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
 * - Lunes 7:00am (Lima): cuotas pending que vencen ese día + overdue
 * - Lunes 7:20am (Lima): reintento solo de los que quedaron en log del día con estado failed/partial
 * - Martes 7:00 y 19:00 (Lima): solo cuotas vencidas (overdue)
 * - Mora: diario 00:05. Antes del 23 no se ejecuta nada.
 */
export const startDailyAutoChargeJob = () => {
  const driverFilter = getAutoChargeDriverFilter();

  // Lunes 7:00am - cobrar cuotas que vencen hoy
  cron.schedule('0 7 * * 1', async () => {
    if (!isDentroDeVentana()) return;
    logger.info(`Iniciando job de cobro automático - Lunes 7:00 (cuotas que vencen hoy)${driverFilter ? ' [solo driver: ' + driverFilter + ']' : ''}`);
    await runDailyAutoCharge(1, driverFilter);
  }, {
    timezone: 'America/Lima'
  });

  // Lunes 7:20am - reintentar solo los del log de hoy con estado failed/partial (no cobrado a las 7:00)
  cron.schedule('20 7 * * 1', async () => {
    if (!isDentroDeVentana()) return;
    logger.info(`Iniciando job de cobro automático - Lunes 7:20 (reintento log del día: failed/partial)${driverFilter ? ' [solo driver: ' + driverFilter + ']' : ''}`);
    await runRetryAutoChargeFromLog(driverFilter);
  }, {
    timezone: 'America/Lima'
  });

  // Martes 7:00am - cobrar solo cuotas vencidas (overdue)
  cron.schedule('0 7 * * 2', async () => {
    if (!isDentroDeVentana()) return;
    logger.info(`Iniciando job de cobro automático - Martes 7:00 (solo vencidas/overdue)${driverFilter ? ' [solo driver: ' + driverFilter + ']' : ''}`);
    await runDailyAutoCharge(2, driverFilter);
  }, {
    timezone: 'America/Lima'
  });

  // Martes 7:00pm - segundo intento de cobro de cuotas vencidas
  cron.schedule('0 19 * * 2', async () => {
    if (!isDentroDeVentana()) return;
    logger.info(`Iniciando job de cobro automático - Martes 19:00 (solo vencidas/overdue)${driverFilter ? ' [solo driver: ' + driverFilter + ']' : ''}`);
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

  logger.info(`Job de cobro automático: activo a partir del 23. Lunes 7:00 (pending), Lunes 7:20 (reintento log del día), Martes 7:00 y 19:00 (solo vencidas); Mora: diario 00:05 (Lima)${driverFilter ? '; solo driver: ' + driverFilter : ''}`);
};
