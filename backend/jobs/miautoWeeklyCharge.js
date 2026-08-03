/**
 * Mi Auto — crons America/Lima: mora 1:00 diaria; demás automatizaciones administrables.
 * @see initializeJobs → startMiautoWeeklyChargeJob
 */
import cron from 'node-cron';
import { logger, businessLog } from '../utils/logger.js';
import { round2 } from '../yego_miauto/services/utils/miautoMoneyUtils.js';
import { MIAUTO_PARK_ID } from '../yego_miauto/services/utils/miautoDriverLookup.js';
import { query } from '../config/database.js';
import {
  getContractorBalance,
  fleetCookieCobroForMiAuto,
  fleetParkIdForMiAuto,
  getDriverIncome,
} from '../services/yangoService.js';
import {
  getSolicitudesParaCobroSemanal,
  isSemanaDepositoMiAuto,
  persistPaidAmountCapsForSolicitud,
  loadMiAutoSolicitudConFlotaDrivers,
  updateMoraDiaria,
} from '../yego_miauto/services/cuotas/miautoCuotaSemanalService.js';
import {
  getCuotasToCharge,
  getCuotasToChargeForSolicitud,
  processCobroCuota,
  effectiveAmountDueForMiAutoFleetRowAsync,
} from '../yego_miauto/services/cuotas/miautoFleetChargeService.js';
import { generateWeeklyCharge } from '../yego_miauto/services/cobros/CobroEngine.js';
import {
  addDaysYmd,
  getPreviousWeekIncomeRangeLima,
  limaWeekStartToMiAutoIncomeRange,
  mondayOfWeekContainingYmd,
} from '../utils/miautoLimaWeekRange.js';
import { appendMiautoFleetCobroJobAuditEvent } from '../utils/miautoFleetCobroAuditLog.js';
import { acquireCronLock, releaseCronLock } from '../utils/cronLock.js';
import {
  generateExpenseCyclesForActiveContracts,
  refreshAdditionalExpenseStatuses,
} from '../yego_miauto/services/gastos/miautoOtrosGastosService.js';
import { getMiautoAutomationConfig } from '../yego_miauto/services/config/miautoAutomationConfigService.js';
import { getMiautoAutomationActions } from '../yego_miauto/services/config/miautoAutomationConfig.js';
import {
  beginMiautoFleetChargeAttempt,
  claimMiautoFleetChargeRun,
  finishMiautoFleetChargeAttempt,
  finishMiautoFleetChargeRun,
  filterMiautoFleetCuotasBySolicitud,
  filterMiautoFleetRetryCuotas,
  getMiautoFleetRetryDecision,
  getMiautoFleetRetryableCuotaIds,
  initializeMiautoFleetChargeRun,
  queueMiautoFleetChargeAttempts,
} from '../yego_miauto/services/cuotas/miautoFleetChargeRunService.js';

const TIMEZONE = 'America/Lima';
const FLEET_MS_BETWEEN_COBROS = 1500;
const INCOME_RETRY_BASE_MS = Math.max(500, Number(process.env.MIAUTO_INCOME_RETRY_BASE_MS || 2500));
let automationPollRunning = false;

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

function ymdFromDbDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  return s ? s.slice(0, 10) : null;
}

/**
 * Viajes desde el conductor working de la placa, no del driver_id_fleet.
 * Aplica para todos los conductores. Si no hay conductor working con esa placa → viajes = 0.
 * @returns {{ driver_id: string, park_id: string } | null}
 */
async function resolveTripsFromPlacaDriver(placa, driverIdFleet = null) {
  if (!placa) return null;
  const placaNorm = String(placa).trim().toUpperCase().replace(/\s+/g, '');
  const placaSql = `UPPER(REGEXP_REPLACE(TRIM(COALESCE(d.car_number, '')), '\\\\s', '', 'g')) = \$2`;

  if (driverIdFleet) {
    const match = await query(
      `SELECT d.driver_id, d.park_id FROM drivers d
       WHERE TRIM(COALESCE(d.park_id::text, '')) = \$1
         AND d.work_status = 'working'
         AND d.driver_id = \$3
         AND ${placaSql}
       LIMIT 1`,
      [MIAUTO_PARK_ID, placaNorm, driverIdFleet]
    );
    if (match.rows.length > 0) {
      return { driver_id: match.rows[0].driver_id, park_id: match.rows[0].park_id || MIAUTO_PARK_ID };
    }
  }

  const res = await query(
    `SELECT d.driver_id, d.park_id FROM drivers d
     WHERE TRIM(COALESCE(d.park_id::text, '')) = \$1
       AND d.work_status = 'working'
       AND ${placaSql}
     LIMIT 1`,
    [MIAUTO_PARK_ID, placaNorm]
  );
  return res.rows.length > 0 ? { driver_id: res.rows[0].driver_id, park_id: res.rows[0].park_id || MIAUTO_PARK_ID } : null;
}

/**
 * Yango (o primera semana) + `generateWeeklyCharge`.
 * @param {{ incomeMaxAttempts?: number }} [options]
 *   incomeMaxAttempts: intentos a Yango por solicitud (default 1; regeneración manual 4–6).
 */
async function ensureCuotaOneSolicitud(sol, cuotaWeekMonday, dateFrom, dateTo, options = {}) {
  const incomeMaxAttempts = Math.max(1, Math.min(12, Number(options.incomeMaxAttempts) || 1));
  const fiStr = sol.fecha_inicio_cobro_semanal
    ? String(sol.fecha_inicio_cobro_semanal).trim().slice(0, 10)
    : null;
  const mondayInicio =
    fiStr && /^\d{4}-\d{2}-\d{2}$/.test(fiStr) ? mondayOfWeekContainingYmd(fiStr) : null;
  if (mondayInicio && cuotaWeekMonday < mondayInicio) {
    return { outcome: 'before_inicio', mondayInicioDeposito: mondayInicio };
  }

  const esPrimera = isSemanaDepositoMiAuto(cuotaWeekMonday, sol.fecha_inicio_cobro_semanal);
  const placaStr = sol.placa_asignada ? ` [Placa: ${String(sol.placa_asignada).trim()}]` : '';
  const driverLabel = [sol.first_name, sol.last_name]
    .filter(Boolean)
    .join(' ')
    .trim() || 'Conductor';
  const sinDriverYango = !sol.external_driver_id || String(sol.external_driver_id).trim() === '';

  let incomeResult;
  if (esPrimera) {
    incomeResult = { success: true, count_completed: 0, partner_fees: 0 };
    logger.debug('miauto.cuota.primera_sin_yango', {
      solicitudId: sol.solicitud_id,
      driverLabel,
      placa: placaStr ? String(sol.placa_asignada).trim() : null,
    });
  } else if (sinDriverYango) {
    logger.error('miauto.cuota.yango_sin_driver', {
      solicitudId: sol.solicitud_id,
      driverLabel,
      placa: placaStr ? String(sol.placa_asignada).trim() : null,
      action: 'omitir_cuota_para_no_guardar_ingresos_en_cero',
    });
    return { outcome: 'income_failed', incomeError: 'driver_yango_no_resuelto' };
  } else {
    const placaTrips = await resolveTripsFromPlacaDriver(sol.placa_asignada, sol.external_driver_id);
    // Viajes: del conductor working de la placa. Si no hay → 0.
    const viajesSource = placaTrips;
    const viajes = viajesSource
      ? await getDriverIncomeWithRetries(dateFrom, dateTo, viajesSource.driver_id, viajesSource.park_id, incomeMaxAttempts)
      : { success: true, count_completed: 0, partner_fees: 0 };
    // Recaudo: del recaudo_driver_id si está seteado, sino del driver_id_fleet
    const recaudoDriver = sol.recaudo_driver_id || sol.external_driver_id;
    const mismaFuente = viajesSource &&
      String(recaudoDriver || '').trim() === String(viajesSource.driver_id || '').trim() &&
      fleetParkIdForMiAuto(sol.park_id) === fleetParkIdForMiAuto(viajesSource.park_id);
    const recaudo = mismaFuente
      ? viajes
      : await getDriverIncomeWithRetries(dateFrom, dateTo, recaudoDriver, sol.park_id, incomeMaxAttempts);

    const viajesFallaron = !!viajesSource && !viajes.success;
    if (viajesFallaron || !recaudo.success) {
      const incomeError = [
        viajesFallaron ? `viajes: ${viajes.error || 'error'}` : null,
        !recaudo.success ? `recaudo: ${recaudo.error || 'error'}` : null,
      ].filter(Boolean).join(' | ');
      logger.error('miauto.cuota.yango_income_failed', {
        solicitudId: sol.solicitud_id,
        driverLabel,
        placa: placaStr ? String(sol.placa_asignada).trim() : null,
        incomeError,
        mismaFuente,
        action: 'omitir_cuota_para_no_guardar_ingresos_en_cero',
      });
      return { outcome: 'income_failed', incomeError };
    }

    incomeResult = {
      success: true,
      count_completed: (viajesSource && viajes.success) ? viajes.count_completed : 0,
      partner_fees: recaudo.partner_fees,
      error: null,
    };
  }

  const ensuredId = await generateWeeklyCharge({
    solicitudId: sol.solicitud_id,
    weekStartDate: cuotaWeekMonday,
    incomeResult: { count_completed: incomeResult.count_completed, partner_fees: incomeResult.partner_fees },
    options: {
      generatedBy: 'cron_lunes',
      forceUseYangoData: !!options.forceUseYangoData,
    },
  });
  if (ensuredId?.error) {
    logger.warn(
      `Mi Auto: sin fila cuota (${ensuredId.error}) solicitud ${sol.solicitud_id} — revisar cronograma/vehículo/reglas viajes`
    );
    return { outcome: 'ensure_failed' };
  }
  // Registrar evento de negocio
  businessLog('charge.generated', {
    solicitudId: sol.solicitud_id,
    weekStartDate: cuotaWeekMonday,
    cuotaId: ensuredId.cuotaId,
    amountDue: ensuredId.amountDue,
    pendingTotal: ensuredId.pendingTotal,
    source: 'cron_lunes',
  }, {
    entityType: 'cuota_semanal',
    entityId: ensuredId.cuotaId,
  });
  return { outcome: 'ok' };
}

/**
 * Regenera la fila `week_start_date` = lunes de cuota indicado (consulta Yango Lun–Dom previo + generateWeeklyCharge).
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

/** Agrupa filas consecutivas mismo conductor/parque Fleet (tras resolver parque Mi Auto). */
function chunkCuotasFleetMismaCuenta(cuotas) {
  if (!cuotas || cuotas.length === 0) return [];
  const chunks = [];
  let cur = [];
  let prevKey = null;
  for (const c of cuotas) {
    const ext = String(c.external_driver_id || '').trim().toLowerCase();
    const park = String(fleetParkIdForMiAuto(c.park_id) || '').trim().toLowerCase();
    const k = `${ext}|${park}`;
    if (prevKey !== null && k !== prevKey) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(c);
    prevKey = k;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function parseJsonArraySafe(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function findCobroSaldoSourceCuota(chunk, cuotaWeekMonday) {
  if (!Array.isArray(chunk) || chunk.length === 0) return null;
  const currentWeek = chunk.find((c) => ymdFromDbDate(c.week_start_date) === cuotaWeekMonday);
  if (currentWeek) return currentWeek;
  return [...chunk].sort((a, b) => {
    const aw = ymdFromDbDate(a.week_start_date) || ymdFromDbDate(a.due_date) || '';
    const bw = ymdFromDbDate(b.week_start_date) || ymdFromDbDate(b.due_date) || '';
    return bw.localeCompare(aw);
  })[0] || null;
}

async function appendCobroSaldoReferencia(sourceCuota, targetCuota, monto, options = {}) {
  const amount = round2(Math.max(0, Number(monto) || 0));
  const sourceId = sourceCuota?.id ? String(sourceCuota.id) : '';
  const targetId = targetCuota?.id ? String(targetCuota.id) : '';
  if (!sourceId || !targetId || sourceId === targetId || amount <= 0.005) return;

  const source = options.source || 'fleet_7_10';
  const existing = await query(
    `SELECT cobro_saldo_referencia
     FROM module_miauto_cuota_semanal
     WHERE id = $1::uuid AND deleted_at IS NULL
     LIMIT 1`,
    [sourceId]
  );
  const refs = parseJsonArraySafe(existing.rows[0]?.cobro_saldo_referencia);
  const targetWeek = ymdFromDbDate(targetCuota.week_start_date);
  const targetDue = ymdFromDbDate(targetCuota.due_date);
  const idx = refs.findIndex((r) =>
    String(r?.cuota_semanal_id || '') === targetId &&
    String(r?.source || 'fleet_7_10') === source
  );

  const nextRef = {
    cuota_semanal_id: targetId,
    week_start_date: targetWeek,
    due_date: targetDue,
    monto: amount,
    source,
  };
  if (idx >= 0) {
    refs[idx] = {
      ...refs[idx],
      ...nextRef,
      monto: round2((Number(refs[idx]?.monto) || 0) + amount),
    };
  } else {
    refs.push(nextRef);
  }

  await query(
    `UPDATE module_miauto_cuota_semanal
     SET cobro_saldo_referencia = $1::jsonb,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2::uuid AND deleted_at IS NULL`,
    [JSON.stringify(refs), sourceId]
  );
}

/**
 * La fila de la semana que originó el saldo conserva el retiro Fleet completo.
 * Las referencias descuentan lo que se destinó a cuotas anteriores, dejando visible
 * en esa misma semana solamente el remanente que la cubrió a ella.
 */
async function acumularCobroFleetDistribuidoEnSemanaOrigen(sourceCuota, monto) {
  const amount = round2(Math.max(0, Number(monto) || 0));
  if (!sourceCuota?.id || amount <= 0.005) return;
  await query(
    `UPDATE module_miauto_cuota_semanal
     SET cobro_desde_saldo_conductor = ROUND((COALESCE(cobro_desde_saldo_conductor, 0) + $1::numeric)::numeric, 2),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2::uuid AND deleted_at IS NULL`,
    [amount, sourceCuota.id]
  );
}

/**
 * Cola Fleet: **un solo** `getContractorBalance` por conductor+parque; el total retirado en la pasada
 * no supera ese snapshot (p. ej. saldo 780 → reparto entre cuotas hasta agotar, sin reconsultar saldo inflado).
 */
async function processCobroCuotaQueue(cuotas, options = {}) {
  let success = 0;
  let partial = 0;
  let failed = 0;
  if (!cuotas || cuotas.length === 0) return { success, partial, failed };

  const solicitudPendingMap = options.solicitudPendingMap;
  if (!(solicitudPendingMap instanceof Map)) {
    throw new Error('processCobroCuotaQueue: falta solicitudPendingMap (usar retorno de getCuotasToCharge*)');
  }
  const simulateFleetWithdraw = !!options.simulateFleetWithdraw;
  const simulateReason = options.simulateReason || null;
  const { cuotaWeekMonday } = currentMondayCuotaContext();
  const cobroReferenciaSource = options.cobroReferenciaSource || (simulateFleetWithdraw ? 'fleet_7_10_simulado' : 'fleet_7_10');
  const beginAttempt = typeof options.beginAttempt === 'function' ? options.beginAttempt : null;
  const finishAttempt = typeof options.finishAttempt === 'function' ? options.finishAttempt : null;

  async function auditRejectedCuota(cuota, result, context) {
    if (!beginAttempt || !finishAttempt) return;
    try {
      const attempt = await beginAttempt(cuota, context);
      await finishAttempt(attempt, {
        ...result,
        externalDriverId: context.externalDriverId,
        parkId: context.parkId,
      });
    } catch (error) {
      logger.error('miauto.fleet_queue.audit_failed', {
        cuotaId: cuota?.id,
        solicitudId: cuota?.solicitud_id,
        error: String(error?.message || error),
      });
    }
  }

  const chunks = chunkCuotasFleetMismaCuenta(cuotas);
  let processedGlobal = 0;
  const total = cuotas.length;

  function logQueueProgress(cuota, status) {
    logger.info('miauto.fleet_queue.progress', {
      cuotaId: cuota?.id || null,
      solicitudId: cuota?.solicitud_id || null,
      processed: processedGlobal,
      total,
      remaining: Math.max(0, total - processedGlobal),
      success,
      partial,
      failed,
      status,
    });
  }

  for (const chunk of chunks) {
    const head = chunk[0];
    const parkId = fleetParkIdForMiAuto(head.park_id);
    const ext = String(head.external_driver_id || '').trim();
    const cookieMiAuto = fleetCookieCobroForMiAuto(null);
    const br = await getContractorBalance(ext, parkId, cookieMiAuto);

    if (!br.success) {
      for (const c of chunk) {
        failed += 1;
        await auditRejectedCuota(c, {
          failed: true,
          partial: false,
          reason: br.error || 'Error consultando saldo Fleet',
          balance: null,
        }, { externalDriverId: ext, parkId });
        processedGlobal += 1;
        logQueueProgress(c, 'failed');
      }
      logger.warn('miauto.fleet_queue.balance_error', {
        cuotasEnChunk: chunk.length,
        driverName: [head.first_name, head.last_name].filter(Boolean).join(' ').trim() || 'Conductor',
        externalDriverId: ext,
        parkId,
        error: br.error,
      });
      continue;
    }

    const snapshot = round2(Math.max(0, Number(br.balance) || 0));
    if (snapshot <= 0) {
      for (const c of chunk) {
        failed += 1;
        await auditRejectedCuota(c, {
          failed: true,
          partial: false,
          reason: 'Sin saldo disponible',
          balance: snapshot,
        }, { externalDriverId: ext, parkId });
        processedGlobal += 1;
        logQueueProgress(c, 'failed');
      }
      logger.info('miauto.fleet_queue.sin_saldo_snapshot', {
        cuotasEnChunk: chunk.length,
        driverName: [head.first_name, head.last_name].filter(Boolean).join(' ').trim() || 'Conductor',
        externalDriverId: ext,
        parkId,
        balance: snapshot,
      });
      continue;
    }

    logger.info('miauto.fleet_queue.balance_snapshot', {
      cuotasEnChunk: chunk.length,
      driverName: [head.first_name, head.last_name].filter(Boolean).join(' ').trim() || 'Conductor',
      externalDriverId: ext,
      parkId,
      balance: snapshot,
    });

    const sharedFleetBalancePEN = { remaining: snapshot };
    const sourceCuota = findCobroSaldoSourceCuota(chunk, cuotaWeekMonday);
    let distribuidoDesdeSemanaOrigen = 0;

    for (let j = 0; j < chunk.length; j++) {
      let attempt = null;
      if (beginAttempt) {
        try {
          attempt = await beginAttempt(chunk[j], { externalDriverId: ext, parkId });
        } catch (error) {
          failed += 1;
          processedGlobal += 1;
          logger.error('miauto.fleet_queue.audit_reservation_failed', {
            cuotaId: chunk[j]?.id,
            solicitudId: chunk[j]?.solicitud_id,
            error: String(error?.message || error),
            action: 'cobro_omitido_para_evitar_retiro_sin_auditoria',
          });
          logQueueProgress(chunk[j], 'failed');
          if (processedGlobal < total) await delay(FLEET_MS_BETWEEN_COBROS);
          continue;
        }
      }
      const balanceBefore = sharedFleetBalancePEN.remaining;
      const result = await processCobroCuota(chunk[j], null, null, {
        sharedFleetBalancePEN,
        solicitudPendingMap,
        simulateFleetWithdraw,
        simulateReason,
        idempotencyToken: attempt?.idempotency_token || null,
      });
      const auditedResult = {
        ...result,
        balance: balanceBefore,
        externalDriverId: ext,
        parkId,
      };
      if (attempt && finishAttempt) {
        try {
          await finishAttempt(attempt, auditedResult);
        } catch (error) {
          logger.error('miauto.fleet_queue.audit_finish_failed', {
            cuotaId: chunk[j]?.id,
            solicitudId: chunk[j]?.solicitud_id,
            attemptId: attempt.id,
            error: String(error?.message || error),
          });
        }
      }
      if (result.failed) {
        failed += 1;
        const rid = chunk[j]?.id;
        const why = result.reason || result.error || '(sin motivo)';
        logger.warn('miauto.fleet_queue.cuota_failed', {
          cuotaId: rid,
          solicitudId: chunk[j]?.solicitud_id,
          reason: why,
        });
      } else if (result.partial) partial += 1;
      else success += 1;
      const amountCredited = round2(Math.max(0, Number(result.amountCreditedCuota) || 0));
      if (!result.failed && amountCredited > 0.005) {
        await appendCobroSaldoReferencia(sourceCuota, chunk[j], amountCredited, {
          source: cobroReferenciaSource,
        });
        if (sourceCuota?.id && String(sourceCuota.id) !== String(chunk[j]?.id)) {
          distribuidoDesdeSemanaOrigen = round2(distribuidoDesdeSemanaOrigen + amountCredited);
        }
      }
      processedGlobal += 1;
      logQueueProgress(chunk[j], result.failed ? 'failed' : result.partial ? 'partial' : 'success');
      if (processedGlobal < total) await delay(FLEET_MS_BETWEEN_COBROS);
    }
    await acumularCobroFleetDistribuidoEnSemanaOrigen(sourceCuota, distribuidoDesdeSemanaOrigen);
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
  const scheduleLabel = options.scheduleLabel || 'ejecución semanal';

  // CronLock: evitar doble ejecución
  const lock = await acquireCronLock('miauto_generacion_cuotas', 600);
  if (!lock.acquired) {
    logger.warn('miauto.weekly_generation.lock_skip', { reason: lock.reason });
    return { skipped: true, reason: lock.reason };
  }

  logger.info('miauto.weekly_generation.start', {
    schedule: scheduleLabel,
    incomeMaxAttempts,
    executionId: lock.executionId,
  });
  try {
    const { incomeWeekMonday, sundayDate, dateFrom, dateTo, cuotaWeekMonday } = currentMondayCuotaContext();
    logger.info('miauto.weekly_generation.range', {
      incomeWeekMonday,
      sundayDate,
      cuotaWeekMonday,
      yangoDateFrom: dateFrom,
      yangoDateTo: dateTo,
      executionId: lock.executionId,
    });

    const solicitudes = await getSolicitudesParaCobroSemanal();
    if (solicitudes.length === 0) {
      logger.info('miauto.weekly_generation.empty', { executionId: lock.executionId });
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
    logger.info('miauto.weekly_generation.finish', {
      solicitudes: solicitudes.length,
      ok,
      antesInicio: skipped,
      incomeFallido: income_failed,
      ensureFailed: ensure_failed,
      nextStep: 'cobro Fleet según configuración administrable',
      executionId: lock.executionId,
    });
    await releaseCronLock('miauto_generacion_cuotas', lock.executionId);
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
    await releaseCronLock('miauto_generacion_cuotas', lock.executionId);
    logger.error('Mi Auto job generación semanal:', err);
    return null;
  }
}

/**
 * Cobro Fleet de todas las solicitudes en cola (horario semanal administrable).
 * Opcional `{ auditJob: 'manual_script' }` para el log de auditoría.
 * Opcional `{ simulateFleetWithdraw: true }` para consultar saldo y acreditar internamente sin retirar de Fleet.
 *
 * @param {{ auditJob?: string, simulateFleetWithdraw?: boolean, simulateReason?: string }} [options]
 * @returns {Promise<{ ok: boolean; success?: number; partial?: number; failed?: number; cuotas_en_cola?: number; error?: string }>}
 */
export async function runWeeklyFleetChargeMonday(options = {}) {
  const auditJob = String(options.auditJob || 'semanal_configurado');
  const simulateFleetWithdraw = !!options.simulateFleetWithdraw;
  const scheduleLabel = options.scheduleLabel || 'ejecución semanal configurada';
  const executionType = options.executionType || 'scheduled';
  const attemptNumber = Number.isInteger(Number(options.attemptNumber))
    ? Number(options.attemptNumber)
    : 0;

  const lock = await acquireCronLock('miauto_cobro_fleet', 7200);
  if (!lock.acquired) {
    logger.warn('miauto.fleet_job.lock_skip', { reason: lock.reason });
    return { ok: false, error: lock.reason, skipped: true };
  }

  let run = null;
  try {
    logger.info('miauto.fleet_job.start', {
      schedule: scheduleLabel,
      executionId: lock.executionId,
      simulateFleetWithdraw,
      executionType,
      attemptNumber,
    });
    run = await claimMiautoFleetChargeRun({
      executionType,
      attemptNumber,
      executionId: lock.executionId,
    });
    if (!run) {
      await releaseCronLock('miauto_cobro_fleet', lock.executionId);
      logger.info('miauto.fleet_job.duplicate_skip', { executionType, attemptNumber });
      return { ok: true, skipped: true, reason: 'ejecucion_ya_registrada' };
    }
    await appendMiautoFleetCobroJobAuditEvent({
      tipo: 'cobro_job_inicio',
      job: auditJob,
      timezone: TIMEZONE,
      simulate_fleet_withdraw: simulateFleetWithdraw,
    });
    // Mora: ya aplicada por el cron 1:00 (mismo lunes); no duplicar antes del cobro.
    const { cuotas, solicitudPendingMap } = await getCuotasToCharge();
    await initializeMiautoFleetChargeRun(run.id, cuotas.length);
    await queueMiautoFleetChargeAttempts(run.id, cuotas);
    const { success, partial, failed } = await processCobroCuotaQueue(cuotas, {
      solicitudPendingMap,
      simulateFleetWithdraw,
      simulateReason: options.simulateReason || auditJob,
      cobroReferenciaSource: simulateFleetWithdraw ? 'fleet_7_10_simulado' : 'fleet_7_10',
      beginAttempt: (cuota, context) => beginMiautoFleetChargeAttempt(run.id, cuota, context),
      finishAttempt: (attempt, result) => finishMiautoFleetChargeAttempt(attempt.id, result),
    });
    const remainingQueue = await getCuotasToCharge();
    await finishMiautoFleetChargeRun(run.id, {
      queueCount: cuotas.length,
      success,
      partial,
      failed,
      remainingCount: remainingQueue.cuotas.length,
    });
    await appendMiautoFleetCobroJobAuditEvent({
      tipo: 'cobro_job_fin',
      job: auditJob,
      cuotas_en_cola: cuotas.length,
      success,
      partial,
      failed,
      remaining: remainingQueue.cuotas.length,
      simulate_fleet_withdraw: simulateFleetWithdraw,
    });
    logger.info('miauto.fleet_job.finish', {
      cuotasEnCola: cuotas.length,
      success,
      partial,
      failed,
      executionId: lock.executionId,
      simulateFleetWithdraw,
    });
    await releaseCronLock('miauto_cobro_fleet', lock.executionId);
    return {
      ok: true,
      run_id: run.id,
      success,
      partial,
      failed,
      cuotas_en_cola: cuotas.length,
      pendientes_despues: remainingQueue.cuotas.length,
      simulated: simulateFleetWithdraw,
    };
  } catch (err) {
    if (run?.id) {
      try {
        await finishMiautoFleetChargeRun(run.id, { error: String(err?.message || err) });
      } catch (auditError) {
        logger.error('miauto.fleet_job.audit_finish_failed', {
          runId: run.id,
          error: String(auditError?.message || auditError),
        });
      }
    }
    await releaseCronLock('miauto_cobro_fleet', lock.executionId);
    await appendMiautoFleetCobroJobAuditEvent({
      tipo: 'cobro_job_error',
      job: auditJob,
      error: String(err?.message || err),
    });
    logger.error('Mi Auto job cobro Fleet:', err);
    return {
      ok: false,
      error: String(err?.message || err),
      success: 0,
      partial: 0,
      failed: 0,
      cuotas_en_cola: 0,
    };
  }
}

async function runFleetCobroManual(options = {}) {
  const sourceId = String(options.sourceRunId || '').trim() || null;
  const solicitudId = String(options.solicitudId || '').trim() || null;
  const jobLabel = sourceId
    ? 'reproceso_admin_semana'
    : solicitudId
      ? 'cobro_admin_conductor_hoy'
      : 'reproceso_admin_hoy';
  const lock = await acquireCronLock('miauto_cobro_fleet', 7200);
  if (!lock.acquired) {
    return { ok: false, error: lock.reason, skipped: true };
  }

  let run = null;
  try {
    const currentQueue = await getCuotasToCharge();
    const solicitudCuotas = solicitudId
      ? filterMiautoFleetCuotasBySolicitud(currentQueue.cuotas, solicitudId)
      : currentQueue.cuotas;
    const requestedIds = sourceId
      ? new Set(await getMiautoFleetRetryableCuotaIds(sourceId))
      : new Set(solicitudCuotas.map((cuota) => String(cuota.id)));
    const cuotas = sourceId
      ? filterMiautoFleetRetryCuotas(currentQueue.cuotas, requestedIds)
      : solicitudCuotas;
    if (cuotas.length === 0) {
      await releaseCronLock('miauto_cobro_fleet', lock.executionId);
      return {
        ok: false,
        error: solicitudId
          ? 'El conductor ya no tiene una cuota pendiente con vencimiento de hoy'
          : 'No hay cuotas pendientes de hoy para procesar',
      };
    }

    run = await claimMiautoFleetChargeRun({
      executionType: 'manual',
      attemptNumber: null,
      executionId: lock.executionId,
      sourceRunId: sourceId,
      triggeredBy: options.triggeredBy || null,
    });
    if (!run) throw new Error('No se pudo registrar el proceso de reproceso');
    await initializeMiautoFleetChargeRun(run.id, cuotas.length);
    await queueMiautoFleetChargeAttempts(run.id, cuotas);
    await appendMiautoFleetCobroJobAuditEvent({
      tipo: 'cobro_job_inicio',
      job: jobLabel,
      source_run_id: sourceId,
      solicitud_id: solicitudId,
      run_id: run.id,
      triggered_by: options.triggeredBy || null,
    });
    const started = {
      ok: true,
      accepted: true,
      status: 'running',
      run_id: run.id,
      source_run_id: sourceId,
      solicitud_id: solicitudId,
      cuotas_solicitadas: requestedIds.size,
      cuotas_procesadas: cuotas.length,
    };
    if (typeof options.onRunStarted === 'function') {
      try {
        options.onRunStarted(started);
      } catch (callbackError) {
        logger.warn('miauto.fleet_manual_retry.start_callback_failed', {
          runId: run.id,
          error: String(callbackError?.message || callbackError),
        });
      }
    }
    logger.info('miauto.fleet_manual_retry.started', {
      runId: run.id,
      sourceRunId: sourceId,
      solicitudId,
      queueCount: cuotas.length,
      background: typeof options.onRunStarted === 'function',
    });
    const { success, partial, failed } = await processCobroCuotaQueue(cuotas, {
      solicitudPendingMap: currentQueue.solicitudPendingMap,
      cobroReferenciaSource: sourceId
        ? 'fleet_reproceso_admin_semana'
        : solicitudId
          ? 'fleet_cobro_admin_conductor_hoy'
          : 'fleet_reproceso_admin_hoy',
      beginAttempt: (cuota, context) => beginMiautoFleetChargeAttempt(run.id, cuota, context),
      finishAttempt: (attempt, result) => finishMiautoFleetChargeAttempt(attempt.id, result),
    });

    const afterQueue = await getCuotasToCharge();
    const remainingCount = sourceId
      ? afterQueue.cuotas.filter((cuota) => requestedIds.has(String(cuota.id))).length
      : solicitudId
        ? filterMiautoFleetCuotasBySolicitud(afterQueue.cuotas, solicitudId).length
        : afterQueue.cuotas.length;
    await finishMiautoFleetChargeRun(run.id, {
      queueCount: cuotas.length,
      success,
      partial,
      failed,
      remainingCount,
    });
    await appendMiautoFleetCobroJobAuditEvent({
      tipo: 'cobro_job_fin',
      job: jobLabel,
      source_run_id: sourceId,
      solicitud_id: solicitudId,
      run_id: run.id,
      cuotas_solicitadas: requestedIds.size,
      cuotas_en_cola: cuotas.length,
      success,
      partial,
      failed,
      remaining: remainingCount,
      triggered_by: options.triggeredBy || null,
    });
    await releaseCronLock('miauto_cobro_fleet', lock.executionId);
    return {
      ok: true,
      run_id: run.id,
      source_run_id: sourceId,
      solicitud_id: solicitudId,
      cuotas_solicitadas: requestedIds.size,
      cuotas_procesadas: cuotas.length,
      success,
      partial,
      failed,
      pendientes_despues: remainingCount,
    };
  } catch (error) {
    if (run?.id) {
      try {
        await finishMiautoFleetChargeRun(run.id, { error: String(error?.message || error) });
      } catch (auditError) {
        logger.error('miauto.fleet_manual_retry.audit_finish_failed', {
          runId: run.id,
          error: String(auditError?.message || auditError),
        });
      }
    }
    await releaseCronLock('miauto_cobro_fleet', lock.executionId);
    logger.error('miauto.fleet_manual_retry.failed', {
      sourceRunId: sourceId,
      error: String(error?.message || error),
    });
    return { ok: false, error: String(error?.message || error) };
  }
}

async function startFleetCobroManual(options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    void runFleetCobroManual({
      ...options,
      onRunStarted: settle,
    }).then((result) => {
      settle(result);
    }).catch((error) => {
      settle({ ok: false, error: String(error?.message || error) });
      logger.error('miauto.fleet_manual_background.unhandled', {
        error: String(error?.message || error),
      });
    });
  });
}

/**
 * Reprocesa en bloque las cuotas fallidas o parciales de un proceso semanal.
 * Las ya pagadas quedan fuera al reconstruir la cola actual.
 */
export async function runFleetCobroPendientesDeRun(sourceRunId, options = {}) {
  const sourceId = String(sourceRunId || '').trim();
  if (!sourceId) return { ok: false, error: 'run_id vacío' };
  return runFleetCobroManual({ ...options, sourceRunId: sourceId });
}

export async function startFleetCobroPendientesDeRun(sourceRunId, options = {}) {
  const sourceId = String(sourceRunId || '').trim();
  if (!sourceId) return { ok: false, error: 'run_id vacío' };
  return startFleetCobroManual({ ...options, sourceRunId: sourceId });
}

/** Reprocesa en bloque todas las cuotas Fleet pendientes con vencimiento de hoy. */
export async function runFleetCobroPendientesDeHoy(options = {}) {
  return runFleetCobroManual(options);
}

export async function startFleetCobroPendientesDeHoy(options = {}) {
  return startFleetCobroManual(options);
}

/** Cobra únicamente las cuotas de hoy de un conductor/contrato. */
export async function runFleetCobroSolicitudDeHoy(solicitudId, options = {}) {
  const sid = String(solicitudId || '').trim();
  if (!sid) return { ok: false, error: 'solicitud_id vacío' };
  return runFleetCobroManual({ ...options, solicitudId: sid });
}

export async function startFleetCobroSolicitudDeHoy(solicitudId, options = {}) {
  const sid = String(solicitudId || '').trim();
  if (!sid) return { ok: false, error: 'solicitud_id vacío' };
  return startFleetCobroManual({ ...options, solicitudId: sid });
}

/**
 * Solo cobro Fleet (misma cola de la automatización semanal), una solicitud rent sale / Mi Auto.
 * No regenera cuota ni llama a Yango income — útil tras ajustes manuales en BD.
 */
export async function runFleetCobroSoloSolicitud(solicitudId, options = {}) {
  const sid = String(solicitudId || '').trim();
  if (!sid) {
    return { ok: false, error: 'solicitud_id vacío' };
  }
  logger.info('miauto.fleet_solicitud.start', {
    solicitudId: sid,
    mode: 'solo_solicitud',
    simulateFleetWithdraw: !!options.simulateFleetWithdraw,
  });
  try {
    await appendMiautoFleetCobroJobAuditEvent({
      tipo: 'cobro_job_inicio',
      job: options.auditJob || 'solo_solicitud',
      solicitud_id: sid,
      simulate_fleet_withdraw: !!options.simulateFleetWithdraw,
    });
    // Mora: cron 1:00 Lima + generación/regeneración; mismo criterio que runWeeklyFleetChargeMonday (sin update extra).
    const { cuotas, pendingMap } = await getCuotasToChargeForSolicitud(sid);
    if (cuotas.length === 0) {
      await appendMiautoFleetCobroJobAuditEvent({
        tipo: 'cobro_job_fin',
        job: 'solo_solicitud',
        solicitud_id: sid,
        cuotas_en_cola: 0,
        success: 0,
        partial: 0,
        failed: 0,
        nota: 'sin_cuotas_en_cola',
      });
      logger.info('miauto.fleet_solicitud.empty', { solicitudId: sid });
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
    const { success, partial, failed } = await processCobroCuotaQueue(cuotas, {
      solicitudPendingMap: pendingMap,
      simulateFleetWithdraw: !!options.simulateFleetWithdraw,
      simulateReason: options.simulateReason || options.auditJob || 'solo_solicitud',
      cobroReferenciaSource: options.simulateFleetWithdraw ? 'fleet_7_10_simulado' : 'fleet_7_10',
    });
    await appendMiautoFleetCobroJobAuditEvent({
      tipo: 'cobro_job_fin',
      job: options.auditJob || 'solo_solicitud',
      solicitud_id: sid,
      cuotas_en_cola: cuotas.length,
      success,
      partial,
      failed,
      simulate_fleet_withdraw: !!options.simulateFleetWithdraw,
    });
    logger.info('miauto.fleet_solicitud.finish', {
      solicitudId: sid,
      cuotasEnCola: cuotas.length,
      success,
      partial,
      failed,
    });
    return {
      ok: failed === 0,
      solicitud_id: sid,
      cuotasProcesadas: cuotas.length,
      success,
      partial,
      failed,
      simulated: !!options.simulateFleetWithdraw,
    };
  } catch (err) {
    await appendMiautoFleetCobroJobAuditEvent({
      tipo: 'cobro_job_error',
      job: options.auditJob || 'solo_solicitud',
      solicitud_id: sid,
      error: String(err?.message || err),
      simulate_fleet_withdraw: !!options.simulateFleetWithdraw,
    });
    logger.error('miauto.fleet_solicitud.error', {
      solicitudId: sid,
      error: String(err?.message || err),
      stack: err?.stack,
    });
    return { ok: false, error: String(err?.message || err), solicitud_id: sid };
  }
}

/**
 * Una solicitud: misma generación que el lunes + cola opcional Fleet (`dryRun: false`).
 */
export async function runWeeklyChargeForSolicitud(solicitudId, options = {}) {
  const dryRun = options.dryRun !== false;
  const sid = String(solicitudId || '').trim();
  logger.info('miauto.weekly_solicitud.start', { solicitudId: sid, dryRun });

  const sol = await loadMiAutoSolicitudConFlotaDrivers(sid);
  if (!sol) {
    logger.error('miauto.weekly_solicitud.not_found', { solicitudId: sid });
    return { ok: false, error: 'not_found' };
  }
  if (sol.status !== 'aprobado') {
    logger.warn('miauto.weekly_solicitud.status_invalido', {
      solicitudId: sid,
      status: sol.status,
      required: 'aprobado',
    });
  }

  const { incomeWeekMonday, sundayDate, dateFrom, dateTo, cuotaWeekMonday } = currentMondayCuotaContext();
  logger.info('miauto.weekly_solicitud.range', {
    solicitudId: sid,
    incomeWeekMonday,
    sundayDate,
    cuotaWeekMonday,
    yangoDateFrom: dateFrom,
    yangoDateTo: dateTo,
  });

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
  // Sin updateMoraDiaria aquí: el cron 1:00 y generateWeeklyCharge/regeneración ya recalculan mora cuando aplica.

  const { cuotas, pendingMap } = await getCuotasToChargeForSolicitud(sid);

  if (dryRun) {
    const cola = [];
    for (let i = 0; i < cuotas.length; i++) {
      const c = cuotas[i];
      const amountDue = await effectiveAmountDueForMiAutoFleetRowAsync(c);
      const paid = round2(parseFloat(c.paid_amount) || 0);
      const lateFee = round2(parseFloat(c.late_fee) || 0);
      const fromMap = pendingMap.get(String(c.id));
      const pendiente =
        fromMap != null && !Number.isNaN(Number(fromMap))
          ? round2(Number(fromMap))
          : round2(amountDue + lateFee - paid);
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

  await appendMiautoFleetCobroJobAuditEvent({
    tipo: 'cobro_job_inicio',
    job: 'weekly_charge_solicitud',
    solicitud_id: sid,
  });
  try {
    const { success, partial, failed } = await processCobroCuotaQueue(cuotas, { solicitudPendingMap: pendingMap });
    await appendMiautoFleetCobroJobAuditEvent({
      tipo: 'cobro_job_fin',
      job: 'weekly_charge_solicitud',
      solicitud_id: sid,
      cuotas_en_cola: cuotas.length,
      success,
      partial,
      failed,
    });
    logger.info('miauto.weekly_solicitud.finish', {
      solicitudId: sid,
      cuotasEnCola: cuotas.length,
      success,
      partial,
      failed,
    });
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
  } catch (err) {
    await appendMiautoFleetCobroJobAuditEvent({
      tipo: 'cobro_job_error',
      job: 'weekly_charge_solicitud',
      solicitud_id: sid,
      error: String(err?.message || err),
    });
    throw err;
  }
}

async function runDailyMora() {
  try {
    logger.info('Mi Auto: mora diaria', { includeExcelMora: true });
    await updateMoraDiaria(null, { includePartial: true, includeExcelMora: true });
  } catch (err) {
    logger.error('Mi Auto mora diaria:', err);
  }
}

async function runDailyAdditionalExpenses() {
  try {
    const statuses = await refreshAdditionalExpenseStatuses();
    const generation = await generateExpenseCyclesForActiveContracts();
    logger.info('Mi Auto: gastos recurrentes diarios', { statuses, generation });
    return { statuses, generation };
  } catch (err) {
    logger.error('Mi Auto gastos recurrentes diarios:', err);
    return { error: err.message };
  }
}

export async function runConfiguredAutomation(now = new Date()) {
  if (automationPollRunning) return { skipped: true, reason: 'poll_en_ejecucion' };
  automationPollRunning = true;
  try {
    const config = await getMiautoAutomationConfig();
    const actions = getMiautoAutomationActions(config, now);
    const result = {};
    if (actions.includes('additional_expenses')) {
      result.additionalExpenses = await runDailyAdditionalExpenses();
    }
    if (actions.includes('generation')) {
      result.generation = await runWeeklyCuotaGenerationMonday({
        scheduleLabel: `configurado día ${config.weekly_generation_day} ${config.weekly_generation_time} ${config.timezone}`,
      });
    }
    if (actions.includes('fleet')) {
      result.fleet = await runWeeklyFleetChargeMonday({
        auditJob: 'semanal_configurado',
        scheduleLabel: `configurado día ${config.weekly_fleet_charge_day} ${config.weekly_fleet_charge_time} ${config.timezone}`,
        executionType: 'scheduled',
        attemptNumber: 0,
      });
    } else {
      const retry = await getMiautoFleetRetryDecision(config, now);
      if (retry.due) {
        result.fleetRetry = await runWeeklyFleetChargeMonday({
          auditJob: retry.executionType === 'retry' ? 'reintento_configurado' : 'recuperacion_configurada',
          scheduleLabel: retry.reason,
          executionType: retry.executionType,
          attemptNumber: retry.attemptNumber,
        });
      }
    }
    if (Object.keys(result).length === 0) {
      return { skipped: true, reason: 'fuera_de_horario' };
    }
    return result;
  } catch (err) {
    logger.error('Mi Auto: error evaluando automatizaciones:', err);
    return { skipped: true, reason: 'error_configuracion' };
  } finally {
    automationPollRunning = false;
  }
}

export function startMiautoWeeklyChargeJob() {
  cron.schedule('0 1 * * *', runDailyMora, { timezone: TIMEZONE });
  cron.schedule('* * * * *', runConfiguredAutomation, { timezone: TIMEZONE });
  logger.info('Mi Auto: mora 1:00 | gastos, cuotas y Fleet según configuración (Lima)');
}
