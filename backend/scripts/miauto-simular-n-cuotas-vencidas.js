/**
 * Simula N cuotas semanales “atrás” (semanas anteriores a la cuota más antigua) y muestra la cola de cobro Fleet
 * en el mismo orden que el job lunes: due_date ASC (primero la más vieja).
 *
 *   # Solo ver cola + dry-run de cada cobro (sin API saldo si --sin-saldo-api)
 *   node scripts/miauto-simular-n-cuotas-vencidas.js <solicitud_uuid> --solo-cola --sin-saldo-api
 *
 *   # Insertar 4 semanas en BD (lunes consecutivos hacia atrás), recalc mora, luego informe de cola
 *   node scripts/miauto-simular-n-cuotas-vencidas.js <solicitud_uuid> --apply --n 4 --sin-saldo-api
 */
import 'dotenv/config';
import { query } from '../config/database.js';
import { addDaysYmd, computeDueDateForMiAutoCuota } from '../utils/miautoLimaWeekRange.js';
import {
  getCuotasToChargeForSolicitud,
  isSemanaDepositoMiAuto,
  persistPaidAmountCapsForSolicitud,
  processCobroCuota,
  updateMoraDiaria,
} from '../services/miautoCuotaSemanalService.js';

function ymd(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    return m ? m[1] : null;
  }
  try {
    return new Date(v).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const id = args.find((a) => !a.startsWith('-'));
  let n = 4;
  const ni = args.indexOf('--n');
  if (ni >= 0 && args[ni + 1]) n = Math.max(1, Math.min(52, parseInt(args[ni + 1], 10) || 4));
  return {
    id,
    n,
    apply: args.includes('--apply'),
    soloCola: args.includes('--solo-cola'),
    sinSaldoApi: args.includes('--sin-saldo-api'),
  };
}

async function reportCola(sid, sinSaldoApi) {
  await updateMoraDiaria(sid, { includePartial: true });
  await persistPaidAmountCapsForSolicitud(sid);
  const cola = await getCuotasToChargeForSolicitud(sid);
  console.log('\n--- Cola cobro Fleet (orden job: due_date ASC) ---');
  console.log(JSON.stringify({ solicitud_id: sid, en_cola: cola.length }, null, 2));
  let i = 0;
  for (const row of cola) {
    i += 1;
    const opts = { dryRun: true };
    if (sinSaldoApi) opts.skipBalanceCheck = true;
    const r = await processCobroCuota(row, null, null, opts);
    console.log(`\n#${i} cuota_id=${row.id} due=${ymd(row.due_date)} status=${row.status}`);
    console.log(JSON.stringify(r, null, 2));
  }
  return cola.length;
}

async function insertPastWeeks(sid, n, fiRaw) {
  const existing = await query(
    `SELECT * FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid ORDER BY week_start_date ASC`,
    [sid]
  );
  const rows = existing.rows || [];
  if (rows.length === 0) {
    throw new Error('La solicitud no tiene cuotas semanales: genera Yego Mi Auto primero.');
  }
  const anchor = rows[0];
  const template = rows[rows.length - 1];
  const earliestWs = ymd(anchor.week_start_date);
  if (!earliestWs) throw new Error('week_start_date inválido en la cuota más antigua');

  const fiYmd = ymd(fiRaw);
  const inserted = [];

  for (let k = 1; k <= n; k++) {
    const ws = addDaysYmd(earliestWs, -7 * k);
    const dup = await query(
      `SELECT id FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid AND week_start_date = $2::date`,
      [sid, ws]
    );
    if (dup.rows.length > 0) {
      console.log(`Omitido (ya existe): week_start=${ws}`);
      continue;
    }
    const isPrimera = isSemanaDepositoMiAuto(ws, fiRaw);
    const due = computeDueDateForMiAutoCuota(ws, fiYmd, !!isPrimera);

    const numViajes = 0;
    const pfRaw = 0;
    const pf83 = 0;
    const bono = round2Safe(template.bono_auto);
    const cuotaSem = round2Safe(template.cuota_semanal);
    const amountDue = round2Safe(template.amount_due);
    const moneda = template.moneda === 'USD' ? 'USD' : 'PEN';
    const pct = round2Safe(template.pct_comision);
    const cobro = round2Safe(template.cobro_saldo);

    await query(
      `INSERT INTO module_miauto_cuota_semanal
       (solicitud_id, week_start_date, due_date, num_viajes, partner_fees_raw, partner_fees_83, bono_auto, cuota_semanal, amount_due, paid_amount, status, moneda, pct_comision, cobro_saldo)
       VALUES ($1::uuid, $2::date, $3::date, $4, $5, $6, $7, $8, $9, 0, 'pending', $10, $11, $12)`,
      [sid, ws, due, numViajes, pfRaw, pf83, bono, cuotaSem, amountDue, moneda, pct, cobro]
    );
    inserted.push({ week_start_date: ws, due_date: due });
  }
  return inserted;
}

function round2Safe(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

async function main() {
  const { id, n, apply, soloCola, sinSaldoApi } = parseArgs(process.argv);
  if (!id) {
    console.error(
      'Uso: node scripts/miauto-simular-n-cuotas-vencidas.js <solicitud_uuid> [--solo-cola] [--apply --n 4] [--sin-saldo-api]'
    );
    process.exit(1);
  }

  const sol = await query(
    `SELECT id, fecha_inicio_cobro_semanal, status FROM module_miauto_solicitud WHERE id = $1::uuid`,
    [id]
  );
  if (!sol.rows[0]) {
    console.error('Solicitud no encontrada');
    process.exit(1);
  }
  const fiRaw = sol.rows[0].fecha_inicio_cobro_semanal;

  if (soloCola && !apply) {
    const len = await reportCola(id, sinSaldoApi);
    console.log('\nListo. Cuotas en cola:', len);
    process.exit(0);
  }

  if (apply) {
    if (!fiRaw) {
      console.error('Sin fecha_inicio_cobro_semanal; no se pueden calcular vencimientos.');
      process.exit(1);
    }
    const ins = await insertPastWeeks(id, n, fiRaw);
    console.log('\nInsertadas (semanas nuevas):', JSON.stringify(ins, null, 2));
    await updateMoraDiaria(id, { includePartial: true });
    await persistPaidAmountCapsForSolicitud(id);
  }

  await reportCola(id, sinSaldoApi);
  console.log(
    '\nNota: con --sin-saldo-api no se consulta Yango; el job real usa min(pendiente, saldo_fleet) por cuota en orden.'
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
