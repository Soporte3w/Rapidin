/**
 * Jobs Mi Auto: mora diaria (todos los días 1:00 AM) y cobro semanal (lunes 1:00 AM).
 * Solo Mi Auto; independiente de Yego Rapidin.
 *
 * Cómo verificar que la mora corre:
 * - Los jobs se inician en backend/jobs/index.js (initializeJobs → startMiautoWeeklyChargeJob).
 * - Mora: cron '0 1 * * *' = todos los días 1:00 AM (America/Lima).
 * - Para que la mora se calcule, el cronograma debe tener tasa_interes_mora > 0 (ej. 0.02 = 2%).
 * - updateMoraDiaria() en miautoCuotaSemanalService: cuotas con due_date < hoy pasan a overdue y se les asigna late_fee.
 */
import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { getDriverIncome } from '../services/yangoService.js';
import {
  getSolicitudesParaCobroSemanal,
  ensureCuotaSemanalForWeek,
  updateMoraDiaria,
  getCuotasToCharge,
  processCobroCuota,
} from '../services/miautoCuotaSemanalService.js';

const TIMEZONE = 'America/Lima';

/** Formatea fecha a ISO con -05:00 para la API Yango (Lima). */
function toLimaISO(date, endOfDay = false) {
  const d = new Date(date);
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const sec = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${min}:${sec}-05:00`;
}

/** Último lunes (inicio de semana) y domingo en fecha local; para "semana pasada" cuando corre el lunes 1am. */
function getLastWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() - diff - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  const weekStartDate = lastMonday.toISOString().slice(0, 10);
  const dateFrom = toLimaISO(lastMonday, false);
  const dateTo = toLimaISO(lastSunday, true);
  return { weekStartDate, dateFrom, dateTo };
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
    const { weekStartDate, dateFrom, dateTo } = getLastWeekRange();
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
