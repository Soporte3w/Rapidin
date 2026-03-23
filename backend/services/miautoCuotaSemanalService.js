/**
 * Cuotas semanales Mi Auto: creación por semana, mora diaria, cobro desde fleet.
 * Solo Mi Auto; no tiene relación con Yego Rapidin.
 */
import { query } from '../config/database.js';
import { getCronogramaById, getRuleForTripCount } from './miautoCronogramaService.js';
import { getDriverIncome, getContractorBalance, withdrawFromContractor } from './yangoService.js';
import { logger } from '../utils/logger.js';
import { round2 } from './miautoMoneyUtils.js';

const PARTNER_FEES_PCT = 0.8333;

/**
 * Solicitudes que entran al cobro semanal: aprobado, pago completo, cronograma y vehículo asignados,
 * fecha_inicio_cobro_semanal setea, y tienen rapidin_driver_id (para external_driver_id y park_id).
 */
export async function getSolicitudesParaCobroSemanal() {
  const res = await query(
    `SELECT s.id AS solicitud_id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
            rd.id AS driver_id, rd.external_driver_id, rd.park_id, rd.first_name, rd.last_name, s.country
     FROM module_miauto_solicitud s
     INNER JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE s.status = 'aprobado'
       AND s.pago_estado = 'completo'
       AND s.cronograma_id IS NOT NULL
       AND s.cronograma_vehiculo_id IS NOT NULL
       AND s.fecha_inicio_cobro_semanal IS NOT NULL
     ORDER BY s.id`
  );
  return res.rows || [];
}

/**
 * Crea o actualiza la cuota semanal para una solicitud y un lunes dado.
 * incomeResult: { count_completed, partner_fees } de getDriverIncome.
 */
export async function ensureCuotaSemanalForWeek(solicitudId, cronogramaId, cronogramaVehiculoId, weekStartDate, incomeResult) {
  const { count_completed: numViajes = 0, partner_fees: partnerFeesRaw = 0 } = incomeResult;
  const partnerFeesRawRounded = round2(Number(partnerFeesRaw) || 0);
  const partnerFees83 = round2(partnerFeesRawRounded * PARTNER_FEES_PCT);

  const cronograma = await getCronogramaById(cronogramaId);
  if (!cronograma?.rules?.length) {
    logger.warn(`Cronograma ${cronogramaId} sin rules para solicitud ${solicitudId}`);
    return null;
  }

  const rule = getRuleForTripCount(cronograma.rules, numViajes);
  if (!rule) {
    logger.warn(`Sin regla para ${numViajes} viajes, cronograma ${cronogramaId}`);
    return null;
  }

  const vehicles = cronograma.vehicles || [];
  const vehicleIndex = vehicles.findIndex((v) => v.id === cronogramaVehiculoId);
  const cuotasPorVehiculo = rule.cuotas_por_vehiculo || [];
  const cuotaSemanal = vehicleIndex >= 0 && cuotasPorVehiculo[vehicleIndex] != null
    ? round2(parseFloat(cuotasPorVehiculo[vehicleIndex]) || 0)
    : 0;
  const monedasPorVehiculo = rule.cuota_moneda_por_vehiculo || [];
  const moneda = vehicleIndex >= 0 && monedasPorVehiculo[vehicleIndex] === 'USD' ? 'USD' : 'PEN';
  const bonoAuto = round2(parseFloat(rule.bono_auto) || 0);
  const amountDue = round2(Math.max(0, (cuotaSemanal - bonoAuto) - partnerFees83));
  const pctComision = round2(Number(parseFloat(rule.pct_comision) || 0));
  const cobroSaldo = round2(parseFloat(rule.cobro_saldo) || 0);

  const existing = await query(
    'SELECT id FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND week_start_date = $2',
    [solicitudId, weekStartDate]
  );

  if (existing.rows.length > 0) {
    await query(
      `UPDATE module_miauto_cuota_semanal
       SET num_viajes = $1, partner_fees_raw = $2, partner_fees_83 = $3, bono_auto = $4, cuota_semanal = $5, amount_due = $6, moneda = $7, pct_comision = $8, cobro_saldo = $9, updated_at = CURRENT_TIMESTAMP
       WHERE solicitud_id = $10 AND week_start_date = $11`,
      [numViajes, partnerFeesRawRounded, partnerFees83, bonoAuto, cuotaSemanal, amountDue, moneda, pctComision, cobroSaldo, solicitudId, weekStartDate]
    );
    return existing.rows[0].id;
  }

  let statusInsert = 'pending';
  let paidAmountInsert = 0;
  const solVeh = await query(
    `SELECT s.fecha_inicio_cobro_semanal, s.cuotas_semanales_bonificadas, v.cuotas_semanales
     FROM module_miauto_solicitud s
     JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id
     WHERE s.id = $1`,
    [solicitudId]
  );
  if (solVeh.rows.length > 0) {
    const f = solVeh.rows[0].fecha_inicio_cobro_semanal;
    const total = parseInt(solVeh.rows[0].cuotas_semanales, 10) || 0;
    const bonif = parseInt(solVeh.rows[0].cuotas_semanales_bonificadas, 10) || 0;
    if (f && total > 0 && bonif >= 1) {
      const start = new Date(f);
      const week = new Date(weekStartDate);
      const daysDiff = Math.round((week - start) / (24 * 60 * 60 * 1000));
      const weekIndex = Math.floor(daysDiff / 7);
      // total = semanas del plan según cronograma del vehículo (v.cuotas_semanales). Bonificación a las últimas N (N = bonif). Ej: 261 → cuota 261 bonificada.
      if (weekIndex >= total - bonif && weekIndex < total) {
        statusInsert = 'bonificada';
        paidAmountInsert = amountDue;
      }
    }
  }

  const ins = await query(
    `INSERT INTO module_miauto_cuota_semanal
     (solicitud_id, week_start_date, due_date, num_viajes, partner_fees_raw, partner_fees_83, bono_auto, cuota_semanal, amount_due, paid_amount, status, moneda, pct_comision, cobro_saldo)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [solicitudId, weekStartDate, numViajes, partnerFeesRawRounded, partnerFees83, bonoAuto, cuotaSemanal, amountDue, paidAmountInsert, statusInsert, moneda, pctComision, cobroSaldo]
  );
  return ins.rows[0]?.id || null;
}

/**
 * Actualiza mora y marca vencidas: cuotas con due_date < hoy pasan a status 'overdue'.
 * La cuota sigue en 'pending' todo el día del vencimiento; a las 00:00 del día siguiente
 * (ej. 17 marzo) ya cumple due_date < CURRENT_DATE y este job la marca vencida. Job diario (ej. 1:00 AM).
 *
 * @param {string|null} solicitudId - Si se indica, solo se procesan cuotas de esa solicitud (p. ej. al listar en API).
 */
export async function updateMoraDiaria(solicitudId = null) {
  let sql = `SELECT c.id, c.solicitud_id, c.cuota_semanal, c.amount_due, c.due_date, c.paid_amount, c.late_fee, c.status,
            s.cronograma_id
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     WHERE c.status IN ('pending', 'overdue') AND c.due_date < CURRENT_DATE`;
  const params = [];
  if (solicitudId) {
    sql += ` AND c.solicitud_id = $1`;
    params.push(solicitudId);
  }
  const res = await query(sql, params);

  let updated = 0;
  for (const row of res.rows || []) {
    const cronograma = await getCronogramaById(row.cronograma_id);
    const tasa = round2(parseFloat(cronograma?.tasa_interes_mora) || 0);
    const dueDate = new Date(row.due_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    dueDate.setHours(0, 0, 0, 0);
    const daysOverdue = Math.max(0, Math.floor((today - dueDate) / (24 * 60 * 60 * 1000)));
    const baseCuota = round2(parseFloat(row.cuota_semanal) || parseFloat(row.amount_due) || 0);
    const lateFee = round2(tasa > 0 && baseCuota > 0 ? (baseCuota * tasa) / 7 * daysOverdue : 0);

    await query(
      `UPDATE module_miauto_cuota_semanal SET late_fee = $1, status = 'overdue', updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [lateFee, row.id]
    );
    updated++;
  }
  if (updated > 0) logger.info(`Mora actualizada para ${updated} cuota(s) semanales Mi Auto`);
  return updated;
}

/**
 * Calcula la racha actual: cuántas cuotas consecutivas (desde la más antigua por due_date)
 * están pagadas o bonificadas y sin mora. Si tiene al menos una cuota vencida (overdue), racha = 0.
 */
export function calcularRacha(cuotas) {
  if (!Array.isArray(cuotas) || cuotas.length === 0) return 0;
  const tieneVencida = cuotas.some((c) => (c.status || '').toLowerCase() === 'overdue');
  if (tieneVencida) return 0;
  const porFechaAsc = [...cuotas].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  let racha = 0;
  for (const c of porFechaAsc) {
    const ok = (c.status === 'paid' || c.status === 'bonificada') && (Number(c.late_fee) || 0) === 0;
    if (!ok) break;
    racha++;
  }
  return racha;
}

/**
 * Lista cuotas semanales de una solicitud (para conductor y admin). Orden por due_date ASC.
 */
export async function getCuotasSemanalesBySolicitud(solicitudId) {
  const res = await query(
    `SELECT id, solicitud_id, week_start_date, due_date, num_viajes, bono_auto, cuota_semanal, amount_due, paid_amount, late_fee, status, moneda, pct_comision, cobro_saldo, created_at, updated_at
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1 ORDER BY due_date ASC`,
    [solicitudId]
  );
  return (res.rows || []).map((r) => {
    const amount_due = round2(parseFloat(r.amount_due) || 0);
    const paid_amount = round2(parseFloat(r.paid_amount) || 0);
    const late_fee = round2(parseFloat(r.late_fee) || 0);
    return {
      id: r.id,
      solicitud_id: r.solicitud_id,
      week_start_date: r.week_start_date,
      due_date: r.due_date,
      num_viajes: r.num_viajes,
      bono_auto: round2(parseFloat(r.bono_auto) || 0),
      cuota_semanal: round2(parseFloat(r.cuota_semanal) || 0),
      amount_due,
      paid_amount,
      late_fee,
      status: r.status,
      moneda: r.moneda === 'USD' ? 'USD' : 'PEN',
      pct_comision: round2(Number(parseFloat(r.pct_comision) || 0)),
      cobro_saldo: round2(parseFloat(r.cobro_saldo) || 0),
      pending_total: round2(amount_due + late_fee - paid_amount),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });
}

/**
 * Lista cuotas semanales y calcula la racha (para conductor). Respuesta: { data: cuotas, racha, cuotas_semanales_bonificadas }.
 * La cuenta de bonificaciones viene de module_miauto_solicitud.cuotas_semanales_bonificadas (se actualiza cada vez que
 * se aplica una bonificación en tryGrantBenefit4Consecutive). Se usa max(column, count de cuotas 'bonificada') por
 * datos históricos donde la columna pudo no existir o no actualizarse.
 */
export async function getCuotasSemanalesConRacha(solicitudId) {
  await updateMoraDiaria(solicitudId);
  const cuotas = await getCuotasSemanalesBySolicitud(solicitudId);
  const racha = calcularRacha(cuotas);
  const solRes = await query(
    'SELECT COALESCE(cuotas_semanales_bonificadas, 0)::int AS cuotas_semanales_bonificadas FROM module_miauto_solicitud WHERE id = $1',
    [solicitudId]
  );
  const fromDb = (solRes.rows[0] && parseInt(solRes.rows[0].cuotas_semanales_bonificadas, 10)) || 0;
  const fromCuotas = (cuotas || []).filter((c) => c.status === 'bonificada').length;
  const cuotasSemanalesBonificadas = Math.max(fromDb, fromCuotas);
  return { data: cuotas, racha, cuotas_semanales_bonificadas: cuotasSemanalesBonificadas };
}

/**
 * Cuotas a cobrar: pending/overdue con saldo pendiente > 0.
 * Orden: por solicitud_id, luego due_date ASC, para cobrar siempre cuota 1 antes que 2, 2 antes que 3, etc.
 */
export async function getCuotasToCharge() {
  const res = await query(
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.status,
            s.cronograma_id, rd.id AS driver_id, rd.external_driver_id, rd.park_id, rd.first_name, rd.last_name, s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     INNER JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE c.status IN ('pending', 'overdue')
       AND (c.amount_due + COALESCE(c.late_fee, 0) - COALESCE(c.paid_amount, 0)) > 0
     ORDER BY c.solicitud_id, c.due_date ASC, c.id`
  );
  return res.rows || [];
}

/**
 * Procesa el cobro de una cuota: consulta saldo fleet, withdraw, actualiza paid_amount.
 * Retorna { success, partial, failed, reason?, amountCharged? }.
 */
export async function processCobroCuota(cuotaRow, cookieOverride = null, parkIdOverride = null) {
  const driverName = [cuotaRow.first_name, cuotaRow.last_name].filter(Boolean).join(' ').trim() || 'Conductor';
  const amountDue = round2(parseFloat(cuotaRow.amount_due) || 0);
  const paid = round2(parseFloat(cuotaRow.paid_amount) || 0);
  const lateFee = round2(parseFloat(cuotaRow.late_fee) || 0);
  const pendingAmount = round2(amountDue + lateFee - paid);

  if (pendingAmount <= 0) {
    return { success: true, partial: false, failed: false, reason: 'Sin saldo pendiente' };
  }

  let externalDriverId = cuotaRow.external_driver_id;
  let parkId = parkIdOverride || cuotaRow.park_id;

  if (!externalDriverId) {
    const byDni = await query(
      'SELECT driver_id, park_id FROM drivers WHERE document_number = (SELECT dni FROM module_rapidin_drivers WHERE id = $1) LIMIT 1',
      [cuotaRow.driver_id]
    );
    if (byDni.rows.length > 0) {
      externalDriverId = byDni.rows[0].driver_id;
      parkId = parkId || byDni.rows[0].park_id;
    }
  }

  if (!externalDriverId) {
    logger.warn(`Mi Auto cobro: ${driverName} sin external_driver_id`);
    return { success: false, partial: false, failed: true, reason: 'Sin external_driver_id' };
  }

  const balanceResult = await getContractorBalance(externalDriverId, parkId, cookieOverride);
  if (!balanceResult.success) {
    logger.warn(`Mi Auto cobro: no se pudo obtener saldo de ${driverName}: ${balanceResult.error}`);
    return { success: false, partial: false, failed: true, reason: balanceResult.error };
  }

  const balance = round2(Number(balanceResult.balance) || 0);
  if (balance <= 0) {
    return { success: false, partial: false, failed: true, reason: 'Sin saldo disponible' };
  }

  const amountToCharge = round2(Math.min(pendingAmount, balance));
  const withdrawResult = await withdrawFromContractor(
    externalDriverId,
    amountToCharge.toFixed(2),
    'Cuota Mi Auto',
    cookieOverride,
    parkId
  );

  if (!withdrawResult.success) {
    logger.error(`Mi Auto cobro: error al retirar de ${driverName}: ${withdrawResult.message || withdrawResult.error}`);
    return { success: false, partial: false, failed: true, reason: withdrawResult.message || withdrawResult.error };
  }

  const newPaid = round2(paid + amountToCharge);
  const totalDue = amountDue + lateFee;
  const newStatus = newPaid >= totalDue ? 'paid' : 'partial';

  await query(
    `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [newPaid, newStatus, cuotaRow.id]
  );

  if (amountToCharge >= pendingAmount) {
    logger.info(`Mi Auto cobro completo: ${driverName} S/ ${amountToCharge.toFixed(2)}`);
    return { success: true, partial: false, failed: false, amountCharged: amountToCharge };
  }
  logger.info(`Mi Auto cobro parcial: ${driverName} S/ ${amountToCharge.toFixed(2)} de S/ ${pendingAmount.toFixed(2)}`);
  return { success: true, partial: true, failed: false, amountCharged: amountToCharge };
}
