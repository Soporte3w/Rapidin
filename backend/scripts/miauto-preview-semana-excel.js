/**
 * Simulación completa del ciclo del lunes para la PRÓXIMA semana de cuota (aún no generada en BD).
 *
 *  1. Consulta ingresos Yango (Lun–Dom) de cada conductor activo (solo lectura).
 *  2. Calcula la cuota según cronograma + viajes.
 *  3. Simula la cascada de cobro de ingresos (PF pool) a cuotas vencidas más antiguas (EN MEMORIA, no toca BD).
 *  4. Consulta saldo Fleet real (solo lectura).
 *  5. Simula el cobro Fleet cuota por cuota (más antigua primero) incluyendo la cuota nueva simulada.
 *
 * NO modifica la BD. NO retira saldo. NO cobra. NO genera cuotas en BD.
 *
 * Uso:
 *   node scripts/miauto-preview-semana-excel.js [YYYY-MM-DD]
 *
 *   Si se omite la fecha, usa el lunes de la PRÓXIMA semana de cuota (hoy + lunes siguiente).
 *
 * Genera: scripts/output/preview-semana-YYYY-MM-DD.xlsx
 */
import XLSX from 'xlsx';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';
import {
  getSolicitudesParaCobroSemanal,
  effectiveAmountDueForMiAutoFleetRowAsync,
  isSemanaDepositoMiAuto,
  planFromCronograma,
  computeAmountDueSemanal,
  partnerFeesPlusComisionPool,
  snapshotOrigenFilaTrasCascadaPool,
} from '../services/miautoCuotaSemanalService.js';
import { getCronogramaById } from '../services/miautoCronogramaService.js';
import {
  round2,
  tipoCambioUsdALocalEfectivo,
  convertirMontoEntreMonedas,
  partnerFeesYangoAMonedaCuota,
} from '../services/miautoMoneyUtils.js';
import {
  getDriverIncome,
  getContractorBalance,
  fleetCookieCobroForMiAuto,
  fleetParkIdForMiAuto,
} from '../services/yangoService.js';
import {
  addDaysYmd,
  limaWeekStartToMiAutoIncomeRange,
  mondayOfWeekContainingYmd,
  computeDueDateForMiAutoCuota,
} from '../utils/miautoLimaWeekRange.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARTNER_FEES_PCT = 0.8333;
const DELAY_MS = 1200;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function ymd(d) {
  if (!d) return '';
  const s = typeof d === 'string' ? d : new Date(d).toISOString();
  return s.slice(0, 10);
}

function limaTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function nextMondayFrom(todayYmd) {
  const [y, m, d] = todayYmd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const daysUntilMon = dow === 0 ? 1 : dow === 1 ? 7 : 8 - dow;
  return addDaysYmd(todayYmd, daysUntilMon);
}

const STATUS_LABEL = {
  pending: 'Pendiente', overdue: 'Vencida', partial: 'Parcial',
  paid: 'Pagada', bonificada: 'Bonificada',
};

async function main() {
  const argDate = process.argv[2]?.trim();
  const cuotaWeekMonday = argDate && /^\d{4}-\d{2}-\d{2}$/.test(argDate)
    ? mondayOfWeekContainingYmd(argDate)
    : nextMondayFrom(limaTodayYmd());

  const { dateFrom, dateTo, weekStartDate: incomeWeekMonday, sundayDate } =
    limaWeekStartToMiAutoIncomeRange(cuotaWeekMonday);

  console.log(`=== Simulación semana de cuota: ${cuotaWeekMonday} ===`);
  console.log(`Ingresos Yango: Lun ${incomeWeekMonday} → Dom ${sundayDate}`);
  console.log(`Rango income API: ${dateFrom} → ${dateTo}\n`);

  const solicitudes = await getSolicitudesParaCobroSemanal();
  console.log(`Solicitudes activas: ${solicitudes.length}\n`);

  const dniRes = await query(
    `SELECT s.id AS solicitud_id,
            COALESCE(NULLIF(TRIM(rd.dni), ''), NULLIF(TRIM(s.dni), '')) AS dni,
            s.placa_asignada
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE s.id = ANY($1::uuid[])`,
    [solicitudes.map((s) => s.solicitud_id)]
  );
  const dniMap = new Map(dniRes.rows.map((r) => [String(r.solicitud_id), { dni: r.dni || '', placa: r.placa_asignada || '' }]));

  const cuotaGenRows = [];
  const cascadaRows = [];
  const fleetRows = [];

  const cookieMiAuto = fleetCookieCobroForMiAuto(null);
  let idx = 0;

  for (const sol of solicitudes) {
    idx++;
    const nombre = [sol.first_name, sol.last_name].filter(Boolean).join(' ').trim() || '—';
    const info = dniMap.get(String(sol.solicitud_id)) || { dni: '', placa: '' };
    const parkId = fleetParkIdForMiAuto(sol.park_id);
    const ext = String(sol.external_driver_id || '').trim();

    const fiStr = sol.fecha_inicio_cobro_semanal
      ? String(sol.fecha_inicio_cobro_semanal).trim().slice(0, 10) : null;
    const mondayInicio = fiStr && /^\d{4}-\d{2}-\d{2}$/.test(fiStr)
      ? mondayOfWeekContainingYmd(fiStr) : null;
    if (mondayInicio && cuotaWeekMonday < mondayInicio) continue;

    const esPrimera = isSemanaDepositoMiAuto(cuotaWeekMonday, sol.fecha_inicio_cobro_semanal);

    // --- PASO 1: Consultar ingresos Yango ---
    let incomeResult;
    if (esPrimera) {
      incomeResult = { success: true, count_completed: 0, partner_fees: 0 };
    } else {
      console.log(`[${idx}/${solicitudes.length}] Consultando income Yango de ${nombre} (${info.dni})…`);
      try {
        incomeResult = await getDriverIncome(dateFrom, dateTo, ext, sol.park_id);
        if (!incomeResult.success) {
          console.warn(`  ⚠ Income fallido: ${incomeResult.error} — se usa 0`);
          incomeResult = { success: true, count_completed: 0, partner_fees: 0 };
        }
      } catch (e) {
        console.warn(`  ⚠ Excepción income: ${e.message} — se usa 0`);
        incomeResult = { success: true, count_completed: 0, partner_fees: 0 };
      }
      await delay(DELAY_MS);
    }

    const numViajes = incomeResult.count_completed || 0;
    let partnerFeesRaw = round2(Math.abs(Number(incomeResult.partner_fees) || 0));

    // --- PASO 2: Calcular cuota del plan ---
    const cronograma = await getCronogramaById(sol.cronograma_id);
    const plan = planFromCronograma(cronograma, sol.cronograma_vehiculo_id, numViajes);

    // Moneda de referencia desde cuotas existentes
    const monedaRef = await query(
      `SELECT DISTINCT moneda FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid AND moneda IS NOT NULL LIMIT 1`,
      [sol.solicitud_id]
    );
    const moneda = plan?.moneda || monedaRef.rows[0]?.moneda || 'USD';

    const cuotaSemanal = plan?.cuotaSemanal || 0;
    const pctComision = plan?.pctComision || 0;
    const cobroSaldo = plan?.cobroSaldo || 0;
    const bonoAuto = plan?.bonoAuto || 0;

    if (partnerFeesRaw > 0.005 && !esPrimera) {
      partnerFeesRaw = await partnerFeesYangoAMonedaCuota(sol.solicitud_id, partnerFeesRaw, moneda);
    }

    const partnerFees83 = round2(partnerFeesRaw * PARTNER_FEES_PCT);
    const useWaterfall = !esPrimera && partnerFeesRaw > 0.005;

    const amountDuePreCascada = plan ? computeAmountDueSemanal({
      cuotaSemanal,
      partnerFeesRaw,
      pctComision,
      cobroSaldo,
      partnerFeesApplyToCuotaReduction: !useWaterfall,
      commissionGoesToWaterfall: useWaterfall,
    }) : 0;

    const poolCascada = useWaterfall ? partnerFeesPlusComisionPool(partnerFees83, pctComision) : 0;

    const dueDateForRow = computeDueDateForMiAutoCuota(cuotaWeekMonday, fiStr, esPrimera);

    // --- PASO 3: Simular cascada en memoria ---
    const cuotasExistentes = await query(
      `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due,
              c.paid_amount, c.late_fee, c.status, c.cuota_semanal, c.bono_auto,
              c.cobro_saldo, c.pct_comision, c.partner_fees_raw, c.moneda,
              c.fecha_ultimo_abono, c.fecha_primer_comprobante
       FROM module_miauto_cuota_semanal c
       WHERE c.solicitud_id = $1::uuid
         AND (c.status IN ('pending', 'overdue', 'partial')
              OR (c.status = 'paid' AND COALESCE(c.amount_due,0)::numeric + COALESCE(c.late_fee,0)::numeric > COALESCE(c.paid_amount,0)::numeric + 0.02))
       ORDER BY c.due_date ASC NULLS LAST, c.week_start_date ASC, c.id ASC`,
      [sol.solicitud_id]
    );

    let pool = round2(poolCascada);
    let poolAplicado = 0;
    const paidAdjustments = new Map();

    for (const row of cuotasExistentes.rows) {
      if (pool <= 0.005) break;
      const paid = round2(parseFloat(row.paid_amount) || 0);
      const amtDue = round2(parseFloat(row.amount_due) || 0);
      const lf = round2(parseFloat(row.late_fee) || 0);
      const pending = round2(Math.max(0, amtDue + lf - paid));
      if (pending <= 0.005) continue;

      const applyAmt = round2(Math.min(pool, pending));
      const newPaid = round2(paid + applyAmt);
      pool = round2(pool - applyAmt);
      poolAplicado = round2(poolAplicado + applyAmt);

      paidAdjustments.set(String(row.id), newPaid);

      cascadaRows.push({
        Conductor: nombre,
        DNI: info.dni,
        Placa: info.placa,
        'Solicitud ID': sol.solicitud_id,
        'Cuota destino': `${ymd(row.week_start_date)}`,
        Vencimiento: ymd(row.due_date),
        'Estado actual': STATUS_LABEL[row.status] || row.status,
        'Pendiente antes': round2(amtDue + lf - paid),
        'Pool recibido': applyAmt,
        'Pagado después': newPaid,
        'Pendiente después': round2(amtDue + lf - newPaid),
        'Origen pool': `PF semana ${cuotaWeekMonday}`,
      });
    }

    const snapshot = snapshotOrigenFilaTrasCascadaPool({
      remainingPoolUsd: pool,
      pctComision,
      cuotaSemanal,
      cobroSaldo,
    });

    const amountDueFinal = useWaterfall ? snapshot.amountDue : amountDuePreCascada;
    const pfRawFinal = useWaterfall ? snapshot.partnerFeesRaw : partnerFeesRaw;
    const pf83Final = useWaterfall ? snapshot.partnerFees83 : partnerFees83;

    cuotaGenRows.push({
      Conductor: nombre,
      DNI: info.dni,
      Placa: info.placa,
      'Solicitud ID': sol.solicitud_id,
      'Semana cuota': cuotaWeekMonday,
      Vencimiento: ymd(dueDateForRow),
      'Tiene plan cronograma': plan ? 'Sí' : 'No',
      Viajes: numViajes,
      'PF Yango (raw)': partnerFeesRaw,
      'PF 83%': partnerFees83,
      'Cuota plan': cuotaSemanal,
      'Cobro saldo': cobroSaldo,
      '% Comisión': pctComision,
      'Pool cascada total': poolCascada,
      'Pool aplicado a viejas': poolAplicado,
      'Pool remanente fila': pool,
      'PF raw (en fila)': pfRawFinal,
      'PF 83% (en fila)': pf83Final,
      'Amount Due (neto)': amountDueFinal,
      Moneda: moneda,
    });

    // --- PASO 4: Consultar saldo Fleet ---
    console.log(`[${idx}/${solicitudes.length}] Consultando saldo Fleet de ${nombre}…`);
    let saldoInicial = 0;
    let saldoError = '';
    try {
      const br = await getContractorBalance(ext, parkId, cookieMiAuto);
      if (br.success) {
        saldoInicial = round2(Math.max(0, Number(br.balance) || 0));
      } else {
        saldoError = br.error || 'Error desconocido';
        console.warn(`  ⚠ Saldo Fleet: ${saldoError}`);
      }
    } catch (e) {
      saldoError = e.message || 'Excepción';
      console.warn(`  ⚠ Excepción saldo: ${saldoError}`);
    }
    await delay(DELAY_MS);

    const country = String(sol.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
    const tcEff = await tipoCambioUsdALocalEfectivo(country);
    const valorTc = tcEff.valorUsdALocal;
    const monedaFleetLocal = tcEff.monedaLocal;

    // --- PASO 5: Simular cobro Fleet (cuotas existentes + nueva) ---
    const allCuotasExistentes = await query(
      `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due,
              c.paid_amount, c.late_fee, c.status, c.cuota_semanal, c.bono_auto,
              c.cobro_saldo, c.pct_comision, c.partner_fees_raw, c.partner_fees_83,
              c.moneda, c.fecha_ultimo_abono, c.fecha_primer_comprobante
       FROM module_miauto_cuota_semanal c
       JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
       WHERE c.solicitud_id = $1::uuid
         AND c.status IN ('pending', 'overdue', 'partial')
         AND (c.amount_due + COALESCE(c.late_fee, 0) - COALESCE(c.paid_amount, 0)) > 0
       ORDER BY c.week_start_date ASC NULLS LAST, c.due_date ASC NULLS LAST, c.id ASC`,
      [sol.solicitud_id]
    );

    const totalCuotasRes = await query(
      `SELECT COUNT(*) AS total FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid`,
      [sol.solicitud_id]
    );
    const totalCuotasExistentes = parseInt(totalCuotasRes.rows[0]?.total || '0', 10);

    let remaining = saldoInicial;

    for (const r of allCuotasExistentes.rows) {
      const adjustedPaid = paidAdjustments.has(String(r.id))
        ? paidAdjustments.get(String(r.id))
        : round2(parseFloat(r.paid_amount) || 0);

      const amountDue = await effectiveAmountDueForMiAutoFleetRowAsync(r);
      const lateFee = round2(parseFloat(r.late_fee) || 0);
      const pendiente = round2(Math.max(0, amountDue + lateFee - adjustedPaid));

      if (pendiente <= 0.005) continue;

      const monedaCuota = r.moneda === 'USD' ? 'USD' : 'PEN';
      let pendienteFleetLocal = pendiente;
      if (monedaCuota === 'USD') {
        const conv = convertirMontoEntreMonedas(pendiente, 'USD', monedaFleetLocal, valorTc);
        pendienteFleetLocal = conv != null ? round2(conv) : round2(pendiente);
      }

      const saldoAntes = round2(remaining);
      const seCobraFleet = round2(Math.min(pendienteFleetLocal, Math.max(0, remaining)));
      let seAcreditaCuota = seCobraFleet;
      if (monedaCuota === 'USD') {
        const c = convertirMontoEntreMonedas(seCobraFleet, monedaFleetLocal, 'USD', valorTc);
        seAcreditaCuota = c != null ? round2(c) : round2(seCobraFleet);
      }
      remaining = round2(Math.max(0, remaining - seCobraFleet));

      fleetRows.push({
        Conductor: nombre,
        DNI: info.dni,
        'Solicitud ID': sol.solicitud_id,
        Tipo: 'EXISTENTE',
        Semana: ymd(r.week_start_date),
        Vencimiento: ymd(r.due_date),
        Estado: STATUS_LABEL[r.status] || r.status,
        'Cuota efectiva': amountDue,
        Mora: lateFee,
        'Pagado (ajustado)': adjustedPaid,
        [`Pendiente (${monedaCuota})`]: pendiente,
        [`Pendiente (${monedaFleetLocal})`]: pendienteFleetLocal,
        [`Saldo Fleet antes (${monedaFleetLocal})`]: saldoError ? `Error: ${saldoError}` : saldoAntes,
        [`Se cobra (${monedaFleetLocal})`]: seCobraFleet,
        [`Se acredita (${monedaCuota})`]: seAcreditaCuota,
        [`Saldo Fleet después (${monedaFleetLocal})`]: saldoError ? '—' : remaining,
        'Cobro completo': seAcreditaCuota >= pendiente - 0.005 ? 'Sí' : 'No',
        Moneda: monedaCuota,
      });
    }

    // Cuota NUEVA simulada
    if (amountDueFinal > 0.005) {
      const monedaCuota = moneda === 'USD' ? 'USD' : 'PEN';
      const pendienteNueva = amountDueFinal;
      let pendienteFleetLocal = pendienteNueva;
      if (monedaCuota === 'USD') {
        const conv = convertirMontoEntreMonedas(pendienteNueva, 'USD', monedaFleetLocal, valorTc);
        pendienteFleetLocal = conv != null ? round2(conv) : round2(pendienteNueva);
      }

      const saldoAntes = round2(remaining);
      const seCobraFleet = round2(Math.min(pendienteFleetLocal, Math.max(0, remaining)));
      let seAcreditaCuota = seCobraFleet;
      if (monedaCuota === 'USD') {
        const c = convertirMontoEntreMonedas(seCobraFleet, monedaFleetLocal, 'USD', valorTc);
        seAcreditaCuota = c != null ? round2(c) : round2(seCobraFleet);
      }
      remaining = round2(Math.max(0, remaining - seCobraFleet));

      fleetRows.push({
        Conductor: nombre,
        DNI: info.dni,
        'Solicitud ID': sol.solicitud_id,
        Tipo: '✱ NUEVA',
        Semana: cuotaWeekMonday,
        Vencimiento: ymd(dueDateForRow),
        Estado: 'Pendiente (simulada)',
        'Cuota efectiva': amountDueFinal,
        Mora: 0,
        'Pagado (ajustado)': 0,
        [`Pendiente (${monedaCuota})`]: pendienteNueva,
        [`Pendiente (${monedaFleetLocal})`]: pendienteFleetLocal,
        [`Saldo Fleet antes (${monedaFleetLocal})`]: saldoError ? `Error: ${saldoError}` : saldoAntes,
        [`Se cobra (${monedaFleetLocal})`]: seCobraFleet,
        [`Se acredita (${monedaCuota})`]: seAcreditaCuota,
        [`Saldo Fleet después (${monedaFleetLocal})`]: saldoError ? '—' : remaining,
        'Cobro completo': seAcreditaCuota >= pendienteNueva - 0.005 ? 'Sí' : 'No',
        Moneda: monedaCuota,
      });
    }
  }

  // --- GENERAR EXCEL ---
  const outDir = join(__dirname, 'output');
  mkdirSync(outDir, { recursive: true });
  const fileName = `preview-semana-${cuotaWeekMonday}.xlsx`;
  const outPath = join(outDir, fileName);

  const wb = XLSX.utils.book_new();

  const ws1 = XLSX.utils.json_to_sheet(cuotaGenRows.length > 0 ? cuotaGenRows : [{ Info: 'Sin datos' }]);
  ws1['!cols'] = [
    { wch: 28 }, { wch: 12 }, { wch: 10 }, { wch: 38 }, { wch: 12 }, { wch: 12 },
    { wch: 18 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
    { wch: 10 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 14 },
    { wch: 16 }, { wch: 8 },
  ];
  XLSX.utils.book_append_sheet(wb, ws1, 'Cuota Generada');

  if (cascadaRows.length > 0) {
    const ws2 = XLSX.utils.json_to_sheet(cascadaRows);
    ws2['!cols'] = [
      { wch: 28 }, { wch: 12 }, { wch: 10 }, { wch: 38 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 20 },
    ];
    XLSX.utils.book_append_sheet(wb, ws2, 'Cascada Cobro Ingresos');
  }

  if (fleetRows.length > 0) {
    const ws3 = XLSX.utils.json_to_sheet(fleetRows);
    ws3['!cols'] = [
      { wch: 28 }, { wch: 12 }, { wch: 38 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
      { wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 16 },
      { wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 22 }, { wch: 14 }, { wch: 8 },
    ];
    XLSX.utils.book_append_sheet(wb, ws3, 'Simulación Cobro Fleet');
  }

  XLSX.writeFile(wb, outPath);

  console.log(`\n=== Excel generado: ${outPath} ===`);
  console.log(`Hoja 1 "Cuota Generada": ${cuotaGenRows.length} solicitudes`);
  console.log(`Hoja 2 "Cascada Cobro Ingresos": ${cascadaRows.length} cuotas que recibirían pool PF`);
  console.log(`Hoja 3 "Simulación Cobro Fleet": ${fleetRows.length} cuotas (existentes + nuevas simuladas)`);
  console.log('\n⚠ SIMULACIÓN — No se cobró nada. No se generó nada en BD. Saldo Fleet intacto.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
