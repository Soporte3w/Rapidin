/**
 * Mi Auto — crons America/Lima: mora 1:00 diaria; lunes 1:10 generación+cascada; lunes 7:10 cobro Fleet.
 * @see initializeJobs → startMiautoWeeklyChargeJob
 */
import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { round2 } from '../services/miautoMoneyUtils.js';
import { getDriverIncome } from '../services/yangoService.js';
import {
  getSolicitudesParaCobroSemanal,
  ensureCuotaSemanalForWeek,
  isSemanaDepositoMiAuto,
  persistPaidAmountCapsForSolicitud,
  getCuotasToCharge,
  getCuotasToChargeForSolicitud,
  loadMiAutoSolicitudConFlotaDrivers,
  processCobroCuota,
  updateMoraDiaria,
  effectiveAmountDueForMiAutoFleetRowAsync,
} from '../services/miautoCuotaSemanalService.js';
import {
  addDaysYmd,
  getPreviousWeekIncomeRangeLima,
  limaWeekStartToMiAutoIncomeRange,
  mondayOfWeekContainingYmd,
} from '../utils/miautoLimaWeekRange.js';

const TIMEZONE = 'America/Lima';
const FLEET_MS_BETWEEN_COBROS = 1500;
const INCOME_RETRY_BASE_MS = Math.max(500, Number(process.env.MIAUTO_INCOME_RETRY_BASE_MS || 2500));

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getDriverIncomeWithRetries(dateFrom, dateTo, externalDriverId, parkId, maxAttempts) {
  const n = Math.max(1, Math.min(12, Number(maxAttempts) || 1));
  let last = { success: false, error: 'sin intentos' };
  for (let attempt = 1; attempt <= n; attempt++) {
    last = await getDriverIncome(dateFrom, dateTo, externalDriverId, parkId);
    if (last.success) return last;
    if (attempt < n) {
      const waitMs = INCOME_RETRY_BASE_MS * attempt;
      logger.warn(
        `Mi Auto: income intento ${attempt}/${n} fallido (${last.error || 'error'}), espero ${waitMs}ms y reintento`
      );
      await delay(waitMs);
    }
  }
  return last;
}

/** Rango Yango semana Lun–Dom cerrada + lunes de fila `week_start_date` en BD (= lunes ingresos + 7). */
function currentMondayCuotaContext() {
  const prev = getPreviousWeekIncomeRangeLima();
  const { weekStartDate: incomeWeekMonday, sundayDate, dateFrom, dateTo } = prev;
  const cuotaWeekMonday = addDaysYmd(incomeWeekMonday, 7);
  return { incomeWeekMonday, sundayDate, dateFrom, dateTo, cuotaWeekMonday };
}

/**
 * Yango (o primera semana) + `ensureCuotaSemanalForWeek`.
 * @param {{ incomeMaxAttempts?: number, incomeFallbackZeroOnFailure?: boolean }} [options]
 *   incomeMaxAttempts: intentos a Yango por solicitud (default 1; regeneración manual 4–6).
 *   incomeFallbackZeroOnFailure: si Yango falla tras reintentos, igual generar cuota con 0 viajes y 0 PF (default true).
 *     Desactivar: `incomeFallbackZeroOnFailure: false` o env `MIAUTO_INCOME_FAIL_USE_ZERO=0`.
 */
async function ensureCuotaOneSolicitud(sol, cuotaWeekMonday, dateFrom, dateTo, options = {}) {
  const incomeMaxAttempts = Math.max(1, Math.min(12, Number(options.incomeMaxAttempts) || 1));
  const strictIncomeFailure =
    options.incomeFallbackZeroOnFailure === false || process.env.MIAUTO_INCOME_FAIL_USE_ZERO === '0';
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
    incomeResult = await getDriverIncomeWithRetries(
      dateFrom,
      dateTo,
      sol.external_driver_id,
      sol.park_id,
      incomeMaxAttempts
    );
    if (!incomeResult.success) {
      if (strictIncomeFailure) {
        logger.warn(`Mi Auto: income fallido solicitud ${sol.solicitud_id}: ${incomeResult.error}`);
        return { outcome: 'income_failed', incomeError: incomeResult.error };
      }
      logger.warn(
        `Mi Auto: income fallido solicitud ${sol.solicitud_id}: ${incomeResult.error} — se genera cuota con 0 viajes y 0 partner_fees (sin datos Yango)`
      );
      incomeResult = { success: true, count_completed: 0, partner_fees: 0 };
    }
  }

  const ensuredId = await ensureCuotaSemanalForWeek(
    sol.solicitud_id,
    sol.cronograma_id,
    sol.cronograma_vehiculo_id,
    cuotaWeekMonday,
    { count_completed: incomeResult.count_completed, partner_fees: incomeResult.partner_fees }
  );
  if (ensuredId == null) {
    logger.warn(
      `Mi Auto: sin fila cuota (ensure null) solicitud ${sol.solicitud_id} — revisar cronograma/vehículo/reglas viajes`
    );
    return { outcome: 'ensure_failed' };
  }
  return { outcome: 'ok' };
}

/**
 * Regenera la fila `week_start_date` = lunes de cuota indicado (consulta Yango Lun–Dom previo + ensureCuotaSemanalForWeek).
 * No ejecuta cobro Fleet.
 * @param {string} solicitudId
 * @param {string} cuotaWeekYmd Fecha civil cualquiera de esa semana o el lunes exacto (YYYY-MM-DD).
 * @param {{ incomeMaxAttempts?: number, incomeFallbackZeroOnFailure?: boolean }} [options]
 */
export async function regenerateMiAutoCuotaForWeekMonday(solicitudId, cuotaWeekYmd, options = {}) {
  const sid = String(solicitudId || '').trim();
  const raw = String(cuotaWeekYmd || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ok: false, error: 'fecha_invalida', solicitud_id: sid };
  }
  const cuotaWeekMonday = mondayOfWeekContainingYmd(raw);
  const sol = await loadMiAutoSolicitudConFlotaDrivers(sid);
  if (!sol) {
    return { ok: false, error: 'not_found', solicitud_id: sid };
  }
  const { dateFrom, dateTo, weekStartDate: incomeWeekMonday, sundayDate } = limaWeekStartToMiAutoIncomeRange(
    cuotaWeekMonday
  );
  logger.info(
    `Mi Auto: regenerar cuota solicitud=${sid} week_start=${cuotaWeekMonday} | ingresos Lun ${incomeWeekMonday}→Dom ${sundayDate}`
  );
  const ensured = await ensureCuotaOneSolicitud(sol, cuotaWeekMonday, dateFrom, dateTo, options);
  if (ensured.outcome !== 'ok') {
    return {
      ok: false,
      solicitud_id: sid,
      cuotaWeekMonday,
      incomeWeekMonday,
      sundayDate,
      ...ensured,
    };
  }
  await persistPaidAmountCapsForSolicitud(sid);
  return {
    ok: true,
    solicitud_id: sid,
    cuotaWeekMonday,
    incomeWeekMonday,
    sundayDate,
    dateFrom,
    dateTo,
  };
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

/**
 * @param {{ incomeMaxAttempts?: number, reportDetails?: boolean }} [options]
 *   incomeMaxAttempts: reintentos Yango por solicitud (cron usa 1; regeneración manual 5 recomendado).
 *   reportDetails: si true, devuelve `details` por solicitud (outcome, errores Yango, etc.).
 */
export async function runWeeklyCuotaGenerationMonday(options = {}) {
  const incomeMaxAttempts = Math.max(1, Math.min(12, Number(options.incomeMaxAttempts) || 1));
  const reportDetails = !!options.reportDetails;
  logger.info(`Mi Auto: generación semanal (lunes 1:10 Lima) incomeMaxAttempts=${incomeMaxAttempts}`);
  try {
    const { incomeWeekMonday, sundayDate, dateFrom, dateTo, cuotaWeekMonday } = currentMondayCuotaContext();
    logger.info(
      `Mi Auto: ingresos Lun ${incomeWeekMonday}→Dom ${sundayDate} | week_start cuota=${cuotaWeekMonday} | Yango ${dateFrom}…${dateTo}`
    );

    const solicitudes = await getSolicitudesParaCobroSemanal();
    if (solicitudes.length === 0) {
      logger.info('Mi Auto: sin solicitudes para cobro semanal');
      return {
        solicitudes: 0,
        ok: 0,
        skipped: 0,
        income_failed: 0,
        ensure_failed: 0,
        cuotaWeekMonday,
        incomeWeekMonday,
        dateFrom,
        dateTo,
        ...(reportDetails ? { details: [] } : {}),
      };
    }

    let ok = 0;
    let skipped = 0;
    let income_failed = 0;
    let ensure_failed = 0;
    const details = reportDetails ? [] : null;
    for (const sol of solicitudes) {
      const r = await ensureCuotaOneSolicitud(sol, cuotaWeekMonday, dateFrom, dateTo, {
        incomeMaxAttempts,
      });
      if (reportDetails) {
        const row = { solicitud_id: sol.solicitud_id, outcome: r.outcome };
        if (r.outcome === 'before_inicio') row.monday_inicio_deposito = r.mondayInicioDeposito;
        if (r.outcome === 'income_failed') row.income_error = r.incomeError;
        details.push(row);
      }
      if (r.outcome === 'before_inicio') skipped++;
      else if (r.outcome === 'income_failed') income_failed++;
      else if (r.outcome === 'ensure_failed') ensure_failed++;
      else ok++;
    }

    for (const sol of solicitudes) {
      await persistPaidAmountCapsForSolicitud(sol.solicitud_id);
    }
    logger.info(
      `Mi Auto: generación lista; cobro Fleet lunes 7:10 | solicitudes=${solicitudes.length} ok=${ok} antes_inicio=${skipped} income_fallido=${income_failed} ensure_null=${ensure_failed}`
    );
    return {
      solicitudes: solicitudes.length,
      ok,
      skipped,
      income_failed,
      ensure_failed,
      cuotaWeekMonday,
      incomeWeekMonday,
      dateFrom,
      dateTo,
      ...(reportDetails ? { details } : {}),
    };
  } catch (err) {
    logger.error('Mi Auto job generación semanal:', err);
    return null;
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

/**
 * Solo cobro Fleet (misma cola que lunes 7:10), una solicitud rent sale / Mi Auto.
 * No regenera cuota ni llama a Yango income — útil tras ajustes manuales en BD.
 */
export async function runFleetCobroSoloSolicitud(solicitudId) {
  const sid = String(solicitudId || '').trim();
  if (!sid) {
    return { ok: false, error: 'solicitud_id vacío' };
  }
  logger.info(`Mi Auto: runFleetCobroSoloSolicitud ${sid} (cola como job 7:10)`);
  try {
    await updateMoraDiaria(sid, { includePartial: true });
    const cuotas = await getCuotasToChargeForSolicitud(sid);
    if (cuotas.length === 0) {
      logger.info(`Mi Auto: ${sid} sin cuotas pending/overdue/partial con saldo > 0 en cola Fleet`);
      return {
        ok: true,
        solicitud_id: sid,
        cuotasProcesadas: 0,
        success: 0,
        partial: 0,
        failed: 0,
        cola: [],
      };
    }
    const { success, partial, failed } = await processCobroCuotaQueue(cuotas);
    logger.info(`Mi Auto Fleet ${sid}: ${success} ok, ${partial} parcial, ${failed} fallidos`);
    return {
      ok: failed === 0,
      solicitud_id: sid,
      cuotasProcesadas: cuotas.length,
      success,
      partial,
      failed,
    };
  } catch (err) {
    logger.error(`Mi Auto runFleetCobroSoloSolicitud ${sid}:`, err);
    return { ok: false, error: String(err?.message || err), solicitud_id: sid };
  }
}

/**
 * Una solicitud: misma generación que el lunes + cola opcional Fleet (`dryRun: false`).
 */
export async function runWeeklyChargeForSolicitud(solicitudId, options = {}) {
  const dryRun = options.dryRun !== false;
  const sid = String(solicitudId || '').trim();
  logger.info(`Mi Auto: runWeeklyChargeForSolicitud ${sid} dryRun=${dryRun}`);

  const sol = await loadMiAutoSolicitudConFlotaDrivers(sid);
  if (!sol) {
    logger.error(`Mi Auto: solicitud no encontrada ${sid}`);
    return { ok: false, error: 'not_found' };
  }
  if (sol.status !== 'aprobado') {
    logger.warn(`Mi Auto: ${sid} status=${sol.status} (se requiere aprobado para generación/cobro semanal)`);
  }

  await updateMoraDiaria(sid, { includePartial: true });

  const { incomeWeekMonday, sundayDate, dateFrom, dateTo, cuotaWeekMonday } = currentMondayCuotaContext();
  logger.info(
    `Mi Auto: ingresos Lun ${incomeWeekMonday}→Dom ${sundayDate} | week_start cuota=${cuotaWeekMonday} | Yango ${dateFrom}…${dateTo}`
  );

  const ensured = await ensureCuotaOneSolicitud(sol, cuotaWeekMonday, dateFrom, dateTo, {
    incomeMaxAttempts: Number(options.incomeMaxAttempts) || 1,
  });
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
  if (ensured.outcome === 'ensure_failed') {
    return { ok: false, error: 'ensure_failed', detail: 'Sin regla/vehículo o ensure null' };
  }

  await persistPaidAmountCapsForSolicitud(sid);
  await updateMoraDiaria(sid, { includePartial: true });

  const cuotas = await getCuotasToChargeForSolicitud(sid);

  if (dryRun) {
    const cola = [];
    for (let i = 0; i < cuotas.length; i++) {
      const c = cuotas[i];
      const amountDue = await effectiveAmountDueForMiAutoFleetRowAsync(c);
      const paid = round2(parseFloat(c.paid_amount) || 0);
      const lateFee = round2(parseFloat(c.late_fee) || 0);
      const pendiente = round2(amountDue + lateFee - paid);
      logger.info(`Mi Auto [dry-run] #${i + 1} id=${c.id} due=${c.due_date} pendiente=${pendiente}`);
      cola.push({
        orden: i + 1,
        cuota_id: c.id,
        due_date: c.due_date,
        week_start_date: c.week_start_date,
        status: c.status,
        pendiente,
      });
    }
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
