/**
 * Carga / corrige cuotas semanales Mi Auto desde cifras tipo Excel (viajes, monto, moneda USD/PEN, pagado sí/no).
 * No aplica mora: `late_fee = 0` y no invoca `updateMoraDiaria`.
 *
 * Pensado para solicitud + DNI del conductor en hoja Excel (ej. Alexander / Onix — DNI 45447986).
 *
 * Uso:
 *   node scripts/miauto-cargar-cuotas-excel-sin-mora.js              # aplica
 *   node scripts/miauto-cargar-cuotas-excel-sin-mora.js --dry-run    # solo muestra SQL lógico
 *   node scripts/miauto-cargar-cuotas-excel-sin-mora.js --skip-dni-check
 *
 * Para otro conductor: edita SOLICITUD_UUID, DNI_ESPERADO y el array RAW_ROWS.
 */
import { query } from '../config/database.js';
import { round2 } from '../services/miautoMoneyUtils.js';
import { mondayOfWeekContainingYmd, computeDueDateForMiAutoCuota } from '../utils/miautoLimaWeekRange.js';
import { isSemanaDepositoMiAuto } from '../services/miautoCuotaSemanalService.js';

const SOLICITUD_UUID = '25722f84-4f4e-40f7-9b0c-1f1ce88a2a9a';
/** DNI solo dígitos (como en el Excel de flota), no confundir con `module_rapidin_drivers.id` (UUID). */
const DNI_ESPERADO = '45447986';

const SKIP_DNI = process.argv.includes('--skip-dni-check');

const DRY = process.argv.includes('--dry-run');

/**
 * Filas tal cual la hoja (fecha DD/MM/AA o "Promedio", viajes o "-", monto con $ o S/, validación).
 * Las dos "Promedio" seguidas del depósito se omiten al generar `ROWS`: quedan las semanas 16/06 y 23/06
 * con los datos de 17/06 y 23/06 (evita duplicar el mismo lunes).
 */
const RAW_ROWS = [
  ['09/06/25', '-', '$137', true],
  // Promedio / Promedio omitidos — ver comentario arriba
  ['17/06/25', '45', '$127', true],
  ['23/06/25', '120', '$107', true],
  ['30/06/25', '140', '$102', true],
  ['08/07/25', '165', '$97', true],
  ['15/07/25', '165', '$97', true],
  ['21/07/25', '160', '$97', true],
  ['29/07/25', '167', '$98.38', true],
  ['05/08/25', '165', '$97.00', true],
  ['11/08/25', '165', '$99.80', true],
  ['18/08/25', '166', '$98.40', true],
  ['25/08/25', '170', '$97.00', true],
  ['01/09/25', '175', 'S/376.50', true],
  ['08/09/25', '175', 'S/341.50', true],
  ['15/09/25', '141', '$116.60', true],
  ['22/09/25', '177', '$110.87', true],
  ['29/09/25', '176', '$112.56', true],
  ['06/10/25', '175', '$106.70', true],
  ['13/10/25', '142', '$122.40', true],
  ['20/10/25', '142', '$133.00', true],
  ['27/10/25', '175', '$97.00', true],
  ['03/11/25', '155', '$119.00', true],
  ['10/11/25', '155', '$132.60', true],
  ['17/11/25', '122', '$128.40', true],
  ['24/11/25', '164', '$137.18', true],
  ['01/12/25', '145', '$134.00', true],
  ['08/12/25', '152', '$161.00', true],
  ['15/12/25', '179', '$147.00', true],
  ['22/12/25', '181', '$145.50', true],
  ['29/12/25', '180', '$150.18', true],
  ['05/01/26', '42', '$243.44', true],
  ['12/01/26', '181', '$97.00', false],
  ['19/01/26', '180', '$97.00', false],
  ['26/01/26', '133', '$97.00', true],
  ['02/02/26', '187', '$131.60', true],
  ['09/02/26', '187', '$97.00', true],
  ['16/02/26', '', '$109.10', true],
  ['23/02/26', '146', '$103.50', true],
  ['02/03/26', '144', '$102.00', true],
  ['09/03/26', '90', '$117.00', false],
  ['16/03/26', '92', '$117.00', false],
];

function parseDdMmYyToYmd(fechaLabel) {
  const t = String(fechaLabel || '').trim();
  if (!t || /^promedio$/i.test(t)) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(t);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const yy = Number(m[3]);
  const year = 2000 + (yy % 100);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function parseMontoYMoneda(montoStr) {
  const s = String(montoStr || '').trim();
  let moneda = 'USD';
  let numPart = s;
  if (/^S\//i.test(s)) {
    moneda = 'PEN';
    numPart = s.replace(/^S\//i, '').trim();
  } else {
    numPart = s.replace(/^\$/i, '').trim();
  }
  const normalized = numPart.replace(/,/g, '');
  const n = parseFloat(normalized);
  if (Number.isNaN(n)) throw new Error(`Monto no numérico: ${montoStr}`);
  return { monto: round2(n), moneda };
}

function parseViajes(v) {
  const t = String(v ?? '').trim();
  if (!t || t === '-') return 0;
  const n = parseInt(t, 10);
  return Number.isNaN(n) ? 0 : n;
}

function buildRowsFromRaw() {
  const byWeek = new Map();
  for (const [fecha, viajesRaw, montoStr, paid] of RAW_ROWS) {
    const ymd = parseDdMmYyToYmd(fecha);
    if (!ymd) continue;
    const weekStart = mondayOfWeekContainingYmd(ymd);
    const { monto, moneda } = parseMontoYMoneda(montoStr);
    const numViajes = parseViajes(viajesRaw);
    if (byWeek.has(weekStart)) {
      console.warn(`Aviso: más de una fila para week_start ${weekStart}; se usa la última del array.`);
    }
    byWeek.set(weekStart, { week_start_date: weekStart, num_viajes: numViajes, monto, moneda, paid });
  }
  return [...byWeek.values()].sort((a, b) => a.week_start_date.localeCompare(b.week_start_date));
}

function statusForRow(paid, amountDue, dueYmd, limaTodayYmd) {
  if (paid) return { status: 'paid', paid_amount: amountDue };
  if (dueYmd < limaTodayYmd) return { status: 'overdue', paid_amount: round2(0) };
  return { status: 'pending', paid_amount: round2(0) };
}

async function main() {
  const rows = buildRowsFromRaw();
  const solRes = await query(
    `SELECT s.id,
            s.rapidin_driver_id::text AS rapidin_driver_id,
            s.fecha_inicio_cobro_semanal,
            REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g') AS dni_sol,
            REGEXP_REPLACE(COALESCE(TRIM(rd.dni), ''), '[^0-9]', '', 'g') AS dni_rd
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE s.id = $1::uuid`,
    [SOLICITUD_UUID]
  );
  const sol = solRes.rows[0];
  if (!sol) {
    console.error('No existe solicitud', SOLICITUD_UUID);
    process.exit(1);
  }
  const dniBd = String(sol.dni_rd || sol.dni_sol || '').trim();
  if (!SKIP_DNI && dniBd !== DNI_ESPERADO) {
    console.error(
      `DNI en BD (solicitud/conductor: ${dniBd || 'vacío'}) no coincide con DNI_ESPERADO (${DNI_ESPERADO}). Abortando. Usa --skip-dni-check si es correcto igualmente.`
    );
    process.exit(1);
  }

  const fi = sol.fecha_inicio_cobro_semanal;
  const fiYmd =
    fi instanceof Date
      ? fi.toISOString().slice(0, 10)
      : String(fi || '')
          .trim()
          .slice(0, 10);

  const limaToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  console.log(`Solicitud ${SOLICITUD_UUID}, fecha_inicio_cobro_semanal=${fiYmd}, filas=${rows.length}, dry-run=${DRY}`);

  let n = 0;
  for (const r of rows) {
    const isPrimera = isSemanaDepositoMiAuto(r.week_start_date, fi);
    const dueDate = computeDueDateForMiAutoCuota(r.week_start_date, fiYmd, isPrimera);
    const amountDue = r.monto;
    const cuotaSemanal = r.monto;
    const { status, paid_amount } = statusForRow(r.paid, amountDue, String(dueDate).slice(0, 10), limaToday);
    const numViajes = isPrimera ? 0 : r.num_viajes;

    const payload = {
      week_start_date: r.week_start_date,
      due_date: String(dueDate).slice(0, 10),
      num_viajes: numViajes,
      partner_fees_raw: 0,
      partner_fees_83: 0,
      bono_auto: 0,
      cuota_semanal: cuotaSemanal,
      amount_due: amountDue,
      paid_amount,
      status,
      moneda: r.moneda,
      pct_comision: 0,
      cobro_saldo: 0,
      late_fee: 0,
    };

    console.log(
      `${payload.week_start_date} | ${r.moneda} | viajes=${numViajes} | monto=${amountDue} | ${status} | vence=${payload.due_date}`
    );

    if (DRY) {
      n++;
      continue;
    }

    const ex = await query(
      `SELECT id FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid AND week_start_date = $2::date`,
      [SOLICITUD_UUID, r.week_start_date]
    );

    if (ex.rows.length > 0) {
      await query(
        `UPDATE module_miauto_cuota_semanal SET
          due_date = $1::date,
          num_viajes = $2,
          partner_fees_raw = $3,
          partner_fees_83 = $4,
          bono_auto = $5,
          cuota_semanal = $6,
          amount_due = $7,
          paid_amount = $8,
          status = $9,
          moneda = $10,
          pct_comision = $11,
          cobro_saldo = $12,
          late_fee = $13,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $14::uuid`,
        [
          payload.due_date,
          payload.num_viajes,
          payload.partner_fees_raw,
          payload.partner_fees_83,
          payload.bono_auto,
          payload.cuota_semanal,
          payload.amount_due,
          payload.paid_amount,
          payload.status,
          payload.moneda,
          payload.pct_comision,
          payload.cobro_saldo,
          payload.late_fee,
          ex.rows[0].id,
        ]
      );
    } else {
      await query(
        `INSERT INTO module_miauto_cuota_semanal
          (solicitud_id, week_start_date, due_date, num_viajes, partner_fees_raw, partner_fees_83, bono_auto,
           cuota_semanal, amount_due, paid_amount, status, moneda, pct_comision, cobro_saldo, late_fee)
         VALUES ($1::uuid, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          SOLICITUD_UUID,
          payload.week_start_date,
          payload.due_date,
          payload.num_viajes,
          payload.partner_fees_raw,
          payload.partner_fees_83,
          payload.bono_auto,
          payload.cuota_semanal,
          payload.amount_due,
          payload.paid_amount,
          payload.status,
          payload.moneda,
          payload.pct_comision,
          payload.cobro_saldo,
          payload.late_fee,
        ]
      );
    }
    n++;
  }

  console.log(`Listo: ${n} fila(s). Sin mora (late_fee=0, sin updateMoraDiaria).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
