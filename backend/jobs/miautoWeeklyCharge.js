/**
 * Mi Auto — crons America/Lima: mora 1:00 diaria; lunes 1:10 generación+cascada; lunes 7:10 cobro Fleet.
 * @see initializeJobs → startMiautoWeeklyChargeJob
 */
import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { query } from '../config/database.js';
import { round2 } from '../services/miautoMoneyUtils.js';
import { getDriverIncome } from '../services/yangoService.js';
import {
  getSolicitudesParaCobroSemanal,
  ensureCuotaSemanalForWeek,
  isSemanaDepositoMiAuto,
  persistPaidAmountCapsForSolicitud,
  getCuotasToCharge,
  getCuotasToChargeForSolicitud,
  processCobroCuota,
  updateMoraDiaria,
} from '../services/miautoCuotaSemanalService.js';
import {
  addDaysYmd,
  getPreviousWeekIncomeRangeLima,
  mondayOfWeekContainingYmd,
} from '../utils/miautoLimaWeekRange.js';

const TIMEZONE = 'America/Lima';
const FLEET_MS_BETWEEN_COBROS = 1500;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Rango Yango semana Lun–Dom cerrada + lunes de fila `week_start_date` en BD (= lunes ingresos + 7). */
function currentMondayCuotaContext() {
  const prev = getPreviousWeekIncomeRangeLima();
  const { weekStartDate: incomeWeekMonday, sundayDate, dateFrom, dateTo } = prev;
  const cuotaWeekMonday = addDaysYmd(incomeWeekMonday, 7);
  return { incomeWeekMonday, sundayDate, dateFrom, dateTo, cuotaWeekMonday };
}

/** Yango (o primera semana) + `ensureCuotaSemanalForWeek`. */
async function ensureCuotaOneSolicitud(sol, cuotaWeekMonday, dateFrom, dateTo) {
  const fiStr = sol.fecha_inicio_cobro_semanal
    ? String(sol.fecha_inicio_cobro_semanal).trim().slice(0, 10)
    : null;
  const mondayInicio =
    fiStr && /^\d{4}-\d{2}-\d{2}$/.test(fiStr) ? mondayOfWeekContainingYmd(fiStr) : null;
  if (mondayInicio && cuotaWeekMonday < mondayInicio) {
    return { outcome: 'before_inicio', mondayInicioDeposito: mondayInicio };
  }

  const esPrimera = isSemanaDepositoMiAuto(cuotaWeekMonday, sol.fecha_inicio_cobro_semanal);
  let incomeResult;
  if (esPrimera) {
    incomeResult = { success: true, count_completed: 0, partner_fees: 0 };
    logger.info(`Mi Auto: solicitud ${sol.solicitud_id} primera cuota semanal — sin consulta Yango`);
  } else {
    incomeResult = await getDriverIncome(dateFrom, dateTo, sol.external_driver_id, sol.park_id);
    if (!incomeResult.success) {
      logger.warn(`Mi Auto: income fallido solicitud ${sol.solicitud_id}: ${incomeResult.error}`);
      return { outcome: 'income_failed', incomeError: incomeResult.error };
    }
  }

  await ensureCuotaSemanalForWeek(
    sol.solicitud_id,
    sol.cronograma_id,
    sol.cronograma_vehiculo_id,
    cuotaWeekMonday,
    { count_completed: incomeResult.count_completed, partner_fees: incomeResult.partner_fees }
  );
  return { outcome: 'ok' };
}

async function processCobroCuotaQueue(cuotas) {
  let success = 0;
  let partial = 0;
  let failed = 0;
  for (let i = 0; i < cuotas.length; i++) {
    const result = await processCobroCuota(cuotas[i]);
    if (result.failed) failed++;
    else if (result.partial) partial++;
    else success++;
    if (i < cuotas.length - 1) await delay(FLEET_MS_BETWEEN_COBROS);
  }
  return { success, partial, failed };
}

async function runWeeklyCuotaGenerationMonday() {
  logger.info('Mi Auto: generación semanal (lunes 1:10 Lima)');
  try {
    const { incomeWeekMonday, sundayDate, dateFrom, dateTo, cuotaWeekMonday } = currentMondayCuotaContext();
    logger.info(
      `Mi Auto: ingresos Lun ${incomeWeekMonday}→Dom ${sundayDate} | week_start cuota=${cuotaWeekMonday} | Yango ${dateFrom}…${dateTo}`
    );

    const solicitudes = await getSolicitudesParaCobroSemanal();
    if (solicitudes.length === 0) {
      logger.info('Mi Auto: sin solicitudes para cobro semanal');
      return;
    }

    for (const sol of solicitudes) {
      const r = await ensureCuotaOneSolicitud(sol, cuotaWeekMonday, dateFrom, dateTo);
      if (r.outcome === 'before_inicio' || r.outcome === 'income_failed') continue;
    }

    for (const sol of solicitudes) {
      await persistPaidAmountCapsForSolicitud(sol.solicitud_id);
    }
    logger.info('Mi Auto: generación lista; cobro Fleet lunes 7:10');
  } catch (err) {
    logger.error('Mi Auto job generación semanal:', err);
  }
}

async function runWeeklyFleetChargeMonday() {
  logger.info('Mi Auto: cobro Fleet (lunes 7:10 Lima)');
  try {
    await updateMoraDiaria(null, { includePartial: true });
    const cuotas = await getCuotasToCharge();
    const { success, partial, failed } = await processCobroCuotaQueue(cuotas);
    logger.info(`Mi Auto cobro semanal: ${success} ok, ${partial} parcial, ${failed} fallidos`);
  } catch (err) {
    logger.error('Mi Auto job cobro Fleet:', err);
  }
}

async function loadSolicitudMiAutoCobro(solicitudId) {
  const res = await query(
    `SELECT s.id AS solicitud_id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
            s.status, s.pago_estado,
            rd.id AS driver_id, rd.external_driver_id, rd.dni, rd.park_id, rd.first_name, rd.last_name, s.country
     FROM module_miauto_solicitud s
     INNER JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE s.id = $1::uuid`,
    [solicitudId]
  );
  return res.rows[0] || null;
}

/**
 * Una solicitud: misma generación que el lunes + cola opcional Fleet (`dryRun: false`).
 */
export async function runWeeklyChargeForSolicitud(solicitudId, options = {}) {
  const dryRun = options.dryRun !== false;
  const sid = String(solicitudId || '').trim();
  logger.info(`Mi Auto: runWeeklyChargeForSolicitud ${sid} dryRun=${dryRun}`);

  const sol = await loadSolicitudMiAutoCobro(sid);
  if (!sol) {
    logger.error(`Mi Auto: solicitud no encontrada ${sid}`);
    return { ok: false, error: 'not_found' };
  }
  if (sol.status !== 'aprobado' || sol.pago_estado !== 'completo') {
    logger.warn(`Mi Auto: ${sid} status=${sol.status} pago=${sol.pago_estado} (se sigue en prueba)`);
  }

  await updateMoraDiaria(sid, { includePartial: true });

  const { incomeWeekMonday, sundayDate, dateFrom, dateTo, cuotaWeekMonday } = currentMondayCuotaContext();
  logger.info(
    `Mi Auto: ingresos Lun ${incomeWeekMonday}→Dom ${sundayDate} | week_start cuota=${cuotaWeekMonday} | Yango ${dateFrom}…${dateTo}`
  );

  const ensured = await ensureCuotaOneSolicitud(sol, cuotaWeekMonday, dateFrom, dateTo);
  if (ensured.outcome === 'before_inicio') {
    return {
      ok: false,
      error: 'cuota_week_before_inicio',
      cuotaWeekMonday,
      mondayInicioDeposito: ensured.mondayInicioDeposito,
    };
  }
  if (ensured.outcome === 'income_failed') {
    return { ok: false, error: 'income_failed', detail: ensured.incomeError };
  }

  await persistPaidAmountCapsForSolicitud(sid);
  await updateMoraDiaria(sid, { includePartial: true });

  const cuotas = await getCuotasToChargeForSolicitud(sid);

  if (dryRun) {
    const cola = cuotas.map((c, i) => {
      const amountDue = round2(parseFloat(c.amount_due) || 0);
      const paid = round2(parseFloat(c.paid_amount) || 0);
      const lateFee = round2(parseFloat(c.late_fee) || 0);
      const pendiente = round2(amountDue + lateFee - paid);
      logger.info(`Mi Auto [dry-run] #${i + 1} id=${c.id} due=${c.due_date} pendiente=${pendiente}`);
      return {
        orden: i + 1,
        cuota_id: c.id,
        due_date: c.due_date,
        week_start_date: c.week_start_date,
        status: c.status,
        pendiente,
      };
    });
    return { ok: true, dryRun: true, solicitud_id: sid, cuotaWeekMonday, incomeWeekMonday, sundayDate, cola_cobro: cola };
  }

  const { success, partial, failed } = await processCobroCuotaQueue(cuotas);
  logger.info(`Mi Auto cobro ${sid}: ${success} ok, ${partial} parcial, ${failed} fallidos`);
  return {
    ok: true,
    dryRun: false,
    solicitud_id: sid,
    cuotaWeekMonday,
    success,
    partial,
    failed,
    cuotasProcesadas: cuotas.length,
  };
}

async function runDailyMora() {
  try {
    logger.info('Mi Auto: mora diaria');
    await updateMoraDiaria(null, { includePartial: true });
  } catch (err) {
    logger.error('Mi Auto mora diaria:', err);
  }
}

export function startMiautoWeeklyChargeJob() {
  cron.schedule('0 1 * * *', runDailyMora, { timezone: TIMEZONE });
  cron.schedule('10 1 * * 1', runWeeklyCuotaGenerationMonday, { timezone: TIMEZONE });
  cron.schedule('10 7 * * 1', runWeeklyFleetChargeMonday, { timezone: TIMEZONE });
  logger.info('Mi Auto: mora 1:00 | lun 1:10 cuotas | lun 7:10 Fleet (Lima)');
}
