/**
 * Yego Mi Auto: mora diaria 1:00 y cobro semanal lunes 2:00 (America/Lima).
 * Registro en jobs/index.js → startMiautoWeeklyChargeJob.
 */
import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { getDriverIncome } from '../services/yangoService.js';
import {
  getSolicitudesParaCobroSemanal,
  ensureCuotaSemanalForWeek,
  persistPaidAmountCapsForSolicitud,
  getCuotasToCharge,
  processCobroCuota,
  updateMoraDiaria,
} from '../services/miautoCuotaSemanalService.js';
import { getPreviousWeekIncomeRangeLima } from '../utils/miautoLimaWeekRange.js';

const TIMEZONE = 'America/Lima';

/** Semana calendario Lun–Dom ya cerrada (siempre según fecha civil en America/Lima, no la TZ del servidor). */
function getLastWeekRange() {
  return getPreviousWeekIncomeRangeLima();
}

/**
 * Job de cobro semanal: lunes 2:00 AM.
 * 1) Obtiene income de la semana pasada por conductor (lunes 00:00 a domingo 23:59).
 * 2) Crea/actualiza cuota semanal (amount_due = max(0, cuota - bono - 83.33% partner_fees)).
 * 3) Cobra cuotas pendientes/overdue (orden por due_date ASC).
 */
async function runWeeklyCharge() {
  logger.info('Mi Auto: iniciando job de cobro semanal (lunes 2:00 AM)');
  try {
    const { weekStartDate, sundayDate, dateFrom, dateTo } = getLastWeekRange();
    logger.info(
      `Mi Auto: semana a liquidar Lun ${weekStartDate} → Dom ${sundayDate} Lima | week_start_date=${weekStartDate} | Yango date_from=${dateFrom} date_to=${dateTo}`
    );
    const solicitudes = await getSolicitudesParaCobroSemanal();
    if (solicitudes.length === 0) {
      logger.info('Mi Auto: no hay solicitudes para cobro semanal');
      return;
    }

    for (const sol of solicitudes) {
      const inicio = sol.fecha_inicio_cobro_semanal ? new Date(sol.fecha_inicio_cobro_semanal).toISOString().slice(0, 10) : null;
      if (inicio && weekStartDate < inicio) continue;

      const incomeResult = await getDriverIncome(dateFrom, dateTo, sol.external_driver_id, sol.park_id);
      if (!incomeResult.success) {
        logger.warn(`Mi Auto: income fallido para solicitud ${sol.solicitud_id}: ${incomeResult.error}`);
        continue;
      }

      await ensureCuotaSemanalForWeek(
        sol.solicitud_id,
        sol.cronograma_id,
        sol.cronograma_vehiculo_id,
        weekStartDate,
        { count_completed: incomeResult.count_completed, partner_fees: incomeResult.partner_fees }
      );
    }

    for (const sol of solicitudes) {
      await persistPaidAmountCapsForSolicitud(sol.solicitud_id);
    }

    const cuotas = await getCuotasToCharge();
    let success = 0, partial = 0, failed = 0;
    for (let i = 0; i < cuotas.length; i++) {
      const cuota = cuotas[i];
      const result = await processCobroCuota(cuota);
      if (result.failed) failed++;
      else if (result.partial) partial++;
      else success++;
      if (i < cuotas.length - 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    logger.info(`Mi Auto cobro semanal: ${success} completos, ${partial} parciales, ${failed} fallidos`);
  } catch (err) {
    logger.error('Mi Auto job cobro semanal:', err);
  }
}

/**
 * Job de mora: todos los días 1:00 AM.
 */
async function runDailyMora() {
  logger.info('Mi Auto: actualizando mora diaria (cuotas vencidas)');
  try {
    await updateMoraDiaria();
  } catch (err) {
    logger.error('Mi Auto job mora diaria:', err);
  }
}

export function startMiautoWeeklyChargeJob() {
  cron.schedule('0 1 * * *', runDailyMora, { timezone: TIMEZONE });
  cron.schedule('0 2 * * 1', runWeeklyCharge, { timezone: TIMEZONE });
  logger.info('Mi Auto jobs: mora diaria 1:00 AM, cobro semanal lunes 2:00 AM (America/Lima)');
}
