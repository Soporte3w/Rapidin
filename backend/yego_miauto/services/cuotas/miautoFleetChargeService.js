/**
 * Yego Mi Auto — cobro Fleet Yango: cuotas a retirar, proceso de retiro y saldo efectivo.
 * Extraído de miautoCuotaSemanalService.js (v5 — Mayo 2026).
 */
import { query } from '../../../config/database.js';
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

// --- Constantes -------------------------------------------------------------

const PARTNER_FEES_PCT = 0.8333;

// --- Helpers SQL compartidos ------------------------------------------------

/** Columnas COALESCE que dependen del LATERAL JOIN `fl` y `module_rapidin_drivers rd`. */
function sqlYangoDriverCoalesceColumns() {
  return `COALESCE(NULLIF(TRIM(COALESCE(fl.driver_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.external_driver_id::text, '')), '')) AS external_driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.park_id::text, '')), ''), '${MIAUTO_PARK_ID}') AS park_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.first_name::text, '')), ''), rd.first_name) AS first_name,
            COALESCE(NULLIF(TRIM(COALESCE(fl.last_name::text, '')), ''), rd.last_name) AS last_name,
            fl.work_status AS yango_work_status`;
}

/** LATERAL JOIN a `drivers` (Yango) buscando por PLACA primero, luego driver_id → DNI → teléfono. */
function sqlYangoDriverLateralJoin(parkParamNumber) {
  const p = parkParamNumber;
  return `LEFT JOIN LATERAL (
        SELECT d.driver_id, d.park_id, d.first_name, d.last_name, d.work_status
        FROM drivers d
        WHERE TRIM(COALESCE(d.park_id::text, '')) = $${p}
          AND (
            UPPER(REGEXP_REPLACE(TRIM(COALESCE(d.car_normalized_number, d.car_number, '')), '\\s', '', 'g')) =
                UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '\\s', '', 'g'))
            OR LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g'))
            OR (
              REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                  REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g')
              AND REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g') <> ''
            )
            OR COALESCE(REGEXP_REPLACE(TRIM(d.login), '[^0-9]', '', 'g'), '') <> ''
               AND COALESCE(REGEXP_REPLACE(TRIM(d.login), '[^0-9]', '', 'g'), '') =
                   COALESCE(REGEXP_REPLACE(TRIM(COALESCE(rd.phone, s.phone)), '[^0-9]', '', 'g'), '')
          )
        ORDER BY
          CASE WHEN d.work_status = 'working' THEN 0
               WHEN d.work_status = 'fired' THEN 1
               ELSE 2 END,
          d.driver_id::text
        LIMIT 1
      ) fl ON true`;
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
    const baseCuota = round2(cuotaSemanal);
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
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.status,
            c.cuota_semanal, c.bono_auto, c.cobro_saldo, c.pct_comision, c.partner_fees_raw, c.moneda,
            c.fecha_ultimo_abono, c.fecha_primer_comprobante,
            s.cronograma_id, s.fecha_inicio_cobro_semanal, s.placa_asignada,
            rd.id AS driver_id,
            ${sqlYangoDriverCoalesceColumns()},
            s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     ${sqlYangoDriverLateralJoin(1)}
     WHERE c.status IN ('pending', 'overdue', 'partial')
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

// --- getCuotasToChargeForSolicitud -----------------------------------------

export async function getCuotasToChargeForSolicitud(solicitudId) {
  const res = await query(
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.status,
            c.cuota_semanal, c.bono_auto, c.cobro_saldo, c.pct_comision, c.partner_fees_raw, c.moneda,
            c.fecha_ultimo_abono, c.fecha_primer_comprobante,
            s.cronograma_id, s.fecha_inicio_cobro_semanal, s.placa_asignada,
            rd.id AS driver_id,
            ${sqlYangoDriverCoalesceColumns()},
            s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     ${sqlYangoDriverLateralJoin(2)}
     WHERE c.solicitud_id = $1::uuid
       AND c.status IN ('pending', 'overdue', 'partial')
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
  const skipBalanceCheck = !!options.skipBalanceCheck;
  const sharedFleetCap = options.sharedFleetBalancePEN;
  const pendingMap = options.solicitudPendingMap;
  const driverName = [cuotaRow.first_name, cuotaRow.last_name].filter(Boolean).join(' ').trim() || 'Conductor';
  const placaInfo = cuotaRow.placa_asignada ? ` [Placa: ${String(cuotaRow.placa_asignada).trim()}]` : '';
  const driverLabel = driverName + placaInfo;
  const amountDue = await effectiveAmountDueForMiAutoFleetRowAsync(cuotaRow);
  const paid = round2(parseFloat(cuotaRow.paid_amount) || 0);
  const lateFee = round2(parseFloat(cuotaRow.late_fee) || 0);
  const pendingCols = round2(amountDue + lateFee - paid);
  let pendingAmount = pendingCols;
  if (pendingMap instanceof Map) {
    const v = pendingMap.get(String(cuotaRow.id));
    if (v != null && !Number.isNaN(Number(v))) {
      pendingAmount = round2(Number(v));
    }
  }

  if (pendingAmount <= 0) {
    return { success: true, partial: false, failed: false, reason: 'Sin saldo pendiente', dryRun };
  }

  let externalDriverId = cuotaRow.external_driver_id;
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
               LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g'))
               OR (
                 REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                     REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g')
                 AND REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g') <> ''
               )
             )
           ORDER BY CASE WHEN LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g')) THEN 0 ELSE 1 END
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
    logger.warn(`Yego Mi Auto cobro: ${driverLabel} sin external_driver_id`);
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
      logger.warn(`Yego Mi Auto cobro: ${driverLabel} sin saldo Fleet (tope de cola agotado, sin nueva consulta API)`);
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
      logger.warn(`Yego Mi Auto cobro: sin saldo API ${driverLabel}: ${balanceResult.error}`);
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
      logger.warn(`Yego Mi Auto cobro: ${driverLabel} sin saldo Fleet (balance API=${balance})`);
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

  const monedaCuota = normalizePenUsd(cuotaRow.moneda);
  const country = String(cuotaRow.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
  const tcEff = await tipoCambioUsdALocalEfectivo(country);
  const valorTc = tcEff.valorUsdALocal;
  const monedaFleetLocal = tcEff.monedaLocal;

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

  let withdrawResult = await withdrawFromContractor(
    externalDriverId,
    amountToChargeFleet.toFixed(2),
    'Cuota Mi Auto',
    cookieMiAuto,
    parkId
  );
  const maxW = fleetWithdrawMaxAttempts();
  const delayMs = fleetWithdrawRetryDelayMs();
  let wAttempt = 0;
  while (
    !withdrawResult.success &&
    wAttempt < maxW - 1 &&
    isFleetOngoingTransactionsError(withdrawResult.message || withdrawResult.error)
  ) {
    wAttempt += 1;
    logger.warn(
      `Yego Mi Auto cobro: retiro ${driverName} transacciones en curso — reintento ${wAttempt}/${maxW - 1} en ${delayMs}ms`
    );
    await new Promise((r) => setTimeout(r, delayMs));
    withdrawResult = await withdrawFromContractor(
      externalDriverId,
      amountToChargeFleet.toFixed(2),
      'Cuota Mi Auto',
      cookieMiAuto,
      parkId
    );
  }

  if (!withdrawResult.success) {
    logger.error(`Yego Mi Auto cobro: retiro ${driverName}: ${withdrawResult.message || withdrawResult.error}`);
    return { success: false, partial: false, failed: true, reason: withdrawResult.message || withdrawResult.error };
  }

  if (sharedFleetCap != null && !dryRun) {
    sharedFleetCap.remaining = round2(Math.max(0, sharedFleetCap.remaining - amountToChargeFleet));
  }

  await query(
    `UPDATE module_miauto_cuota_semanal SET
       paid_amount = $1,
       status = $2,
       cobro_desde_saldo_conductor = ROUND((COALESCE(cobro_desde_saldo_conductor, 0) + $3::numeric)::numeric, 2),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $4::uuid`,
    [newPaid, newStatus, creditCuotaMoneda, cuotaRow.id]
  );
  await touchFechaUltimoAbonoCuota(cuotaRow.id, paid, newPaid);

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
    logger.info(
      `Yego Mi Auto cobro completo: ${driverName} Fleet ${amountToChargeFleet.toFixed(2)} ${monedaFleetLocal} → +${creditCuotaMoneda.toFixed(2)} ${monedaCuota} pagado`
    );
    return {
      success: true,
      partial: false,
      failed: false,
      amountChargedFleet: amountToChargeFleet,
      amountCreditedCuota: creditCuotaMoneda,
    };
  }
  logger.info(
    `Yego Mi Auto cobro parcial: ${driverName} Fleet ${amountToChargeFleet.toFixed(2)} ${monedaFleetLocal} → +${creditCuotaMoneda.toFixed(2)} ${monedaCuota} (pendiente cuota ${pendingAmount.toFixed(2)} ${monedaCuota})`
  );
  return {
    success: true,
    partial: true,
    failed: false,
    amountChargedFleet: amountToChargeFleet,
    amountCreditedCuota: creditCuotaMoneda,
  };
}
