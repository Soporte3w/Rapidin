/**
 * Yego Mi Auto — cobro Fleet Yango: cuotas a retirar, proceso de retiro y saldo efectivo.
 * Extraído de miautoCuotaSemanalService.js (v5 — Mayo 2026).
 */
import { getClient, query } from '../../../config/database.js';
import { logger } from '../../../utils/logger.js';
import {
  fleetCookieCobroForMiAuto,
  fleetParkIdForMiAuto,
  getContractorBalance,
  withdrawFromContractor,
} from '../../../services/yangoService.js';
import { MIAUTO_PARK_ID } from '../utils/miautoDriverLookup.js';
import {
  round2,
  normalizePenUsd,
  convertirMontoEntreMonedas,
  tipoCambioUsdALocalEfectivo,
  partnerFeesRawDbNormalizeUsdFromYangoLocal,
} from '../utils/miautoMoneyUtils.js';
import { appendMiautoFleetCobroAuditLog } from '../../../utils/miautoFleetCobroAuditLog.js';
import {
  buildPendingTotalMapForSolicitud,
  isSemanaDepositoMiAuto,
  touchFechaUltimoAbonoCuota,
} from './miautoCuotaSemanalService.js';
import { computeAmountDueSemanal as computeAmountDueSemanalObj } from '../cobros/CuotaCalculator.js';
import { applyPaymentToExpense } from '../gastos/miautoGastoPagoService.js';
import { availableFleetCharge } from '../gastos/miautoGastoRules.js';

// --- Constantes -------------------------------------------------------------

const PARTNER_FEES_PCT = 0.8333;
const MAX_MANUAL_EXPENSE_CHARGES = 100;

// --- Helpers SQL compartidos ------------------------------------------------

/** Columnas del LATERAL JOIN `fl` (Yango drivers) sin dependencia de module_rapidin_drivers. */
function sqlYangoDriverCoalesceColumns() {
  return `fl.driver_id AS external_driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), '${MIAUTO_PARK_ID}') AS park_id,
            fl.first_name, fl.last_name,
            fl.work_status AS yango_work_status,
            fw.first_name AS working_driver_first_name,
            fw.last_name AS working_driver_last_name,
            s.recaudo_driver_id`;
}

/** LATERAL JOIN a `drivers` (Yango): prioridad driver_id_fleet → DNI → placa → teléfono. */
function sqlYangoDriverLateralJoin(parkParamNumber) {
  const p = parkParamNumber;
  return `LEFT JOIN LATERAL (
        SELECT d.driver_id, d.park_id, d.first_name, d.last_name, d.work_status
        FROM drivers d
        WHERE TRIM(COALESCE(d.park_id::text, '')) = $${p}
          AND (
            d.driver_id = s.driver_id_fleet
            OR (
              REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                  REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g')
              AND REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g') <> ''
            )
            OR UPPER(REGEXP_REPLACE(TRIM(COALESCE(d.car_number, '')), '\\s', '', 'g')) =
                UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '\\s', '', 'g'))
            OR (
              REGEXP_REPLACE(COALESCE(TRIM(d.phone), ''), '[^0-9]', '', 'g') =
                  REGEXP_REPLACE(COALESCE(TRIM(s.phone), ''), '[^0-9]', '', 'g')
              AND REGEXP_REPLACE(COALESCE(TRIM(s.phone), ''), '[^0-9]', '', 'g') <> ''
              AND CHAR_LENGTH(REGEXP_REPLACE(COALESCE(TRIM(s.phone), ''), '[^0-9]', '', 'g')) >= 9
            )
          )
        ORDER BY
          CASE WHEN d.driver_id = s.driver_id_fleet AND s.driver_id_fleet IS NOT NULL AND TRIM(s.driver_id_fleet) <> '' THEN 0
               WHEN REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                    REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g')
                    AND REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g') <> '' THEN 1
               WHEN UPPER(REGEXP_REPLACE(TRIM(COALESCE(d.car_number, '')), '\\s', '', 'g')) =
                    UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '\\s', '', 'g'))
                    AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '\\s', '', 'g')) <> '' THEN 2
               WHEN REGEXP_REPLACE(COALESCE(TRIM(d.phone), ''), '[^0-9]', '', 'g') = REGEXP_REPLACE(COALESCE(TRIM(s.phone), ''), '[^0-9]', '', 'g') THEN 3
               ELSE 4 END,
          CASE WHEN d.work_status = 'working' THEN 0 ELSE 1 END,
          d.driver_id::text
        LIMIT 1
      ) fl ON true
      LEFT JOIN LATERAL (
        SELECT d2.first_name, d2.last_name
        FROM drivers d2
        WHERE TRIM(COALESCE(d2.park_id::text, '')) = $${p}
          AND d2.work_status = 'working'
          AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(d2.car_number, '')), '\\s', '', 'g')) =
              UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '\\s', '', 'g'))
          AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '\\s', '', 'g')) <> ''
        LIMIT 1
      ) fw ON true`;
}

// --- Helpers fleet ---------------------------------------------------------

function isFleetOngoingTransactionsError(msg) {
  const s = String(msg || '').toLowerCase();
  if (!s) return false;
  if (/ongoing/.test(s) && /transaction/.test(s)) return true;
  if (/transacci(o|ó)n(es)?\s+en\s+curso/.test(s)) return true;
  return false;
}

function fleetWithdrawRetryDelayMs() {
  return Math.max(2000, Math.min(120_000, Number(process.env.MIAUTO_FLEET_ONGOING_RETRY_MS || 6000)));
}

function fleetWithdrawMaxAttempts() {
  return Math.max(1, Math.min(8, Number(process.env.MIAUTO_FLEET_WITHDRAW_RETRIES || 5)));
}

async function withdrawWithOngoingRetry({
  externalDriverId,
  amount,
  description,
  cookie,
  parkId,
  logLabel,
  condition,
}) {
  const maxAttempts = fleetWithdrawMaxAttempts();
  const delayMs = fleetWithdrawRetryDelayMs();
  let attempt = 1;
  let result = await withdrawFromContractor(
    externalDriverId,
    amount,
    description,
    cookie,
    parkId,
    condition,
  );
  while (
    !result.success &&
    attempt < maxAttempts &&
    isFleetOngoingTransactionsError(result.message || result.error)
  ) {
    logger.warn('miauto.fleet.withdraw_retry', {
      label: logLabel,
      externalDriverId,
      parkId,
      attempt,
      maxAttempts,
      delayMs,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempt += 1;
    result = await withdrawFromContractor(
      externalDriverId,
      amount,
      description,
      cookie,
      parkId,
      condition,
    );
  }
  return result;
}

async function reserveAdditionalExpenseFleetIntent(expense, intentData) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const lockedExpense = await client.query(
      `SELECT amount_due, paid_amount
       FROM module_miauto_otros_gastos
       WHERE id = $1::uuid AND solicitud_id = $2::uuid AND deleted_at IS NULL
       FOR UPDATE`,
      [expense.id, expense.solicitud_id]
    );
    const current = lockedExpense.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'gasto_no_encontrado' };
    }
    const currentPending = round2(Math.max(0, Number(current.amount_due) - Number(current.paid_amount)));
    if (currentPending <= 0.005) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'sin_saldo_pendiente' };
    }
    if (Math.abs(Number(current.paid_amount) - Number(expense.paid_amount)) > 0.005) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'saldo_actualizado_durante_cobro' };
    }
    const pendingReceipt = await client.query(
      `SELECT cp.id,
              EXISTS (
                SELECT 1 FROM module_miauto_gasto_pago_aplicacion pa
                WHERE pa.comprobante_id = cp.id AND pa.reversed_at IS NULL
              ) OR COALESCE(cp.monto_aplicado, 0) > 0.005 AS pago_aplicado
       FROM module_miauto_comprobante_otros_gastos cp
       WHERE cp.otros_gastos_id = $1::uuid AND cp.estado = 'pendiente'
       ORDER BY cp.created_at DESC, cp.id DESC
       LIMIT 1
       FOR UPDATE`,
      [expense.id]
    );
    const receipt = pendingReceipt.rows[0];
    if (intentData.requiredReceiptId) {
      if (!receipt || receipt.id !== intentData.requiredReceiptId || receipt.pago_aplicado) {
        await client.query('ROLLBACK');
        return { skipped: true, reason: 'comprobante_no_disponible' };
      }
    } else if (receipt) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'comprobante_pendiente' };
    }

    const intent = await client.query(
      `INSERT INTO module_miauto_gasto_cobro_fleet_intento
         (solicitud_id, otros_gastos_id, source_key, monto_retiro, moneda_retiro,
          monto_acreditar, moneda_acreditar, external_driver_id, park_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (source_key) DO UPDATE
         SET estado = 'processing', error = NULL, response = NULL, completed_at = NULL
         WHERE module_miauto_gasto_cobro_fleet_intento.estado = 'failed'
       RETURNING id`,
      [expense.solicitud_id, expense.id, intentData.sourceKey,
        intentData.withdrawalAmount, intentData.localCurrency,
        intentData.creditAmount, intentData.expenseCurrency,
        intentData.externalDriverId, intentData.parkId]
    );
    await client.query('COMMIT');
    return intent.rows[0]
      ? { intentId: intent.rows[0].id }
      : { skipped: true, reason: 'intento_ya_registrado' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// --- Helpers fecha ---------------------------------------------------------

function ymdFromDbDate(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    return m ? m[1] : null;
  }
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return null;
  }
}

function limaTodayYmdSync() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function miAutoOpenStatusSaldoVencimiento(dueYmd, pend, paidDb) {
  if (pend <= 0.005) return 'paid';
  const todayY = limaTodayYmdSync();
  if (dueYmd && /^\d{4}-\d{2}-\d{2}$/.test(dueYmd) && dueYmd < todayY) return 'overdue';
  return paidDb > 0.005 ? 'partial' : 'pending';
}

// --- Helpers monto ---------------------------------------------------------

function computeAmountDueSemanal(params) {
  return computeAmountDueSemanalObj(params).amountDue;
}

function partnerFees83FromRow(row) {
  let pf83 = round2(parseFloat(row.partner_fees_83) || 0);
  if (pf83 > 0) return pf83;
  const raw = round2(parseFloat(row.partner_fees_raw) || 0);
  return round2(raw * PARTNER_FEES_PCT);
}

function resolvedAmountDueSchedForOpenRow(
  r,
  cuotaSemanal,
  _bonoAuto,
  pctComision,
  cobroSaldo,
  isPrimeraCuotaSemanal
) {
  const pfRaw = round2(parseFloat(r.partner_fees_raw) || 0);
  const useWaterfallGross = !isPrimeraCuotaSemanal && pfRaw > 0.005;
  if (useWaterfallGross) {
    const pfYangoRaw = round2(parseFloat(r.partner_fees_yango_raw) || 0);
    const baseCuota = round2(cuotaSemanal);
    const obligacion = round2(baseCuota + round2(cobroSaldo));
    if (pfYangoRaw > 0.005) {
      const poolTotal = round2(pfYangoRaw * PARTNER_FEES_PCT);
      if (poolTotal >= obligacion) {
        return 0;
      }
    }
    const pf83 = partnerFees83FromRow(r);
    return round2(Math.max(0, baseCuota - pf83 + cobroSaldo));
  }
  return computeAmountDueSemanal({
    cuotaSemanal: cuotaSemanal,
    partnerFeesRaw: r.partner_fees_raw,
    pctComision: pctComision,
    cobroSaldo: cobroSaldo,
    partnerFeesApplyToCuotaReduction: true,
    commissionGoesToWaterfall: false,
  });
}

// --- effectiveAmountDue ----------------------------------------------------

function effectiveAmountDueForMiAutoFleetRow(cuotaRow) {
  if (!cuotaRow) return 0;
  const wsCobro = ymdFromDbDate(cuotaRow.week_start_date);
  const isPrimeraCobro =
    wsCobro && cuotaRow.fecha_inicio_cobro_semanal
      ? isSemanaDepositoMiAuto(wsCobro, cuotaRow.fecha_inicio_cobro_semanal)
      : false;
  const csRaw = parseFloat(cuotaRow.cuota_semanal);
  const cuotaSemPlan =
    Number.isFinite(csRaw) && csRaw > 0.005 ? round2(csRaw) : round2(parseFloat(cuotaRow.amount_due) || 0);
  return resolvedAmountDueSchedForOpenRow(
    cuotaRow,
    cuotaSemPlan,
    round2(parseFloat(cuotaRow.bono_auto) || 0),
    round2(Number(parseFloat(cuotaRow.pct_comision) || 0)),
    round2(parseFloat(cuotaRow.cobro_saldo) || 0),
    !!isPrimeraCobro
  );
}

export { effectiveAmountDueForMiAutoFleetRow };

function assertUuidList(values) {
  const ids = [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim()))];
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (ids.length === 0) {
    const error = new Error('Selecciona al menos una cuota de otros gastos');
    error.statusCode = 400;
    throw error;
  }
  if (ids.length > MAX_MANUAL_EXPENSE_CHARGES || ids.some((id) => !uuidPattern.test(id))) {
    const error = new Error('La seleccion de otros gastos no es valida');
    error.statusCode = 400;
    throw error;
  }
  return ids;
}

async function getOpenAdditionalExpenses(solicitudId, expenseIds = null) {
  const parkId = fleetParkIdForMiAuto();
  const ids = expenseIds == null ? null : assertUuidList(expenseIds);
  const expensePromise = query(
      `SELECT og.id, og.solicitud_id, og.tipo, og.numero_cuota, og.total_cuotas,
              og.periodo_anio, og.due_date, og.amount_due, og.paid_amount,
              og.moneda, og.status,
              pending_receipt.id AS pending_receipt_id,
              pending_receipt.monto AS pending_receipt_amount,
              pending_receipt.moneda AS pending_receipt_currency,
              pending_receipt.tipo_cambio AS pending_receipt_exchange_rate,
              pending_receipt.moneda_aplicada AS pending_receipt_applied_currency,
              pending_receipt.file_name AS pending_receipt_file_name,
              pending_receipt.file_path AS pending_receipt_file_path,
              pending_receipt.pago_aplicado AS pending_receipt_applied
       FROM module_miauto_otros_gastos og
       LEFT JOIN LATERAL (
         SELECT cp.id, cp.monto, cp.moneda, cp.tipo_cambio, cp.moneda_aplicada,
                cp.file_name, cp.file_path,
                EXISTS (
                  SELECT 1 FROM module_miauto_gasto_pago_aplicacion pa
                  WHERE pa.comprobante_id = cp.id AND pa.reversed_at IS NULL
                ) OR COALESCE(cp.monto_aplicado, 0) > 0.005 AS pago_aplicado
         FROM module_miauto_comprobante_otros_gastos cp
         WHERE cp.otros_gastos_id = og.id AND cp.estado = 'pendiente'
         ORDER BY cp.created_at DESC, cp.id DESC
         LIMIT 1
       ) pending_receipt ON true
       WHERE og.solicitud_id = $1::uuid
         AND og.deleted_at IS NULL
         AND COALESCE(og.paid_amount, 0) < COALESCE(og.amount_due, 0) - 0.005
         AND ($2::uuid[] IS NULL OR og.id = ANY($2::uuid[]))
         AND NOT EXISTS (
           SELECT 1 FROM module_miauto_gasto_cobro_fleet_intento fi
           WHERE fi.otros_gastos_id = og.id AND fi.estado IN ('processing', 'reconcile')
         )
       ORDER BY og.due_date ASC NULLS LAST, COALESCE(og.numero_cuota, og.week_index), og.id`,
      [solicitudId, ids]
    );
  const [expenseResult, contextResult] = await Promise.all([
    expensePromise,
    query(
      `SELECT s.country,
            ${sqlYangoDriverCoalesceColumns()}
       FROM module_miauto_solicitud s
     ${sqlYangoDriverLateralJoin(2)}
       WHERE s.id = $1::uuid
       AND s.deleted_at IS NULL
       AND s.status = 'aprobado'
       LIMIT 1`,
      [solicitudId, parkId]
    ),
  ]);
  const context = contextResult.rows[0];
  if (!context) return [];
  return expenseResult.rows.map((expense) => ({ ...expense, ...context }));
}

function fleetDriverDisplayName(fullName, fallbackRow) {
  if (typeof fullName === 'string' && fullName.trim()) return fullName.trim();
  if (fullName && typeof fullName === 'object') {
    const resolved = [fullName.first_name, fullName.last_name].filter(Boolean).join(' ').trim();
    if (resolved) return resolved;
  }
  return [fallbackRow.first_name, fallbackRow.last_name].filter(Boolean).join(' ').trim() || null;
}

export async function getAdditionalExpenseChargePreview(solicitudId) {
  const expenses = await getOpenAdditionalExpenses(solicitudId);
  if (expenses.length === 0) {
    return { balance: null, balance_currency: null, driver_name: null, expenses: [] };
  }

  const driver = expenses[0];
  if (!driver.external_driver_id) {
    const error = new Error('No se encontro el conductor de Fleet para consultar su saldo');
    error.statusCode = 409;
    throw error;
  }

  const parkId = fleetParkIdForMiAuto(driver.park_id);
  const cookie = fleetCookieCobroForMiAuto();
  const country = String(driver.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
  const [balanceResult, exchange] = await Promise.all([
    getContractorBalance(driver.external_driver_id, parkId, cookie),
    tipoCambioUsdALocalEfectivo(country),
  ]);
  if (!balanceResult.success) {
    const error = new Error(balanceResult.error || 'No se pudo consultar el saldo del conductor en Fleet');
    error.statusCode = 502;
    throw error;
  }

  return {
    balance: round2(Math.max(0, Number(balanceResult.balance) || 0)),
    balance_currency: exchange.monedaLocal,
    driver_name: fleetDriverDisplayName(balanceResult.full_name, driver),
    expenses: expenses.map((expense) => {
      const pendingAmount = round2(Math.max(0, Number(expense.amount_due) - Number(expense.paid_amount)));
      const receiptAmount = round2(Number(expense.pending_receipt_amount) || 0);
      const preparedAmount = expense.pending_receipt_id
        ? pendingReceiptCreditAmount(expense)
        : null;
      return {
        id: expense.id,
        tipo: expense.tipo,
        numero_cuota: expense.numero_cuota,
        total_cuotas: expense.total_cuotas,
        periodo_anio: expense.periodo_anio,
        due_date: ymdFromDbDate(expense.due_date),
        amount_due: round2(Number(expense.amount_due) || 0),
        paid_amount: round2(Number(expense.paid_amount) || 0),
        pending_amount: pendingAmount,
        currency: normalizePenUsd(expense.moneda),
        status: miAutoOpenStatusSaldoVencimiento(
          ymdFromDbDate(expense.due_date),
          pendingAmount,
          Number(expense.paid_amount) || 0
        ),
        pending_receipt_id: expense.pending_receipt_id || null,
        pending_receipt_amount: expense.pending_receipt_id ? receiptAmount : null,
        pending_receipt_currency: expense.pending_receipt_currency || null,
        pending_receipt_applied_amount: preparedAmount,
        pending_receipt_applied_currency: expense.pending_receipt_applied_currency || null,
        pending_receipt_file_name: expense.pending_receipt_file_name || null,
        pending_receipt_file_path: expense.pending_receipt_file_path || null,
        pending_receipt_applied: Boolean(expense.pending_receipt_applied),
      };
    }),
  };
}

function pendingReceiptCreditAmount(expense) {
  const originalAmount = round2(Number(expense.pending_receipt_amount) || 0);
  const exchangeRate = Number(expense.pending_receipt_exchange_rate);
  if (originalAmount <= 0.005) return 0;
  return round2(originalAmount * (Number.isFinite(exchangeRate) && exchangeRate > 0 ? exchangeRate : 1));
}

export async function chargeSelectedAdditionalExpensesWithReceipts(solicitudId, expenseIds, options = {}) {
  const ids = assertUuidList(expenseIds);
  const expenses = await getOpenAdditionalExpenses(solicitudId, ids);
  if (expenses.length !== ids.length) {
    const error = new Error('Una o mas cuotas ya fueron pagadas o estan en proceso');
    error.statusCode = 409;
    throw error;
  }
  if (expenses.some((expense) => !expense.pending_receipt_id || expense.pending_receipt_applied)) {
    const error = new Error('Todas las cuotas seleccionadas deben tener un comprobante antes de confirmar');
    error.statusCode = 409;
    throw error;
  }

  const sharedFleetCap = {
    remaining: null,
    externalDriverId: null,
    parkId: null,
    exchangeCountry: null,
    exchange: null,
    processed: 0,
  };
  const results = [];
  for (const expense of expenses) {
    try {
      const receiptCreditAmount = pendingReceiptCreditAmount(expense);
      if (receiptCreditAmount <= 0.005) {
        throw new Error('El comprobante no tiene un monto valido para cobrar');
      }
      const result = await processAdditionalExpenseFleetCharge(expense, {
        ...options,
        sharedFleetCap,
        requiredReceiptId: expense.pending_receipt_id,
        maxCreditAmount: receiptCreditAmount,
        delayBeforeWithdrawMs: !options.dryRun && sharedFleetCap.processed > 0 ? 1500 : 0,
      });
      sharedFleetCap.processed += 1;
      results.push({
        ...result,
        expense_id: expense.id,
        receipt_id: expense.pending_receipt_id,
        method: 'fleet_con_comprobante',
      });
    } catch (error) {
      logger.error('miauto.gastos.manual_fleet_charge_failed', {
        solicitudId,
        expenseId: expense.id,
        error: error.message,
      });
      results.push({ expense_id: expense.id, success: false, failed: true, reason: error.message });
    }
  }

  const summary = {
    total: results.length,
    success: results.filter((result) => result.success && !result.skipped).length,
    failed: results.filter((result) => !result.success).length,
    skipped: results.filter((result) => result.skipped).length,
    partial: results.filter((result) => result.partial).length,
    fleet: results.filter((result) => result.success && !result.skipped).length,
    results,
  };
  if (summary.success === 0) {
    const firstFailure = results.find((result) => !result.success);
    const error = new Error(
      firstFailure?.reason
      || (summary.skipped > 0 ? 'El cobro ya fue procesado o cambio de estado' : 'Fleet no realizo ningun cobro')
    );
    error.statusCode = /saldo disponible/i.test(error.message) ? 409 : 502;
    throw error;
  }
  return summary;
}

export async function processAdditionalExpenseFleetCharge(expense, options = {}) {
  const dryRun = Boolean(options.dryRun || options.simulateFleetWithdraw);
  const pending = round2(Math.max(0, Number(expense.amount_due) - Number(expense.paid_amount)));
  if (pending <= 0.005) return { success: true, skipped: true, reason: 'sin_saldo_pendiente' };
  const maxCreditAmount = Number(options.maxCreditAmount);
  const requestedCredit = Number.isFinite(maxCreditAmount) && maxCreditAmount > 0
    ? round2(Math.min(pending, maxCreditAmount))
    : pending;
  const externalDriverId = expense.external_driver_id;
  if (!externalDriverId) return { success: false, failed: true, reason: 'Sin external_driver_id' };
  const parkId = fleetParkIdForMiAuto(expense.park_id);
  const cookie = fleetCookieCobroForMiAuto(options.cookieOverride);
  const sharedFleetCap = options.sharedFleetCap;
  let balance;
  if (sharedFleetCap && Number.isFinite(sharedFleetCap.remaining)) {
    if (sharedFleetCap.externalDriverId !== externalDriverId || sharedFleetCap.parkId !== parkId) {
      return { success: false, failed: true, reason: 'La seleccion mezcla conductores o flotas' };
    }
    balance = round2(Math.max(0, sharedFleetCap.remaining));
  } else {
    const balanceResult = await getContractorBalance(externalDriverId, parkId, cookie);
    if (!balanceResult.success) return { success: false, failed: true, reason: balanceResult.error };
    balance = round2(Math.max(0, Number(balanceResult.balance) || 0));
    if (sharedFleetCap) {
      sharedFleetCap.remaining = balance;
      sharedFleetCap.externalDriverId = externalDriverId;
      sharedFleetCap.parkId = parkId;
    }
  }
  if (balance <= 0.005) {
    return {
      success: false,
      failed: true,
      partial: false,
      reason: 'Sin saldo disponible; la cuota conserva su saldo pendiente',
    };
  }

  const country = String(expense.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
  let exchange = sharedFleetCap?.exchangeCountry === country
    ? sharedFleetCap.exchange
    : null;
  if (!exchange) {
    exchange = await tipoCambioUsdALocalEfectivo(country);
    if (sharedFleetCap) {
      sharedFleetCap.exchangeCountry = country;
      sharedFleetCap.exchange = exchange;
    }
  }
  const localCurrency = exchange.monedaLocal;
  const expenseCurrency = normalizePenUsd(expense.moneda);
  const pendingLocal = expenseCurrency === 'USD'
    ? round2(convertirMontoEntreMonedas(requestedCredit, 'USD', localCurrency, exchange.valorUsdALocal))
    : expenseCurrency === localCurrency ? requestedCredit : null;
  if (pendingLocal == null) {
    return {
      success: false,
      failed: true,
      reason: `La moneda ${expenseCurrency} no corresponde a la moneda Fleet ${localCurrency}`,
    };
  }
  const withdrawalAmount = availableFleetCharge(pendingLocal, balance);
  const creditAmount = expenseCurrency === 'USD'
    ? round2(convertirMontoEntreMonedas(withdrawalAmount, localCurrency, 'USD', exchange.valorUsdALocal))
    : withdrawalAmount;
  if (withdrawalAmount <= 0.005 || creditAmount <= 0.005) {
    return { success: false, failed: true, reason: 'No se pudo convertir el monto para Fleet' };
  }
  const requiredReceiptId = options.requiredReceiptId || null;
  const fleetExchangeRate = localCurrency === expenseCurrency
    ? 1
    : Number((creditAmount / withdrawalAmount).toFixed(6));
  const sourceKey = requiredReceiptId
    ? `fleet-gasto:${expense.id}:comprobante:${requiredReceiptId}`
    : `fleet-gasto:${expense.id}:${limaTodayYmdSync()}:${Number(expense.paid_amount || 0).toFixed(2)}`;

  if (dryRun) {
    if (sharedFleetCap) {
      sharedFleetCap.remaining = round2(Math.max(0, balance - withdrawalAmount));
    }
    return {
      success: true,
      dryRun: true,
      partial: creditAmount + 0.005 < pending,
      expenseId: expense.id,
      pending,
      withdrawalAmount,
      withdrawalCurrency: localCurrency,
      creditAmount,
      creditCurrency: expenseCurrency,
      receiptId: requiredReceiptId,
    };
  }

  const delayBeforeWithdrawMs = Math.max(0, Number(options.delayBeforeWithdrawMs) || 0);
  if (delayBeforeWithdrawMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayBeforeWithdrawMs));
  }

  const reservation = await reserveAdditionalExpenseFleetIntent(expense, {
    sourceKey,
    withdrawalAmount,
    localCurrency,
    creditAmount,
    expenseCurrency,
    externalDriverId,
    parkId,
    requiredReceiptId,
  });
  if (reservation.skipped) return { success: true, skipped: true, reason: reservation.reason };
  const intentId = reservation.intentId;

  const withdrawal = await withdrawWithOngoingRetry({
    externalDriverId,
    amount: withdrawalAmount.toFixed(2),
    description: `Mi Auto - ${expense.tipo || 'otro gasto'}`,
    cookie,
    parkId,
    logLabel: `gasto:${expense.id}`,
    condition: { balance_min: '0' },
  });
  if (!withdrawal.success) {
    await query(
      `UPDATE module_miauto_gasto_cobro_fleet_intento
       SET estado = 'failed', error = $1, response = $2::jsonb, completed_at = CURRENT_TIMESTAMP
       WHERE id = $3::uuid`,
      [withdrawal.message || withdrawal.error || 'Error Fleet', JSON.stringify(withdrawal.data || {}), intentId]
    );
    return { success: false, failed: true, reason: withdrawal.message || withdrawal.error };
  }

  if (sharedFleetCap) {
    sharedFleetCap.remaining = round2(Math.max(0, balance - withdrawalAmount));
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const application = await applyPaymentToExpense({
      client,
      solicitudId: expense.solicitud_id,
      expenseId: expense.id,
      receiptId: requiredReceiptId,
      source: 'fleet',
      sourceKey,
      originalAmount: withdrawalAmount,
      originalCurrency: localCurrency,
      appliedAmount: creditAmount,
      appliedCurrency: expenseCurrency,
      exchangeRate: fleetExchangeRate,
      userId: options.userId || null,
      metadata: {
        fleet_intent_id: intentId,
        fleet_response: withdrawal.data || {},
        comprobante_id: requiredReceiptId,
      },
      rejectExcess: false,
    });
    if (requiredReceiptId) {
      await client.query(
        `UPDATE module_miauto_comprobante_otros_gastos
         SET monto_aplicado = $1, moneda_aplicada = $2
         WHERE id = $3::uuid AND otros_gastos_id = $4::uuid AND estado = 'pendiente'`,
        [application.applied, expenseCurrency, requiredReceiptId, expense.id]
      );
    }
    await client.query(
      `UPDATE module_miauto_gasto_cobro_fleet_intento
       SET estado = 'success', response = $1::jsonb, completed_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid`,
      [JSON.stringify(withdrawal.data || {}), intentId]
    );
    await client.query('COMMIT');
    return {
      success: true,
      partial: application.pendingAfter > 0.005,
      withdrawalAmount,
      withdrawalCurrency: localCurrency,
      application,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    await query(
      `UPDATE module_miauto_gasto_cobro_fleet_intento
       SET estado = 'reconcile', error = $1, response = $2::jsonb
       WHERE id = $3::uuid`,
      [error.message, JSON.stringify(withdrawal.data || {}), intentId]
    );
    throw error;
  } finally {
    client.release();
  }
}

async function cuotaRowWithPartnerFeesUsdNormalizedIfNeeded(solicitudId, r) {
  if (!r || String(r.moneda || 'PEN').toUpperCase() !== 'USD') return r;
  const pf = round2(parseFloat(r.partner_fees_raw) || 0);
  if (pf <= 0.005) return r;
  const cs = round2(parseFloat(r.cuota_semanal) || 0);
  const cuotaRef = cs > 0.005 ? cs : round2(parseFloat(r.amount_due) || 0);
  const norm = await partnerFeesRawDbNormalizeUsdFromYangoLocal(solicitudId, pf, cuotaRef);
  if (Math.abs(norm - pf) <= 0.02) return r;
  return {
    ...r,
    partner_fees_raw: norm,
    partner_fees_83: round2(norm * PARTNER_FEES_PCT),
  };
}

export async function effectiveAmountDueForMiAutoFleetRowAsync(cuotaRow) {
  const row = await cuotaRowWithPartnerFeesUsdNormalizedIfNeeded(cuotaRow.solicitud_id, cuotaRow);
  return effectiveAmountDueForMiAutoFleetRow(row);
}

// --- pendingTotalMaps ------------------------------------------------------

async function pendingTotalMapsForSolicitudIdsBatched(solicitudIds, batchSize = 8) {
  const unique = [...new Set((solicitudIds || []).map((x) => String(x)))];
  const mapsBySid = new Map();
  for (let i = 0; i < unique.length; i += batchSize) {
    const slice = unique.slice(i, i + batchSize);
    const loaded = await Promise.all(
      slice.map(async (sid) => {
        const m = await buildPendingTotalMapForSolicitud(sid);
        return [sid, m];
      })
    );
    for (const [sid, m] of loaded) mapsBySid.set(sid, m);
  }
  return mapsBySid;
}

// --- getCuotasToCharge -----------------------------------------------------

export async function getCuotasToCharge() {
  const res = await query(
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.mora_extra, c.status,
            c.cuota_semanal, c.bono_auto, c.cobro_saldo, c.pct_comision, c.partner_fees_raw, c.moneda,
            c.fecha_ultimo_abono, c.fecha_primer_comprobante,
            s.cronograma_id, s.fecha_inicio_cobro_semanal, s.placa_asignada, s.license_number,
            ${sqlYangoDriverCoalesceColumns()},
            s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     ${sqlYangoDriverLateralJoin(1)}
     WHERE c.status IN ('pending', 'overdue', 'partial')
       AND s.status = 'aprobado'
     ORDER BY c.solicitud_id, c.week_start_date ASC NULLS LAST, c.due_date ASC NULLS LAST, c.id ASC`,
    [MIAUTO_PARK_ID]
  );
  let rows = res.rows || [];
  const sids = [...new Set(rows.map((r) => String(r.solicitud_id)))];
  const mapsBySid = await pendingTotalMapsForSolicitudIdsBatched(sids);
  rows = rows.filter((r) => {
    const m = mapsBySid.get(String(r.solicitud_id));
    if (!m) return false;
    const pt = m.get(String(r.id));
    return pt != null && pt > 0.005;
  });
  const solicitudPendingMap = new Map();
  for (const m of mapsBySid.values()) {
    for (const [cuotaId, pt] of m) solicitudPendingMap.set(cuotaId, pt);
  }
  return { cuotas: rows, solicitudPendingMap };
}

export async function getCuotasToChargeForSolicitud(solicitudId) {
  const res = await query(
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.mora_extra, c.status,
            c.cuota_semanal, c.bono_auto, c.cobro_saldo, c.pct_comision, c.partner_fees_raw, c.moneda,
            c.fecha_ultimo_abono, c.fecha_primer_comprobante,
            s.cronograma_id, s.fecha_inicio_cobro_semanal, s.placa_asignada, s.license_number,
            ${sqlYangoDriverCoalesceColumns()},
            s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     ${sqlYangoDriverLateralJoin(2)}
     WHERE c.solicitud_id = $1::uuid
       AND c.status IN ('pending', 'overdue', 'partial')
       AND s.status = 'aprobado'
     ORDER BY c.week_start_date ASC NULLS LAST, c.due_date ASC NULLS LAST, c.id ASC`,
    [solicitudId, MIAUTO_PARK_ID]
  );
  let rows = res.rows || [];
  const m = await buildPendingTotalMapForSolicitud(solicitudId);
  rows = rows.filter((r) => {
    const pt = m.get(String(r.id));
    return pt != null && pt > 0.005;
  });
  return { cuotas: rows, pendingMap: m };
}

// --- processCobroCuota -----------------------------------------------------

export async function processCobroCuota(
  cuotaRow,
  cookieOverride = null,
  parkIdOverride = null,
  options = {}
) {
  const dryRun = !!options.dryRun;
  const simulateFleetWithdraw = !dryRun && !!options.simulateFleetWithdraw;
  const skipBalanceCheck = !!options.skipBalanceCheck;
  const sharedFleetCap = options.sharedFleetBalancePEN;
  const pendingMap = options.solicitudPendingMap;
  const driverName = [cuotaRow.first_name, cuotaRow.last_name].filter(Boolean).join(' ').trim() || 'Conductor';
  const placaInfo = cuotaRow.placa_asignada ? ` [Placa: ${String(cuotaRow.placa_asignada).trim()}]` : '';
  const driverLabel = driverName + placaInfo;
  const amountDue = await effectiveAmountDueForMiAutoFleetRowAsync(cuotaRow);
  const paid = round2(parseFloat(cuotaRow.paid_amount) || 0);
  const lateFee = round2(parseFloat(cuotaRow.late_fee) || 0);
  const moraExtra = round2(parseFloat(cuotaRow.mora_extra) || 0);
  // El mapa se prepara antes de procesar la cola. Después de una cascada puede quedar
  // desactualizado; nunca puede habilitar un retiro mayor al saldo persistido de la cuota.
  const pendingCols = round2(Math.max(0, amountDue + lateFee + moraExtra - paid));
  let pendingAmount = pendingCols;
  if (pendingMap instanceof Map) {
    const v = pendingMap.get(String(cuotaRow.id));
    if (v != null && !Number.isNaN(Number(v))) {
      pendingAmount = round2(Math.min(Math.max(0, Number(v)), pendingCols));
    }
  }

  if (pendingAmount <= 0) {
    return { success: true, partial: false, failed: false, reason: 'Sin saldo pendiente', dryRun };
  }

  let externalDriverId = cuotaRow.recaudo_driver_id || cuotaRow.external_driver_id;
  let parkId = parkIdOverride || cuotaRow.park_id;

  const extMissing = !externalDriverId || String(externalDriverId).trim() === '';
  const parkMissing = !parkId || String(parkId).trim() === '';

  if (extMissing || parkMissing) {
    let resolved = null;
    if (cuotaRow.driver_id) {
      const byRapidin = await query(
        `SELECT d.driver_id, d.park_id
         FROM drivers d
         INNER JOIN module_rapidin_drivers rd ON rd.id = $1::uuid
         WHERE REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
               REGEXP_REPLACE(COALESCE(TRIM(rd.dni), ''), '[^0-9]', '', 'g')
           AND REGEXP_REPLACE(COALESCE(TRIM(rd.dni), ''), '[^0-9]', '', 'g') <> ''
         ORDER BY
           CASE WHEN TRIM(COALESCE(d.park_id::text, '')) = $2 THEN 0
                WHEN TRIM(COALESCE(d.park_id::text, '')) <> '' THEN 1
                ELSE 2 END,
           d.driver_id::text
         LIMIT 1`,
        [cuotaRow.driver_id, MIAUTO_PARK_ID]
      );
      resolved = byRapidin.rows[0] || null;
    }
    if (!resolved && cuotaRow.solicitud_id) {
      const bySol = await query(
        `SELECT fl.driver_id, fl.park_id
         FROM module_miauto_solicitud s
         LEFT JOIN LATERAL (
           SELECT d.driver_id, d.park_id
           FROM drivers d
           WHERE TRIM(COALESCE(d.park_id::text, '')) = $2
             AND d.work_status = 'working'
             AND (
                LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.driver_id_fleet::text, '')), '-', '', 'g'))
               OR (
                 REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                     REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g')
                 AND REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g') <> ''
               )
             )
            ORDER BY CASE WHEN d.driver_id = s.driver_id_fleet AND s.driver_id_fleet IS NOT NULL AND TRIM(s.driver_id_fleet) <> '' THEN 0 ELSE 1 END
            LIMIT 1
         ) fl ON true
         WHERE s.id = $1::uuid`,
        [cuotaRow.solicitud_id, MIAUTO_PARK_ID]
      );
      resolved = bySol.rows[0]?.driver_id ? bySol.rows[0] : null;
    }
    if (resolved) {
      if (extMissing) externalDriverId = resolved.driver_id;
      if (parkMissing) parkId = resolved.park_id;
    }
  }

  if (!externalDriverId) {
    logger.warn('miauto.fleet.sin_external_driver_id', {
      solicitudId: cuotaRow.solicitud_id,
      cuotaId: cuotaRow.id,
      driverLabel,
    });
    return { success: false, partial: false, failed: true, reason: 'Sin external_driver_id', dryRun, driverName: driverLabel };
  }

  parkId = fleetParkIdForMiAuto(parkId);
  const cookieMiAuto = fleetCookieCobroForMiAuto(cookieOverride);

  let balance = null;
  if (dryRun && skipBalanceCheck) {
    return {
      dryRun: true,
      skipBalanceCheck: true,
      success: true,
      partial: null,
      failed: false,
      driverName,
      solicitud_id: cuotaRow.solicitud_id,
      cuota_id: cuotaRow.id,
      due_date: cuotaRow.due_date,
      week_start_date: cuotaRow.week_start_date,
      status_cuota: cuotaRow.status,
      amount_due: amountDue,
      late_fee: lateFee,
      paid_amount_actual: paid,
      pendiente_en_cuota: pendingAmount,
      balance_fleet_consultado: null,
      retiro_simulado: null,
      nota:
        'Sin consulta API: en el job real se cobraría min(pendiente, saldo_fleet). Pendiente mostrado es el de esta fila.',
      despues_paid_simulado: null,
      despues_status_simulado: null,
    };
  }

  if (
    sharedFleetCap != null &&
    typeof sharedFleetCap.remaining === 'number' &&
    !Number.isNaN(sharedFleetCap.remaining)
  ) {
    balance = round2(Math.max(0, sharedFleetCap.remaining));
    if (balance <= 0) {
      logger.info('miauto.fleet.sin_saldo', {
        solicitudId: cuotaRow.solicitud_id,
        cuotaId: cuotaRow.id,
        driverLabel,
        source: 'shared_cap',
        balance: 0,
      });
      return {
        success: false,
        partial: false,
        failed: true,
        reason: 'Sin saldo disponible',
        dryRun,
        balance: 0,
        driverName: driverLabel,
        cuota_id: cuotaRow.id,
        solicitud_id: cuotaRow.solicitud_id,
      };
    }
  } else {
    const balanceResult = await getContractorBalance(externalDriverId, parkId, cookieMiAuto);
    if (!balanceResult.success) {
      logger.warn('miauto.fleet.balance_error', {
        solicitudId: cuotaRow.solicitud_id,
        cuotaId: cuotaRow.id,
        driverLabel,
        externalDriverId,
        parkId,
        error: balanceResult.error,
      });
      return {
        success: false,
        partial: false,
        failed: true,
        reason: balanceResult.error,
        dryRun,
        driverName: driverLabel,
        cuota_id: cuotaRow.id,
        solicitud_id: cuotaRow.solicitud_id,
      };
    }

    balance = round2(Math.max(0, Number(balanceResult.balance) || 0));
    if (balance <= 0) {
      logger.info('miauto.fleet.sin_saldo', {
        solicitudId: cuotaRow.solicitud_id,
        cuotaId: cuotaRow.id,
        driverLabel,
        source: 'fleet_api',
        balance,
      });
      return {
        success: false,
        partial: false,
        failed: true,
        reason: 'Sin saldo disponible',
        dryRun,
        balance,
        driverName: driverLabel,
        cuota_id: cuotaRow.id,
        solicitud_id: cuotaRow.solicitud_id,
      };
    }
  }

  const country = String(cuotaRow.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
  const tcEff = await tipoCambioUsdALocalEfectivo(country);
  const valorTc = tcEff.valorUsdALocal;
  const monedaFleetLocal = tcEff.monedaLocal;
  const monedaPlan = normalizePenUsd(cuotaRow.moneda);
  const monedaCuota = monedaPlan === 'USD' ? 'USD' : monedaFleetLocal;

  let pendingFleetLocal = pendingAmount;
  if (monedaCuota === 'USD') {
    const conv = convertirMontoEntreMonedas(pendingAmount, 'USD', monedaFleetLocal, valorTc);
    pendingFleetLocal = conv != null ? round2(conv) : round2(pendingAmount);
  }

  const amountToChargeFleet = round2(Math.min(pendingFleetLocal, balance));

  let creditCuotaMoneda = amountToChargeFleet;
  if (monedaCuota === 'USD') {
    const c = convertirMontoEntreMonedas(amountToChargeFleet, monedaFleetLocal, 'USD', valorTc);
    creditCuotaMoneda = c != null ? round2(c) : round2(amountToChargeFleet);
  }

  logger.info('miauto.fleet.charge_attempt', {
    solicitudId: cuotaRow.solicitud_id,
    cuotaId: cuotaRow.id,
    driverName,
    dueDate: ymdFromDbDate(cuotaRow.due_date),
    weekStartDate: ymdFromDbDate(cuotaRow.week_start_date),
    monedaCuota,
    monedaFleetLocal,
    tipoCambioUsdLocal: valorTc,
    pendienteCuota: pendingAmount,
    pendienteFleetLocal: pendingFleetLocal,
    balanceFleet: balance,
    montoRetiroFleet: amountToChargeFleet,
    montoAcreditadoCuota: creditCuotaMoneda,
    dryRun,
  });

  const totalDueCap = round2(paid + pendingAmount);
  let newPaid = round2(paid + creditCuotaMoneda);
  newPaid = round2(Math.min(newPaid, totalDueCap));
  const pendAfter = round2(Math.max(0, totalDueCap - newPaid));
  const newStatus = miAutoOpenStatusSaldoVencimiento(ymdFromDbDate(cuotaRow.due_date), pendAfter, newPaid);

  if (dryRun) {
    if (sharedFleetCap != null) {
      sharedFleetCap.remaining = round2(Math.max(0, sharedFleetCap.remaining - amountToChargeFleet));
    }
    const cobroCompletoEnCuota = creditCuotaMoneda >= pendingAmount - 0.005;
    return {
      dryRun: true,
      success: true,
      partial: !cobroCompletoEnCuota && amountToChargeFleet > 0,
      failed: false,
      driverName,
      solicitud_id: cuotaRow.solicitud_id,
      cuota_id: cuotaRow.id,
      due_date: cuotaRow.due_date,
      week_start_date: cuotaRow.week_start_date,
      status_cuota: cuotaRow.status,
      moneda_cuota: monedaCuota,
      moneda_fleet_retiro: monedaFleetLocal,
      amount_due: amountDue,
      late_fee: lateFee,
      paid_amount_actual: paid,
      pendiente_en_cuota: pendingAmount,
      pendiente_fleet_local: pendingFleetLocal,
      balance_fleet_consultado: balance,
      retiro_simulado_fleet: amountToChargeFleet,
      acreditado_en_cuota: creditCuotaMoneda,
      despues_paid_simulado: newPaid,
      despues_status_simulado: newStatus,
      external_driver_id: externalDriverId,
      park_id_usado: parkId,
      descripcion_retiro_job: 'Cuota Mi Auto',
    };
  }

  let withdrawResult;
  if (simulateFleetWithdraw) {
    withdrawResult = {
      success: true,
      data: {
        simulated: true,
        reason: options.simulateReason || 'miauto_fleet_charge_simulated_no_withdraw',
        external_driver_id: externalDriverId,
        park_id: parkId,
        amount: amountToChargeFleet.toFixed(2),
        currency: monedaFleetLocal,
      },
    };
    logger.warn('miauto.fleet.withdraw_simulated_no_external_charge', {
      solicitudId: cuotaRow.solicitud_id,
      cuotaId: cuotaRow.id,
      driverName,
      externalDriverId,
      parkId,
      montoRetiroFleet: amountToChargeFleet,
      monedaFleetLocal,
    });
  } else {
    withdrawResult = await withdrawWithOngoingRetry({
      externalDriverId,
      amount: amountToChargeFleet.toFixed(2),
      description: 'Cuota Mi Auto',
      cookie: cookieMiAuto,
      parkId,
      logLabel: `cuota:${cuotaRow.id}:${driverName}`,
    });
  }

  if (!withdrawResult.success) {
    logger.error('miauto.fleet.withdraw_error', {
      solicitudId: cuotaRow.solicitud_id,
      cuotaId: cuotaRow.id,
      driverName,
      externalDriverId,
      parkId,
      montoRetiroFleet: amountToChargeFleet,
      monedaFleetLocal,
      error: withdrawResult.message || withdrawResult.error,
    });
    return { success: false, partial: false, failed: true, reason: withdrawResult.message || withdrawResult.error };
  }

  if (sharedFleetCap != null && !dryRun) {
    sharedFleetCap.remaining = round2(Math.max(0, sharedFleetCap.remaining - amountToChargeFleet));
  }

  await query(
    `UPDATE module_miauto_cuota_semanal SET
       paid_amount = $1,
       status = $2,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $3::uuid`,
    [newPaid, newStatus, cuotaRow.id]
  );
  await touchFechaUltimoAbonoCuota(cuotaRow.id, paid, newPaid);

  // Guardar el cobro Fleet en la cuota que realmente recibió el pago.
  if (!dryRun && creditCuotaMoneda > 0.005) {
    await query(
      `UPDATE module_miauto_cuota_semanal SET
         cobro_desde_saldo_conductor = ROUND((COALESCE(cobro_desde_saldo_conductor, 0) + $1::numeric)::numeric, 2),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid`,
      [creditCuotaMoneda, cuotaRow.id]
    );
  }

  await appendMiautoFleetCobroAuditLog({
    cuotaRow,
    monto_retiro_fleet_local: amountToChargeFleet,
    moneda_fleet_local: monedaFleetLocal,
    monto_acreditado_cuota: creditCuotaMoneda,
    moneda_cuota: monedaCuota,
    paid_amount_antes: paid,
    paid_amount_despues: newPaid,
    pending_total_antes: pendingAmount,
    partial: creditCuotaMoneda < pendingAmount - 0.005,
    fleet_withdraw_response: withdrawResult.data,
  });

  if (creditCuotaMoneda >= pendingAmount - 0.005) {
    logger.info('miauto.fleet.charge_success', {
      solicitudId: cuotaRow.solicitud_id,
      cuotaId: cuotaRow.id,
      driverName,
      result: 'complete',
      montoRetiroFleet: amountToChargeFleet,
      monedaFleetLocal,
      montoAcreditadoCuota: creditCuotaMoneda,
      monedaCuota,
      paidAntes: paid,
      paidDespues: newPaid,
      statusDespues: newStatus,
    });
    return {
      success: true,
      partial: false,
      failed: false,
      amountChargedFleet: amountToChargeFleet,
      amountCreditedCuota: creditCuotaMoneda,
    };
  }
  logger.info('miauto.fleet.charge_success', {
    solicitudId: cuotaRow.solicitud_id,
    cuotaId: cuotaRow.id,
    driverName,
    result: 'partial',
    montoRetiroFleet: amountToChargeFleet,
    monedaFleetLocal,
    montoAcreditadoCuota: creditCuotaMoneda,
    monedaCuota,
    paidAntes: paid,
    paidDespues: newPaid,
    pendingAntes: pendingAmount,
    pendingDespues: pendAfter,
    statusDespues: newStatus,
  });
  return {
    success: true,
    partial: true,
    failed: false,
    amountChargedFleet: amountToChargeFleet,
    amountCreditedCuota: creditCuotaMoneda,
  };
}
