/**
 * Yego Mi Auto — cuotas semanales: generación por semana, mora y API conductor/admin.
 */
import { query } from '../../../config/database.js';
import {
  addDaysYmd,
  computeDueDateForMiAutoCuota,
  isWeekYangoClosedForMiAutoCuotaMetrics,
  mondayOfWeekContainingYmd,
} from '../../../utils/miautoLimaWeekRange.js';
import {
  getCronogramaById,
  getMonedaCuotaSemanalPorVehiculo,
  getRuleForTripCount,
  resolveMonedaCuotaSemanal,
} from '../cronograma/miautoCronogramaService.js';
import { logger } from '../../../utils/logger.js';
import {
  computeAmountDueSemanal as _computeAmountDueSemanal,
} from '../cobros/CuotaCalculator.js';
import {
  montoComprobanteCuotaALaMonedaFila,
  partnerFeesRawDbNormalizeUsdFromYangoLocal,
  round2,
  tipoCambioUsdALocalEfectivo,
} from '../utils/miautoMoneyUtils.js';
import { MIAUTO_PARK_ID } from '../utils/miautoDriverLookup.js';

const PARTNER_FEES_PCT = 0.8333;

// --- Helpers reutilizables para matching de driver Yango por PLACA ---

/**
 * Columnas del LATERAL JOIN `fl` (Yango drivers) sin dependencia de module_rapidin_drivers.
 */
function sqlYangoDriverCoalesceColumns() {
  return `fl.driver_id AS external_driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), '${MIAUTO_PARK_ID}') AS park_id,
            fl.first_name, fl.last_name,
            fl.work_status AS yango_work_status,
            fw.first_name AS working_driver_first_name,
            fw.last_name AS working_driver_last_name,
            s.recaudo_driver_id`;
}

/**
 * LATERAL JOIN a `drivers` (Yango): prioridad driver_id_fleet → DNI → placa → teléfono.
 */
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

/**
 * Máx. días civiles de devengo de mora desde el vencimiento (Lima). Ej. venc. 16/03 → 06/04 = 21 días.
 * Evita que la mora siga creciendo indefinidamente en columnas/Excel que suman cuota + late_fee.
 */
const MORA_MAX_DIAS_ACUMULACION_MI_AUTO = null;

/** Fragmento SQL: fecha civil de hoy en Lima (misma región que cronos Mi Auto). */
const SQL_LIMA_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date`;

function envFlagEnabled(name) {
  return ['1', 'true', 'yes', 'on', 'si', 'sí'].includes(String(process.env[name] || '').trim().toLowerCase());
}

/**
 * Cuota vencida con saldo pendiente (overdue o fecha < hoy Lima con deuda).
 * La generación semanal usa esta señal para cobrar cuota máxima sin bono por viajes.
 */
async function solicitudTieneCuotaVencidaSinCubrirParaMayorPlan(solicitudId) {
  const res = await query(
    `SELECT 1 FROM (
       SELECT lower(trim(coalesce(c.status, ''))) AS st,
              coalesce(c.due_date, c.week_start_date) AS ref_d,
              coalesce(c.paid_amount, 0)::numeric AS p,
              coalesce(c.amount_due, 0)::numeric AS ad,
              coalesce(c.late_fee, 0)::numeric AS lf,
              coalesce(c.mora_extra, 0)::numeric AS me,
              lower(coalesce(c.montos_fuente, '')) AS fuente
       FROM module_miauto_cuota_semanal c
       WHERE c.solicitud_id = $1::uuid
     ) x
     WHERE x.st NOT IN ('paid', 'bonificada')
       AND x.p < CASE WHEN x.fuente = 'excel' THEN x.ad ELSE x.ad + x.lf + x.me END - 0.02
       AND (
         x.st = 'overdue'
         OR (
           x.ref_d IS NOT NULL
           AND (x.ref_d)::date < ${SQL_LIMA_TODAY}
         )
       )
     LIMIT 1`,
    [solicitudId]
  );
  return (res.rows || []).length > 0;
}

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

/** Igual que en `fetchCuotasSemanalesPayload` (SQL): week_start → due_date → id. */
export function ordenarCuotasSemanalesCronologico(rows) {
  return [...(rows || [])].sort((a, b) => {
    const wa = ymdFromDbDate(a.week_start_date) || '';
    const wb = ymdFromDbDate(b.week_start_date) || '';
    const c0 = wa.localeCompare(wb);
    if (c0 !== 0) return c0;
    const da = ymdFromDbDate(a.due_date) || '';
    const db = ymdFromDbDate(b.due_date) || '';
    const c1 = da.localeCompare(db);
    if (c1 !== 0) return c1;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
}

/**
 * Semana del depósito (sem. 1 sin viajes Yango / sin bono): `week_start_date` = lunes de la semana civil que contiene `fecha_inicio_cobro_semanal`.
 * No usar MIN(week_start) ni “sin fila anterior”: falla con filas fuera de orden o datos viejos.
 */
export function isSemanaDepositoMiAuto(weekStartYmd, fechaInicioCobroRaw) {
  const fi = ymdFromDbDate(fechaInicioCobroRaw);
  const ws = ymdFromDbDate(weekStartYmd) || String(weekStartYmd || '').trim().slice(0, 10);
  if (!fi || !/^\d{4}-\d{2}-\d{2}$/.test(ws)) return false;
  const mondayInicio = mondayOfWeekContainingYmd(fi);
  return ws === mondayInicio;
}

function diffDaysYmdUtc(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  const ta = Date.UTC(ya, ma - 1, da);
  const tb = Date.UTC(yb, mb - 1, db);
  return Math.round((tb - ta) / (24 * 60 * 60 * 1000));
}

/** Fecha civil de hoy en Lima (misma región que `SQL_LIMA_TODAY` y `updateMoraDiaria`). */
function limaTodayYmdSync() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Con saldo pendiente tras el vencimiento (Lima) → `overdue`; `partial` solo si aún no vence y hubo abono. Umbral 1 céntimo (0.005 USD) para no marcar pagada con centavos pendientes. */
function miAutoOpenStatusSaldoVencimiento(dueYmd, pend, paidDb) {
  if (pend <= 0.005) return 'paid';
  const todayY = limaTodayYmdSync();
  if (dueYmd && /^\d{4}-\d{2}-\d{2}$/.test(dueYmd) && dueYmd < todayY) return 'overdue';
  return paidDb > 0.005 ? 'partial' : 'pending';
}

/**
 * Carga desde Excel: si `paid_amount` coincide con `cuota_semanal` de la fila, se considera el periodo cubierto
 * y no se aplica mora teórica (evita desvíos entre intereses calculados y montos importados).
 */
function excelPaidIgualCuotaSemanalIgnoraMora(r) {
  if (!r || String(r.status || '').toLowerCase() === 'bonificada') return false;
  const paid = round2(parseFloat(r.paid_amount) || 0);
  const cs = round2(parseFloat(r.cuota_semanal) || 0);
  const moraExtraPendiente = round2(parseFloat(r.mora_extra) || 0);
  return cs > 0.005 && moraExtraPendiente <= 0.005 && Math.abs(paid - cs) <= 0.005;
}

function cuotaTieneSaldoPendienteColumnas(r) {
  const paid = round2(parseFloat(r?.paid_amount) || 0);
  const amountDue = round2(parseFloat(r?.amount_due) || 0);
  if (rowMontosFuenteExcel(r)) {
    return paid < amountDue - 0.005;
  }
  const lateFee = round2(parseFloat(r?.late_fee) || 0);
  const moraExtra = round2(parseFloat(r?.mora_extra) || 0);
  return paid < round2(amountDue + lateFee + moraExtra) - 0.005;
}

/** Montos base cargados desde Excel: la API y la mora deben usar columnas persistidas, no el cronograma dinámico. */
function rowMontosFuenteExcel(r) {
  return String(r?.montos_fuente || '').toLowerCase() === 'excel';
}

function distribuirPagoMoraPrimero({ capital = 0, moraNormal = 0, moraExtra = 0, pagado = 0 } = {}) {
  const cap = round2(Math.max(0, Number(capital) || 0));
  const mn = round2(Math.max(0, Number(moraNormal) || 0));
  const me = round2(Math.max(0, Number(moraExtra) || 0));
  const paid = round2(Math.max(0, Number(pagado) || 0));
  const moraNormalPendiente = round2(Math.max(0, mn - Math.min(paid, mn)));
  const pagoTrasMoraNormal = round2(Math.max(0, paid - mn));
  const moraExtraPendiente = round2(Math.max(0, me - Math.min(pagoTrasMoraNormal, me)));
  const pagoCapital = round2(Math.max(0, pagoTrasMoraNormal - me));
  const capitalPendiente = round2(Math.max(0, cap - pagoCapital));
  return {
    mora_normal_pendiente: moraNormalPendiente,
    mora_extra_pendiente: moraExtraPendiente,
    capital_pendiente: capitalPendiente,
    total_pendiente: round2(moraNormalPendiente + moraExtraPendiente + capitalPendiente),
  };
}

function moraNormalBaseExcelParaImputacion(r, cronograma, vehId, isPrimeraCuotaSemanal, historicaAplicada = 0) {
  const lateFeeDb = round2(parseFloat(r?.late_fee) || 0);
  const hist = round2(Math.max(0, Number(historicaAplicada) || 0));
  const status = String(r?.status || '').toLowerCase();
  if (isPrimeraCuotaSemanal || status === 'bonificada' || status === 'paid') {
    return round2(Math.max(lateFeeDb, hist));
  }
  const paid = round2(parseFloat(r?.paid_amount) || 0);
  if (paid <= 0.005) {
    return round2(Math.max(lateFeeDb, hist));
  }
  const refYmd = ymdFromDbDate(r?.fecha_ultimo_abono) || ymdFromDbDate(r?.fecha_primer_comprobante) || limaTodayYmdSync();
  const dueYmd = ymdFromDbDate(r?.mora_desde) || ymdFromDbDate(r?.due_date);
  let moraCalculada = 0;
  if (dueYmd && refYmd && /^\d{4}-\d{2}-\d{2}$/.test(dueYmd) && /^\d{4}-\d{2}-\d{2}$/.test(refYmd) && dueYmd < refYmd) {
    const baseMora = round2(Math.max(
      0,
      Number(resolveCuotaEsperadaParaMora(r, cronograma, vehId, isPrimeraCuotaSemanal)) || Number(r?.amount_due) || 0
    ));
    moraCalculada = computeLateFeeForDayCount(cronograma, baseMora, diffDaysYmdUtc(dueYmd, refYmd));
  }
  return round2(Math.max(lateFeeDb, hist, moraCalculada));
}

/**
 * Hermana misma solicitud con vencimiento **estrictamente anterior** a `miDueYmd`, **saldo pendiente** según
 * motor (`options.pendienteEconomico`) o, si no viene, fallback columnas cuota+mora − pagado.
 * **Vencida** (`overdue` o `due_date` antes de hoy Lima): el pool comisión/PF debe atender primero esa fila.
 */
function cuotaHermanaBloqueaPorDeudaMasAntigua(o, miDueYmd, todayYmd, options = {}) {
  if (!o || miDueYmd == null) return false;
  const dueO = ymdFromDbDate(o.due_date);
  if (!dueO || !/^\d{4}-\d{2}-\d{2}$/.test(dueO) || !/^\d{4}-\d{2}-\d{2}$/.test(String(miDueYmd).slice(0, 10))) {
    return false;
  }
  const miDue = String(miDueYmd).trim().slice(0, 10);
  if (dueO >= miDue) return false;
  const st = String(o.status || '').toLowerCase();
  if (st === 'bonificada') return false;
  const paid = round2(parseFloat(o.paid_amount) || 0);
  const pendCol =
    options.pendienteEconomico != null && Number.isFinite(Number(options.pendienteEconomico))
      ? round2(Math.max(0, Number(options.pendienteEconomico)))
      : round2(
          Math.max(
            0,
            round2(parseFloat(o.amount_due) || 0)
              + round2(parseFloat(o.late_fee) || 0)
              + round2(parseFloat(o.mora_extra) || 0)
              - paid
          )
        );
  if (pendCol <= 0.02) return false;
  const vencidaPorEstado = st === 'overdue';
  const todayOk = todayYmd && /^\d{4}-\d{2}-\d{2}$/.test(String(todayYmd).slice(0, 10));
  const vencidaPorFecha = todayOk && dueO < String(todayYmd).trim().slice(0, 10);
  return vencidaPorEstado || vencidaPorFecha;
}

/**
 * Si la cuota programada del periodo (`amount_due_sched`, p. ej. tras PF + cobro saldo) es ~0 y la obligación derivada no deja saldo,
 * no forzar pendiente con `amount_due` persistido aún alto (cascada/pool ya cubrió esta semana).
 * Si `hasOlderBlockingDebt`: hay cuota más antigua vencida con saldo → no dar por pagada esta fila con pend ~0.
 * @param {{ hasOlderBlockingDebt?: boolean }} [options]
 */
function pendienteStatusCuotaAbiertaPostCorte(d, pendDerived, pendCols, options = {}) {
  const hasOlder = !!options.hasOlderBlockingDebt;
  const schedNet = round2(d.amount_due_sched);
  let pend = round2(Math.max(pendDerived, pendCols));
  if (schedNet <= 0.02 && pendDerived <= 0.02 && !hasOlder) {
    pend = pendDerived;
  }
  if (hasOlder && schedNet <= 0.02 && pendDerived <= 0.02 && pend <= 0.02) {
    pend = round2(0.03);
  }
  return pend;
}

/**
 * Si hay mora abierta en la solicitud (flag previo): no primera semana depósito, no `paid` → mayor cuota del cronograma sin bono por viajes.
 */
function debeAplicarCuotaMaximaSinBonoPorMora(hayCuotaOverdueEnSolicitud, esCuotaPrimeraSemanaDeposito, statusFilaRow) {
  const st = String(statusFilaRow || '').toLowerCase();
  return (
    hayCuotaOverdueEnSolicitud === true &&
    !esCuotaPrimeraSemanaDeposito &&
    st !== 'paid'
  );
}

/**
 * Monto base semanal antes de mora (lo que “cuota a pagar” representa en hoja, sin mora).
 *
 * - **Cuota semanal** (`cuotaSemanal`): tramo del cronograma por viajes (bruta del plan).
 * - **Cobro por ingresos** (en fila: `partner_fees_83` = 83,33% del raw Yango): lo retenido sobre ingresos de la semana;
 *   con `partnerFeesApplyToCuotaReduction` (por defecto) la base es **cuota semanal − cobro por ingresos** (cuota neta).
 * - **Cobro saldo** (`cobroSaldo`): cargo/alícuota de la **regla del cronograma** sobre el saldo / Fleet (puede ser negativo);
 *   se **suma** a la cuota neta (no es lo mismo que el tributo por ingresos).
 * - Opcional: % comisión sobre el tributo (`partner_fees_83`) según regla.
 * La **cuota del plan no resta `bono_auto`**: el bono es informativo en columna.
 */
/** Helper numérico interno sobre CuotaCalculator.computeAmountDueSemanal. */
function computeAmountDueSemanal(params) {
  return _computeAmountDueSemanal(params).amountDue;
}

/** Quita imputaciones a la propia fila origen (la cascada es solo a cuotas distintas; nunca «Semana N → Semana N»). */
function cascadaDestinoExcluirCuotaOrigen(merged, excludeCuotaSemanalId) {
  const ex =
    excludeCuotaSemanalId != null && String(excludeCuotaSemanalId).trim()
      ? String(excludeCuotaSemanalId).trim()
      : null;
  if (!ex || !Array.isArray(merged)) return Array.isArray(merged) ? merged : [];
  return merged.filter((a) => a && String(a.cuota_semanal_id) !== ex);
}

/**
 * Regla por tramo de viajes + montos del vehículo en el cronograma.
 * @returns {null|{ cuotaSemanal, moneda, bonoAuto, pctComision, cobroSaldo }}
 */
function planFromCronograma(cronograma, cronogramaVehiculoId, numViajes) {
  if (!cronograma?.rules?.length) return null;
  const vehicles = cronograma.vehicles || [];
  const vehicleIndex = vehicles.findIndex((v) => v.id === cronogramaVehiculoId);
  if (vehicleIndex < 0) return null;
  const n = numViajes == null || Number.isNaN(Number(numViajes)) ? 0 : Number(numViajes);
  const rule = getRuleForTripCount(cronograma.rules, n);
  if (!rule) return null;
  const cuotasPorVehiculo = rule.cuotas_por_vehiculo || [];
  const cuotaSemanal =
    cuotasPorVehiculo[vehicleIndex] != null ? round2(parseFloat(cuotasPorVehiculo[vehicleIndex]) || 0) : 0;
  return {
    cuotaSemanal,
    moneda: resolveMonedaCuotaSemanal(cronograma, rule, vehicleIndex),
    bonoAuto: round2(parseFloat(rule.bono_auto) || 0),
    pctComision: round2(Number(parseFloat(rule.pct_comision) || 0)),
    cobroSaldo: round2(parseFloat(rule.cobro_saldo) || 0),
  };
}

/**
 * Mayor `cuota_semanal` del cronograma para el vehículo (todas las reglas).
 * Cuando hay mora abierta (`overdue` en cualquier cuota): no aplica el bono por viajes y se cobra la cuota del tramo más alto.
 */
function planFromCronogramaMayorCuotaPorVehiculo(cronograma, cronogramaVehiculoId) {
  if (!cronograma?.rules?.length) return null;
  const vehicles = cronograma.vehicles || [];
  const vehicleIndex = vehicles.findIndex((v) => v.id === cronogramaVehiculoId);
  if (vehicleIndex < 0) return null;
  let best = null;
  let bestCuota = -1;
  for (let i = 0; i < cronograma.rules.length; i++) {
    const rule = cronograma.rules[i];
    const cuotasPorVehiculo = rule.cuotas_por_vehiculo || [];
    const cuotaSemanal =
      cuotasPorVehiculo[vehicleIndex] != null ? round2(parseFloat(cuotasPorVehiculo[vehicleIndex]) || 0) : 0;
    if (cuotaSemanal > bestCuota + 1e-6) {
      bestCuota = cuotaSemanal;
      best = {
        cuotaSemanal,
        moneda: resolveMonedaCuotaSemanal(cronograma, rule, vehicleIndex),
        bonoAuto: round2(parseFloat(rule.bono_auto) || 0),
        pctComision: round2(Number(parseFloat(rule.pct_comision) || 0)),
        cobroSaldo: round2(parseFloat(rule.cobro_saldo) || 0),
      };
    }
  }
  return bestCuota >= 0 ? best : null;
}

/** partner_fees_83 guardado o derivado de partner_fees_raw (misma lógica que al generar la cuota). */
function partnerFees83FromRow(row) {
  let pf83 = round2(parseFloat(row.partner_fees_83) || 0);
  if (pf83 > 0) return pf83;
  const raw = round2(parseFloat(row.partner_fees_raw) || 0);
  return round2(raw * PARTNER_FEES_PCT);
}

/** nº de viajes usable para reglas del cronograma, o null si no aplica. */
function tripCountForRules(numViajes) {
  if (numViajes == null) return null;
  const n = Number(numViajes);
  return Number.isNaN(n) || n < 0 ? null : n;
}

/** % comisión y cobro del saldo desde una fila de regla (cronograma). */
function pctCobroFromRule(rule) {
  return {
    pct_comision: round2(Number(parseFloat(rule.pct_comision) || 0)),
    cobro_saldo: round2(parseFloat(rule.cobro_saldo) || 0),
  };
}

/**
 * Vencimiento canónico para mora (misma regla que `computeDueDateForMiAutoCuota` al generar la fila).
 * Así la mora corre desde el día correcto hasta hoy aunque `due_date` en BD esté desactualizado.
 */
function dueDateYmdForMoraDesdeSemana(r, fechaInicioCobroSemanal) {
  const wsYmd = ymdFromDbDate(r.week_start_date);
  const fiYmd = ymdFromDbDate(fechaInicioCobroSemanal);
  const storedDue = ymdFromDbDate(r.due_date);
  /** Si hay mora_desde (carga tardía de data), usar esa fecha como inicio de mora. */
  const moraDesde = ymdFromDbDate(r.mora_desde);
  if (moraDesde && /^\d{4}-\d{2}-\d{2}$/.test(moraDesde)) {
    return moraDesde;
  }
  if (wsYmd && /^\d{4}-\d{2}-\d{2}$/.test(wsYmd) && fiYmd && /^\d{4}-\d{2}-\d{2}$/.test(fiYmd)) {
    const isPrimera = isSemanaDepositoMiAuto(wsYmd, fechaInicioCobroSemanal);
    const canon = computeDueDateForMiAutoCuota(wsYmd, fiYmd, !!isPrimera);
    /** Si due_date fue postergado manualmente (posterior al canónico), usar el almacenado. */
    if (storedDue && /^\d{4}-\d{2}-\d{2}$/.test(storedDue) && canon && /^\d{4}-\d{2}-\d{2}$/.test(String(canon)) && storedDue > canon) return storedDue;
    if (canon && /^\d{4}-\d{2}-\d{2}$/.test(String(canon))) return String(canon).trim().slice(0, 10);
  }
  return storedDue && /^\d{4}-\d{2}-\d{2}$/.test(storedDue) ? storedDue : null;
}

/** Días civiles de retraso respecto al vencimiento (Lima). El día del vencimiento cuenta como 0; el interés empieza al día siguiente. */
function calendarDaysLateLima(dueDateStr) {
  if (!dueDateStr) return 0;
  const dueYmd = ymdFromDbDate(dueDateStr) || String(dueDateStr).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueYmd)) return 0;
  const todayYmd = limaTodayYmdSync();
  if (dueYmd >= todayYmd) return 0;
  return Math.max(0, diffDaysYmdUtc(dueYmd, todayYmd));
}

/**
 * Mora por días de retraso (Lima). Interés proporcional a días calendario tras el vencimiento (`tasa` semanal → tasa/7 por día sobre capital moroso).
 * `baseCuota` = capital moroso sobre el que corre la mora (típ. saldo pendiente de cuota neta, no la bruta).
 * @param {number|null} [maxDaysOverdue] Si viene, los días de mora son `min(días hasta hoy, max)` (p. ej. `MORA_MAX_DIAS_ACUMULACION_MI_AUTO`).
 */
function computeLateFeeDisplay(cronograma, dueDateStr, baseCuota, maxDaysOverdue = null) {
  if (!dueDateStr || baseCuota <= 0) return round2(0);
  const tasa = round2(parseFloat(cronograma?.tasa_interes_mora) || 0);
  if (tasa <= 0) return round2(0);
  let daysOverdue = calendarDaysLateLima(dueDateStr);
  if (maxDaysOverdue != null && Number.isFinite(maxDaysOverdue) && maxDaysOverdue > 0) {
    daysOverdue = Math.min(daysOverdue, maxDaysOverdue);
  }
  if (daysOverdue <= 0) return round2(0);
  const factorDia = tasa / 7;
  const moraDia = round2(baseCuota * factorDia);
  return round2(moraDia * daysOverdue);
}

/** Misma fórmula que `computeLateFeeDisplay` pero con número de días explícito (p. ej. mora sobre saldo desde una fecha guardada). */
function computeLateFeeForDayCount(cronograma, baseCuota, daysOverdue) {
  if (baseCuota <= 0 || daysOverdue <= 0) return round2(0);
  const tasa = round2(parseFloat(cronograma?.tasa_interes_mora) || 0);
  if (tasa <= 0) return round2(0);
  let d = Math.floor(Number(daysOverdue) || 0);
  if (d <= 0) return round2(0);
  if (MORA_MAX_DIAS_ACUMULACION_MI_AUTO != null && Number.isFinite(MORA_MAX_DIAS_ACUMULACION_MI_AUTO) && MORA_MAX_DIAS_ACUMULACION_MI_AUTO > 0) {
    d = Math.min(d, MORA_MAX_DIAS_ACUMULACION_MI_AUTO);
  }
  const factorDia = tasa / 7;
  const moraDia = round2(baseCuota * factorDia);
  return round2(moraDia * d);
}

function cuotaRegistradaParaMora(row) {
  const amountDue = round2(parseFloat(row?.amount_due) || 0);
  if (amountDue > 0.005) return amountDue;
  return round2(parseFloat(row?.cuota_semanal) || 0);
}

function resolveCuotaEsperadaParaMora(row, cronograma, vehId, isPrimera) {
  const rowCuota = cuotaRegistradaParaMora(row);
  if (isPrimera) return rowCuota;
  const trips = tripCountForRules(row.num_viajes);
  const plan = cronograma?.rules?.length && vehId != null && trips != null
    ? planFromCronograma(cronograma, vehId, trips)
    : null;
  if (plan?.cuotaSemanal != null) return round2(plan.cuotaSemanal);
  return rowCuota;
}

function saldoColumnasConMora(row) {
  const amountDue = round2(parseFloat(row?.amount_due) || 0);
  const lateFee = round2(parseFloat(row?.late_fee) || 0);
  const moraExtra = round2(parseFloat(row?.mora_extra) || 0);
  const paid = round2(parseFloat(row?.paid_amount) || 0);
  return round2(Math.max(0, amountDue + lateFee + moraExtra - paid));
}

function saldoBaseCuotaParaMora(row) {
  const amountDue = round2(parseFloat(row?.amount_due) || 0);
  const paid = round2(parseFloat(row?.paid_amount) || 0);
  return round2(Math.max(0, amountDue - paid));
}

function latestOverdueDueYmdWithDebt(rows, { excelOnly = false } = {}) {
  const todayYmd = limaTodayYmdSync();
  let latest = null;
  for (const r of rows || []) {
    if (excelOnly && !rowMontosFuenteExcel(r)) continue;
    const st = String(r?.status || '').toLowerCase();
    if (st === 'paid' || st === 'bonificada') continue;
    const dueYmd = ymdFromDbDate(r?.due_date) || ymdFromDbDate(r?.week_start_date);
    if (!dueYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dueYmd) || dueYmd >= todayYmd) continue;
    if (saldoColumnasConMora(r) <= 0.005) continue;
    if (!latest || dueYmd > latest) latest = dueYmd;
  }
  return latest;
}

function classifyMoraCuotaSemanalCase({
  row,
  cronograma,
  vehId,
  isPrimera,
  dueEffYmd,
  hermanas,
  comprobanteAbonoYmd,
}) {
  const paid = round2(parseFloat(row?.paid_amount) || 0);
  const basePendiente = saldoBaseCuotaParaMora(row);
  const esExcel = rowMontosFuenteExcel(row);
  const cuotaEsperada = resolveCuotaEsperadaParaMora(row, cronograma, vehId, isPrimera);
  const diff = round2(basePendiente - cuotaEsperada);
  const todayYmd = limaTodayYmdSync();
  const vencida = dueEffYmd && /^\d{4}-\d{2}-\d{2}$/.test(dueEffYmd) && dueEffYmd < todayYmd;
  if (isPrimera || !vencida || basePendiente <= 0.005) {
    return {
      case: basePendiente <= 0.005 ? (esExcel ? 'excel_sin_saldo' : 'sin_saldo') : (esExcel ? 'excel_no_vencida' : 'no_vencida'),
      cuotaEsperada,
      baseMora: basePendiente,
      fechaMora: null,
      lateFee: 0,
    };
  }
  if (paid > 0.005) {
    const fechaCorte = comprobanteAbonoYmd || ymdFromDbDate(row.fecha_ultimo_abono) || ymdFromDbDate(row.fecha_primer_comprobante) || todayYmd;
    const fechaMora = esExcel && diff < -0.05
      ? (latestOverdueDueYmdWithDebt(hermanas, { excelOnly: true }) || dueEffYmd)
      : dueEffYmd;
    const baseMora = esExcel && diff < -0.05
      ? cuotaRegistradaParaMora(row)
      : round2(Math.max(0, Number(cuotaEsperada) || Number(row.amount_due) || 0));
    const dias = fechaMora < fechaCorte ? Math.max(0, diffDaysYmdUtc(fechaMora, fechaCorte)) : 0;
    return {
      case: esExcel && diff < -0.05 ? 'excel_menor_fecha_reciente_pagado' : (esExcel ? 'excel_pagado_comprobante' : 'pagado_comprobante'),
      cuotaEsperada,
      baseMora,
      fechaMora,
      fechaCorte,
      lateFee: computeLateFeeForDayCount(cronograma, baseMora, dias),
    };
  }
  if (Math.abs(diff) <= 0.05) {
    return {
      case: esExcel ? 'excel_igual_due' : 'igual_due',
      cuotaEsperada,
      baseMora: basePendiente,
      fechaMora: dueEffYmd,
      lateFee: computeLateFeeDisplay(cronograma, dueEffYmd, basePendiente, MORA_MAX_DIAS_ACUMULACION_MI_AUTO),
    };
  }
  if (diff < -0.05) {
    const recentDue = latestOverdueDueYmdWithDebt(hermanas, { excelOnly: esExcel }) || dueEffYmd;
    return {
      case: esExcel ? 'excel_menor_fecha_reciente' : 'menor_fecha_reciente',
      cuotaEsperada,
      baseMora: basePendiente,
      fechaMora: recentDue,
      lateFee: computeLateFeeDisplay(cronograma, recentDue, basePendiente, MORA_MAX_DIAS_ACUMULACION_MI_AUTO),
    };
  }
  return {
    case: esExcel ? 'excel_mayor_due' : 'mayor_due_alerta',
    cuotaEsperada,
    baseMora: basePendiente,
    fechaMora: dueEffYmd,
    lateFee: computeLateFeeDisplay(cronograma, dueEffYmd, basePendiente, MORA_MAX_DIAS_ACUMULACION_MI_AUTO),
  };
}

function addOneCalendarDayYmd(ymd) {
  const s = String(ymd || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Prioriza fecha del último abono; si no hay, la del primer comprobante (conductor). */
function pickFechaReferenciaMoraSaldo(r) {
  const fa = ymdFromDbDate(r.fecha_ultimo_abono);
  const fc = ymdFromDbDate(r.fecha_primer_comprobante);
  if (fa && /^\d{4}-\d{2}-\d{2}$/.test(fa)) return fa;
  if (fc && /^\d{4}-\d{2}-\d{2}$/.test(fc)) return fc;
  return null;
}

/**
 * Actualiza `fecha_ultimo_abono` (Lima) cuando sube `paid_amount`; si el abono vuelve a ~0, limpia la fecha.
 * @param {string} cuotaId
 * @param {number|string} previousPaid
 * @param {number|string} newPaid
 */
export async function touchFechaUltimoAbonoCuota(cuotaId, previousPaid, newPaid) {
  const prev = round2(parseFloat(previousPaid) || 0);
  const neu = round2(parseFloat(newPaid) || 0);
  try {
    if (neu > prev + 0.005) {
      const ymd = limaTodayYmdSync();
      await query(
        `UPDATE module_miauto_cuota_semanal SET fecha_ultimo_abono = $1::date, updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid`,
        [ymd, cuotaId]
      );
    } else if (neu < prev - 0.005 && neu <= 0.005) {
      await query(
        `UPDATE module_miauto_cuota_semanal SET fecha_ultimo_abono = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
        [cuotaId]
      );
    }
  } catch (e) {
    if (e?.code === '42703') return;
    throw e;
  }
}

/** Primera subida de comprobante por cuota: ancla civil Lima para mora sobre saldo si aún no hay `fecha_ultimo_abono`. */
export async function touchFechaPrimerComprobanteCuota(cuotaSemanalId) {
  const ymd = limaTodayYmdSync();
  try {
    await query(
      `UPDATE module_miauto_cuota_semanal SET fecha_primer_comprobante = COALESCE(fecha_primer_comprobante, $1::date), updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid`,
      [ymd, cuotaSemanalId]
    );
  } catch (e) {
    if (e?.code === '42703') return;
    throw e;
  }
}

export async function updatePagoPuntualCuotaSemanal(solicitudId, cuotaSemanalId, pagoPuntual) {
  const elegibilidad = await query(
    `SELECT c.status, c.week_start_date, s.fecha_inicio_cobro_semanal, cr.bono_tiempo_activo
     FROM module_miauto_cuota_semanal c
     JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     LEFT JOIN module_miauto_cronograma cr ON cr.id = s.cronograma_id
     WHERE c.solicitud_id = $1::uuid AND c.id = $2::uuid AND c.deleted_at IS NULL`,
    [solicitudId, cuotaSemanalId]
  );
  const cuota = elegibilidad.rows[0];
  if (!cuota) {
    const err = new Error('Cuota semanal no encontrada');
    err.statusCode = 404;
    throw err;
  }
  if (!cuota.bono_tiempo_activo) {
    const err = new Error('El cronograma de esta solicitud no tiene bono tiempo activo');
    err.statusCode = 400;
    throw err;
  }
  if (pagoPuntual === true && isSemanaDepositoMiAuto(cuota.week_start_date, cuota.fecha_inicio_cobro_semanal)) {
    const err = new Error('La primera semana de depósito no cuenta para el bono tiempo');
    err.statusCode = 400;
    throw err;
  }
  if (pagoPuntual === true && String(cuota.status || '').toLowerCase() !== 'paid') {
    const err = new Error('Solo una cuota pagada puede marcarse como pago puntual');
    err.statusCode = 400;
    throw err;
  }
  const res = await query(
    `UPDATE module_miauto_cuota_semanal
     SET pago_puntual = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE solicitud_id = $2::uuid
       AND id = $3::uuid
       AND deleted_at IS NULL
     RETURNING id, solicitud_id, pago_puntual`,
    [pagoPuntual === true, solicitudId, cuotaSemanalId]
  );
  if (!res.rows[0]) {
    const err = new Error('Cuota semanal no encontrada');
    err.statusCode = 404;
    throw err;
  }
  const { reconciliarBonosTiempo } = await import('../bonos/miautoBonoTiempoService.js');
  await reconciliarBonosTiempo(solicitudId);
  return {
    id: res.rows[0].id,
    solicitud_id: res.rows[0].solicitud_id,
    pago_puntual: res.rows[0].pago_puntual === true,
  };
}

/**
 * Cuota programada a cobrar (`amount_due_sched`): **cuota semanal − cobro por ingresos (PF83)** + **cobro saldo** de regla
 * (y comisión % si aplica vía `computeAmountDueSemanal`).
 * Con pool PF en cascada: `cuota_semanal − partner_fees_83 + cobro_saldo` en la fila origen.
 * La **mora** se devenga aparte sobre la **cuota bruta** del plan (`cuota_semanal`) cuando existe; ver `amountDueAndLateForOpen`.
 */
export function resolvedAmountDueSchedForOpenRow(
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

/** Cuota en USD: corrige `partner_fees_raw` guardado en PEN/COP para PF83, comisión % y cobro Fleet (sin pisar filas ya en USD). */
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

/**
 * Cronograma abierto: abonos cubren primero la **mora normal**, luego la **mora extra** y el remanente reduce la **cuota** (`amount_due_sched`).
 * La mora devengada del periodo se calcula sobre la **cuota bruta del plan** (`cuota_semanal`, p. ej. 520) cuando existe;
 * la cuota a pagar sigue siendo la **neta** (520 − PF83 + cobro saldo, etc.). Así el reparto 200 = mora(bruta) + abono cuota
 * coincide con la hoja (mora sobre 520, tasa/7 × días).
 * Días = min(atraso hasta hoy, tope `MORA_MAX_DIAS_ACUMULACION_MI_AUTO`).
 *
 * Si el abono cubre toda esa mora (bruta) y además baja capital (`paid > mora_full`), puede quedar cuota
 * pendiente: sobre ese saldo se devenga **otra** mora (misma tasa/días) hasta pagar — coherente con “ya se cobró
 * la mora del tramo bruto y al capital que sigue impago le corre mora”.
 *
 * `paid_amount` incluye abonos Fleet y **cascada PF** de otras semanas. La imputación es **mora normal → mora extra → cuota** en dos pasos:
 * 1) Abonos distintos de cascada (`paid − cascade_received`) con la regla habitual (mora bruto → cuota → mora sobre saldo).
 * 2) La **cascada** se aplica después sobre el remanente (**mora pendiente** incl. mora sobre saldo, luego capital de cuota).
 * Así un ingreso en cascada cubre primero la mora “de pantalla” (~19) y el resto baja la cuota (~332,68), alineado a rent-sale.
 */
function amountDueAndLateForOpenSinglePhase(
  cronograma,
  r,
  cuota_semanal,
  bono_auto,
  pct_comision,
  cobro_saldo,
  isPrimeraCuotaSemanal,
  fechaInicioCobroSemanal,
  paidPhase
) {
  const amount_due_sched = resolvedAmountDueSchedForOpenRow(
    r,
    cuota_semanal,
    bono_auto,
    pct_comision,
    cobro_saldo,
    isPrimeraCuotaSemanal
  );

  if (isPrimeraCuotaSemanal) {
    return {
      amount_due_sched,
      mora_sched: 0,
      mora_full: 0,
      mora_saldo_capital_pendiente: 0,
      late_fee_remaining: 0,
      amount_due_remaining: round2(Math.max(0, amount_due_sched - round2(parseFloat(r.paid_amount) || 0))),
      obligacion_total_open: round2(amount_due_sched),
    };
  }

  const paid = round2(parseFloat(paidPhase) || 0);

  if (paid > 0.005) {
    const lateFeeDb = round2(parseFloat(r.late_fee) || 0);
    const moraExtraDb = round2(parseFloat(r.mora_extra) || 0);
    const moraTotalDb = round2(lateFeeDb + moraExtraDb);
    const abonoMoraTotal = round2(Math.min(paid, moraTotalDb));
    const abonoMoraLateFee = round2(Math.min(abonoMoraTotal, lateFeeDb));
    const abonoMoraExtra = round2(Math.min(moraExtraDb, Math.max(0, abonoMoraTotal - abonoMoraLateFee)));
    const abonoCuota = round2(Math.max(0, paid - abonoMoraTotal));
    const amt = resolvedAmountDueSchedForOpenRow(r, cuota_semanal, bono_auto, pct_comision, cobro_saldo, isPrimeraCuotaSemanal);
    const adRem = round2(Math.max(0, amt - abonoCuota));
    const lfRem = round2(Math.max(0, lateFeeDb - abonoMoraLateFee));
    return {
      amount_due_sched: amt,
      amount_due_remaining: adRem,
      late_fee_remaining: lfRem,
      mora_full: lateFeeDb,
      mora_saldo_capital_pendiente: round2(Math.max(0, moraExtraDb - abonoMoraExtra)),
      mora_sched_periodo: 0,
      obligacion_total_open: round2(adRem + lfRem + paid),
    };
  }

  const dueForMora =
    (ymdFromDbDate(r.mora_desde) || null) != null
      ? ymdFromDbDate(r.mora_desde)
      : fechaInicioCobroSemanal != null
        ? dueDateYmdForMoraDesdeSemana(r, fechaInicioCobroSemanal) || ymdFromDbDate(r.due_date) || r.due_date
        : ymdFromDbDate(r.due_date) || r.due_date;

  const cuotaNetaProg = round2(Math.max(0, amount_due_sched));
  const cuotaBruta = round2(Math.max(0, parseFloat(cuota_semanal) || 0));
  /** Base para mora (tasa diaria × días): sobre lo pendiente neto, descontando lo ya pagado. */
  const baseReparto = round2(Math.max(0.005, cuotaNetaProg - paid));
  const moraParaReparto = computeLateFeeDisplay(
    cronograma,
    dueForMora,
    baseReparto,
    MORA_MAX_DIAS_ACUMULACION_MI_AUTO
  );
  /** Misma cifra para imputación y columnas: no recalcular mora sobre saldo neto residual (eso subestimaba la mora). */
  const mora_full = round2(moraParaReparto);
  const mora_sched = round2(moraParaReparto);

  let late_fee_remaining;
  let amount_due_remaining;

  if (mora_full > 0.005) {
    const abonoMora = round2(Math.min(paid, mora_full));
    const abonoCuota = round2(Math.max(0, paid - abonoMora));
    late_fee_remaining = round2(Math.max(0, mora_full - abonoMora));
    amount_due_remaining = round2(Math.max(0, amount_due_sched - abonoCuota));
  } else {
    late_fee_remaining = round2(0);
    amount_due_remaining = round2(Math.max(0, amount_due_sched - paid));
  }

  /** Mora sobre capital de cuota aún pendiente tras haber cubierto la mora sobre cuota bruta y haber abonado algo a capital.
   * Días: desde el día **siguiente** a `fecha_ultimo_abono` o `fecha_primer_comprobante` (Lima) hasta hoy; si no hay fecha en BD, mismo criterio que antes (días desde vencimiento). */
  let mora_saldo_capital_pendiente = round2(0);
  const abonoACapitalTrasMoraBruta = round2(paid - mora_full);
  if (
    mora_full > 0.005 &&
    late_fee_remaining <= 0.005 &&
    amount_due_remaining > 0.005 &&
    abonoACapitalTrasMoraBruta > 0.005
  ) {
    const refYmd = pickFechaReferenciaMoraSaldo(r);
    let daysSaldoRem;
    if (refYmd) {
      const startYmd = addOneCalendarDayYmd(refYmd);
      const todayY = limaTodayYmdSync();
      daysSaldoRem = startYmd > todayY ? 0 : Math.max(0, diffDaysYmdUtc(startYmd, todayY));
      if (MORA_MAX_DIAS_ACUMULACION_MI_AUTO != null && MORA_MAX_DIAS_ACUMULACION_MI_AUTO > 0) {
        daysSaldoRem = Math.min(daysSaldoRem, MORA_MAX_DIAS_ACUMULACION_MI_AUTO);
      }
    } else {
      daysSaldoRem = calendarDaysLateLima(dueForMora);
    }
    mora_saldo_capital_pendiente = computeLateFeeForDayCount(cronograma, amount_due_remaining, daysSaldoRem);
    late_fee_remaining = round2(late_fee_remaining + mora_saldo_capital_pendiente);
  }

  const obligacion_total_open = round2(amount_due_remaining + late_fee_remaining + paid);

  return {
    amount_due_sched,
    mora_sched: round2(mora_sched),
    mora_full,
    mora_saldo_capital_pendiente,
    late_fee_remaining,
    amount_due_remaining,
    obligacion_total_open,
  };
}

function amountDueAndLateForOpen(
  cronograma,
  r,
  cuota_semanal,
  bono_auto,
  pct_comision,
  cobro_saldo,
  isPrimeraCuotaSemanal,
  cascadeReceived,
  fechaInicioCobroSemanal
) {
  const paid = round2(parseFloat(r.paid_amount) || 0);
  let cascade = round2(Math.max(0, parseFloat(cascadeReceived) || 0));
  if (cascade > paid + 0.01) cascade = paid;
  const paidNonCascade = round2(Math.max(0, paid - cascade));

  // Si todo el pago proviene de cascada (sin pagos directos), imputar contra la
  // mora histórica real al momento de la cascada. La fecha de cascada se infiere
  // de `mora_extra_desde` (día en que el cascadeo actualizó paid_amount). Se usa
  // `computeLateFeeForDayCount` para evitar la distorsión del late_fee inflado actual.
  if (cascade > 0.005 && paidNonCascade <= 0.005) {
    const moraExtraDesdeYmd = ymdFromDbDate(r.mora_extra_desde);
    const dueYmd = dueDateYmdForMoraDesdeSemana(r, fechaInicioCobroSemanal)
      || ymdFromDbDate(r.due_date) || r.due_date;
    const diasReales = moraExtraDesdeYmd && dueYmd
      ? Math.max(0, diffDaysYmdUtc(dueYmd, moraExtraDesdeYmd))
      : 0;
    const moraReal = diasReales > 0
      ? computeLateFeeForDayCount(cronograma, round2(cuota_semanal), diasReales)
      : round2(parseFloat(r.late_fee) || 0);
    const moraExtraDb = round2(parseFloat(r.mora_extra) || 0);
    const abonoMoraTotal = round2(Math.min(paid, round2(moraReal + moraExtraDb)));
    const abonoMora = round2(Math.min(abonoMoraTotal, moraReal));
    const abonoMoraExtra = round2(Math.min(moraExtraDb, Math.max(0, abonoMoraTotal - abonoMora)));
    const abonoCuota = round2(Math.max(0, paid - abonoMoraTotal));
    const amt = resolvedAmountDueSchedForOpenRow(
      r, cuota_semanal, bono_auto, pct_comision, cobro_saldo, isPrimeraCuotaSemanal
    );
    return {
      amount_due_sched: amt,
      amount_due_remaining: round2(Math.max(0, amt - abonoCuota)),
      late_fee_remaining: round2(Math.max(0, moraReal - abonoMora)),
      mora_full: moraReal,
      mora_saldo_capital_pendiente: round2(Math.max(0, moraExtraDb - abonoMoraExtra)),
      mora_sched_periodo: 0,
      obligacion_total_open: round2(round2(Math.max(0, amt - abonoCuota)) + round2(Math.max(0, moraReal - abonoMora)) + paid),
    };
  }

  const p1 = amountDueAndLateForOpenSinglePhase(
    cronograma,
    r,
    cuota_semanal,
    bono_auto,
    pct_comision,
    cobro_saldo,
    isPrimeraCuotaSemanal,
    fechaInicioCobroSemanal,
    paidNonCascade
  );

  if (cascade <= 0.005) {
    return p1;
  }

  let lf = p1.late_fee_remaining;
  let moraExtra = round2(p1.mora_saldo_capital_pendiente || 0);
  let ad = p1.amount_due_remaining;
  const toMoraNormal = round2(Math.min(cascade, lf));
  const remAfterMoraNormal = round2(Math.max(0, cascade - toMoraNormal));
  const toMoraExtra = round2(Math.min(remAfterMoraNormal, moraExtra));
  const toCuota = round2(Math.max(0, remAfterMoraNormal - toMoraExtra));
  lf = round2(Math.max(0, lf - toMoraNormal));
  moraExtra = round2(Math.max(0, moraExtra - toMoraExtra));
  ad = round2(Math.max(0, ad - toCuota));

  return {
    ...p1,
    late_fee_remaining: lf,
    amount_due_remaining: ad,
    mora_saldo_capital_pendiente: moraExtra,
    obligacion_total_open: round2(ad + lf + paid),
  };
}

/**
 * Misma regla final que `amountDueAndLateForOpen` (abono primero a mora, luego a cuota)
 * para alinear `mora_pendiente` + `cuota_pendiente` con `pending_total` cuando el derivado quedó desfasado.
 */
function imputacionMoraCuotaRemanenteFromPaid(paid, moraFull, amountDueSched) {
  const p = round2(parseFloat(paid) || 0);
  const mf = round2(parseFloat(moraFull) || 0);
  const sched = round2(parseFloat(amountDueSched) || 0);
  if (mf > 0.005) {
    const abonoMora = round2(Math.min(p, mf));
    const abonoCuota = round2(Math.max(0, p - abonoMora));
    return {
      late_fee_remaining: round2(Math.max(0, mf - abonoMora)),
      amount_due_remaining: round2(Math.max(0, sched - abonoCuota)),
    };
  }
  return {
    late_fee_remaining: round2(0),
    amount_due_remaining: round2(Math.max(0, sched - p)),
  };
}

/**
 * Usar siempre la mora pendiente de la cascada (`late_fee_remaining`) en filas abiertas.
 * Antes `overdue`/`partial` podían quedar fuera del `|| paid < obligación` y forzar mora a 0 en API.
 */
function debeAplicarMoraCuotaSemanal(status) {
  const st = (status || '').toLowerCase();
  if (st === 'paid' || st === 'bonificada') return false;
  return true;
}

/**
 * Solicitudes listas para generar cuota semanal (job lunes). No filtra por pago_estado: basta Mi Auto ya generado (fecha_inicio_cobro_semanal) y datos operativos.
 * `park_id`: si no viene de `drivers` ni `rapidin_drivers`, se usa el parque Fleet Mi Auto (`MIAUTO_PARK_ID`) para no excluir préstamos nuevos con `external_driver_id` pero sin park aún en BD.
 */
export async function getSolicitudesParaCobroSemanal() {
  const res = await query(
    `SELECT s.id AS solicitud_id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
            s.placa_asignada, s.dni,
            ${sqlYangoDriverCoalesceColumns()},
            s.country
     FROM module_miauto_solicitud s
     ${sqlYangoDriverLateralJoin(1)}
      WHERE s.status = 'aprobado'
        AND s.cronograma_id IS NOT NULL
        AND s.cronograma_vehiculo_id IS NOT NULL
        AND s.fecha_inicio_cobro_semanal IS NOT NULL
      ORDER BY s.id`,
    [MIAUTO_PARK_ID]
  );
  return res.rows || [];
}

/**
 * Solicitud Mi Auto + conductor Yango: `external_driver_id` / `park_id` / nombre.
 * El match se hace por driver_id_fleet, DNI, placa o teléfono (en ese orden).
 */
export async function loadMiAutoSolicitudConFlotaDrivers(solicitudId) {
  const res = await query(
    `SELECT s.id AS solicitud_id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
            s.status, s.pago_estado, s.placa_asignada, s.dni,
            ${sqlYangoDriverCoalesceColumns()},
            s.country
     FROM module_miauto_solicitud s
     ${sqlYangoDriverLateralJoin(2)}
     WHERE s.id = $1::uuid`,
    [solicitudId, MIAUTO_PARK_ID]
  );
  return res.rows[0] || null;
}

/**
 * Mora y estado vencida (Lima):
 * - La **semana de cuota** (`week_start_date` = lunes) si ya pasó (`< hoy`) → entra al job; también entra si **`due_date` < hoy** aunque `week_start_date` esté erróneo (p. ej. futuro).
 * - Si no hay `week_start_date`, se usa `due_date < hoy`.
 * - El día del vencimiento canónico (`due_date` = lunes de cuota o fecha depósito en sem. 1) sigue **pendiente** ese mismo día: `week_start >= hoy` → no mora.
 * - Con saldo tras el vencimiento (Lima) → `overdue`; `partial` solo si aún no vence y hubo abono.
 */
export async function updateMoraDiaria(solicitudId = null, options = {}) {
  const singleCuotaId = options.singleCuotaId || null;
  const includePartial = options.includePartial === true;
  const ignorePendingComprobanteFreeze = options.ignorePendingComprobanteFreeze === true;
  const dryRun = options.dryRun === true;
  const includeExcelMora = dryRun || options.includeExcelMora === true || envFlagEnabled('MIAUTO_MORA_EXCEL_ENABLED');

  const scopeConds = [];
  const scopeParams = [];
  if (solicitudId) {
    scopeParams.push(solicitudId);
    scopeConds.push(`c.solicitud_id = $${scopeParams.length}`);
  }
  if (singleCuotaId) {
    scopeParams.push(singleCuotaId);
    scopeConds.push(`c.id = $${scopeParams.length}::uuid`);
  }
  const scopeSql = scopeConds.length ? ` AND ${scopeConds.join(' AND ')}` : '';

  /** Excluir solicitudes desactivadas de cualquier recálculo de mora. */
  const skipDesactivadasSql = ` AND EXISTS (SELECT 1 FROM module_miauto_solicitud s WHERE s.id = c.solicitud_id AND s.status = 'aprobado')`;

  /** Semana de cuota aún no empezó (lunes ≥ hoy) o sin lunes: se usa `due_date` ≥ hoy para revertir mora. */
  const vencimientoHoyOFuturoSql = `(
      (c.week_start_date IS NOT NULL AND c.week_start_date::date >= ${SQL_LIMA_TODAY})
      OR (c.week_start_date IS NULL AND c.due_date IS NOT NULL AND c.due_date::date >= ${SQL_LIMA_TODAY})
    )`;
  /**
   * Incluye `due_date::date < hoy` (Lima en SQL) aunque `week_start_date` esté mal en BD (p. ej. futuro):
   * si no, el job no recalcula mora ni pasa a vencido aunque el vencimiento civil ya pasó.
   */
  const vencimientoYaPasadoSql = `(
      (c.week_start_date IS NOT NULL AND c.week_start_date::date < ${SQL_LIMA_TODAY})
      OR (c.week_start_date IS NULL AND c.due_date IS NOT NULL AND c.due_date::date < ${SQL_LIMA_TODAY})
      OR (c.due_date IS NOT NULL AND c.due_date::date < ${SQL_LIMA_TODAY})
    )`;

  if (!dryRun && !includeExcelMora) {
    const syncExcelSql = `
      UPDATE module_miauto_cuota_semanal c
      SET status = CASE
            WHEN COALESCE(c.paid_amount, 0)::numeric >= COALESCE(c.amount_due, 0)::numeric + COALESCE(c.late_fee, 0)::numeric + COALESCE(c.mora_extra, 0)::numeric - 0.005 THEN 'paid'
            WHEN COALESCE(c.due_date, c.week_start_date)::date < ${SQL_LIMA_TODAY} THEN 'overdue'
            WHEN COALESCE(c.paid_amount, 0)::numeric > 0.005 THEN 'partial'
            ELSE 'pending'
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE LOWER(COALESCE(c.montos_fuente, '')) = 'excel'${scopeSql}${skipDesactivadasSql}`;
    await query(syncExcelSql, scopeParams);
  }

  /** Solo corrige estado; no pisa `late_fee` (mora histórica en cuotas pagadas). */
  /** Total registrado cuota+mora en columnas vs pagado (sin SQL del cronograma). */
  const revertOverdueSql = `
    UPDATE module_miauto_cuota_semanal c
    SET status = CASE
          WHEN COALESCE(c.paid_amount, 0)::numeric <= 0.005 THEN 'pending'
          WHEN COALESCE(c.paid_amount, 0)::numeric >= COALESCE(c.amount_due, 0)::numeric + COALESCE(c.late_fee, 0)::numeric - 0.005 THEN 'paid'
          ELSE 'partial'
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE c.status = 'overdue'
      AND ${vencimientoHoyOFuturoSql}
      AND (c.due_date IS NULL OR c.due_date::date >= ${SQL_LIMA_TODAY})${scopeSql}${skipDesactivadasSql}`;
  if (!dryRun) await query(revertOverdueSql, scopeParams);

  /** Bonificada: anular mora en columna; en `paid` se conserva devengo/histórico. */
  const clearBonificadaLateFeeSql = `
    UPDATE module_miauto_cuota_semanal c
    SET late_fee = 0, updated_at = CURRENT_TIMESTAMP
    WHERE c.status = 'bonificada'
      AND COALESCE(c.late_fee, 0)::numeric > 0.005${scopeSql}${skipDesactivadasSql}`;
  if (!dryRun) await query(clearBonificadaLateFeeSql, scopeParams);

  const clearPartialSql = `
    UPDATE module_miauto_cuota_semanal c
    SET late_fee = 0, updated_at = CURRENT_TIMESTAMP
    WHERE c.status = 'partial'
      AND ${vencimientoHoyOFuturoSql}
      AND (c.due_date IS NULL OR c.due_date::date >= ${SQL_LIMA_TODAY})
      AND COALESCE(c.late_fee, 0)::numeric > 0.005${scopeSql}${skipDesactivadasSql}`;
  if (!dryRun) await query(clearPartialSql, scopeParams);

  /** Incluir `paid` mal etiquetada: aún hay saldo en columnas cuota+mora respecto al abono (p. ej. cascada vs Excel). */
  /** Columnas pueden marcar «pagado» sin mora persistida; el job re-deriva cuota+mora y corrige estado. */
  const underpaidPaidSql = `(c.status = 'paid' AND COALESCE(c.amount_due,0)::numeric + COALESCE(c.late_fee,0)::numeric > COALESCE(c.paid_amount,0)::numeric + 0.02)`;
  const statusSql = includePartial
    ? `(c.status IN ('pending', 'overdue', 'partial') OR ${underpaidPaidSql})`
    : `(c.status IN ('pending', 'overdue') OR ${underpaidPaidSql})`;
  const fuenteSql = includeExcelMora ? '' : `LOWER(COALESCE(c.montos_fuente, '')) <> 'excel' AND `;
  let sql = `SELECT c.id, c.solicitud_id, c.week_start_date, c.cuota_semanal, c.amount_due, c.due_date, c.num_viajes, c.bono_auto,
            c.paid_amount, c.late_fee, c.status, c.moneda, c.pct_comision, c.cobro_saldo,
            c.partner_fees_raw, c.partner_fees_83,
            c.fecha_ultimo_abono, c.fecha_primer_comprobante, c.montos_fuente, c.cobro_desde_saldo_conductor,
            c.mora_desde, c.mora_extra, c.mora_extra_desde,
            s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     WHERE ${fuenteSql}${statusSql} AND ${vencimientoYaPasadoSql}`;
  let p = 0;
  if (solicitudId) {
    p += 1;
    sql += ` AND c.solicitud_id = $${p}`;
  }
  if (singleCuotaId) {
    p += 1;
    sql += ` AND c.id = $${p}::uuid`;
  }
  const res = await query(sql, scopeParams);
  const rows = res.rows || [];

  /** Comprobante del conductor aún sin validar/rechazar → no subir mora en BD ni en estado hasta resolución. */
  let pendingComprobanteCuotaIds = new Set();
  if (rows.length > 0 && !ignorePendingComprobanteFreeze) {
    const cuotaIdList = rows.map((r) => r.id);
    const pendRes = await query(
      `SELECT DISTINCT cuota_semanal_id::text AS id
       FROM module_miauto_comprobante_cuota_semanal
       WHERE cuota_semanal_id = ANY($1::uuid[])
         AND validated_at IS NULL
         AND LOWER(COALESCE(NULLIF(TRIM(estado::text), ''), 'pendiente')) = 'pendiente'`,
      [cuotaIdList]
    );
    pendingComprobanteCuotaIds = new Set((pendRes.rows || []).map((x) => String(x.id)));
  }

  const comprobanteAbonoFechaByCuota = new Map();
  if (rows.length > 0) {
    const cuotaIdList = rows.map((r) => r.id);
    const compRes = await query(
      `SELECT cuota_semanal_id::text AS id,
              MIN(created_at)::date AS fecha_abono
       FROM module_miauto_comprobante_cuota_semanal
       WHERE cuota_semanal_id = ANY($1::uuid[])
         AND LOWER(COALESCE(NULLIF(TRIM(estado::text), ''), 'pendiente')) NOT IN ('rechazado', 'anulado')
       GROUP BY cuota_semanal_id`,
      [cuotaIdList]
    );
    for (const r of compRes.rows || []) {
      const ymd = ymdFromDbDate(r.fecha_abono);
      if (ymd) comprobanteAbonoFechaByCuota.set(String(r.id), ymd);
    }
  }

  const solIds = [...new Set(rows.map((x) => x.solicitud_id).filter(Boolean))];
  /** Por solicitud: todas las filas (para saber si hay vencida más antigua con saldo). */
  const hermanasPorSolicitud = new Map();
  if (solIds.length > 0) {
    const herRes = await query(
       `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.status, c.amount_due, c.late_fee, c.paid_amount,
               c.num_viajes, c.bono_auto, c.cuota_semanal, c.partner_fees_raw, c.partner_fees_83,
               c.cobro_saldo, c.pct_comision, c.moneda, c.partner_fees_cascada_destino,
               c.fecha_ultimo_abono, c.fecha_primer_comprobante, c.montos_fuente, c.cobro_desde_saldo_conductor,
            c.mora_desde, c.mora_extra, c.mora_extra_desde, c.mora_extra_total,
              s.fecha_inicio_cobro_semanal
       FROM module_miauto_cuota_semanal c
       INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
       WHERE c.solicitud_id = ANY($1::uuid[])`,
      [solIds]
    );
    for (const h of herRes.rows || []) {
      const k = String(h.solicitud_id);
      if (!hermanasPorSolicitud.has(k)) hermanasPorSolicitud.set(k, []);
      hermanasPorSolicitud.get(k).push(h);
    }
  }
  const todayYForBlocking = limaTodayYmdSync();

  /** Mapa cuota_id → monto cascada recibida (para excluir del cálculo de mora). */
  const cascadeReceivedBySol = new Map();
  for (const [solKey, hRows] of hermanasPorSolicitud) {
    cascadeReceivedBySol.set(solKey, buildCascadeReceivedMap(hRows));
  }

  const cronogramaById = new Map();
  const cronogramaFor = async (cronoId) => {
    if (cronoId == null) return null;
    const key = String(cronoId);
    if (cronogramaById.has(key)) return cronogramaById.get(key);
    const c = await getCronogramaById(cronoId);
    cronogramaById.set(key, c);
    return c;
  };

  let updated = 0;
  const moraStats = {
    rowsEvaluadas: rows.length,
    conMoraNormal: 0,
    conMoraExtra: 0,
    moraExtraReiniciada: 0,
    congeladasPorComprobante: 0,
    cambiosEstado: 0,
    cambiosMoraNormal: 0,
    casos: {},
  };
  const dryRunChanges = [];
  for (const row of rows) {
    const cronograma = await cronogramaFor(row.cronograma_id);
    const vehId = row.cronograma_vehiculo_id;
    const wsYmd = ymdFromDbDate(row.week_start_date);
    const isPrimera = wsYmd ? isSemanaDepositoMiAuto(wsYmd, row.fecha_inicio_cobro_semanal) : false;
    const fiYmd = ymdFromDbDate(row.fecha_inicio_cobro_semanal);
    const canonicalDueYmd =
      wsYmd && /^\d{4}-\d{2}-\d{2}$/.test(wsYmd)
        ? computeDueDateForMiAutoCuota(wsYmd, fiYmd, !!isPrimera)
        : null;
    const storedDueYmd = ymdFromDbDate(row.due_date);
    const canonicalValid = canonicalDueYmd && /^\d{4}-\d{2}-\d{2}$/.test(String(canonicalDueYmd));
    /** Solo parchea auto-calculado si el stored no está manualmente postergado (due_date > canonical). */
    const patchDue = canonicalValid && (!storedDueYmd || canonicalDueYmd > storedDueYmd);
    const dueEffYmd = storedDueYmd && (!canonicalValid || storedDueYmd > canonicalDueYmd) ? storedDueYmd : (canonicalValid ? canonicalDueYmd : null);
    const rowForDerived = patchDue ? { ...row, due_date: canonicalDueYmd } : row;
    const fiRow = row.fecha_inicio_cobro_semanal;
    const yangoSemanaCerrada = wsYmd ? isWeekYangoClosedForMiAutoCuotaMetrics(wsYmd, fiRow) : false;
    const tieneDatosMora = (row.num_viajes != null && Number(row.num_viajes) > 0) || (row.partner_fees_raw != null && round2(parseFloat(row.partner_fees_raw) || 0) > 0.005);
    const sinViajesYangoRow = isPrimera || (!yangoSemanaCerrada && !tieneDatosMora);
    const hermanasMis = hermanasPorSolicitud.get(String(row.solicitud_id)) || [];
    const solTieneCuotaOverdue = hermanasMis.some((x) => String(x.status || '').toLowerCase() === 'overdue' && cuotaTieneSaldoPendienteColumnas(x));
    const forzarCuotaMaxSinBono = debeAplicarCuotaMaximaSinBonoPorMora(solTieneCuotaOverdue, isPrimera, row.status);
    const cascRecvMapForRow = cascadeReceivedBySol.get(String(row.solicitud_id));
    const cascRecv = cascRecvMapForRow ? cascRecvMapForRow.get(String(row.id)) || 0 : 0;
    const d = computeCuotaDerivedForRow(rowForDerived, cronograma, vehId, {
      isPrimeraCuotaSemanal: !!isPrimera,
      fechaInicioCobroSemanal: row.fecha_inicio_cobro_semanal,
      cascadeReceived: cascRecv,
      forzarMayorCuotaSinBono: forzarCuotaMaxSinBono,
    });
    let lateFeeOut = round2(d.late_fee);
    const moraCase = classifyMoraCuotaSemanalCase({
      row,
      cronograma,
      vehId,
      isPrimera,
      dueEffYmd,
      hermanas: hermanasMis,
      comprobanteAbonoYmd: comprobanteAbonoFechaByCuota.get(String(row.id)) || null,
    });
    if (rowMontosFuenteExcel(row)) {
      lateFeeOut = round2(moraCase.lateFee);
    }
    moraStats.casos[moraCase.case] = (moraStats.casos[moraCase.case] || 0) + 1;
    const lateFeeDb = round2(parseFloat(row.late_fee) || 0);
    const paidDb = round2(parseFloat(row.paid_amount) || 0);
    const oblig = round2(d.obligacion_total);
    const pendDerived = round2(Math.max(0, oblig - paidDb));
    /** Pendiente según motor (cuota remanente + mora pendiente), no `amount_due` persistido a secas. */
    const pendCols = round2(Math.max(0, d.cuota_final));
    const hermanas = hermanasMis;
    const hasOlderBlockingDebt = hermanas.some((o) => {
      if (String(o.id) === String(row.id)) return false;
      const wsH = ymdFromDbDate(o.week_start_date);
      const fiH = o.fecha_inicio_cobro_semanal ?? row.fecha_inicio_cobro_semanal;
      const isPH = wsH ? isSemanaDepositoMiAuto(wsH, fiH) : false;
      const cascRecvMapH = cascadeReceivedBySol.get(String(row.solicitud_id));
      const forzarHermana = debeAplicarCuotaMaximaSinBonoPorMora(solTieneCuotaOverdue, isPH, o.status);
      const dH = computeCuotaDerivedForRow(o, cronograma, row.cronograma_vehiculo_id, {
        isPrimeraCuotaSemanal: !!isPH,
        fechaInicioCobroSemanal: fiH,
        cascadeReceived: cascRecvMapH ? (cascRecvMapH.get(String(o.id)) || 0) : 0,
        forzarMayorCuotaSinBono: forzarHermana,
      });
      const pendEconHermana = round2(Math.max(0, dH.cuota_final));
      return cuotaHermanaBloqueaPorDeudaMasAntigua(o, dueEffYmd, todayYForBlocking, {
        pendienteEconomico: pendEconHermana,
      });
    });
    const moraComputed = round2(lateFeeOut);
    const freezeMoraPorComprobante = pendingComprobanteCuotaIds.has(String(row.id));
    let pendDerivedUse = pendDerived;
    let pendColsUse = pendCols;
    if (freezeMoraPorComprobante) {
      const obligFrozen = round2(d.obligacion_total - moraComputed + lateFeeDb);
      pendDerivedUse = round2(Math.max(0, obligFrozen - paidDb));
      pendColsUse = round2(Math.max(0, d.cuota_final - moraComputed + lateFeeDb));
      moraStats.congeladasPorComprobante++;
    }
    const pend = pendienteStatusCuotaAbiertaPostCorte(d, pendDerivedUse, pendColsUse, { hasOlderBlockingDebt });
    let statusOut = miAutoOpenStatusSaldoVencimiento(dueEffYmd, pend, paidDb);
    const stRow = String(row.status || '').toLowerCase();
    /**
     * La mora persistida debe seguir al cálculo vigente. Antes se conservaba el
     * máximo histórico de mora, lo que podía dejar
     * moras infladas después de corregir pagos, fechas o cronograma.
     */
    let lateFeePersist = lateFeeOut;
    if (!freezeMoraPorComprobante && stRow === 'bonificada') lateFeePersist = 0;
    if (freezeMoraPorComprobante) {
      lateFeePersist = lateFeeDb;
    }

    // Regla de imputación: el pago cubre primero mora normal, luego mora extra y recién después capital.
    // La mora_extra solo crece cuando el pago ya cubrió toda la mora vigente hasta el abono
    // y dejó un abono real a capital/cuota.
    let moraExtraPersist = round2(parseFloat(row.mora_extra) || 0);
    let moraExtraDesde = ymdFromDbDate(row.mora_extra_desde);
    const moraExtraTotalDbOld = round2(parseFloat(row.mora_extra_total) || 0);
    const pagoHecho = round2(paidDb);
    const fechaUltimoAbono = comprobanteAbonoFechaByCuota.get(String(row.id)) || ymdFromDbDate(row.fecha_ultimo_abono);
    const fechaCorteMoraNormal = moraCase.fechaCorte || fechaUltimoAbono || limaTodayYmdSync();
    const fechaInicioMoraNormal = rowMontosFuenteExcel(row) && moraCase.fechaMora ? moraCase.fechaMora : dueEffYmd;
    const baseCapitalMoraNormal = round2(Math.max(0, Number(rowMontosFuenteExcel(row) ? moraCase.baseMora : d.amount_due_sched) || Number(row.amount_due) || 0));
    const diasMoraNormalHastaAbono =
      fechaInicioMoraNormal && fechaCorteMoraNormal && fechaInicioMoraNormal < fechaCorteMoraNormal
        ? Math.max(0, diffDaysYmdUtc(fechaInicioMoraNormal, fechaCorteMoraNormal))
        : 0;
    const moraNormalHastaAbono = isPrimera
      ? 0
      : computeLateFeeForDayCount(cronograma, baseCapitalMoraNormal, diasMoraNormalHastaAbono);
    const moraExtraExistente = round2(parseFloat(row.mora_extra) || 0);
    const abonoMoraNormal = round2(Math.min(pagoHecho, moraNormalHastaAbono));
    const saldoPagoTrasMoraNormal = round2(Math.max(0, pagoHecho - abonoMoraNormal));
    const moraExtraDisponibleParaImputar =
      moraExtraDesde && fechaUltimoAbono && moraExtraDesde >= fechaUltimoAbono
        ? 0
        : moraExtraExistente;
    const abonoMoraExtraExistente = round2(Math.min(saldoPagoTrasMoraNormal, moraExtraDisponibleParaImputar));
    const abonoACapital = round2(Math.max(0, saldoPagoTrasMoraNormal - abonoMoraExtraExistente));
    const moraNormalPendiente = round2(Math.max(0, moraNormalHastaAbono - abonoMoraNormal));
    const moraExtraExistentePendiente = round2(Math.max(0, moraExtraExistente - abonoMoraExtraExistente));
    const capitalPendienteTrasAbono = round2(Math.max(0, baseCapitalMoraNormal - abonoACapital));

    if (!isPrimera && !freezeMoraPorComprobante && pagoHecho > 0.005) {
      lateFeePersist = moraNormalPendiente;
      const pendienteTrasImputacion = round2(
        moraNormalPendiente + moraExtraExistentePendiente + capitalPendienteTrasAbono
      );
      statusOut = miAutoOpenStatusSaldoVencimiento(dueEffYmd, pendienteTrasImputacion, paidDb);
    }
    
    if (freezeMoraPorComprobante) {
      moraExtraPersist = round2(parseFloat(row.mora_extra) || 0);
      moraExtraDesde = ymdFromDbDate(row.mora_extra_desde);
    } else if (
      statusOut === 'overdue' &&
      moraNormalPendiente <= 0.005 &&
      capitalPendienteTrasAbono > 0.005
    ) {
      if (abonoACapital > 0.005 && !moraExtraDesde) {
        moraExtraDesde = fechaUltimoAbono || limaTodayYmdSync();
      }
      const dias = moraExtraDesde ? Math.max(0, calendarDaysLateLima(moraExtraDesde)) : 0;
      const moraExtraNueva = abonoACapital > 0.005 && dias > 0
        ? computeLateFeeForDayCount(cronograma, capitalPendienteTrasAbono, dias)
        : 0;
      moraExtraPersist = round2(Math.max(moraExtraExistentePendiente, moraExtraNueva));
    } else {
      if (moraExtraExistentePendiente > 0.005) {
        moraExtraPersist = moraExtraExistentePendiente;
      } else if (moraExtraPersist > 0.005 || moraExtraDesde) {
        moraStats.moraExtraReiniciada++;
        moraExtraPersist = 0;
        moraExtraDesde = null;
      } else {
        moraExtraPersist = 0;
        moraExtraDesde = null;
      }
    }

    if (isPrimera && !freezeMoraPorComprobante) {
      lateFeePersist = 0;
      moraExtraPersist = 0;
      moraExtraDesde = null;
      if (statusOut === 'overdue') statusOut = paidDb > 0.005 ? 'partial' : 'pending';
    }

    if (!isPrimera && moraExtraPersist > 0.005 && statusOut === 'paid') {
      statusOut = miAutoOpenStatusSaldoVencimiento(dueEffYmd, moraExtraPersist, paidDb);
    }

    // mora_extra_total = total generado histórico (cristalizado + actual)
    const moraExtraDbOld = round2(parseFloat(row.mora_extra) || 0);
    const moraExtraTotalPersist = freezeMoraPorComprobante
      ? moraExtraTotalDbOld
      : round2(Math.max(moraExtraTotalDbOld, moraExtraTotalDbOld - moraExtraDbOld + moraExtraPersist));

    if (dryRun) {
      dryRunChanges.push({
        cuota_semanal_id: row.id,
        solicitud_id: row.solicitud_id,
        fuente: row.montos_fuente || null,
        caso_mora: moraCase.case,
        fecha_mora: moraCase.fechaMora,
        fecha_corte: moraCase.fechaCorte || null,
        cuota_esperada: moraCase.cuotaEsperada,
        base_mora: moraCase.baseMora,
        late_fee_actual: lateFeeDb,
        late_fee_nuevo: lateFeePersist,
        mora_extra_actual: round2(parseFloat(row.mora_extra) || 0),
        mora_extra_nueva: moraExtraPersist,
        mora_extra_desde_actual: ymdFromDbDate(row.mora_extra_desde),
        mora_extra_desde_nueva: moraExtraDesde,
        status_actual: row.status,
        status_nuevo: statusOut,
        due_date_actual: storedDueYmd,
        due_date_nueva: patchDue ? canonicalDueYmd : storedDueYmd,
      });
    } else {
      await query(
        patchDue
          ? `UPDATE module_miauto_cuota_semanal SET late_fee = $1, mora_extra = $5, mora_extra_desde = $6::date, mora_extra_total = $7, status = $4, due_date = $3::date, updated_at = CURRENT_TIMESTAMP WHERE id = $2`
          : `UPDATE module_miauto_cuota_semanal SET late_fee = $1, mora_extra = $4, mora_extra_desde = $5::date, mora_extra_total = $6, status = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        patchDue
          ? [lateFeePersist, row.id, canonicalDueYmd, statusOut, moraExtraPersist, moraExtraDesde, moraExtraTotalPersist]
          : [lateFeePersist, row.id, statusOut, moraExtraPersist, moraExtraDesde, moraExtraTotalPersist]
      );
    }
    if (lateFeePersist > 0.005) moraStats.conMoraNormal++;
    if (moraExtraPersist > 0.005) moraStats.conMoraExtra++;
    if (String(statusOut || '').toLowerCase() !== String(row.status || '').toLowerCase()) {
      moraStats.cambiosEstado++;
    }
    if (Math.abs(round2(lateFeePersist) - round2(lateFeeDb)) > 0.005) {
      moraStats.cambiosMoraNormal++;
    }
    updated++;
  }
  logger.info('miauto.mora.update', {
    solicitudId: solicitudId || null,
    singleCuotaId,
    includePartial,
    dryRun,
    includeExcelMora,
    updated,
    ...moraStats,
  });
  if (dryRun) {
    return {
      dryRun: true,
      updated,
      stats: {
        ...moraStats,
        includeExcelMora,
      },
      changes: dryRunChanges,
    };
  }
  return updated;
}

/**
 * Recalcula mora en BD para todas las cuotas vencidas (incl. parciales), para alinear conductores tras validar tarde, etc.
 */
export async function recalcularMoraGlobal() {
  const updated = await updateMoraDiaria(null, { includePartial: true, includeExcelMora: true });
  return { updated };
}

/**
 * Progreso de la racha actual de bono: cuotas pagadas, puntuales y con viajes mínimos.
 * La semana de depósito se excluye; una cuota no elegible reinicia solo la racha en curso.
 */
function calcularRacha(cuotas, fechaInicioCobroSemanal) {
  if (!Array.isArray(cuotas) || cuotas.length === 0) return 0;
  const porFechaAsc = ordenarCuotasSemanalesCronologico(cuotas);
  let racha = 0;
  for (const c of porFechaAsc) {
    if (isSemanaDepositoMiAuto(c.week_start_date, fechaInicioCobroSemanal)) continue;
    const pend = Number(c.pending_total) || 0;
    const ok = c.status === 'paid'
      && pend <= 0.005
      && c.pago_puntual === true
      && Number(c.num_viajes || 0) >= 120;
    if (!ok) {
      racha = 0;
      continue;
    }
    racha = (racha + 1) % 4;
  }
  return racha;
}

/**
 * Montos del cronograma (cuota bruta, bono, %, cobro saldo) — mismo criterio que el bloque inicial de `computeCuotaDerivedForRow`.
 * @param {boolean} isPrimera — debe coincidir con `options.isPrimeraCuotaSemanal` del derivado.
 * @param {boolean} [forzarMayorCuotaSinBono] — Hay mora abierta (`overdue`) en la solicitud: mayor cuota del cronograma y sin bono por viajes (no primera semana).
 * Exportada para scripts de auditoría / dry-run rent-sale.
 */
function resolveMontosPlanCuotaSemanalCore(
  r,
  cronograma,
  vehId,
  fi,
  isPrimera,
  sinViajesYango,
  forzarMayorCuotaSinBono = false
) {
  let cuota_semanal = round2(parseFloat(r.cuota_semanal) || 0);
  let bono_auto = round2(parseFloat(r.bono_auto) || 0);
  let pct_comision = round2(Number(parseFloat(r.pct_comision) || 0));
  let cobro_saldo = round2(parseFloat(r.cobro_saldo) || 0);
  let moneda = r.moneda === 'USD' ? 'USD' : 'PEN';

  if (String(r.montos_fuente || '').toLowerCase() === 'sistema') {
    /** La fila ya fue generada por CobroEngine con los montos correctos. */
    return {
      cuota_semanal,
      bono_auto: isPrimera ? 0 : bono_auto,
      pct_comision,
      cobro_saldo,
      moneda,
      usoCronogramaParaMontos: true,
    };
  }

  if (rowMontosFuenteExcel(r)) {
    return {
      cuota_semanal,
      bono_auto: isPrimera ? 0 : bono_auto,
      pct_comision,
      cobro_saldo,
      moneda,
      usoCronogramaParaMontos: true,
    };
  }

  const tripsEnFila = tripCountForRules(r.num_viajes);
  const nTrips = isPrimera ? 0 : sinViajesYango ? tripsEnFila ?? 0 : tripsEnFila;
  const vehicles = cronograma?.vehicles || [];
  const vehicleOk = vehId != null && vehicles.findIndex((v) => v.id === vehId) >= 0;

  if (forzarMayorCuotaSinBono && !isPrimera && vehicleOk && cronograma?.rules?.length) {
    const maxPlan = planFromCronogramaMayorCuotaPorVehiculo(cronograma, vehId);
    if (maxPlan) {
      return {
        cuota_semanal: maxPlan.cuotaSemanal,
        bono_auto: 0,
        pct_comision: maxPlan.pctComision,
        cobro_saldo: maxPlan.cobroSaldo,
        moneda: maxPlan.moneda,
        usoCronogramaParaMontos: true,
      };
    }
  }

  const ruleForTrips =
    cronograma?.rules?.length && nTrips != null ? getRuleForTripCount(cronograma.rules, nTrips) : null;

  const plan =
    cronograma?.rules?.length && vehicleOk && nTrips != null
      ? planFromCronograma(cronograma, vehId, nTrips)
      : null;

  let usoCronogramaParaMontos = false;

  if (plan) {
    usoCronogramaParaMontos = true;
    cuota_semanal = plan.cuotaSemanal;
    bono_auto = isPrimera ? 0 : plan.bonoAuto;
    pct_comision = plan.pctComision;
    cobro_saldo = plan.cobroSaldo;
    moneda = plan.moneda;
    const rowCs = round2(parseFloat(r.cuota_semanal) || 0);
    const planCs = round2(plan.cuotaSemanal);
    const pfRawRow = round2(parseFloat(r.partner_fees_raw) || 0);
    if (
      !isPrimera &&
      rowCs > 0.005 &&
      Math.abs(rowCs - planCs) > 0.05 &&
      (pfRawRow <= 0.02 || (!rowMontosFuenteExcel(r) && rowCs > planCs + 0.05))
    ) {
      cuota_semanal = rowCs;
    }
  } else if (cronograma?.rules?.length && vehicleOk) {
    moneda = getMonedaCuotaSemanalPorVehiculo(cronograma, vehId);
  }

  if (!plan && ruleForTrips) {
    usoCronogramaParaMontos = true;
    const pc = pctCobroFromRule(ruleForTrips);
    pct_comision = pc.pct_comision;
    cobro_saldo = pc.cobro_saldo;
    if (vehId != null && cronograma) moneda = getMonedaCuotaSemanalPorVehiculo(cronograma, vehId);
  }

  if (isPrimera) {
    bono_auto = 0;
  }

  return { cuota_semanal, bono_auto, pct_comision, cobro_saldo, moneda, usoCronogramaParaMontos };
}

/** Plan + mora para API (listados Yego Mi Auto). Depósito o semana Yango no cerrada (Lima) → sin viajes/fees en cálculo. */
function computeCuotaDerivedForRow(r, cronograma, vehId, options = {}) {
  const isPrimera = options.isPrimeraCuotaSemanal === true;
  const fi = options.fechaInicioCobroSemanal ?? r.fecha_inicio_cobro_semanal;
  const wsRow = ymdFromDbDate(r.week_start_date);
  const yangoSemanaCerrada = wsRow ? isWeekYangoClosedForMiAutoCuotaMetrics(wsRow, fi) : false;
  const tieneDatosDerived = (r.num_viajes != null && Number(r.num_viajes) > 0) || (r.partner_fees_raw != null && round2(parseFloat(r.partner_fees_raw) || 0) > 0.005);
  const sinViajesYango = isPrimera || (!yangoSemanaCerrada && !tieneDatosDerived);
  const rForFees = sinViajesYango && (r.partner_fees_raw == null || round2(parseFloat(r.partner_fees_raw) || 0) <= 0) ? { ...r, partner_fees_raw: 0, partner_fees_83: 0 } : r;

  let amount_due_remaining = round2(parseFloat(r.amount_due) || 0);
  let late_fee = round2(parseFloat(r.late_fee) || 0);
  let amount_due_sched = amount_due_remaining;

  const montosPlan = resolveMontosPlanCuotaSemanalCore(
    r,
    cronograma,
    vehId,
    fi,
    isPrimera,
    sinViajesYango,
    !!options.forzarMayorCuotaSinBono
  );
  let cuota_semanal = montosPlan.cuota_semanal;
  let bono_auto = montosPlan.bono_auto;
  let pct_comision = montosPlan.pct_comision;
  let cobro_saldo = montosPlan.cobro_saldo;
  let moneda = montosPlan.moneda;
  let usoCronogramaParaMontos = montosPlan.usoCronogramaParaMontos;

  const cerradaRaw = r.status === 'paid' || r.status === 'bonificada';
  const cerrada = options.ignoreClosedStatusForDerived ? false : cerradaRaw;
  const pf83 = sinViajesYango ? 0 : partnerFees83FromRow(rForFees);

  /** Mora teórica (para persistir en `late_fee` en BD). */
  let mora_full = round2(parseFloat(r.late_fee) || 0);
  let mOpen = null;

  if (cerrada && usoCronogramaParaMontos) {
    mOpen = amountDueAndLateForOpen(
      cronograma,
      rForFees,
      cuota_semanal,
      bono_auto,
      pct_comision,
      cobro_saldo,
      isPrimera,
      options.cascadeReceived,
      fi
    );
    mora_full = round2(mOpen.mora_full);
    amount_due_sched = round2(mOpen.amount_due_sched);
    /**
     * «Pagada» en BD no implica saldo 0: la fuente de verdad es el remanente tras imputar mora→cuota (`amountDueAndLateForOpen`),
     * no `paid < obligación` redondeada (evita colapsar 0,32¢ a «pagada» cuando la obligación total cuadra mal a 2 decimales).
     */
    const stLow = (r.status || '').toLowerCase();
    const saldoRemanenteOpen = round2(mOpen.amount_due_remaining + mOpen.late_fee_remaining);
    const underpaidEcon = stLow !== 'bonificada' && saldoRemanenteOpen > 0.005;
    if (underpaidEcon) {
      amount_due_remaining = round2(mOpen.amount_due_remaining);
      late_fee = round2(mOpen.late_fee_remaining);
    } else {
      amount_due_remaining = 0;
      late_fee = 0;
    }
  } else if (!cerrada) {
    mOpen = amountDueAndLateForOpen(
      cronograma,
      rForFees,
      cuota_semanal,
      bono_auto,
      pct_comision,
      cobro_saldo,
      isPrimera,
      options.cascadeReceived,
      fi
    );
    mora_full = round2(mOpen.mora_full);
    amount_due_sched = round2(mOpen.amount_due_sched);
    amount_due_remaining = mOpen.amount_due_remaining;
    late_fee = debeAplicarMoraCuotaSemanal(r.status)
      ? mOpen.late_fee_remaining
      : 0;
  }

  /**
   * Si `mOpen` nunca se asignó (p. ej. `paid` en BD pero sin tramo de plan → no entró a `cerrada && usoCronogramaParaMontos`),
   * los remanentes quedaban como `amount_due`/`late_fee` en BD y desfasados respecto a `obligacion_total − paid`.
   */
  if (!mOpen && cronograma && vehId != null) {
    mOpen = amountDueAndLateForOpen(
      cronograma,
      rForFees,
      cuota_semanal,
      bono_auto,
      pct_comision,
      cobro_saldo,
      isPrimera,
      options.cascadeReceived,
      fi
    );
    mora_full = round2(mOpen.mora_full);
    amount_due_sched = round2(mOpen.amount_due_sched);
    const stLow = (r.status || '').toLowerCase();
    const cerradaEff = stLow === 'paid' || stLow === 'bonificada';
    if (cerradaEff) {
      const saldoRemanenteOpen = round2(mOpen.amount_due_remaining + mOpen.late_fee_remaining);
      const underpaidEcon = stLow !== 'bonificada' && saldoRemanenteOpen > 0.005;
      if (underpaidEcon) {
        amount_due_remaining = round2(mOpen.amount_due_remaining);
        late_fee = round2(mOpen.late_fee_remaining);
      } else {
        amount_due_remaining = 0;
        late_fee = 0;
      }
    } else {
      amount_due_remaining = mOpen.amount_due_remaining;
      late_fee = debeAplicarMoraCuotaSemanal(r.status) ? mOpen.late_fee_remaining : 0;
    }
  }

  /**
   * Cuota del plan a pagar (sin mora): programada = PF + cobro saldo + regla comisión según `resolvedAmountDueSchedForOpenRow` / `amount_due_sched`.
   * No confundir con solo `cuota_semanal − PF` (faltaba restar/sumar cobro saldo).
   */
  const cuota_neta = mOpen
    ? round2(mOpen.amount_due_sched)
    : round2(
        resolvedAmountDueSchedForOpenRow(rForFees, cuota_semanal, bono_auto, pct_comision, cobro_saldo, isPrimera)
      );
  /** Tope de la deuda del periodo (cuota programada + mora generada + mora extra), sin descontar pagos — para cap de paid_amount / persist. */
  const moraExtraDb = round2(parseFloat(r.mora_extra) || 0);
  /** Mora extra derivada: si el early return la cubrió, es 0; si no, usar BD. */
  const moraExtraDerivada = mOpen ? round2(mOpen.mora_saldo_capital_pendiente || 0) : moraExtraDb;
  const obligacion_total = round2(
    (mOpen
      ? round2(
          mOpen.obligacion_total_open != null && Number.isFinite(Number(mOpen.obligacion_total_open))
            ? mOpen.obligacion_total_open
            : mOpen.amount_due_sched + mOpen.mora_full
        )
      : round2(amount_due_remaining + late_fee)) + moraExtraDerivada
  );
  /**
   * Saldo aún por cubrir del periodo: **mora pendiente + cuota pendiente + mora extra derivada** (misma imputación que el pago: primero mora, luego capital).
   * Si la mora queda cubierta, `late_fee` aquí es 0 y solo resta cuota.
   */
  const basePend = round2(amount_due_remaining + late_fee);
  const cuota_final = basePend <= 0.005 ? 0 : round2(basePend + moraExtraDerivada);
  return {
    cuota_semanal,
    /** Cuota del periodo: preferentemente columna `amount_due` de la fila (persistida al generar la semana). */
    amount_due_sched,
    /** Saldo pendiente de cuota (sin mora). */
    amount_due_remaining,
    late_fee,
    bono_auto,
    pct_comision,
    cobro_saldo,
    moneda,
    cuota_neta,
    cuota_final,
    obligacion_total,
    pf83,
    mora_full,
    /** Mora adicional sobre cuota neta pendiente cuando ya se cubrió la mora sobre cuota bruta y hubo abono a capital. */
    mora_saldo_capital_pendiente: mOpen ? round2(parseFloat(mOpen.mora_saldo_capital_pendiente) || 0) : 0,
    /** Interés devengado sobre cuota bruta (misma ventana de días). La mora sobre saldo de capital va en `mora_saldo_capital_pendiente`. */
    mora_sched_periodo: mOpen ? round2(parseFloat(mOpen.mora_sched) || 0) : 0,
  };
}

function parsePartnerFeesCascadaDestinoDb(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseMiautoJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function loadMoraHistoricaAplicadaPorCuota(solicitudId, { incluirPendientesAplicados = false } = {}) {
  const estadoSql = incluirPendientesAplicados
    ? `LOWER(COALESCE(NULLIF(TRIM(estado::text), ''), 'pendiente')) NOT IN ('rechazado', 'anulado')`
    : `LOWER(COALESCE(NULLIF(TRIM(estado::text), ''), 'pendiente')) = 'validado'`;
  const res = await query(
    `SELECT cuota_semanal_id::text AS cid, aplicacion_chunks
     FROM module_miauto_comprobante_cuota_semanal
     WHERE solicitud_id = $1::uuid
       AND ${estadoSql}
       AND aplicacion_chunks IS NOT NULL`,
    [solicitudId]
  );
  const normal = new Map();
  const extra = new Map();
  for (const row of res.rows || []) {
    const cid = String(row.cid);
    let moraBase = normal.get(cid) || 0;
    let moraExtraBase = extra.get(cid) || 0;
    for (const ch of parseMiautoJsonArray(row.aplicacion_chunks)) {
      if (String(ch?.cuota_semanal_id || '') !== cid) continue;
      moraBase = Math.max(moraBase, round2(Number(ch?.before?.late_fee) || 0));
      moraExtraBase = Math.max(
        moraExtraBase,
        round2(Number(ch?.before?.mora_extra) || 0),
        round2(Number(ch?.before?.mora_extra_total) || 0)
      );
    }
    if (moraBase > 0.005) normal.set(cid, round2(moraBase));
    if (moraExtraBase > 0.005) extra.set(cid, round2(moraExtraBase));
  }
  return { normal, extra };
}

/**
 * Mapa cuota_id → monto total recibido vía cascada PF desde otras cuotas (JSON en filas origen).
 * Útil para auditoría y para `amountDueAndLateForOpen`: primero `paid − cascada`, luego la cascada (mora→cuota).
 */
function buildCascadeReceivedMap(cuotaRows) {
  const map = new Map();
  for (const r of cuotaRows) {
    const entries = parsePartnerFeesCascadaDestinoDb(r.partner_fees_cascada_destino);
    for (const e of entries) {
      const id = String(e.cuota_semanal_id);
      map.set(id, round2((map.get(id) || 0) + (Number(e.monto) || 0)));
    }
  }
  return map;
}

function buildCascadeMoraHistoricaMap(cuotaRows) {
  const normal = new Map();
  const extra = new Map();
  for (const r of cuotaRows) {
    const entries = parsePartnerFeesCascadaDestinoDb(r.partner_fees_cascada_destino);
    for (const e of entries) {
      const id = String(e.cuota_semanal_id || '');
      if (!id) continue;
      const moraNormalBase = round2(Number(e.mora_normal_base) || 0);
      const moraExtraBase = round2(Number(e.mora_extra_base) || 0);
      if (moraNormalBase > 0.005) normal.set(id, round2(Math.max(normal.get(id) || 0, moraNormalBase)));
      if (moraExtraBase > 0.005) extra.set(id, round2(Math.max(extra.get(id) || 0, moraExtraBase)));
    }
  }
  return { normal, extra };
}

/**
 * Contexto para imputar comprobantes / pagos manuales con la misma lógica que la API (cuota_final, no solo columnas).
 */
export async function loadMiautoComprobanteDerivacionContext(solicitudId) {
  const solRes = await query(
    `SELECT id, cronograma_id, cronograma_vehiculo_id, fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1`,
    [solicitudId]
  );
  const sol = solRes.rows[0];
  if (!sol?.cronograma_id) return null;
  const cronograma = await getCronogramaById(sol.cronograma_id);
  const cascRes = await query(
    `SELECT id, partner_fees_cascada_destino FROM module_miauto_cuota_semanal WHERE solicitud_id = $1`,
    [solicitudId]
  );
  const cascadeMap = buildCascadeReceivedMap(cascRes.rows || []);
  const moraHistorica = await loadMoraHistoricaAplicadaPorCuota(solicitudId, {
    incluirPendientesAplicados: true,
  });
  const ovRes = await query(
    `SELECT EXISTS (
       SELECT 1
       FROM module_miauto_cuota_semanal
       WHERE solicitud_id = $1::uuid
         AND status = 'overdue'
         AND COALESCE(paid_amount, 0)::numeric < COALESCE(amount_due, 0)::numeric + COALESCE(late_fee, 0)::numeric + COALESCE(mora_extra, 0)::numeric - 0.005
     ) AS e`,
    [solicitudId]
  );
  const solicitudTieneCuotaOverdue = !!ovRes.rows?.[0]?.e;
  return {
    sol,
    cronograma,
    cascadeMap,
    solicitudTieneCuotaOverdue,
    moraNormalHistoricaAplicadaPorCuota: moraHistorica.normal,
    moraExtraHistoricaAplicadaPorCuota: moraHistorica.extra,
  };
}

function computeDerivedForComprobanteRow(cuotaRow, ctx) {
  if (!ctx) {
    if (excelPaidIgualCuotaSemanalIgnoraMora(cuotaRow)) {
      const sched = round2(parseFloat(cuotaRow.cuota_semanal) || 0);
      return { cuota_final: 0, obligacion_total: sched };
    }
    const paid = round2(parseFloat(cuotaRow.paid_amount) || 0);
    const ad = round2(parseFloat(cuotaRow.amount_due) || 0);
    const ws = ymdFromDbDate(cuotaRow.week_start_date);
    const fi = cuotaRow.fecha_inicio_cobro_semanal;
    const isPrimera = ws && fi ? isSemanaDepositoMiAuto(ws, fi) : false;
    const lf = isPrimera ? 0 : round2(parseFloat(cuotaRow.late_fee) || 0);
    return { cuota_final: Math.max(0, round2(ad + lf - paid)) };
  }
  const { sol, cronograma, cascadeMap } = ctx;
  const cascRecv = cascadeMap.get(String(cuotaRow.id)) || 0;
  const ws = ymdFromDbDate(cuotaRow.week_start_date);
  const isPrimera = ws ? isSemanaDepositoMiAuto(ws, sol.fecha_inicio_cobro_semanal) : false;
  const moraAbiertaOtrosPlanes = debeAplicarCuotaMaximaSinBonoPorMora(
    !!ctx?.solicitudTieneCuotaOverdue,
    isPrimera,
    cuotaRow.status
  );
  return computeCuotaDerivedForRow(cuotaRow, cronograma, sol.cronograma_vehiculo_id, {
    isPrimeraCuotaSemanal: isPrimera,
    fechaInicioCobroSemanal: sol.fecha_inicio_cobro_semanal,
    cascadeReceived: cascRecv,
    forzarMayorCuotaSinBono: moraAbiertaOtrosPlanes,
  });
}

/**
 * Piso por columnas BD: si `d.obligacion_total` subestima `amount_due`+`late_fee`, el pendiente no puede ser menor que
 * `amount_due`+`late_fee` − `paidRaw`. Misma regla que `buildCuotaSemanalApiRow` y necesaria para cascada de comprobantes.
 */
function aplicarPisoColumnasPendienteCuota(cuotaRow, d, pendienteEconPrePiso, isPrimeraCuotaSemanal = false, ctx = null) {
  if (excelPaidIgualCuotaSemanalIgnoraMora(cuotaRow)) {
    return round2(Math.max(0, pendienteEconPrePiso));
  }
  if (rowMontosFuenteExcel(cuotaRow)) {
    const cid = String(cuotaRow.id || '');
    const moraHist = ctx?.moraNormalHistoricaAplicadaPorCuota?.get?.(cid) || 0;
    const moraNormalBase = round2(Math.max(
      parseFloat(cuotaRow.late_fee) || 0,
      parseFloat(d?.mora_full) || 0,
      moraHist
    ));
    const moraExtraPendiente = round2(parseFloat(cuotaRow.mora_extra) || 0);
    // La mora extra se genera después de un abono. No puede ser absorbida por
    // `paid_amount` histórico: solo un pago posterior puede disminuirla.
    const saldoSinMoraExtra = distribuirPagoMoraPrimero({
      capital: parseFloat(cuotaRow.amount_due) || 0,
      moraNormal: moraNormalBase,
      moraExtra: 0,
      pagado: parseFloat(cuotaRow.paid_amount) || 0,
    }).total_pendiente;
    const saldoExcel = round2(saldoSinMoraExtra + moraExtraPendiente);
    return round2(Math.max(pendienteEconPrePiso, saldoExcel));
  }
  const obTot = d.obligacion_total;
  if (obTot == null || !Number.isFinite(Number(obTot))) return pendienteEconPrePiso;
  const paidRaw = round2(parseFloat(cuotaRow.paid_amount) || 0);
  const colAdRaw = round2(parseFloat(cuotaRow.amount_due) || 0);
  const schedD = round2(parseFloat(d.amount_due_sched) || 0);
  const csRow = round2(parseFloat(cuotaRow.cuota_semanal) || 0);
  /**
   * Si en BD `amount_due` quedó como **cuota bruta** (≈ `cuota_semanal`) al generar la semana antes de PF/cobro saldo,
   * pero el derivado ya trae la **cuota neta** (`amount_due_sched`), no usar 460 como piso: infla «Cuota a pagar» / pendiente.
   */
  let adParaPiso = colAdRaw;
  if (
    schedD > 0.005 &&
    colAdRaw > schedD + 0.05 &&
    csRow > 0.005 &&
    Math.abs(colAdRaw - csRow) <= 0.05
  ) {
    adParaPiso = schedD;
  }
  const obligacionColumnas = isPrimeraCuotaSemanal
    ? round2(adParaPiso)
    : round2(
        adParaPiso
        + round2(parseFloat(cuotaRow.late_fee) || 0)
        + round2(parseFloat(cuotaRow.mora_extra) || 0)
      );
  const pendientePorColumnas = round2(Math.max(0, obligacionColumnas - paidRaw));
  /**
   * Si `obligacion_total` del derivado queda por debajo de `amount_due`+`late_fee` (columnas), el pendiente no puede ser
   * menor que columnas − pagado. Margen 1¢: con −2¢ solo se corregían huecos ≥2¢; un desfase de exactamente 1¢
   * (p. ej. 170.31 vs 170.32) no aplicaba el piso y la UI mostraba «Pagada» con 0.01 faltante.
   */
  if (round2(obTot) <= round2(obligacionColumnas - 0.01)) {
    return round2(Math.max(pendienteEconPrePiso, pendientePorColumnas));
  }
  return pendienteEconPrePiso;
}

/** Saldo pendiente económico (`cuota_final`) alineado con el cronograma y mora derivada. */
export function miautoCuotaFinalDerivada(cuotaRow, ctx) {
  const d = computeDerivedForComprobanteRow(cuotaRow, ctx);
  const base = round2(Math.max(0, d.cuota_final));
  const ws = ymdFromDbDate(cuotaRow.week_start_date);
  const isPrimera = ws && ctx?.sol?.fecha_inicio_cobro_semanal
    ? isSemanaDepositoMiAuto(ws, ctx.sol.fecha_inicio_cobro_semanal)
    : false;
  return aplicarPisoColumnasPendienteCuota(cuotaRow, d, base, isPrimera, ctx);
}

/** Estado tras abonar `newPaid` según derivado (evita marcar pagada si solo cubre cuota en columnas y falta mora). */
export function miautoStatusCuotaTrasAbonoDerivado(cuotaRow, newPaid, ctx) {
  const row = { ...cuotaRow, paid_amount: newPaid };
  const d = computeDerivedForComprobanteRow(row, ctx);
  const ws = ymdFromDbDate(cuotaRow.week_start_date);
  const isPrimera = ws && ctx?.sol?.fecha_inicio_cobro_semanal
    ? isSemanaDepositoMiAuto(ws, ctx.sol.fecha_inicio_cobro_semanal)
    : false;
  const pend = aplicarPisoColumnasPendienteCuota(row, d, round2(Math.max(0, d.cuota_final)), isPrimera, ctx);
  const dueY = ymdFromDbDate(cuotaRow.due_date);
  return miAutoOpenStatusSaldoVencimiento(dueY, pend, newPaid);
}

/**
 * Fila **origen** de cascada de cobro por ingresos: imputó el pool a otras semanas y ya no tiene PF en columna.
 * En ese caso el `paid` en BD no debe cerrar la fila como «cuota pagada» si solo se descontó/reasignó el tributo:
 * la obligación se recalcula como cuota abierta (plan sin crédito PF en esta fila).
 */
function esOrigenCascadaCobroIngresosSinPfEnFila(r) {
  const dest = parsePartnerFeesCascadaDestinoDb(r.partner_fees_cascada_destino);
  if (!dest.length) return false;
  const raw = round2(parseFloat(r.partner_fees_raw) || 0);
  const p83 = round2(parseFloat(r.partner_fees_83) || 0);
  return raw <= 0.02 && p83 <= 0.02;
}

function buildCuotaSemanalApiRow(r, cronograma, vehId, options = {}) {
  const isPrimera = options.isPrimeraCuotaSemanal === true;
  const fi = options.fechaInicioCobroSemanal ?? r.fecha_inicio_cobro_semanal;
  const wsR = ymdFromDbDate(r.week_start_date);
  const yangoCerrada = wsR ? isWeekYangoClosedForMiAutoCuotaMetrics(wsR, fi) : false;
  // Si la BD ya tiene datos reales (viajes o PF), usarlos aunque la semana no haya cerrado
  const tieneDatosReales = (r.num_viajes != null && Number(r.num_viajes) > 0) || (r.partner_fees_raw != null && round2(parseFloat(r.partner_fees_raw) || 0) > 0.005);
  const sinViajesYango = isPrimera || (!yangoCerrada && !tieneDatosReales);
  const st = (r.status || '').toLowerCase();
  const ignoreClosedForDerived = st === 'paid' && esOrigenCascadaCobroIngresosSinPfEnFila(r);
  if (rowMontosFuenteExcel(r)) {
    const paidAmountExcel = round2(parseFloat(r.paid_amount) || 0);
    const amountDueExcel = round2(parseFloat(r.amount_due) || 0);
    const lateFeeDbExcel = round2(parseFloat(r.late_fee) || 0);
    const moraExtraDbExcel = round2(Math.max(parseFloat(r.mora_extra_total) || 0, parseFloat(r.mora_extra) || 0));
    const moraNormalHistoricaExcel = round2(Number(options.moraNormalHistoricaAplicada) || 0);
    const moraExtraHistoricaExcel = round2(Number(options.moraExtraHistoricaAplicada) || 0);
    const tieneMoraHistoricaExcel = moraNormalHistoricaExcel > 0.005 || moraExtraHistoricaExcel > 0.005;
    const dueY = ymdFromDbDate(r.due_date);
    const excelPagadaSinMora = st === 'paid'
      && lateFeeDbExcel <= 0.005
      && moraExtraDbExcel <= 0.005
      && !tieneMoraHistoricaExcel
      && paidAmountExcel >= amountDueExcel - 0.005;
    const ignorarMoraExcelPagada = excelPagadaSinMora || (
      lateFeeDbExcel <= 0.005
      && moraExtraDbExcel <= 0.005
      && !tieneMoraHistoricaExcel
      && excelPaidIgualCuotaSemanalIgnoraMora(r)
    );
    const moraCaseExcel = ignorarMoraExcelPagada
      ? null
      : classifyMoraCuotaSemanalCase({
          row: r,
          cronograma,
          vehId,
          isPrimera,
          dueEffYmd: dueY,
          hermanas: options.hermanasForMora || [r],
          comprobanteAbonoYmd: null,
        });
    const moraNormalBaseExcel = st === 'bonificada' || ignorarMoraExcelPagada
      ? 0
      : st === 'paid' && lateFeeDbExcel > 0.005
        ? lateFeeDbExcel
      : round2(Math.max(
          Number(moraCaseExcel?.lateFee) || 0,
          moraNormalHistoricaExcel
        ));
    const moraExtraPendienteDbExcel = st === 'bonificada' || ignorarMoraExcelPagada
      ? 0
      : round2(parseFloat(r.mora_extra) || 0);
    const moraExtraBaseExcel = st === 'bonificada' || ignorarMoraExcelPagada
      ? 0
      : round2(Math.max(
          parseFloat(r.mora_extra_total) || 0,
          moraExtraPendienteDbExcel,
          moraExtraHistoricaExcel
        ));
    /*
     * En cuotas Excel con abono parcial, la mora extra suele nacer DESPUES del abono
     * (`mora_extra_desde`). No debe consumirse con el mismo `paid_amount` histórico,
     * porque ese pago solo podía cubrir la mora normal vigente y luego capital.
     * La BD ya guarda `mora_extra` como saldo pendiente y `mora_extra_total` como histórico.
     */
    const imputacionExcel = ignorarMoraExcelPagada
      ? {
          mora_normal_pendiente: 0,
          mora_extra_pendiente: 0,
          capital_pendiente: 0,
          total_pendiente: 0,
        }
      : distribuirPagoMoraPrimero({
          capital: amountDueExcel,
          moraNormal: moraNormalBaseExcel,
          moraExtra: 0,
          pagado: paidAmountExcel,
        });
    const lateFeeExcel = st === 'bonificada' ? 0 : imputacionExcel.mora_normal_pendiente;
    const moraExtraExcel = st === 'bonificada' ? 0 : moraExtraPendienteDbExcel;
    const moraExtraTotalExcel = st === 'bonificada'
      ? 0
      : round2(Math.max(moraExtraBaseExcel, moraExtraExcel));
    const pendingExcel = imputacionExcel.capital_pendiente;
    const pendingTotalExcel = round2(imputacionExcel.mora_normal_pendiente + moraExtraExcel + pendingExcel);
    const statusExcel = st === 'bonificada'
      ? 'bonificada'
      : miAutoOpenStatusSaldoVencimiento(dueY, pendingTotalExcel, paidAmountExcel);
    const monedaExcel = String(r.moneda || 'PEN').toUpperCase();
    const creditoPend = round2(Math.max(0, Number(options.creditoComprobantePendienteMonedaCuota) || 0));
    const lateFeeCalendarDaysExcel =
      pendingTotalExcel <= 0.005 || statusExcel === 'bonificada'
        ? 0
        : calendarDaysLateLima(ymdFromDbDate(r.mora_desde) || moraCaseExcel?.fechaMora || dueY);

    return {
      id: r.id,
      solicitud_id: r.solicitud_id,
      montos_fuente: 'excel',
      week_start_date: r.week_start_date,
      due_date: r.due_date,
      num_viajes: r.num_viajes ?? 0,
      bono_auto: round2(parseFloat(r.bono_auto) || 0),
      cuota_semanal: round2(parseFloat(r.cuota_semanal) || amountDueExcel),
      amount_due: amountDueExcel,
      paid_amount: paidAmountExcel,
      pago_puntual: r.pago_puntual === true,
      comprobante_en_revision_monto: creditoPend > 0.005 ? round2(Math.min(creditoPend, pendingTotalExcel)) : 0,
      late_fee: lateFeeExcel,
      mora_pendiente: lateFeeExcel,
      late_fee_calendar_days: lateFeeCalendarDaysExcel,
      mora_interes_periodo: moraNormalBaseExcel,
      mora_acumulada: moraNormalBaseExcel,
      mora_extra: moraExtraExcel,
      mora_extra_total: moraExtraTotalExcel,
      mora_extra_cobrada: round2(Math.max(0, moraExtraTotalExcel - moraExtraExcel)),
      mora_extra_desde: ymdFromDbDate(r.mora_extra_desde),
      status: statusExcel,
      moneda: monedaExcel,
      pct_comision: round2(parseFloat(r.pct_comision) || 0),
      cobro_saldo: round2(parseFloat(r.cobro_saldo) || 0),
      cobro_saldo_regla: round2(parseFloat(r.cobro_saldo) || 0),
      cobro_desde_saldo_conductor: round2(parseFloat(r.cobro_desde_saldo_conductor) || 0),
      fecha_ultimo_abono: ymdFromDbDate(r.fecha_ultimo_abono),
      fecha_primer_comprobante: ymdFromDbDate(r.fecha_primer_comprobante),
      partner_fees_raw: round2(parseFloat(r.partner_fees_raw) || 0),
      partner_fees_83: round2(parseFloat(r.partner_fees_83) || 0),
      partner_fees_yango_raw: r.partner_fees_yango_raw != null ? round2(parseFloat(r.partner_fees_yango_raw) || 0) : null,
      partner_fees_yango_83: r.partner_fees_yango_raw != null ? round2((parseFloat(r.partner_fees_yango_raw) || 0) * PARTNER_FEES_PCT) : 0,
      partner_fees_cascada_aplicado_a: cascadaDestinoExcluirCuotaOrigen(
        parsePartnerFeesCascadaDestinoDb(r.partner_fees_cascada_destino),
        r.id
      ),
      cobro_saldo_referencia: parsePartnerFeesCascadaDestinoDb(r.cobro_saldo_referencia),
      saldo_favor_conductor: round2(parseFloat(r.saldo_favor_conductor) || 0),
      cuota_neta: amountDueExcel,
      cuota_pendiente: pendingExcel,
      cuota_final: pendingTotalExcel,
      pending_total: pendingTotalExcel,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
  const derivedOpts = {
    isPrimeraCuotaSemanal: isPrimera,
    fechaInicioCobroSemanal: fi,
    ignoreClosedStatusForDerived: ignoreClosedForDerived,
    cascadeReceived: options.cascadeReceived,
    forzarMayorCuotaSinBono: options.forzarMayorCuotaSinBono === true,
  };
  const d0 = computeCuotaDerivedForRow(r, cronograma, vehId, derivedOpts);
  let paid_amount = round2(parseFloat(r.paid_amount) || 0);
  /** Pago real en BD antes del cap API; para cotejar con `amount_due`+`late_fee` cuando el derivado subestima la obligación. */
  const filaCerrada = (st === 'paid' || st === 'bonificada') && !ignoreClosedForDerived;
  /**
   * Solo en **pagada/bonificada**: acotar `paid_amount` API a la obligación del periodo derivada.
   * En **vencida / parcial / pendiente**: no recortar — la columna «Pagado» debe reflejar el abono real en BD aunque el derivado difiera.
   */
  const capPagadoApi =
    d0.obligacion_total > 0.005
      ? d0.obligacion_total
      : round2(parseFloat(r.amount_due) || 0)
        + round2(parseFloat(r.late_fee) || 0)
        + round2(parseFloat(r.mora_extra) || 0);
  if (filaCerrada && capPagadoApi > 0.005) {
    paid_amount = round2(Math.min(paid_amount, capPagadoApi));
  }
  /** Comprobante en revisión: solo congela mora y queda como evidencia; no descuenta cuota hasta validar/confirmar. */
  const creditoPend = round2(Math.max(0, Number(options.creditoComprobantePendienteMonedaCuota) || 0));
  const pendPreDerivado = round2(Math.max(0, d0.obligacion_total - paid_amount));
  const extraAbonoRevision = 0;
  const d =
    extraAbonoRevision > 0.005
      ? computeCuotaDerivedForRow(
          { ...r, paid_amount: round2(paid_amount + extraAbonoRevision) },
          cronograma,
          vehId,
          derivedOpts
        )
      : d0;
  let pendienteEcon = round2(Math.max(0, d.obligacion_total - paid_amount));
  pendienteEcon = aplicarPisoColumnasPendienteCuota(r, d, pendienteEcon, isPrimera);
  const filaCerradaEfectiva = filaCerrada && pendienteEcon <= 0.005;
  const cobroSaldoRegla = round2(parseFloat(r.cobro_saldo) || 0);
  const cobroDesdeFleet = round2(parseFloat(r.cobro_desde_saldo_conductor) || 0);
   const cobroSaldoApi = cobroSaldoRegla;
  /**
   * `amount_due` API: cuota del plan del periodo (programada), no el remanente.
   * `cuota_pendiente`: lo que falta de esa cuota tras abonos (mora se descuenta primero del pago).
   * `mora_pendiente` / `late_fee`: saldo mora pendiente; si hay atraso, el interés corre sobre capital cuota según cronograma.
   * `cuota_final` / `pending_total`: mora pendiente + cuota pendiente (≈ obligación − pagado); comprobante en revisión puede congelar mora mostrada.
   */
  let amountDueApi = rowMontosFuenteExcel(r) 
    ? round2(parseFloat(r.amount_due) || 0)
    : round2(d.amount_due_sched);
  const lateFeeColDb = round2(parseFloat(r.late_fee) || 0);
  const moraNormalHistoricaAplicada = round2(Math.max(0, Number(options.moraNormalHistoricaAplicada) || 0));
  const moraExtraHistoricaAplicada = round2(Math.max(
    Number(options.moraExtraHistoricaAplicada) || 0,
    Number(r.mora_extra_total) || 0,
    Number(r.mora_extra) || 0
  ));
  const moraSchedDer = round2(parseFloat(d.mora_sched_periodo) || 0);
  const moraSaldoCapitalDer = round2(parseFloat(d.mora_saldo_capital_pendiente) || 0);
  let moraExtraApiOut = round2(parseFloat(r.mora_extra) || 0);
  let moraExtraTotalApiOut = round2(parseFloat(r.mora_extra_total) || 0);
  /** Fila pagada: mostrar la mora persistida ya corregida. `bonificada`: sin mora. */
  const lateFeeHistoricaPagada =
    filaCerradaEfectiva && st !== 'bonificada'
      ? lateFeeColDb
      : round2(0);
  /** `mora_pendiente` / `late_fee` (fila abierta): saldo mora **pendiente** tras imputar pagos (mora primero). El devengo del periodo va en `mora_interes_periodo`. */
  let lateFeePendiente = filaCerradaEfectiva ? round2(0) : round2(d.late_fee);
  let lateFeeApi = filaCerradaEfectiva ? lateFeeHistoricaPagada : round2(lateFeePendiente);
  let moraInteresPeriodoApi = filaCerradaEfectiva
    ? st === 'bonificada'
      ? round2(0)
      : lateFeeHistoricaPagada
    : round2(moraSchedDer + moraSaldoCapitalDer);
  /** Comprobante en revisión: no mostrar mora teórica mayor que la persistida (el job no incrementa hasta validar/rechazar). */
  if (options.congelaMoraComprobantePendiente && !filaCerradaEfectiva) {
    const cap = lateFeeColDb;
    lateFeePendiente = round2(Math.min(lateFeePendiente, cap));
    moraInteresPeriodoApi = round2(Math.min(moraInteresPeriodoApi, cap));
    lateFeeApi = round2(lateFeePendiente);
  }
  const moraComputedStat = round2(d.late_fee);
  let saldoPendienteApi = filaCerradaEfectiva ? round2(0) : pendienteEcon;
  /** Con monto proyectado, `pendienteEcon` ya incorpora el abono; no restar solo `paid_amount` de BD. */
  if (!filaCerradaEfectiva && options.congelaMoraComprobantePendiente && extraAbonoRevision <= 0.005) {
    const obligFrozen = round2(d.obligacion_total - moraComputedStat + lateFeeColDb);
    saldoPendienteApi = round2(Math.max(0, obligFrozen - paid_amount));
  }
  /**
   * Sin saldo pendiente: no mostrar devengo/días de mora como si aún debiera (p. ej. «paid» económico con fila aún «abierta» en BD).
   */
  if (saldoPendienteApi <= 0.005) {
    moraInteresPeriodoApi = round2(0);
  }
  let moraPendienteApiOut = lateFeePendiente;
  let cuotaPendienteApiOut = filaCerradaEfectiva ? round2(0) : round2(Math.max(0, d.amount_due_remaining));
  if (!filaCerradaEfectiva && moraNormalHistoricaAplicada > lateFeeColDb + 0.005 && paid_amount > 0.005) {
    const moraBase = moraNormalHistoricaAplicada;
    const moraPendienteHist = round2(Math.max(0, moraBase - paid_amount));
    const pagoTrasMoraNormalHist = round2(Math.max(0, paid_amount - moraBase));
    const moraExtraPendienteHist = round2(Math.max(0, moraExtraHistoricaAplicada - pagoTrasMoraNormalHist));
    const pagoTrasMorasHist = round2(Math.max(0, pagoTrasMoraNormalHist - moraExtraHistoricaAplicada));
    const cuotaPendienteHist = round2(Math.max(0, d.amount_due_sched - pagoTrasMorasHist));
    lateFeePendiente = moraPendienteHist;
    lateFeeApi = moraPendienteHist;
    moraPendienteApiOut = moraPendienteHist;
    cuotaPendienteApiOut = cuotaPendienteHist;
    moraInteresPeriodoApi = moraBase;
    moraExtraApiOut = moraExtraPendienteHist;
    moraExtraTotalApiOut = round2(Math.max(moraExtraTotalApiOut, moraExtraHistoricaAplicada));
    saldoPendienteApi = round2(cuotaPendienteHist + moraPendienteHist + moraExtraPendienteHist);
  }
  const moraDesdeOrDue = ymdFromDbDate(r.mora_desde) || r.due_date;
  const lateFeeCalendarDays =
    saldoPendienteApi <= 0.005 ? 0 : filaCerradaEfectiva ? 0 : calendarDaysLateLima(moraDesdeOrDue);
  /** `cuota_final` = `pending_total` = saldo pendiente (no el monto pagado; evita confusión en UI). */
  const cuotaFinalApi = saldoPendienteApi;
  const pendingTotalApi = saldoPendienteApi;
  /** Si mora+cuota derivados no cierran con `pending_total`, re-imputar con mora_full + sched + paid (misma regla que cascada). */
  if (!filaCerradaEfectiva && !options.congelaMoraComprobantePendiente && pendingTotalApi > 0.005) {
    const sumParts = round2(moraPendienteApiOut + moraSaldoCapitalDer + cuotaPendienteApiOut);
    if (Math.abs(sumParts - pendingTotalApi) > 0.05) {
      const paidParaImputar = round2(paid_amount + extraAbonoRevision);
      const imp = imputacionMoraCuotaRemanenteFromPaid(paidParaImputar, d.mora_full, d.amount_due_sched);
      const sImp = round2(imp.late_fee_remaining + moraSaldoCapitalDer + imp.amount_due_remaining);
      if (Math.abs(sImp - pendingTotalApi) <= 0.12) {
        moraPendienteApiOut = imp.late_fee_remaining;
        cuotaPendienteApiOut = imp.amount_due_remaining;
        lateFeeApi = round2(moraPendienteApiOut);
      }
    }
  }
  let statusApi = r.status;
  /** Estado en API desde saldo derivado si la fila no está liquidada (`filaCerradaEfectiva`), no solo `status` en BD. */
  if (!filaCerradaEfectiva && st !== 'bonificada') {
    /** Pendiente según motor (`cuota_final`), no columnas `amount_due`+mora crudas. */
    let pendCols = round2(Math.max(0, d.cuota_final));
    if (options.congelaMoraComprobantePendiente && extraAbonoRevision <= 0.005) {
      pendCols = round2(Math.max(0, d.cuota_final - moraComputedStat + lateFeeColDb));
    }
    const pendStat = pendienteStatusCuotaAbiertaPostCorte(d, saldoPendienteApi, pendCols, {
      hasOlderBlockingDebt: !!options.hasOlderBlockingDebt,
    });
    const dueYStat = ymdFromDbDate(r.due_date);
    const paidEfectivoApi = round2(paid_amount + extraAbonoRevision);
    statusApi = miAutoOpenStatusSaldoVencimiento(dueYStat, pendStat, paidEfectivoApi);
  }
  // Solo cerrar si el saldo derivado completo (mora normal + mora extra + cuota) quedó cubierto.
  if (saldoPendienteApi <= 0.005 && round2(paid_amount) > 0.005) {
    statusApi = 'paid';
    amountDueApi = 0;
    lateFeeApi = 0;
  }
  const yangoRawCol =
    r.partner_fees_yango_raw != null && String(r.partner_fees_yango_raw).trim() !== ''
      ? round2(parseFloat(r.partner_fees_yango_raw) || 0)
      : null;
  const yangoRawPara83 =
    yangoRawCol != null && yangoRawCol > 0.005
      ? yangoRawCol
      : round2(parseFloat(r.partner_fees_raw) || 0);
  const partnerFeesYango83Api = sinViajesYango && (yangoRawPara83 == null || yangoRawPara83 <= 0.005) ? 0 : round2(yangoRawPara83 * PARTNER_FEES_PCT);
  const partnerFeesCascadaApi = sinViajesYango && (!r.partner_fees_cascada_destino || parsePartnerFeesCascadaDestinoDb(r.partner_fees_cascada_destino).length === 0)
    ? []
    : cascadaDestinoExcluirCuotaOrigen(
        parsePartnerFeesCascadaDestinoDb(r.partner_fees_cascada_destino),
        r.id
      );
  const tcOpt = options.tipoCambioUsd;
  const refUsdPen =
    d.moneda === 'USD' && tcOpt?.valorUsdALocal > 0
      ? {
          tipo_cambio_ref: {
            valor_usd_a_local: tcOpt.valorUsdALocal,
            moneda_local: tcOpt.monedaLocal,
          },
          /** Con `paid_amount` en USD: equivalente aproximado en moneda local Fleet (PEN/COP). */
          paid_amount_equivalente_moneda_local: round2(paid_amount * tcOpt.valorUsdALocal),
        }
      : {};
  return {
    id: r.id,
    solicitud_id: r.solicitud_id,
    montos_fuente: String(r.montos_fuente || 'sistema'),
    week_start_date: r.week_start_date,
    due_date: r.due_date,
    num_viajes: sinViajesYango && (r.num_viajes == null || Number(r.num_viajes) === 0) ? 0 : (r.num_viajes ?? 0),
    bono_auto: d.bono_auto,
    cuota_semanal: d.cuota_semanal,
    amount_due: amountDueApi,
    paid_amount,
    pago_puntual: r.pago_puntual === true,
    /** Monto declarado en comprobante pendiente; informativo, no descuenta cuota ni paid_amount. */
    comprobante_en_revision_monto: creditoPend > 0.005 ? round2(Math.min(creditoPend, pendPreDerivado)) : 0,
    late_fee: lateFeeApi,
    mora_pendiente: moraPendienteApiOut,
    late_fee_calendar_days: lateFeeCalendarDays,
    mora_interes_periodo: moraInteresPeriodoApi,
    /** Mora total devengada en este periodo (valor BD). Aunque ya esté pagada, muestra cuánto se acumuló. */
    mora_acumulada: round2(Math.max(round2(parseFloat(r.late_fee) || 0), moraNormalHistoricaAplicada)),
    /** Mora extra: acumulada sobre el pendiente cuando hay pagos parciales. Empieza en 0. */
    mora_extra: moraExtraApiOut,
    /** Total histórico de mora_extra generada (incluye la ya pagada/cristalizada). */
    mora_extra_total: moraExtraTotalApiOut,
    /** Mora extra que ya fue pagada/cristalizada (total − actual). */
    mora_extra_cobrada: round2(Math.max(0, moraExtraTotalApiOut - moraExtraApiOut)),
    mora_extra_desde: ymdFromDbDate(r.mora_extra_desde),
    status: statusApi,
    moneda: d.moneda,
    pct_comision: d.pct_comision,
    cobro_saldo: cobroSaldoApi,
     cobro_saldo_regla: cobroSaldoRegla,
     cobro_desde_saldo_conductor: round2(parseFloat(r.cobro_desde_saldo_conductor) || 0),
    /** Lima YYYY-MM-DD: último abono registrado en cuota (Fleet, validación, admin, cascada). Mora sobre saldo desde el día siguiente. */
    fecha_ultimo_abono: ymdFromDbDate(r.fecha_ultimo_abono),
    /** Primera subida de comprobante por el conductor (ancla si aún no hay `fecha_ultimo_abono`). */
    fecha_primer_comprobante: ymdFromDbDate(r.fecha_primer_comprobante),
    /** Tras cascada: remanente imputable a esta fila (0 si todo el pool fue a cuotas anteriores). */
    partner_fees_raw: sinViajesYango && (r.partner_fees_raw == null || round2(parseFloat(r.partner_fees_raw) || 0) <= 0) ? 0 : round2(parseFloat(r.partner_fees_raw) || 0),
    /** 83,33% del `partner_fees_raw` de la fila (coherente con cuota neta / Fleet). */
    partner_fees_83: d.pf83,
    /** Monto bruto reportado por Yango para esta semana (auditoría; puede ser > 0 aunque `partner_fees_raw` sea 0). */
    partner_fees_yango_raw: sinViajesYango && yangoRawCol == null ? null : yangoRawCol,
    /** 83,33% sobre `partner_fees_yango_raw` (o sobre raw si aún no hay columna yango). */
    partner_fees_yango_83: partnerFeesYango83Api,
    /** Imputación del pool PF+comisión a otras filas: `{ cuota_semanal_id, week_start_date, monto }[]`. */
    partner_fees_cascada_aplicado_a: partnerFeesCascadaApi,
    /** Referencia de cobro de saldo aplicado a otras cuotas: [{ semana, week_start_date, monto }] */
    cobro_saldo_referencia: parsePartnerFeesCascadaDestinoDb(r.cobro_saldo_referencia),
    /** Saldo a favor del conductor: excedente del cobro por ingresos que cubre la cuota completa. El operario debe pagárselo. */
    saldo_favor_conductor: round2(parseFloat(r.saldo_favor_conductor) || 0),
    cuota_neta: d.cuota_neta,
    /** Remanente del capital cuota (plan) tras imputar pagos con regla mora → cuota. */
    cuota_pendiente: cuotaPendienteApiOut,
    cuota_final: cuotaFinalApi,
    /** Saldo pendiente de cuota + mora. */
    pending_total: pendingTotalApi,
    ...refUsdPen,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Recorta paid_amount si supera la obligación del periodo (`obligacion_total`) tras cambio de tramo de viajes (tras updateMoraDiaria).
 * @param {string} solicitudId
 * @param {{ onlyCapDueBeforeYmd?: string }} [options] Si `onlyCapDueBeforeYmd` es `YYYY-MM-DD`, solo se ajustan filas con `due_date` estrictamente anterior (no toca >= esa fecha; p. ej. carga Excel pre-corte).
 */
export async function persistPaidAmountCapsForSolicitud(solicitudId, options = {}) {
  const capCutoff = options.onlyCapDueBeforeYmd;
  const capCutoffOk = capCutoff && /^\d{4}-\d{2}-\d{2}$/.test(String(capCutoff).trim().slice(0, 10));
  const capCutNorm = capCutoffOk ? String(capCutoff).trim().slice(0, 10) : null;

  const solRes = await query(
    'SELECT cronograma_id, cronograma_vehiculo_id, fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1',
    [solicitudId]
  );
  const solRow = solRes.rows[0];
  if (!solRow?.cronograma_id) return 0;

  const cronograma = await getCronogramaById(solRow.cronograma_id);
  const vehId = solRow.cronograma_vehiculo_id;

  const res = await query(
    `SELECT id, solicitud_id, week_start_date, due_date, num_viajes, bono_auto, cuota_semanal, amount_due, paid_amount, pago_puntual, late_fee, status, moneda, pct_comision, cobro_saldo,
            partner_fees_raw, partner_fees_83, partner_fees_cascada_destino,
            fecha_ultimo_abono, fecha_primer_comprobante, montos_fuente, cobro_desde_saldo_conductor,
            mora_extra, mora_extra_desde, created_at, updated_at
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1 ORDER BY due_date ASC`,
    [solicitudId]
  );

  const rowsAll = res.rows || [];
  const tieneCuotaOverdueSol = rowsAll.some((x) => String(x.status || '').toLowerCase() === 'overdue' && cuotaTieneSaldoPendienteColumnas(x));
  const fiRaw = solRow.fecha_inicio_cobro_semanal;
  const todayYBlocking = limaTodayYmdSync();
  const cascRecvMap = buildCascadeReceivedMap(rowsAll);

  let updated = 0;
  let realignedOrigenCascada = false;
  for (const r of rowsAll) {
    const st = (r.status || '').toLowerCase();
    if (st === 'bonificada') continue;

    if (capCutNorm) {
      const dueY = ymdFromDbDate(r.due_date);
      if (!dueY || dueY >= capCutNorm) continue;
    }

    const w = ymdFromDbDate(r.week_start_date);
    const isPrimera = w ? isSemanaDepositoMiAuto(w, fiRaw) : false;
    const forzarBonifPersist = debeAplicarCuotaMaximaSinBonoPorMora(tieneCuotaOverdueSol, isPrimera, r.status);
    const d = computeCuotaDerivedForRow(r, cronograma, vehId, {
      isPrimeraCuotaSemanal: isPrimera,
      fechaInicioCobroSemanal: fiRaw,
      cascadeReceived: cascRecvMap.get(String(r.id)) || 0,
      forzarMayorCuotaSinBono: forzarBonifPersist,
    });
    const paidDb = round2(parseFloat(r.paid_amount) || 0);
    const rawOblig = d.obligacion_total;
    /** Igual que `buildCuotaSemanalApiRow`: si la obligación derivada ~0, usar fila BD para no borrar abonos al abrir cuotas. */
    const cap =
      rawOblig > 0.005
        ? rawOblig
        : round2(parseFloat(r.amount_due) || 0)
          + round2(parseFloat(r.late_fee) || 0)
          + round2(parseFloat(r.mora_extra) || 0);
    if (cap <= 0.005 && paidDb > 0.005) continue;
    if (paidDb <= cap + 0.005) continue;

    const paidNew = round2(Math.min(paidDb, cap));
    const pendCap = round2(Math.max(0, cap - paidNew));
    let statusOut = miAutoOpenStatusSaldoVencimiento(ymdFromDbDate(r.due_date), pendCap, paidNew);
    if (cap <= 0.005 && paidNew <= 0.005) {
      statusOut = 'pending';
    }

    await query(
      `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [paidNew, statusOut, r.id]
    );
    // Registrar ajuste de paid_amount para trazabilidad
    try {
      await query(
        `INSERT INTO module_miauto_paid_adjustment_log (cuota_semanal_id, solicitud_id, paid_amount_antes, paid_amount_despues, motivo)
         VALUES ($1, $2, $3, $4, 'cap_por_cambio_obligacion_derivada')`,
        [r.id, solicitudId, paidDb, paidNew]
      );
    } catch {}
    await touchFechaUltimoAbonoCuota(r.id, paidDb, paidNew);
    updated++;
  }

  /** Origen de cascada con PF en 0: no dejar `paid` en BD si la obligación abierta aún tiene saldo (p. ej. abono mal imputado al descontar solo el cobro por ingresos). */
  for (const r of rowsAll) {
    const st = (r.status || '').toLowerCase();
    if (st !== 'paid' || !esOrigenCascadaCobroIngresosSinPfEnFila(r)) continue;

    if (capCutNorm) {
      const dueY = ymdFromDbDate(r.due_date);
      if (!dueY || dueY >= capCutNorm) continue;
    }

    const w = ymdFromDbDate(r.week_start_date);
    const isPrimera = w ? isSemanaDepositoMiAuto(w, fiRaw) : false;
    const dueR = ymdFromDbDate(r.due_date);
    const hasOlderBlockingDebt = rowsAll.some((o) => {
      if (String(o.id) === String(r.id)) return false;
      const wO = ymdFromDbDate(o.week_start_date);
      const isPO = wO ? isSemanaDepositoMiAuto(wO, fiRaw) : false;
      const forzarH = debeAplicarCuotaMaximaSinBonoPorMora(tieneCuotaOverdueSol, isPO, o.status);
      const dH = computeCuotaDerivedForRow(o, cronograma, vehId, {
        isPrimeraCuotaSemanal: !!isPO,
        fechaInicioCobroSemanal: fiRaw,
        cascadeReceived: cascRecvMap.get(String(o.id)) || 0,
        forzarMayorCuotaSinBono: forzarH,
      });
      return cuotaHermanaBloqueaPorDeudaMasAntigua(o, dueR, todayYBlocking, {
        pendienteEconomico: round2(Math.max(0, dH.cuota_final)),
      });
    });
    const dOpen = computeCuotaDerivedForRow(r, cronograma, vehId, {
      isPrimeraCuotaSemanal: isPrimera,
      fechaInicioCobroSemanal: fiRaw,
      ignoreClosedStatusForDerived: true,
      cascadeReceived: cascRecvMap.get(String(r.id)) || 0,
    });
    const paidDb = round2(parseFloat(r.paid_amount) || 0);
    const pendDerived = round2(Math.max(0, dOpen.obligacion_total - paidDb));
    const pendCols = round2(Math.max(0, dOpen.cuota_final));
    const pendStat = pendienteStatusCuotaAbiertaPostCorte(dOpen, pendDerived, pendCols, { hasOlderBlockingDebt });
    const statusRe = miAutoOpenStatusSaldoVencimiento(ymdFromDbDate(r.due_date), pendStat, paidDb);
    if (statusRe === 'paid') continue;

    await query(
      `UPDATE module_miauto_cuota_semanal SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [statusRe, r.id]
    );
    updated++;
    realignedOrigenCascada = true;
  }
  if (realignedOrigenCascada) {
    await updateMoraDiaria(solicitudId, { includePartial: true, includeExcelMora: true });
  }
  if (updated > 0) {
    logger.info('miauto.cuota.cap_status_realign', {
      solicitudId,
      updated,
      realignedOrigenCascada,
    });
  }
  return updated;
}

/**
 * Cuotas API + bonificadas desde solicitud (un solo SELECT a `module_miauto_solicitud`).
 * No ejecuta `updateMoraDiaria` ni `persistPaidAmountCapsForSolicitud` aquí: en cada GET ralentizaban mucho la vista
 * (recalcular mora y posibles UPDATE por fila). La UI usa `buildCuotaSemanalApiRow` / derivados con los datos actuales;
 * mora persistida y topes de pagado siguen actualizándose por job, POST recalcular-mora, y tras mutaciones (validar comprobante, etc.).
 * @param {{ incluirAbonoComprobantePendiente?: boolean }} [options] Si true (vista staff/admin), resta en UI el monto de comprobantes sin validar; el conductor no debe verlo hasta validación.
 * @returns {{ cuotas: object[], bonificadas_db: number }}
 */
async function fetchCuotasSemanalesPayload(solicitudId, options = {}) {
  const incluirAbonoPendiente = options.incluirAbonoComprobantePendiente === true;
  const solRes = await query(
    `SELECT cronograma_id, cronograma_vehiculo_id, fecha_inicio_cobro_semanal, country,
            COALESCE(cuotas_semanales_bonificadas, 0)::int AS cuotas_semanales_bonificadas
     FROM module_miauto_solicitud WHERE id = $1`,
    [solicitudId]
  );
  const solRow = solRes.rows[0];
  if (!solRow) {
    return { cuotas: [], bonificadas_db: 0 };
  }
  const cronograma =
    solRow.cronograma_id != null ? await getCronogramaById(solRow.cronograma_id) : null;
  const countrySol = String(solRow.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
  const tipoCambioUsd = await tipoCambioUsdALocalEfectivo(countrySol);

  const res = await query(
    `SELECT id, solicitud_id, week_start_date, due_date, num_viajes, bono_auto, cuota_semanal, amount_due, paid_amount, pago_puntual, late_fee, status, moneda, pct_comision, cobro_saldo,
            partner_fees_raw, partner_fees_83, partner_fees_yango_raw, partner_fees_cascada_destino,
            fecha_ultimo_abono, fecha_primer_comprobante, montos_fuente, cobro_desde_saldo_conductor,
            saldo_favor_conductor, mora_desde, mora_extra, mora_extra_desde, mora_extra_total, cobro_saldo_referencia, created_at, updated_at
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1 AND deleted_at IS NULL
     ORDER BY week_start_date ASC NULLS LAST, due_date ASC NULLS LAST, id ASC`,
    [solicitudId]
  );
  const vehId = solRow.cronograma_vehiculo_id;
  const fiRaw = solRow.fecha_inicio_cobro_semanal;
  const bonificadas_db = parseInt(solRow.cuotas_semanales_bonificadas, 10) || 0;

  const rows = res.rows || [];
  const tieneCuotaVencidaGlobal = rows.some((row) => String(row.status || '').toLowerCase() === 'overdue' && cuotaTieneSaldoPendienteColumnas(row));
  let pendingComprobanteCuotaIds = new Set();
  /** Suma de montos declarados en comprobantes sin validar (moneda de la fila de cuota), para mostrar saldo pendiente. */
  const creditoComprobantePendientePorCuota = new Map();
  const moraNormalHistoricaAplicadaPorCuota = new Map();
  const moraExtraHistoricaAplicadaPorCuota = new Map();
  if (rows.length > 0) {
    const freezeRes = await query(
      `SELECT DISTINCT cuota_semanal_id::text AS cid
       FROM module_miauto_comprobante_cuota_semanal
       WHERE solicitud_id = $1::uuid
         AND validated_at IS NULL
         AND LOWER(COALESCE(NULLIF(TRIM(estado::text), ''), 'pendiente')) = 'pendiente'`,
      [solicitudId]
    );
    pendingComprobanteCuotaIds = new Set((freezeRes.rows || []).map((x) => String(x.cid)));
    const pendRes = await query(
      `SELECT cuota_semanal_id::text AS cid, monto, moneda,
              COALESCE(origen, 'conductor') AS origen
       FROM module_miauto_comprobante_cuota_semanal
       WHERE solicitud_id = $1::uuid
         AND validated_at IS NULL
         AND LOWER(COALESCE(NULLIF(TRIM(estado::text), ''), 'pendiente')) = 'pendiente'`,
      [solicitudId]
    );
    const pendRows = pendRes.rows || [];
    if (incluirAbonoPendiente) {
      const byCuota = new Map();
      for (const pr of pendRows) {
        const o = (pr.origen || 'conductor').toLowerCase();
        if (o === 'admin_confirmacion' || o === 'pago_manual') continue;
        const m = pr.monto;
        if (m == null || String(m).trim() === '' || Number.isNaN(parseFloat(m))) continue;
        const cid = String(pr.cid);
        if (!byCuota.has(cid)) byCuota.set(cid, []);
        byCuota.get(cid).push({ monto: parseFloat(m), moneda: pr.moneda });
      }
      for (const [cid, lista] of byCuota) {
        const rowCuota = rows.find((x) => String(x.id) === cid);
        if (!rowCuota) continue;
        let sum = 0;
        for (const { monto, moneda } of lista) {
          const c = await montoComprobanteCuotaALaMonedaFila(solicitudId, monto, moneda, rowCuota.moneda);
          sum = round2(sum + c);
        }
        if (sum > 0.005) creditoComprobantePendientePorCuota.set(cid, sum);
      }
    }
    const moraHistorica = await loadMoraHistoricaAplicadaPorCuota(solicitudId, {
      incluirPendientesAplicados: true,
    });
    for (const [cid, monto] of moraHistorica.normal) {
      moraNormalHistoricaAplicadaPorCuota.set(cid, monto);
    }
    for (const [cid, monto] of moraHistorica.extra) {
      moraExtraHistoricaAplicadaPorCuota.set(cid, monto);
    }
  }
  const todayYBlocking = limaTodayYmdSync();
  const cascRecvMap = buildCascadeReceivedMap(rows);
  const cascMoraHistoricaMap = buildCascadeMoraHistoricaMap(rows);
  const cuotas = [];
  for (const r of rows) {
    const w = ymdFromDbDate(r.week_start_date);
    const isPrimera = w ? isSemanaDepositoMiAuto(w, fiRaw) : false;
    const rNorm = await cuotaRowWithPartnerFeesUsdNormalizedIfNeeded(solicitudId, r);
    const forzarBonifPorCuotaOverdueGlobal = debeAplicarCuotaMaximaSinBonoPorMora(
      tieneCuotaVencidaGlobal,
      isPrimera,
      rNorm.status
    );
    const dueR = ymdFromDbDate(rNorm.due_date);
    const hasOlderBlockingDebt = rows.some((o) => {
      if (String(o.id) === String(rNorm.id)) return false;
      const wO = ymdFromDbDate(o.week_start_date);
      const isPO = wO ? isSemanaDepositoMiAuto(wO, fiRaw) : false;
      const forzarHermana = debeAplicarCuotaMaximaSinBonoPorMora(tieneCuotaVencidaGlobal, isPO, o.status);
      const dH = computeCuotaDerivedForRow(o, cronograma, vehId, {
        isPrimeraCuotaSemanal: !!isPO,
        fechaInicioCobroSemanal: fiRaw,
        cascadeReceived: cascRecvMap.get(String(o.id)) || 0,
        forzarMayorCuotaSinBono: forzarHermana,
      });
      return cuotaHermanaBloqueaPorDeudaMasAntigua(o, dueR, todayYBlocking, {
        pendienteEconomico: round2(Math.max(0, dH.cuota_final)),
      });
    });
    cuotas.push(
      buildCuotaSemanalApiRow(rNorm, cronograma, vehId, {
        isPrimeraCuotaSemanal: isPrimera,
        fechaInicioCobroSemanal: fiRaw,
        tipoCambioUsd,
        hasOlderBlockingDebt,
        cascadeReceived: cascRecvMap.get(String(rNorm.id)) || 0,
        congelaMoraComprobantePendiente: pendingComprobanteCuotaIds.has(String(rNorm.id)),
        creditoComprobantePendienteMonedaCuota: creditoComprobantePendientePorCuota.get(String(rNorm.id)) || 0,
        moraNormalHistoricaAplicada: Math.max(
          moraNormalHistoricaAplicadaPorCuota.get(String(rNorm.id)) || 0,
          cascMoraHistoricaMap.normal.get(String(rNorm.id)) || 0
        ),
        moraExtraHistoricaAplicada: Math.max(
          moraExtraHistoricaAplicadaPorCuota.get(String(rNorm.id)) || 0,
          cascMoraHistoricaMap.extra.get(String(rNorm.id)) || 0
        ),
        hermanasForMora: rows,
        forzarMayorCuotaSinBono: forzarBonifPorCuotaOverdueGlobal,
      })
    );
  }
  return { cuotas, bonificadas_db, fecha_inicio_cobro_semanal: fiRaw };
}

/**
 * Mapa `cuota_id` → `pending_total` (misma regla que la API / `buildCuotaSemanalApiRow`).
 * @param {string} solicitudId
 * @returns {Promise<Map<string, number>>}
 */
export async function buildPendingTotalMapForSolicitud(solicitudId) {
  const { cuotas } = await fetchCuotasSemanalesPayload(String(solicitudId), {
    incluirAbonoComprobantePendiente: false,
  });
  const m = new Map();
  for (const c of cuotas || []) {
    m.set(String(c.id), round2(Number(c.pending_total) || 0));
  }
  return m;
}

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

/**
 * Cuotas + racha + bonificadas.
 * @param {{ incluirAbonoComprobantePendiente?: boolean }} [options] Solo staff/admin: proyectar abono de comprobantes en revisión en `cuota_final` / `pending_total`.
 */
export async function getCuotasSemanalesConRacha(solicitudId, options = {}) {
  const { cuotas, bonificadas_db: fromDb, fecha_inicio_cobro_semanal } = await fetchCuotasSemanalesPayload(solicitudId, options);
  const racha = calcularRacha(cuotas, fecha_inicio_cobro_semanal);
  const fromCuotas = (cuotas || []).filter((c) => c.status === 'bonificada').length;
  const cuotasSemanalesBonificadas = Math.max(fromDb, fromCuotas);
  const totalCuotasCargadas = (cuotas || []).length;
  return { data: cuotas, racha, cuotas_semanales_bonificadas: cuotasSemanalesBonificadas, total_cuotas_cargadas: totalCuotasCargadas };
}

/**
 * Recalcula y persiste en BD `pct_comision`, `cobro_saldo`, `cuota_semanal`, `bono_auto`, `moneda`, `partner_fees_83`
 * y `amount_due` según el cronograma actual y los `num_viajes` / `partner_fees_raw` ya guardados en cada fila.
 * La primera cuota semanal (lunes de la semana de `fecha_inicio_cobro_semanal`) fuerza `num_viajes` 0, `partner_fees_raw` 0 y `bono_auto` 0.
 * Cuotas `paid`: solo actualiza snapshot de la regla (no cambia `amount_due` para no alterar pagos cerrados).
 * Luego aplica mora y tope de paid_amount por solicitud.
 *
 * @param {{ solicitudId?: string|null }} opts - Si viene `solicitudId`, solo cuotas de esa solicitud.
 * @returns {Promise<{ updated: number, solicitudes: number }>}
 */
export async function recalcMontosCuotasSemanalesDesdeCronograma(opts = {}) {
  const solicitudId = opts.solicitudId != null && String(opts.solicitudId).trim() ? String(opts.solicitudId).trim() : null;

  let sql = `
    SELECT c.id, c.solicitud_id, c.week_start_date, c.num_viajes, c.partner_fees_raw, c.paid_amount, c.late_fee, c.status,
           c.amount_due, c.fecha_ultimo_abono, c.fecha_primer_comprobante, c.montos_fuente,
           s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal
    FROM module_miauto_cuota_semanal c
    INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id`;
  const params = [];
  if (solicitudId) {
    sql += ` WHERE c.solicitud_id = $1::uuid`;
    params.push(solicitudId);
  }
  sql += ` ORDER BY c.solicitud_id, c.due_date, c.id`;

  const res = await query(sql, params);
  const rows = res.rows || [];
  const solicitudTieneCuotaOverdueIds = new Set(
    rows
      .filter((r) => String(r.status || '').toLowerCase() === 'overdue')
      .map((r) => String(r.solicitud_id))
  );
  const cronogramaCache = new Map();
  let updated = 0;
  const solicitudesAfectadas = new Set();

  for (const row of rows) {

    const crId = String(row.cronograma_id);
    let cronograma = cronogramaCache.get(crId);
    if (!cronograma) {
      cronograma = await getCronogramaById(crId);
      cronogramaCache.set(crId, cronograma);
    }
    if (!cronograma) continue;

    const wsYmd = ymdFromDbDate(row.week_start_date);
    const fiYmd = ymdFromDbDate(row.fecha_inicio_cobro_semanal);
    const isFirstCuota = wsYmd ? isSemanaDepositoMiAuto(wsYmd, row.fecha_inicio_cobro_semanal) : false;
    const dueRecalc = computeDueDateForMiAutoCuota(wsYmd, fiYmd, !!isFirstCuota);

    const yangoCerrada = wsYmd ? isWeekYangoClosedForMiAutoCuotaMetrics(wsYmd, row.fecha_inicio_cobro_semanal) : false;
    const numViajesPlan = isFirstCuota || !yangoCerrada ? 0 : Number(row.num_viajes) || 0;
    const st = (row.status || '').toLowerCase();
    const aplicarCuotaMaxSinBonoPorMora = debeAplicarCuotaMaximaSinBonoPorMora(
      solicitudTieneCuotaOverdueIds.has(String(row.solicitud_id)),
      isFirstCuota,
      row.status
    );

    let plan = aplicarCuotaMaxSinBonoPorMora
      ? planFromCronogramaMayorCuotaPorVehiculo(cronograma, row.cronograma_vehiculo_id)
      : null;
    if (!plan) {
      plan = planFromCronograma(cronograma, row.cronograma_vehiculo_id, numViajesPlan);
    }
    if (!plan) continue;

    const bonoStored = aplicarCuotaMaxSinBonoPorMora ? 0 : isFirstCuota ? 0 : plan.bonoAuto;
    let pfRaw = isFirstCuota || !yangoCerrada ? 0 : round2(Number(row.partner_fees_raw) || 0);
    if (pfRaw > 0.005 && String(plan.moneda || 'PEN').toUpperCase() === 'USD') {
      pfRaw = await partnerFeesRawDbNormalizeUsdFromYangoLocal(
        row.solicitud_id,
        pfRaw,
        plan.cuotaSemanal
      );
    }
    const pf83 = round2(pfRaw * PARTNER_FEES_PCT);
    const useWaterfallGross = !isFirstCuota && yangoCerrada && pfRaw > 0;
    const amountDue = computeAmountDueSemanal({
      cuotaSemanal: plan.cuotaSemanal,
      partnerFeesRaw: pfRaw,
      pctComision: plan.pctComision,
      cobroSaldo: plan.cobroSaldo,
      partnerFeesApplyToCuotaReduction: !useWaterfallGross,
      commissionGoesToWaterfall: useWaterfallGross,
    });

    solicitudesAfectadas.add(String(row.solicitud_id));

    const numViajesOut =
      isFirstCuota || !yangoCerrada ? 0 : Math.round(Number(row.num_viajes) || 0);

    if (st === 'paid') {
      await query(
        `UPDATE module_miauto_cuota_semanal SET
          cuota_semanal = $1, bono_auto = $2, moneda = $3, pct_comision = $4, cobro_saldo = $5, partner_fees_83 = $6, due_date = $7,
          num_viajes = $8, partner_fees_raw = $9, updated_at = CURRENT_TIMESTAMP
         WHERE id = $10`,
        [plan.cuotaSemanal, bonoStored, plan.moneda, plan.pctComision, plan.cobroSaldo, pf83, dueRecalc, numViajesOut, pfRaw, row.id]
      );
      updated++;
      continue;
    }

    if (st === 'bonificada') {
      await query(
        `UPDATE module_miauto_cuota_semanal SET
          cuota_semanal = $1, bono_auto = $2, amount_due = $3, paid_amount = $3, moneda = $4, pct_comision = $5, cobro_saldo = $6, partner_fees_83 = $7, due_date = $8,
          num_viajes = $9, partner_fees_raw = $10, late_fee = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = $11`,
        [plan.cuotaSemanal, bonoStored, amountDue, plan.moneda, plan.pctComision, plan.cobroSaldo, pf83, dueRecalc, numViajesOut, pfRaw, row.id]
      );
      updated++;
      continue;
    }

    await query(
      `UPDATE module_miauto_cuota_semanal SET
        cuota_semanal = $1, bono_auto = $2, amount_due = $3, moneda = $4, pct_comision = $5, cobro_saldo = $6, partner_fees_83 = $7, due_date = $8,
        num_viajes = $9, partner_fees_raw = $10, updated_at = CURRENT_TIMESTAMP
       WHERE id = $11`,
      [plan.cuotaSemanal, bonoStored, amountDue, plan.moneda, plan.pctComision, plan.cobroSaldo, pf83, dueRecalc, numViajesOut, pfRaw, row.id]
    );
    updated++;
  }

  await updateMoraDiaria(null, { includePartial: true, includeExcelMora: true });
  for (const sid of solicitudesAfectadas) {
    await persistPaidAmountCapsForSolicitud(sid);
  }

  logger.info('miauto.cuota.recalc_montos_cronograma', {
    updated,
    solicitudes: solicitudesAfectadas.size,
  });
  return { updated, solicitudes: solicitudesAfectadas.size };
}

/**
 * Devuelve todas las semanas del cronograma para una solicitud, indicando cuáles ya tienen cuota generada.
 * Solo las semanas cuyo lunes ≤ hoy aparecen como disponibles para generación manual.
 */
export async function getSemanasDisponibles(solicitudId) {
  const solRes = await query(
    `SELECT s.id, s.fecha_inicio_cobro_semanal, s.cronograma_vehiculo_id, s.status
     FROM module_miauto_solicitud s
     WHERE s.id = $1`,
    [solicitudId]
  );
  const sol = solRes.rows[0];
  if (!sol) throw new Error('Solicitud no encontrada');
  if (!sol.fecha_inicio_cobro_semanal) throw new Error('La solicitud aún no tiene fecha de inicio de cobro semanal');
  if (!sol.cronograma_vehiculo_id) throw new Error('La solicitud no tiene vehículo de cronograma asignado');

  const fiRaw = sol.fecha_inicio_cobro_semanal;
  const fiYmd = typeof fiRaw === 'string'
    ? fiRaw.trim().slice(0, 10)
    : (fiRaw ? new Date(fiRaw).toISOString().slice(0, 10) : '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fiYmd)) throw new Error('Fecha de inicio de cobro inválida');

  const vehRes = await query(
    `SELECT cuotas_semanales FROM module_miauto_cronograma_vehiculo WHERE id = $1`,
    [sol.cronograma_vehiculo_id]
  );
  const totalSemanas = parseInt(vehRes.rows[0]?.cuotas_semanales, 10) || 0;
  if (totalSemanas <= 0) throw new Error('El vehículo del cronograma no tiene cuotas_semanales definido');

  const firstMonday = mondayOfWeekContainingYmd(fiYmd);
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const cuotasExistentes = await query(
    `SELECT id, week_start_date, amount_due, paid_amount, status, late_fee
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1 AND deleted_at IS NULL
     ORDER BY week_start_date ASC`,
    [solicitudId]
  );
  const cuotaByWeek = new Map();
  for (const c of cuotasExistentes.rows) {
    const wsRaw = c.week_start_date;
    const ws = typeof wsRaw === 'string'
      ? (wsRaw || '').trim().slice(0, 10)
      : (wsRaw ? new Date(wsRaw).toISOString().slice(0, 10) : '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(ws)) {
      cuotaByWeek.set(ws, {
        cuota_id: c.id,
        amount_due: parseFloat(c.amount_due) || 0,
        paid_amount: parseFloat(c.paid_amount) || 0,
        status: c.status,
        late_fee: parseFloat(c.late_fee) || 0,
      });
    }
  }

  const semanas = [];
  for (let i = 0; i < totalSemanas; i++) {
    const weekStart = addDaysYmd(firstMonday, i * 7);
    const esPasadoOFuturo = weekStart <= todayYmd ? 'pasado' : 'futuro';
    const existente = cuotaByWeek.get(weekStart) || null;

    semanas.push({
      week_start: weekStart,
      semana: i + 1,
      es_deposito: i === 0,
      disponible: esPasadoOFuturo === 'pasado' && !existente,
      tiene_cuota: !!existente,
      ...(existente
        ? {
            cuota_id: existente.cuota_id,
            amount_due: existente.amount_due,
            paid_amount: existente.paid_amount,
            status: existente.status,
            late_fee: existente.late_fee,
          }
        : {}),
    });
  }

  return {
    fecha_inicio: fiYmd,
    first_monday: firstMonday,
    total_semanas: totalSemanas,
    semanas,
  };
}
