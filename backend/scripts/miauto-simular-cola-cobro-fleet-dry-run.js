/**
 * Cola de cobro Fleet (misma lógica que job lunes 7:10): orden, pending_total API y agrupación
 * por conductor+parque (un snapshot de saldo Yango por bloque). Solo lectura — no INSERT/UPDATE ni cobro.
 *
 * Incluye desglose cronograma/API: amount_due (plan), mora_pendiente, cuota_pendiente, suma y comparación
 * con pending_total; y saldo por columnas BD (amount_due + late_fee - paid) para cotejar.
 *
 * Uso:
 *   cd backend && node scripts/miauto-simular-cola-cobro-fleet-dry-run.js <solicitud_uuid>
 *   cd backend && node scripts/miauto-simular-cola-cobro-fleet-dry-run.js --todas
 *
 * Por defecto (una sola solicitud): fusiona una fila **proforma** del lunes de cuota actual
 * (como tras job 1:10) si esa semana aún no está en BD/cola, para alinear pending_total / restas
 * con lo que vería el job 7:10. Desactivar: --sin-proforma-lunes
 *
 * Reparto simulado (misma lógica que job 7:10: un snapshot de saldo Fleet por bloque, orden antigua→reciente):
 * lectura API saldo + processCobroCuota(dryRun). Desactivar: --sin-reparto
 * Hipótesis de saldo (sin consultar API): --saldo-fleet 100  (mismo valor inicial por bloque en la simulación)
 */
import 'dotenv/config';
import { query } from '../config/database.js';
import { MIAUTO_PARK_ID } from '../services/miautoDriverLookup.js';
import {
  getCuotasSemanalesConRacha,
  getCuotasToCharge,
  getCuotasToChargeForSolicitud,
  processCobroCuota,
} from '../services/miautoCuotaSemanalService.js';
import { round2 } from '../services/miautoMoneyUtils.js';
import { fleetCookieCobroForMiAuto, fleetParkIdForMiAuto, getContractorBalance } from '../services/yangoService.js';
import {
  currentMondayCuotaContext,
  previewProformaSemanaLunes,
} from './miauto-simular-generacion-lunes-dry-run.js';

/** UUID fijo solo para visualización (no existe en BD). */
const PROFORMA_CUOTA_ID = '00000000-0000-4000-8000-000000001304';

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

function pad(s, w) {
  const t = String(s ?? '');
  return t.length >= w ? `${t.slice(0, w - 1)}…` : t.padEnd(w);
}

/** `--saldo-fleet 100` → 100 (moneda local Yango / mismo snapshot que usa el job por bloque). */
function parseSaldoFleetOverride(argv) {
  const i = argv.indexOf('--saldo-fleet');
  if (i < 0 || argv[i + 1] == null) return null;
  const raw = String(argv[i + 1]).trim().replace(',', '.');
  const n = parseFloat(raw);
  if (Number.isNaN(n) || n < 0) return null;
  return round2(n);
}

function ymd(v) {
  if (v == null) return '';
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    if (m) return m[1];
  }
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(d);
    }
  } catch {
    /* ignore */
  }
  return String(v).slice(0, 10);
}

function ordenarCuotasCola(rows) {
  return [...rows].sort((a, b) => {
    const wa = ymd(a.week_start_date);
    const wb = ymd(b.week_start_date);
    if (wa !== wb) return wa < wb ? -1 : wa > wb ? 1 : 0;
    const da = ymd(a.due_date);
    const db = ymd(b.due_date);
    if (da !== db) return da < db ? -1 : da > db ? 1 : 0;
    return String(a.id).localeCompare(String(b.id));
  });
}

async function fleetContextForSolicitud(sid) {
  const r = await query(
    `SELECT s.id AS solicitud_id,
            COALESCE(NULLIF(TRIM(s.country::text), ''), 'PE') AS country,
            COALESCE(NULLIF(TRIM(COALESCE(fl.driver_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.external_driver_id::text, '')), '')) AS external_driver_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.park_id::text, '')), ''), NULLIF(TRIM(COALESCE(rd.park_id::text, '')), ''), $2) AS park_id,
            COALESCE(NULLIF(TRIM(COALESCE(fl.first_name::text, '')), ''), rd.first_name) AS first_name,
            COALESCE(NULLIF(TRIM(COALESCE(fl.last_name::text, '')), ''), rd.last_name) AS last_name
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     LEFT JOIN LATERAL (
       SELECT d.driver_id, d.park_id, d.first_name, d.last_name
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
  );
  return r.rows[0] || null;
}

/**
 * Si falta la semana del lunes de cuota (job 1:10 aún no insertó), añade fila proforma y pending/API simulados.
 */
async function mergeProformaLunes110({ sid, cuotas, pendingMap, apiByCuotaId, sinProforma }) {
  if (sinProforma) {
    return { cuotas, pendingMap, apiByCuotaId, notaProforma: null };
  }
  const { cuotaWeekMonday: targetMonday } = currentMondayCuotaContext();
  const ya = cuotas.some((c) => ymd(c.week_start_date) === targetMonday);
  if (ya) {
    return {
      cuotas,
      pendingMap,
      apiByCuotaId,
      notaProforma: `Semana ${targetMonday} ya está en la cola — sin fila proforma 1:10.`,
    };
  }
  const r = await previewProformaSemanaLunes(sid, { weekOverride: targetMonday });
  if (!r.ok) {
    return {
      cuotas,
      pendingMap,
      apiByCuotaId,
      notaProforma: `Preview job 1:10 no disponible: ${r.error}`,
    };
  }
  if (r.outcome === 'before_inicio' || r.outcome === 'no_plan') {
    return {
      cuotas,
      pendingMap,
      apiByCuotaId,
      notaProforma: `Sin proforma 1:10 (${r.outcome}).`,
    };
  }
  const out = r.out;
  if (out.fila_ya_existe_en_bd) {
    return {
      cuotas,
      pendingMap,
      apiByCuotaId,
      notaProforma: `La semana ${targetMonday} ya tiene fila en BD (id ${out.fila_ya_existe_en_bd.id}) — sin duplicar proforma.`,
    };
  }
  const pmax = out.insert_proforma_columnas.proforma_max_tras_snapshot;
  const amountPersist = round2(Number(pmax.amountDue) || 0);
  const paidIns = round2(Number(out.insert_proforma_paid_amount) || 0);
  const late = 0;
  const pt = round2(amountPersist + late - paidIns);
  const tpl = cuotas[0] || (await fleetContextForSolicitud(sid));
  if (!tpl || !String(tpl.external_driver_id || '').trim() || !String(tpl.park_id || '').trim()) {
    return {
      cuotas,
      pendingMap,
      apiByCuotaId,
      notaProforma: 'No se resolvió conductor/parque Fleet — omitiendo fila proforma 1:10.',
    };
  }
  const mon = out.derivado_antes_insert.moneda || 'PEN';
  const dueStr = out.derivado_antes_insert.due_date;
  const synthetic = {
    id: PROFORMA_CUOTA_ID,
    solicitud_id: sid,
    week_start_date: targetMonday,
    due_date: dueStr,
    amount_due: amountPersist,
    late_fee: late,
    paid_amount: paidIns,
    status: out.insert_proforma_status,
    moneda: mon,
    external_driver_id: tpl.external_driver_id,
    park_id: tpl.park_id,
    first_name: tpl.first_name,
    last_name: tpl.last_name,
    country: tpl.country || 'PE',
    _proforma_lunes_110: true,
  };
  const nextPending = new Map(pendingMap);
  nextPending.set(PROFORMA_CUOTA_ID, pt);
  const nextApi = new Map(apiByCuotaId);
  const planAmt = round2(Number(out.derivado_antes_insert.amount_due_sin_cascada_en_fila) || 0);
  const mo = 0;
  const cp = round2(Math.max(0, amountPersist - paidIns));
  nextApi.set(PROFORMA_CUOTA_ID, {
    id: PROFORMA_CUOTA_ID,
    amount_due: planAmt,
    mora_pendiente: mo,
    cuota_pendiente: cp,
    pending_total: pt,
  });
  const merged = ordenarCuotasCola([...cuotas, synthetic]);
  return {
    cuotas: merged,
    pendingMap: nextPending,
    apiByCuotaId: nextApi,
    notaProforma: `Incluye fila proforma job 1:10 (week_start=${targetMonday}, sin INSERT). pending_total simulado = columnas tras snapshot − paid ≈ ${pt} (coherente con 7:10 si esa fila existiera).`,
  };
}

/** Una fila API por cuota_id (misma fuente que GET cuotas-semanales, sin comprobante pendiente proyectado). */
async function mapaFilasApiPorCuotas(cuotas) {
  const sids = [...new Set(cuotas.map((c) => String(c.solicitud_id)))];
  const map = new Map();
  for (const sid of sids) {
    const { data } = await getCuotasSemanalesConRacha(sid, { incluirAbonoComprobantePendiente: false });
    for (const row of data || []) {
      map.set(String(row.id), row);
    }
  }
  return map;
}

function imprimirCola({ cuotas, pendingMap, apiByCuotaId, titulo, modoTodas, notaProforma }) {
  console.log('');
  console.log('='.repeat(88));
  console.log(`  ${titulo}`);
  console.log('  (solo lectura | pending_total = misma regla que API | sin retiro Fleet)');
  if (notaProforma) {
    console.log(`  ${notaProforma}`);
  }
  console.log('='.repeat(88));

  if (!cuotas.length) {
    console.log('\n  (vacío — no hay cuotas en cola con las reglas actuales)\n');
    return;
  }

  const wOrd = 4;
  const wSid = 38;
  const wId = modoTodas ? 30 : 36;
  const wWs = 12;
  const wDue = 12;
  const wSt = 10;
  const wPaid = 8;
  const wPend = 12;
  const wMon = 5;

  const rowInner = `${'─'.repeat(wId)}┬${'─'.repeat(wWs)}┬${'─'.repeat(wDue)}┬${'─'.repeat(wSt)}┬${'─'.repeat(wPaid)}┬${'─'.repeat(wPend)}┬${'─'.repeat(wMon)}`;
  let sepTop = `┌${'─'.repeat(wOrd)}┬`;
  if (modoTodas) sepTop += `${'─'.repeat(wSid)}┬`;
  sepTop += `${rowInner}┐`;
  console.log(sepTop);

  let hdr = `│${pad('#', wOrd)}│`;
  if (modoTodas) hdr += `${pad('solicitud_id', wSid)}│`;
  hdr += `${pad('cuota_id', wId)}│${pad('week_start', wWs)}│${pad('due_date', wDue)}│${pad('status', wSt)}│${pad('paid', wPaid)}│${pad('pendiente', wPend)}│${pad('mon', wMon)}│`;
  console.log(hdr);
  let sepMid = `├${'─'.repeat(wOrd)}┼`;
  if (modoTodas) sepMid += `${'─'.repeat(wSid)}┼`;
  sepMid += `${rowInner.replace(/┬/g, '┼')}┤`;
  console.log(sepMid);

  let sumPend = 0;
  cuotas.forEach((c, i) => {
    const pt = pendingMap.get(String(c.id));
    const pend = pt != null ? Number(pt) : 0;
    sumPend += pend;
    let line = `│${pad(i + 1, wOrd)}│`;
    if (modoTodas) line += `${pad(String(c.solicitud_id), wSid)}│`;
    const idLabel = c._proforma_lunes_110 ? 'proforma-1:10' : String(c.id);
    line += `${pad(idLabel, wId)}│${pad(ymd(c.week_start_date), wWs)}│${pad(ymd(c.due_date), wDue)}│${pad(c.status, wSt)}│${pad(c.paid_amount, wPaid)}│${pad(pend.toFixed(2), wPend)}│${pad(c.moneda || 'PEN', wMon)}│`;
    console.log(line);
  });

  let foot = `└${'─'.repeat(wOrd)}┴`;
  if (modoTodas) foot += `${'─'.repeat(wSid)}┴`;
  foot += `${rowInner.replace(/┬/g, '┴')}┘`;
  console.log(foot);
  console.log(`\n  Suma pending_total (cola): ${sumPend.toFixed(2)} (referencia; cada cuota se cobra hasta ese tope según saldo Yango del bloque)\n`);

  if (apiByCuotaId && apiByCuotaId.size > 0) {
    console.log('-'.repeat(100));
    console.log('  Desglose cronograma / API (mora_pendiente + cuota_pendiente ≈ pending_total)');
    console.log('-'.repeat(100));
    const wN = 4;
    const wAd = 10;
    const wMo = 10;
    const wCp = 10;
    const wSum = 10;
    const wPt = 10;
    const wDf = 8;
    const wSc = 10;
    const ri = `${'─'.repeat(wN)}┬${'─'.repeat(wAd)}┬${'─'.repeat(wMo)}┬${'─'.repeat(wCp)}┬${'─'.repeat(wSum)}┬${'─'.repeat(wPt)}┬${'─'.repeat(wDf)}┬${'─'.repeat(wSc)}`;
    console.log(`┌${ri}┐`);
    console.log(
      `│${pad('#', wN)}│${pad('amt_due plan', wAd)}│${pad('mora_pend', wMo)}│${pad('cuota_pend', wCp)}│${pad('mora+cuota', wSum)}│${pad('pend_total', wPt)}│${pad('|diff|', wDf)}│${pad('cols BD*', wSc)}│`
    );
    console.log(`├${ri.replace(/┬/g, '┼')}┤`);
    cuotas.forEach((c, i) => {
      const api = apiByCuotaId.get(String(c.id));
      const ad = api != null ? round2(Number(api.amount_due) || 0) : null;
      const mo = api != null ? round2(Number(api.mora_pendiente) || 0) : null;
      const cp = api != null ? round2(Number(api.cuota_pendiente) || 0) : null;
      const sumPart = ad != null && mo != null && cp != null ? round2(mo + cp) : null;
      const pt = pendingMap.get(String(c.id));
      const pend = pt != null ? round2(Number(pt)) : null;
      const diff =
        sumPart != null && pend != null ? round2(Math.abs(sumPart - pend)) : null;
      const adCol = round2(parseFloat(c.amount_due) || 0);
      const lfCol = round2(parseFloat(c.late_fee) || 0);
      const paidCol = round2(parseFloat(c.paid_amount) || 0);
      const saldoCols = round2(adCol + lfCol - paidCol);
      console.log(
        `│${pad(i + 1, wN)}│${pad(ad != null ? ad.toFixed(2) : '—', wAd)}│${pad(mo != null ? mo.toFixed(2) : '—', wMo)}│${pad(cp != null ? cp.toFixed(2) : '—', wCp)}│${pad(sumPart != null ? sumPart.toFixed(2) : '—', wSum)}│${pad(pend != null ? pend.toFixed(2) : '—', wPt)}│${pad(diff != null ? diff.toFixed(2) : '—', wDf)}│${pad(saldoCols.toFixed(2), wSc)}│`
      );
    });
    console.log(`└${ri.replace(/┬/g, '┴')}┘`);
    console.log(
      '  * cols BD = amount_due + late_fee - paid_amount (resta en columnas SQL; puede diferir del motor / pending_total).'
    );
    console.log(
      '  * Si |diff| > 0.05: mora_pendiente + cuota_pendiente puede no cerrar con pend_total; la fuente de cobro sigue siendo pending_total.\n'
    );
  }

  const chunks = chunkCuotasFleetMismaCuenta(cuotas);
  console.log('-'.repeat(88));
  console.log('  Bloques mismo conductor + parque Fleet (un getContractorBalance por bloque en el job real)');
  console.log('-'.repeat(88));
  chunks.forEach((chunk, bi) => {
    const head = chunk[0];
    const ext = String(head.external_driver_id || '').trim();
    const park = String(fleetParkIdForMiAuto(head.park_id) || '').trim();
    const nombre = [head.first_name, head.last_name].filter(Boolean).join(' ').trim() || '(sin nombre)';
    let sub = 0;
    for (const c of chunk) {
      const pt = pendingMap.get(String(c.id));
      sub += pt != null ? Number(pt) : 0;
    }
    console.log('');
    console.log(`  Bloque ${bi + 1}/${chunks.length} | cuotas en bloque: ${chunk.length}`);
    console.log(`    conductor: ${nombre}`);
    console.log(`    external_driver_id: ${ext}`);
    console.log(`    park_id (Fleet): ${park}`);
    console.log(`    orden en bloque: semana antigua → reciente (ya aplicado en la lista de arriba)`);
    console.log(`    suma pending_total en este bloque: ${sub.toFixed(2)} ${head.moneda || 'PEN'}`);
    console.log(`    comportamiento job: un snapshot de saldo Yango reparte en orden hasta agotar remaining entre las ${chunk.length} fila(s).`);
  });
  console.log('');
}

/**
 * Misma secuencia que `processCobroCuotaQueue` en el job: un `getContractorBalance` por bloque,
 * luego `processCobroCuota(..., { dryRun: true, sharedFleetBalancePEN, solicitudPendingMap })` en orden.
 * @param {{ saldoFleetOverride?: number | null }} [opts] Si viene, no se consulta API; mismo valor por bloque.
 */
async function imprimirRepartoSimulado({ cuotas, pendingMap, modoTodas, saldoFleetOverride }) {
  console.log('');
  console.log('='.repeat(104));
  const tituloReparto =
    saldoFleetOverride != null
      ? `  Reparto simulado job 7:10 (hipótesis saldo Fleet ${saldoFleetOverride.toFixed(2)} por bloque — sin API saldo; sin retiro ni UPDATE BD)`
      : '  Reparto simulado job 7:10 (dryRun: snapshot saldo Fleet por bloque; sin retiro ni UPDATE BD)';
  console.log(tituloReparto);
  console.log('='.repeat(104));

  if (!cuotas.length) {
    console.log('\n  (sin filas)\n');
    return;
  }

  const chunks = chunkCuotasFleetMismaCuenta(cuotas);
  for (let bi = 0; bi < chunks.length; bi++) {
    const chunk = chunks[bi];
    const head = chunk[0];
    const parkId = fleetParkIdForMiAuto(head.park_id);
    const ext = String(head.external_driver_id || '').trim();

    const nombre = [head.first_name, head.last_name].filter(Boolean).join(' ').trim() || '(sin nombre)';
    console.log('');
    console.log(`  Bloque ${bi + 1}/${chunks.length} | ${nombre}`);
    console.log(`    external_driver_id: ${ext} | park Fleet: ${parkId}`);

    let snapshot;
    if (saldoFleetOverride != null) {
      snapshot = round2(Math.max(0, saldoFleetOverride));
      console.log(
        `    Saldo inicial (simulado, no se llamó a la API): ${snapshot.toFixed(2)} (moneda local Yango — mismo tope que usaría el job)`
      );
    } else {
      const cookieMiAuto = fleetCookieCobroForMiAuto(null);
      const br = await getContractorBalance(ext, parkId, cookieMiAuto);
      if (!br.success) {
        console.log(`    No se pudo leer saldo API: ${br.error} — sin simulación fila a fila.`);
        continue;
      }
      snapshot = round2(Math.max(0, Number(br.balance) || 0));
      console.log(`    Saldo inicial (snapshot único para este bloque): ${snapshot.toFixed(2)} (moneda local Yango)`);
    }

    if (snapshot <= 0.005) {
      console.log(
        `    Con saldo 0 el job no aplica retiros (no entra al reparto fila a fila con saldo disponible). Resumen:`
      );
      chunk.forEach((c, j) => {
        const pend = pendingMap.get(String(c.id));
        const p = pend != null ? round2(Number(pend)).toFixed(2) : '—';
        const idLabel = c._proforma_lunes_110 ? 'proforma-1:10' : `${String(c.id).slice(0, 8)}…`;
        console.log(`      #${j + 1} ${idLabel} | week ${ymd(c.week_start_date)} | pendiente ${p} → sin cobro (sin saldo Fleet)`);
      });
      continue;
    }

    const sharedFleetBalancePEN = { remaining: snapshot };

    const wN = 4;
    const wSid = 38;
    const wId = modoTodas ? 26 : 20;
    const wWs = 11;
    const wPend = 9;
    const wAnt = 10;
    const wRet = 9;
    const wAcr = 10;
    const wDes = 10;
    const wEst = 11;

    const rowInner = `${'─'.repeat(wId)}┬${'─'.repeat(wWs)}┬${'─'.repeat(wPend)}┬${'─'.repeat(wAnt)}┬${'─'.repeat(wRet)}┬${'─'.repeat(wAcr)}┬${'─'.repeat(wDes)}┬${'─'.repeat(wEst)}`;
    let sepTop = `┌${'─'.repeat(wN)}┬`;
    if (modoTodas) sepTop += `${'─'.repeat(wSid)}┬`;
    sepTop += `${rowInner}┐`;
    console.log(sepTop);

    let hdr = `│${pad('#', wN)}│`;
    if (modoTodas) hdr += `${pad('solicitud_id', wSid)}│`;
    hdr += `${pad('cuota', wId)}│${pad('week_start', wWs)}│${pad('pendiente', wPend)}│${pad('saldo_antes', wAnt)}│${pad('retiro_Fl', wRet)}│${pad('acred_cuo', wAcr)}│${pad('saldo_desp', wDes)}│${pad('resultado', wEst)}│`;
    console.log(hdr);

    let sepMid = `├${'─'.repeat(wN)}┼`;
    if (modoTodas) sepMid += `${'─'.repeat(wSid)}┼`;
    sepMid += `${rowInner.replace(/┬/g, '┼')}┤`;
    console.log(sepMid);

    for (let j = 0; j < chunk.length; j++) {
      const c = chunk[j];
      const saldoAntes = round2(sharedFleetBalancePEN.remaining);
      const pend = pendingMap.get(String(c.id));
      const pendStr = pend != null ? round2(Number(pend)).toFixed(2) : '—';

      const r = await processCobroCuota(c, null, null, {
        dryRun: true,
        sharedFleetBalancePEN,
        solicitudPendingMap: pendingMap,
      });

      const saldoDespues = round2(sharedFleetBalancePEN.remaining);
      const idLabel = c._proforma_lunes_110 ? 'proforma-1:10' : `${String(c.id).slice(0, 8)}…`;

      let retStr = '—';
      let acrStr = '—';
      let est = '—';
      if (r.reason === 'Sin saldo pendiente') {
        retStr = '0.00';
        acrStr = '0.00';
        est = 'sin pend.';
      } else if (r.dryRun && !r.failed) {
        retStr =
          r.retiro_simulado_fleet != null ? round2(Number(r.retiro_simulado_fleet)).toFixed(2) : '0.00';
        acrStr =
          r.acreditado_en_cuota != null ? round2(Number(r.acreditado_en_cuota)).toFixed(2) : '—';
        est = r.partial ? 'parcial' : 'ok';
      } else if (r.failed) {
        est = String(r.reason || 'falló').slice(0, 22);
      }

      let line = `│${pad(j + 1, wN)}│`;
      if (modoTodas) line += `${pad(String(c.solicitud_id), wSid)}│`;
      line += `${pad(idLabel, wId)}│${pad(ymd(c.week_start_date), wWs)}│${pad(pendStr, wPend)}│${pad(saldoAntes.toFixed(2), wAnt)}│${pad(retStr, wRet)}│${pad(acrStr, wAcr)}│${pad(saldoDespues.toFixed(2), wDes)}│${pad(est, wEst)}│`;
      console.log(line);
    }

    let foot = `└${'─'.repeat(wN)}┴`;
    if (modoTodas) foot += `${'─'.repeat(wSid)}┴`;
    foot += `${rowInner.replace(/┬/g, '┴')}┘`;
    console.log(foot);
    console.log(
      `    Saldo restante tras el bloque (no reconsultado en el job real): ${round2(sharedFleetBalancePEN.remaining).toFixed(2)}`
    );
  }
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const todas = args.includes('--todas');
  const sinProforma = args.includes('--sin-proforma-lunes');
  const sinReparto = args.includes('--sin-reparto');
  const saldoFleetOverride = parseSaldoFleetOverride(args);
  const sid = args.find((a) => !a.startsWith('-'));

  if (!todas && !sid) {
    console.error('Uso: node scripts/miauto-simular-cola-cobro-fleet-dry-run.js <solicitud_uuid>');
    console.error('   o: node scripts/miauto-simular-cola-cobro-fleet-dry-run.js --todas');
    console.error('   Opciones: --sin-proforma-lunes | --sin-reparto | --saldo-fleet <monto>  (ej. 100 = simular 100 PEN de saldo inicial por bloque)');
    process.exit(1);
  }

  if (todas) {
    const { cuotas, solicitudPendingMap } = await getCuotasToCharge();
    const apiByCuotaId = cuotas.length ? await mapaFilasApiPorCuotas(cuotas) : new Map();
    imprimirCola({
      cuotas,
      pendingMap: solicitudPendingMap,
      apiByCuotaId,
      titulo: 'COLA GLOBAL getCuotasToCharge() — todas las solicitudes Mi Auto en cola',
      modoTodas: true,
    });
    if (!sinReparto && cuotas.length) {
      await imprimirRepartoSimulado({
        cuotas,
        pendingMap: solicitudPendingMap,
        modoTodas: true,
        saldoFleetOverride,
      });
    }
  } else {
    const { cuotas, pendingMap } = await getCuotasToChargeForSolicitud(sid);
    const apiByCuotaId = cuotas.length ? await mapaFilasApiPorCuotas(cuotas) : new Map();
    const merged = await mergeProformaLunes110({
      sid,
      cuotas,
      pendingMap,
      apiByCuotaId,
      sinProforma,
    });
    imprimirCola({
      cuotas: merged.cuotas,
      pendingMap: merged.pendingMap,
      apiByCuotaId: merged.apiByCuotaId,
      titulo: `COLA getCuotasToChargeForSolicitud — ${sid}`,
      modoTodas: false,
      notaProforma: merged.notaProforma,
    });
    if (!sinReparto && merged.cuotas.length) {
      await imprimirRepartoSimulado({
        cuotas: merged.cuotas,
        pendingMap: merged.pendingMap,
        modoTodas: false,
        saldoFleetOverride,
      });
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
