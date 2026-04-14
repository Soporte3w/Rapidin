/**
 * Simula la generación de cuota del job lunes 1:10 (Misma lógica que `ensureCuotaOneSolicitud` / `ensureCuotaSemanalForWeek`
 * hasta los valores que irían al INSERT), **sin escribir en BD** (solo SELECT + lectura API Yango income).
 *
 * No ejecuta: `updateMoraDiaria`, `applyPartnerFeesWaterfallToSolicitud`, INSERT/UPDATE.
 * La cascada real reparte pool en cuotas viejas antes del INSERT; aquí se muestran límites teóricos del snapshot.
 *
 * Uso:
 *   cd backend && node scripts/miauto-simular-generacion-lunes-dry-run.js <solicitud_uuid>
 *   cd backend && node scripts/miauto-simular-generacion-lunes-dry-run.js <solicitud_uuid> --week 2026-04-13
 *   Solo JSON: ... --json   (sin tablas en consola)
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../config/database.js';
import {
  addDaysYmd,
  computeDueDateForMiAutoCuota,
  getPreviousWeekIncomeRangeLima,
  isWeekYangoClosedForMiAutoCuotaMetrics,
  limaWeekStartToMiAutoIncomeRange,
  mondayOfWeekContainingYmd,
} from '../utils/miautoLimaWeekRange.js';
import { MIAUTO_PARK_ID } from '../services/miautoDriverLookup.js';
import { getCronogramaById } from '../services/miautoCronogramaService.js';
import { getDriverIncome, fleetParkIdForMiAuto } from '../services/yangoService.js';
import {
  isSemanaDepositoMiAuto,
  planFromCronograma,
  computeAmountDueSemanal,
  partnerFeesPlusComisionPool,
  snapshotOrigenFilaTrasCascadaPool,
} from '../services/miautoCuotaSemanalService.js';
import { partnerFeesYangoAMonedaCuota, round2 } from '../services/miautoMoneyUtils.js';

const PARTNER_FEES_PCT = 0.8333;

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

function diffDaysYmdUtc(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  const ta = Date.UTC(ya, ma - 1, da);
  const tb = Date.UTC(yb, mb - 1, db);
  return Math.round((tb - ta) / (24 * 60 * 60 * 1000));
}

export function currentMondayCuotaContext() {
  const prev = getPreviousWeekIncomeRangeLima();
  const { weekStartDate: incomeWeekMonday, sundayDate, dateFrom, dateTo } = prev;
  const cuotaWeekMonday = addDaysYmd(incomeWeekMonday, 7);
  return { incomeWeekMonday, sundayDate, dateFrom, dateTo, cuotaWeekMonday };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const id = args.find((a) => !a.startsWith('-'));
  const wi = args.indexOf('--week');
  const weekOverride = wi >= 0 && args[wi + 1] ? String(args[wi + 1]).trim().slice(0, 10) : null;
  return {
    id,
    weekOverride: weekOverride && /^\d{4}-\d{2}-\d{2}$/.test(weekOverride) ? weekOverride : null,
    soloJson: args.includes('--json'),
  };
}

function padCell(s, w) {
  const t = String(s ?? '');
  return t.length >= w ? `${t.slice(0, w - 2)}..` : t.padEnd(w);
}

/** Tablas ASCII para ver montos en consola (además del JSON con `--json`). */
function imprimirTablasResumen(out) {
  const mon = out.derivado_antes_insert?.moneda || 'PEN';
  const wConcepto = 42;
  const wValor = 22;

  console.log('\n┌─────────────────────────────────────────────────────────────────────────');
  console.log('│ Contexto (mismo criterio que job lunes 1:10)');
  console.log('├────────────────────────────────────────────────────────┬──────────────');
  console.log(`│ ${padCell('Lunes cuota (week_start_date)', wConcepto)} │ ${padCell(out.job_context.cuota_week_monday_target, wValor)} │`);
  const df = String(out.job_context.yango_query_used.dateFrom);
  const dt = String(out.job_context.yango_query_used.dateTo);
  console.log(`│ ${padCell('Rango Yango Lun-Dom (ingresos)', wConcepto)} │ ${padCell(`${df.slice(0, 10)} al ${dt.slice(0, 10)}`, wValor)} │`);
  console.log('└────────────────────────────────────────────────────────┴──────────────');

  const inc = out.income_yango;
  console.log('\n┌─────────────────────────────────────────────────────────────────────────');
  console.log('│ Ingresos Yango (solo lectura API)');
  console.log('├────────────────────────────────────────────────────────┬──────────────');
  if (inc.success === false) {
    console.log(`│ ${padCell('Error', wConcepto)} │ ${padCell(inc.error || '', wValor)} │`);
  } else {
    console.log(`│ ${padCell('Viajes completados (count_completed)', wConcepto)} │ ${padCell(inc.count_completed, wValor)} │`);
    console.log(`│ ${padCell('Partner fees (bruto API → moneda cuota)', wConcepto)} │ ${padCell(`${inc.partner_fees} ${mon}`, wValor)} │`);
  }
  console.log('└────────────────────────────────────────────────────────┴──────────────');

  const d = out.derivado_antes_insert;
  console.log('\n┌─────────────────────────────────────────────────────────────────────────');
  console.log('│ Derivado antes del INSERT (sin escribir BD)');
  console.log('├────────────────────────────────────────────────────────┬──────────────');
  console.log(`│ ${padCell('Primera semana depósito', wConcepto)} │ ${padCell(d.es_primera_semana_deposito ? 'sí' : 'no', wValor)} │`);
  console.log(`│ ${padCell('Cuota semanal (plan)', wConcepto)} │ ${padCell(`${d.cuota_semanal} ${mon}`, wValor)} │`);
  console.log(`│ ${padCell('Bono auto', wConcepto)} │ ${padCell(`${d.bono_auto} ${mon}`, wValor)} │`);
  console.log(`│ ${padCell('amount_due (fila, sin cascada en columnas)', wConcepto)} │ ${padCell(`${d.amount_due_sin_cascada_en_fila} ${mon}`, wValor)} │`);
  console.log(`│ ${padCell('Vencimiento due_date', wConcepto)} │ ${padCell(d.due_date, wValor)} │`);
  console.log(`│ ${padCell('Pool cascada (PF83+comisión → cuotas viejas)', wConcepto)} │ ${padCell(`${d.pool_cascada_nuevo} ${mon}`, wValor)} │`);
  console.log(`│ ${padCell('Partner fees en moneda cuota', wConcepto)} │ ${padCell(`${d.partner_fees_raw_tras_moneda} ${mon}`, wValor)} │`);
  console.log('└────────────────────────────────────────────────────────┴──────────────');

  const pmax = out.insert_proforma_columnas.proforma_max_tras_snapshot;
  const pmin = out.insert_proforma_columnas.proforma_min_tras_snapshot;
  console.log('\n┌─────────────────────────────────────────────────────────────────────────');
  console.log(`│ Proforma columnas INSERT (moneda ${mon}; cascada real no ejecutada)`);
  console.log('├────────────────────────────────────────────────────────┬─────────┬─────────┐');
  console.log(`│ ${padCell('Concepto', wConcepto)} │ ${padCell('máx', 9)} │ ${padCell('mín', 9)} │`);
  console.log('├────────────────────────────────────────────────────────┼─────────┼─────────┤');
  console.log(
    `│ ${padCell('partner_fees_raw (columna)', wConcepto)} │ ${padCell(pmax.partnerFeesRaw, 9)} │ ${padCell(pmin.partnerFeesRaw, 9)} │`
  );
  console.log(
    `│ ${padCell('partner_fees_83', wConcepto)} │ ${padCell(pmax.partnerFees83, 9)} │ ${padCell(pmin.partnerFees83, 9)} │`
  );
  console.log(
    `│ ${padCell('partner_fees_yango_raw', wConcepto)} │ ${padCell(pmax.partnerFeesYangoRaw ?? '—', 9)} │ ${padCell(pmin.partnerFeesYangoRaw ?? '—', 9)} │`
  );
  console.log(
    `│ ${padCell('amount_due persistido', wConcepto)} │ ${padCell(pmax.amountDue, 9)} │ ${padCell(pmin.amountDue, 9)} │`
  );
  console.log('├────────────────────────────────────────────────────────┴─────────┴─────────┤');
  console.log(`│ Estado / paid INSERT: ${out.insert_proforma_status} | paid_amount: ${out.insert_proforma_paid_amount} ${mon}`.padEnd(76) + ' │');
  console.log(`│ Fila ya existe en BD: ${out.fila_ya_existe_en_bd ? `sí (${out.fila_ya_existe_en_bd.id})` : 'no'}`.padEnd(76) + ' │');
  console.log('└─────────────────────────────────────────────────────────────────────────┘');
  if (out.insert_proforma_columnas.nota_cascada) {
    console.log(`\nNota: ${out.insert_proforma_columnas.nota_cascada}\n`);
  }
}

/**
 * Misma lógica que el CLI de este archivo, para reutilizar en otros scripts (p. ej. simulación cola 7:10).
 * @param {string} solicitudId
 * @param {{ weekOverride?: string | null, soloJson?: boolean }} [options]
 * @returns {Promise<
 *   | { ok: true; out: object }
 *   | { ok: false; error: string }
 *   | { ok: true; outcome: 'before_inicio'; payload: object }
 *   | { ok: true; outcome: 'no_plan'; payload: object }
 * >}
 */
export async function previewProformaSemanaLunes(solicitudId, options = {}) {
  const sid = String(solicitudId || '').trim();
  const rawWo = options.weekOverride != null ? String(options.weekOverride).trim().slice(0, 10) : null;
  const weekOverride = rawWo && /^\d{4}-\d{2}-\d{2}$/.test(rawWo) ? rawWo : null;

  const ctx = currentMondayCuotaContext();
  const cuotaWeekMonday = weekOverride || ctx.cuotaWeekMonday;
  const rangeForIncome = weekOverride
    ? limaWeekStartToMiAutoIncomeRange(weekOverride)
    : { dateFrom: ctx.dateFrom, dateTo: ctx.dateTo, weekStartDate: ctx.incomeWeekMonday, sundayDate: ctx.sundayDate };

  const sol = await query(
    `SELECT s.id AS solicitud_id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
            COALESCE(NULLIF(TRIM(COALESCE(fl.driver_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.external_driver_id::text, '')), '')) AS external_driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.park_id::text, '')), '')) AS park_id
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     LEFT JOIN LATERAL (
       SELECT d.driver_id, d.park_id
       FROM drivers d
       WHERE TRIM(COALESCE(d.park_id::text, '')) = $2
         AND d.work_status = 'working'
         AND (
           LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g'))
           OR (
             REGEXP_REPLACE(COALESCE(TRIM(d.document_number), ''), '[^0-9]', '', 'g') =
                 REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g')
             AND REGEXP_REPLACE(COALESCE(TRIM(COALESCE(rd.dni, s.dni)), ''), '[^0-9]', '', 'g') <> ''
           )
         )
       ORDER BY
         CASE WHEN LOWER(REGEXP_REPLACE(TRIM(COALESCE(d.driver_id::text, '')), '-', '', 'g')) = LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.rapidin_driver_id::text, '')), '-', '', 'g')) THEN 0 ELSE 1 END,
         d.driver_id::text
       LIMIT 1
     ) fl ON true
     WHERE s.id = $1::uuid`,
    [sid, MIAUTO_PARK_ID]
  ).then((r) => r.rows[0]);

  if (!sol?.cronograma_id) {
    return { ok: false, error: 'Solicitud no encontrada o sin cronograma' };
  }

  const fiStr = sol.fecha_inicio_cobro_semanal ? String(sol.fecha_inicio_cobro_semanal).trim().slice(0, 10) : null;
  const mondayInicio =
    fiStr && /^\d{4}-\d{2}-\d{2}$/.test(fiStr) ? mondayOfWeekContainingYmd(fiStr) : null;
  if (mondayInicio && cuotaWeekMonday < mondayInicio) {
    return {
      ok: true,
      outcome: 'before_inicio',
      payload: {
        outcome: 'before_inicio',
        cuota_week_monday: cuotaWeekMonday,
        monday_inicio_deposito: mondayInicio,
        nota: 'El job no genera cuota para semanas anteriores a inicio cobro semanal.',
      },
    };
  }

  const fechaInicioYmd = ymdFromDbDate(sol.fecha_inicio_cobro_semanal);
  const weekYmd = String(cuotaWeekMonday).trim().slice(0, 10);
  const esPrimera = isSemanaDepositoMiAuto(weekYmd, sol.fecha_inicio_cobro_semanal);

  let incomeResult = { success: true, count_completed: 0, partner_fees: 0 };
  const dateFrom = rangeForIncome.dateFrom;
  const dateTo = rangeForIncome.dateTo;

  if (!esPrimera) {
    if (!isWeekYangoClosedForMiAutoCuotaMetrics(weekYmd, sol.fecha_inicio_cobro_semanal)) {
      incomeResult = { success: true, count_completed: 0, partner_fees: 0 };
    } else {
      const parkId = fleetParkIdForMiAuto(sol.park_id);
      const ir = await getDriverIncome(dateFrom, dateTo, sol.external_driver_id, parkId);
      incomeResult = ir.success
        ? { success: true, count_completed: ir.count_completed ?? 0, partner_fees: ir.partner_fees ?? 0 }
        : { success: false, error: ir.error, count_completed: 0, partner_fees: 0 };
    }
  }

  let numViajes = Number(incomeResult.count_completed) || 0;
  let partnerFeesRawRounded = round2(Number(incomeResult.partner_fees) || 0);
  if (esPrimera) {
    numViajes = 0;
    partnerFeesRawRounded = 0;
  } else if (!isWeekYangoClosedForMiAutoCuotaMetrics(weekYmd, sol.fecha_inicio_cobro_semanal)) {
    numViajes = 0;
    partnerFeesRawRounded = 0;
  }

  const cronograma = await getCronogramaById(sol.cronograma_id);
  const plan = planFromCronograma(cronograma, sol.cronograma_vehiculo_id, numViajes);
  if (!plan) {
    return {
      ok: true,
      outcome: 'no_plan',
      payload: {
        outcome: 'no_plan',
        num_viajes: numViajes,
        cronograma_id: sol.cronograma_id,
        nota: 'Sin regla de plan para este número de viajes / vehículo.',
      },
    };
  }

  const { cuotaSemanal, moneda, pctComision, cobroSaldo } = plan;
  if (partnerFeesRawRounded > 0.005) {
    partnerFeesRawRounded = await partnerFeesYangoAMonedaCuota(sid, partnerFeesRawRounded, moneda);
  }
  const partnerFees83 = round2(partnerFeesRawRounded * PARTNER_FEES_PCT);
  const bonoAuto = esPrimera ? 0 : plan.bonoAuto;
  const dueDateForRow = computeDueDateForMiAutoCuota(weekYmd, fechaInicioYmd, esPrimera);
  const useWaterfallAmountDue = !esPrimera && partnerFeesRawRounded > 0;
  const amountDue = computeAmountDueSemanal({
    cuotaSemanal,
    partnerFeesRaw: partnerFeesRawRounded,
    pctComision,
    cobroSaldo,
    partnerFeesApplyToCuotaReduction: !useWaterfallAmountDue,
    commissionGoesToWaterfall: useWaterfallAmountDue,
  });
  const poolCascadaNuevo = useWaterfallAmountDue ? partnerFeesPlusComisionPool(partnerFees83, pctComision) : round2(0);

  const existing = await query(
    'SELECT id, week_start_date::text FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND week_start_date = $2',
    [sid, cuotaWeekMonday]
  );

  let statusInsert = 'pending';
  let paidAmountInsert = 0;
  const solVeh = await query(
    `SELECT s.fecha_inicio_cobro_semanal, s.cuotas_semanales_bonificadas, v.cuotas_semanales
     FROM module_miauto_solicitud s
     JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id
     WHERE s.id = $1`,
    [sid]
  );
  if (solVeh.rows.length > 0) {
    const f = solVeh.rows[0].fecha_inicio_cobro_semanal;
    const total = parseInt(solVeh.rows[0].cuotas_semanales, 10) || 0;
    const bonif = parseInt(solVeh.rows[0].cuotas_semanales_bonificadas, 10) || 0;
    if (f && total > 0 && bonif >= 1) {
      const fYmd = ymdFromDbDate(f);
      const wYmd = weekYmd;
      const daysDiff =
        fYmd && /^\d{4}-\d{2}-\d{2}$/.test(wYmd)
          ? diffDaysYmdUtc(mondayOfWeekContainingYmd(fYmd), mondayOfWeekContainingYmd(wYmd))
          : 0;
      const weekIndex = Math.floor(daysDiff / 7);
      if (weekIndex >= total - bonif && weekIndex < total) {
        statusInsert = 'bonificada';
        paidAmountInsert = amountDue;
      }
    }
  }

  let proformaMin = null;
  let proformaMax = null;
  if (!esPrimera && poolCascadaNuevo > 0.005) {
    proformaMax = snapshotOrigenFilaTrasCascadaPool({
      remainingPoolUsd: poolCascadaNuevo,
      pctComision,
      cuotaSemanal,
      cobroSaldo,
    });
    proformaMin = snapshotOrigenFilaTrasCascadaPool({
      remainingPoolUsd: 0,
      pctComision,
      cuotaSemanal,
      cobroSaldo,
    });
  } else {
    proformaMax = {
      partnerFeesRaw: partnerFeesRawRounded,
      partnerFees83: round2(partnerFeesRawRounded * PARTNER_FEES_PCT),
      partnerFeesYangoRaw: partnerFeesRawRounded > 0.005 ? partnerFeesRawRounded : null,
      amountDue,
    };
    proformaMin = proformaMax;
  }

  const out = {
    modo: 'dry_run_sin_escritura_bd',
    job_context: {
      ...(weekOverride ? { week_override: weekOverride } : {}),
      incomeWeekMonday: ctx.incomeWeekMonday,
      sundayDate: ctx.sundayDate,
      yango_income_range_default: { dateFrom: ctx.dateFrom, dateTo: ctx.dateTo },
      cuota_week_monday_target: cuotaWeekMonday,
      yango_query_used: { dateFrom, dateTo },
    },
    solicitud_id: sid,
    income_yango: incomeResult.success === false ? { success: false, error: incomeResult.error } : incomeResult,
    derivado_antes_insert: {
      es_primera_semana_deposito: esPrimera,
      num_viajes: numViajes,
      partner_fees_raw_tras_moneda: partnerFeesRawRounded,
      use_waterfall_amount_due: useWaterfallAmountDue,
      pool_cascada_nuevo: poolCascadaNuevo,
      cuota_semanal: cuotaSemanal,
      bono_auto: bonoAuto,
      amount_due_sin_cascada_en_fila: amountDue,
      due_date: dueDateForRow,
      moneda,
      pct_comision: pctComision,
      cobro_saldo: cobroSaldo,
    },
    fila_ya_existe_en_bd: existing.rows.length > 0 ? { id: existing.rows[0].id, week_start_date: existing.rows[0].week_start_date } : null,
    insert_proforma_status: statusInsert,
    insert_proforma_paid_amount: paidAmountInsert,
    insert_proforma_columnas: {
      nota_cascada:
        !esPrimera && poolCascadaNuevo > 0.005
          ? 'Job real: applyPartnerFeesWaterfallToSolicitud(pool) antes del INSERT; la fila nueva usa snapshotOrigenFilaTrasCascadaPool(remanente). proforma_max / proforma_min = limites teoricos sin ejecutar cascada en cuotas viejas.'
          : null,
      proforma_max_tras_snapshot: proformaMax,
      proforma_min_tras_snapshot: proformaMin,
    },
  };

  return { ok: true, out };
}

async function main() {
  const { id: sid, weekOverride, soloJson } = parseArgs(process.argv);
  if (!sid) {
    console.error('Uso: node scripts/miauto-simular-generacion-lunes-dry-run.js <solicitud_uuid> [--week YYYY-MM-DD]');
    process.exit(1);
  }

  const r = await previewProformaSemanaLunes(sid, { weekOverride, soloJson });
  if (!r.ok) {
    console.error(JSON.stringify({ error: r.error }, null, 2));
    process.exit(1);
  }
  if (r.outcome === 'before_inicio' || r.outcome === 'no_plan') {
    console.log(JSON.stringify(r.payload, null, 2));
    process.exit(0);
  }
  const { out } = r;
  if (!soloJson) {
    imprimirTablasResumen(out);
    console.log('\n--- JSON (usar --json para solo JSON) ---\n');
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
