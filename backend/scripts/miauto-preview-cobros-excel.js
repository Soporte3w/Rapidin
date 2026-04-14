/**
 * Simulación (solo lectura) de la cola de cobro Fleet del lunes.
 * Consulta el saldo Fleet de cada conductor (GET, no cobra) y simula
 * la resta cuota por cuota en memoria. Exporta todo a Excel.
 *
 * NO modifica la BD. NO retira saldo. NO cobra.
 *
 * Uso:
 *   node scripts/miauto-preview-cobros-excel.js
 *
 * Genera: scripts/output/cobros-fleet-preview-YYYY-MM-DD.xlsx
 */
import XLSX from 'xlsx';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';
import {
  getCuotasToCharge,
  effectiveAmountDueForMiAutoFleetRowAsync,
} from '../services/miautoCuotaSemanalService.js';
import {
  round2,
  tipoCambioUsdALocalEfectivo,
  convertirMontoEntreMonedas,
} from '../services/miautoMoneyUtils.js';
import {
  getContractorBalance,
  fleetCookieCobroForMiAuto,
  fleetParkIdForMiAuto,
} from '../services/yangoService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function ymd(d) {
  if (!d) return '';
  const s = typeof d === 'string' ? d : new Date(d).toISOString();
  return s.slice(0, 10);
}

const STATUS_LABEL = {
  pending: 'Pendiente',
  overdue: 'Vencida',
  partial: 'Parcial',
  paid: 'Pagada',
  bonificada: 'Bonificada',
};

function chunkPorConductor(cuotas) {
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
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

async function main() {
  console.log('Consultando cola de cobro (misma query que job lunes 7:10)…');
  const { cuotas: cola } = await getCuotasToCharge();
  console.log(`Cuotas en cola: ${cola.length}`);

  if (cola.length === 0) {
    console.log('No hay cuotas pendientes de cobro. No se genera Excel.');
    process.exit(0);
  }

  const solIds = [...new Set(cola.map((r) => r.solicitud_id))];
  const dniRes = await query(
    `SELECT s.id AS solicitud_id,
            COALESCE(NULLIF(TRIM(rd.dni), ''), NULLIF(TRIM(s.dni), '')) AS dni
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE s.id = ANY($1::uuid[])`,
    [solIds]
  );
  const dniMap = new Map(dniRes.rows.map((r) => [String(r.solicitud_id), r.dni || '']));

  const ordinalRes = await query(
    `SELECT c.id, c.solicitud_id,
            ROW_NUMBER() OVER (PARTITION BY c.solicitud_id ORDER BY c.week_start_date ASC NULLS LAST, c.due_date ASC NULLS LAST, c.id) AS nro,
            COUNT(*) OVER (PARTITION BY c.solicitud_id) AS total
     FROM module_miauto_cuota_semanal c
     WHERE c.solicitud_id = ANY($1::uuid[])`,
    [solIds]
  );
  const ordinalMap = new Map(
    ordinalRes.rows.map((r) => [String(r.id), { nro: parseInt(r.nro, 10), total: parseInt(r.total, 10) }])
  );

  const pendientesPorFila = new Map();
  for (const r of cola) {
    const amountDue = await effectiveAmountDueForMiAutoFleetRowAsync(r);
    const paid = round2(parseFloat(r.paid_amount) || 0);
    const lateFee = round2(parseFloat(r.late_fee) || 0);
    const pendiente = round2(amountDue + lateFee - paid);
    pendientesPorFila.set(r.id, { amountDue, paid, lateFee, pendiente });
  }

  const chunks = chunkPorConductor(cola);
  const cookieMiAuto = fleetCookieCobroForMiAuto(null);

  const excelRows = [];
  let chunkIdx = 0;

  for (const chunk of chunks) {
    chunkIdx++;
    const head = chunk[0];
    const parkId = fleetParkIdForMiAuto(head.park_id);
    const ext = String(head.external_driver_id || '').trim();
    const nombre = [head.first_name, head.last_name].filter(Boolean).join(' ').trim() || '—';

    console.log(`[${chunkIdx}/${chunks.length}] Consultando saldo Fleet de ${nombre} (ext=${ext})…`);

    let saldoInicial = 0;
    let saldoError = '';
    try {
      const br = await getContractorBalance(ext, parkId, cookieMiAuto);
      if (br.success) {
        saldoInicial = round2(Math.max(0, Number(br.balance) || 0));
      } else {
        saldoError = br.error || 'Error desconocido';
        console.warn(`  ⚠ No se pudo consultar saldo: ${saldoError}`);
      }
    } catch (e) {
      saldoError = e.message || 'Excepción';
      console.warn(`  ⚠ Excepción consultando saldo: ${saldoError}`);
    }

    const country = String(head.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
    const tcEff = await tipoCambioUsdALocalEfectivo(country);
    const valorTc = tcEff.valorUsdALocal;
    const monedaFleetLocal = tcEff.monedaLocal;

    let remaining = saldoInicial;

    for (const r of chunk) {
      const { amountDue, paid, lateFee, pendiente } = pendientesPorFila.get(r.id);
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
      const cobroCompleto = seAcreditaCuota >= pendiente - 0.005;

      const ord = ordinalMap.get(String(r.id));

      excelRows.push({
        Conductor: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || '—',
        DNI: dniMap.get(String(r.solicitud_id)) || '',
        'Solicitud ID': r.solicitud_id,
        'Nro. cuota': ord ? `${ord.nro} de ${ord.total}` : '—',
        Semana: ymd(r.week_start_date),
        Vencimiento: ymd(r.due_date),
        Estado: STATUS_LABEL[r.status] || r.status,
        'Cuota semanal (plan)': round2(parseFloat(r.cuota_semanal) || 0),
        'Cuota efectiva (neta)': amountDue,
        Mora: lateFee,
        'Ya pagado': paid,
        [`Pendiente (${monedaCuota})`]: pendiente,
        [`Pendiente (${monedaFleetLocal})`]: pendienteFleetLocal,
        [`Saldo Fleet antes (${monedaFleetLocal})`]: saldoError ? `Error: ${saldoError}` : saldoAntes,
        [`Se cobra (${monedaFleetLocal})`]: seCobraFleet,
        [`Se acredita (${monedaCuota})`]: seAcreditaCuota,
        [`Saldo Fleet después (${monedaFleetLocal})`]: saldoError ? '—' : remaining,
        'Cobro completo': cobroCompleto ? 'Sí' : 'No',
        Moneda: monedaCuota,
        País: country,
      });
    }
  }

  const outDir = join(__dirname, 'output');
  mkdirSync(outDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const fileName = `cobros-fleet-preview-${today}.xlsx`;
  const outPath = join(outDir, fileName);

  const ws = XLSX.utils.json_to_sheet(excelRows);

  const colWidths = [
    { wch: 28 }, // Conductor
    { wch: 12 }, // DNI
    { wch: 38 }, // Solicitud ID
    { wch: 12 }, // Nro. cuota
    { wch: 12 }, // Semana
    { wch: 12 }, // Vencimiento
    { wch: 10 }, // Estado
    { wch: 18 }, // Cuota semanal
    { wch: 18 }, // Cuota efectiva
    { wch: 10 }, // Mora
    { wch: 12 }, // Ya pagado
    { wch: 16 }, // Pendiente USD
    { wch: 16 }, // Pendiente PEN
    { wch: 22 }, // Saldo antes
    { wch: 16 }, // Se cobra
    { wch: 16 }, // Se acredita
    { wch: 22 }, // Saldo después
    { wch: 14 }, // Cobro completo
    { wch: 8 },  // Moneda
    { wch: 6 },  // País
  ];
  ws['!cols'] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Simulación Cobros Fleet');
  XLSX.writeFile(wb, outPath);

  console.log(`\nExcel generado: ${outPath}`);
  console.log(`Total filas: ${excelRows.length} cuotas de ${solIds.length} solicitud(es)`);
  console.log(`Conductores consultados: ${chunks.length}`);
  console.log('\n⚠ SIMULACIÓN — No se cobró nada. Saldo Fleet intacto.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
