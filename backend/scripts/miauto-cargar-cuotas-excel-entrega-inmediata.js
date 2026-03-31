/**
 * Carga cuotas Mi Auto desde hoja Cuotas Semanales (Excel ENTREGA INMEDIATA).
 * Uso: npm run miauto:cargar-cuotas-excel-entrega -- --dry-run
 *
 * Corte: solo celdas con due_date calculado desde Excel < --cutoff-date (default 2026-03-30).
 * Para esas filas el monto del Excel es la obligación total del periodo (cuota + mora ya mezclada):
 * `late_fee` siempre 0 en BD; `amount_due` y `paid_amount` (si ✓) = monto Excel.
 * No se usa el monto derivado del cronograma para cuotas impagas bajo el corte.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import { query } from '../config/database.js';
import { getCronogramaById } from '../services/miautoCronogramaService.js';
import { round2 } from '../services/miautoMoneyUtils.js';
import { mondayOfWeekContainingYmd, computeDueDateForMiAutoCuota } from '../utils/miautoLimaWeekRange.js';
import {
  isSemanaDepositoMiAuto,
  planCuotaFromCronogramaViajes,
  persistPaidAmountCapsForSolicitud,
} from '../services/miautoCuotaSemanalService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHEET_NAME = 'Cuotas Semanales';
const CUOTA_BASE_COL = 15;
const COL_PLACA = 4;
const COL_DNI = 6;
const FIRST_DATA_ROW = 3;
const DEFAULT_CUTOFF = '2026-03-30';
const DEFAULT_XLSX = path.join(__dirname, '../../ENTREGA INMEDIATA - GIOMAR SISTEMAS - FINAL.xlsx');

function normalizePlacaAsignada(value) {
  if (value == null) return '';
  return String(value).trim().toUpperCase().replace(/\s+/g, '');
}

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  let cutoff = DEFAULT_CUTOFF;
  let xlsxPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cutoff-date' && argv[i + 1]) {
      cutoff = String(argv[i + 1]).trim().slice(0, 10);
      i++;
      continue;
    }
    if (argv[i].startsWith('--')) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(argv[i])) continue;
    if (/\.xlsx$/i.test(argv[i]) || fs.existsSync(argv[i])) xlsxPath = argv[i];
  }
  if (!xlsxPath) xlsxPath = DEFAULT_XLSX;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error('--cutoff-date invalida: ' + cutoff);
  return { dryRun, cutoff, xlsxPath };
}

function excelSerialToYmd(n) {
  const intPart = Math.floor(Number(n));
  const base = Date.UTC(1899, 11, 30);
  const d = new Date(base + intPart * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function getCell(ws, row1, col0) {
  return ws[XLSX.utils.encode_cell({ r: row1 - 1, c: col0 })];
}

function cellToString(cell) {
  if (!cell) return '';
  if (cell.w != null && String(cell.w).trim() !== '') return String(cell.w).trim();
  const v = cell.v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (v == null) return '';
  return String(v).trim();
}

function fechaCellToYmd(cell) {
  if (!cell) return null;
  const v = cell.v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return excelSerialToYmd(v);
  const s = cellToString(cell);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s.replace(/\s/g, ''));
  if (dm) {
    let y = Number(dm[3]);
    if (y < 100) y += 2000;
    const mm = String(Number(dm[2])).padStart(2, '0');
    const dd = String(Number(dm[1])).padStart(2, '0');
    return y + '-' + mm + '-' + dd;
  }
  return null;
}

function parsePaidFlag(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/[\u2714\u2713\u2611]/.test(s) || s === '\u2705') return true;
  if (s.includes('\u274C') || /^x$/i.test(s) || s.toLowerCase() === 'no') return false;
  return null;
}

function parseViajesCell(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return { num: 0, skip: false };
  if (/^promedio$/i.test(t)) return { num: 0, skip: true };
  if (/^dep[o\u00F3]sito$/i.test(t) || t === '-') return { num: 0, skip: false };
  const intMatch = t.match(/(\d+)/);
  if (intMatch) return { num: parseInt(intMatch[1], 10) || 0, skip: false };
  const n = parseInt(t, 10);
  if (!Number.isNaN(n)) return { num: n, skip: false };
  return { num: 0, skip: false };
}

function parseMontoYMoneda(montoStr, defaultMoneda) {
  const s = String(montoStr ?? '').trim();
  if (s === '' && typeof montoStr === 'number') {
    return { monto: round2(Number(montoStr)), moneda: defaultMoneda || 'USD' };
  }
  if (s === '') throw new Error('Monto vacio');
  let moneda = defaultMoneda || 'USD';
  let numPart = s;
  if (/^S\//i.test(s)) {
    moneda = 'PEN';
    numPart = s.replace(/^S\//i, '').trim();
  } else numPart = s.replace(/^\$/i, '').trim();
  const n = parseFloat(numPart.replace(/,/g, ''));
  if (Number.isNaN(n)) throw new Error('Monto no numerico: ' + montoStr);
  return { monto: round2(n), moneda };
}

function parseMontoCell(cell, defaultMoneda) {
  if (!cell) throw new Error('Sin celda monto');
  const v = cell.v;
  if (typeof v === 'number') return { monto: round2(v), moneda: defaultMoneda || 'USD' };
  return parseMontoYMoneda(cellToString(cell), defaultMoneda);
}

function limaTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function statusForUnpaid(dueYmd, limaToday) {
  if (dueYmd < limaToday) return { status: 'overdue', paid_amount: round2(0) };
  return { status: 'pending', paid_amount: round2(0) };
}

async function findSolicitud(placaNorm, dniDigits) {
  if (placaNorm) {
    const r = await query(
      `SELECT s.id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal, s.placa_asignada
       FROM module_miauto_solicitud s
       WHERE REGEXP_REPLACE(UPPER(TRIM(COALESCE(s.placa_asignada,''))), '\\s', '', 'g') = $1
       ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
      [placaNorm]
    );
    if (r.rows[0]) return r.rows[0];
  }
  if (dniDigits && dniDigits.length >= 4) {
    const r2 = await query(
      `SELECT s.id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal, s.placa_asignada
       FROM module_miauto_solicitud s
       LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
       WHERE REGEXP_REPLACE(COALESCE(TRIM(s.dni),''), '[^0-9]', '', 'g') = $1
          OR REGEXP_REPLACE(COALESCE(TRIM(rd.dni),''), '[^0-9]', '', 'g') = $1
       ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
      [dniDigits]
    );
    return r2.rows[0] || null;
  }
  return null;
}

function ymdFromFi(fi) {
  if (fi instanceof Date) return fi.toISOString().slice(0, 10);
  return String(fi || '').trim().slice(0, 10);
}

async function main() {
  const { dryRun, cutoff, xlsxPath } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(xlsxPath)) {
    console.error('No existe el archivo:', xlsxPath);
    process.exit(1);
  }

  const wb = XLSX.readFile(xlsxPath, { cellDates: true, raw: true });
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    console.error('No hay hoja ' + SHEET_NAME);
    process.exit(1);
  }

  const ref = ws['!ref'];
  const range = ref ? XLSX.utils.decode_range(ref) : { e: { r: 0, c: 0 } };
  const maxRow = range.e.r + 1;

  const stats = {
    aplicables: 0,
    skipped_cutoff: 0,
    skipped_promedio: 0,
    skipped_empty_validation: 0,
    skipped_no_solicitud: 0,
    skipped_no_cronograma: 0,
    skipped_no_plan: 0,
    skipped_bad_fecha: 0,
    skipped_bad_monto: 0,
    db_updates: 0,
    warnings: [],
    errors: [],
  };

  const cronogramaCache = new Map();
  const touchedSolicitudes = new Set();
  const limaToday = limaTodayYmd();

  for (let row = FIRST_DATA_ROW; row <= maxRow; row++) {
    const placaRaw = cellToString(getCell(ws, row, COL_PLACA));
    const dniRaw = cellToString(getCell(ws, row, COL_DNI));
    const placaNorm = normalizePlacaAsignada(placaRaw);
    const dniDigits = String(dniRaw || '').replace(/\D/g, '');

    if (!placaNorm && dniDigits.length < 4) continue;

    const sol = await findSolicitud(placaNorm, dniDigits);
    if (!sol) {
      stats.skipped_no_solicitud++;
      stats.warnings.push({ row, msg: 'sin solicitud', placa: placaRaw, dni: dniRaw });
      continue;
    }

    const crId = sol.cronograma_id;
    const vehId = sol.cronograma_vehiculo_id;
    if (!crId || !vehId) {
      stats.skipped_no_cronograma++;
      stats.warnings.push({ row, solicitud_id: sol.id, msg: 'sin cronograma o vehiculo' });
      continue;
    }

    let cronograma = cronogramaCache.get(String(crId));
    if (!cronograma) {
      cronograma = await getCronogramaById(crId);
      cronogramaCache.set(String(crId), cronograma);
    }
    if (!cronograma?.rules?.length) {
      stats.skipped_no_cronograma++;
      continue;
    }

    const fiYmd = ymdFromFi(sol.fecha_inicio_cobro_semanal);

    for (let k = 0; k < 40; k++) {
      const c0 = CUOTA_BASE_COL + k * 4;
      const cFecha = getCell(ws, row, c0);
      const cViajes = getCell(ws, row, c0 + 1);
      const cMonto = getCell(ws, row, c0 + 2);
      const cVal = getCell(ws, row, c0 + 3);

      const fechaStr = cellToString(cFecha);
      const viajesStr = cellToString(cViajes);
      const montoStr = cellToString(cMonto);
      const valStr = cellToString(cVal);

      if (!fechaStr && !viajesStr && !montoStr && !valStr) {
        if (k === 0) break;
        continue;
      }

      const ymd = fechaCellToYmd(cFecha);
      if (!ymd) {
        stats.skipped_bad_fecha++;
        stats.warnings.push({ row, block: k + 1, msg: 'fecha ilegible', raw: fechaStr });
        continue;
      }

      const weekStart = mondayOfWeekContainingYmd(ymd);
      const isPrimera = isSemanaDepositoMiAuto(weekStart, sol.fecha_inicio_cobro_semanal);
      const viajesParsed = parseViajesCell(viajesStr);
      if (viajesParsed.skip) {
        stats.skipped_promedio++;
        continue;
      }

      const numViajesPlan = isPrimera ? 0 : viajesParsed.num;
      const plan = planCuotaFromCronogramaViajes(cronograma, vehId, numViajesPlan);
      if (!plan) {
        stats.skipped_no_plan++;
        stats.warnings.push({ row, block: k + 1, msg: 'sin regla cronograma', viajes: numViajesPlan, solicitud_id: sol.id });
        continue;
      }

      const dueDate = computeDueDateForMiAutoCuota(weekStart, fiYmd, isPrimera);
      const dueYmd = String(dueDate).trim().slice(0, 10);

      if (dueYmd >= cutoff) {
        stats.skipped_cutoff++;
        continue;
      }

      const paidFlag = parsePaidFlag(valStr);
      if (paidFlag === null) {
        stats.skipped_empty_validation++;
        stats.warnings.push({ row, block: k + 1, msg: 'validacion vacia o no reconocida', val: valStr });
        continue;
      }

      const bonoStored = isPrimera ? 0 : plan.bonoAuto;

      let montoExcel;
      try {
        montoExcel = parseMontoCell(cMonto, plan.moneda);
      } catch (e) {
        stats.skipped_bad_monto++;
        stats.warnings.push({ row, block: k + 1, msg: String(e.message) });
        continue;
      }

      let amountDue;
      let paidAmount;
      let status;
      let monedaRow;

      if (paidFlag === true) {
        amountDue = montoExcel.monto;
        paidAmount = amountDue;
        status = 'paid';
        monedaRow = montoExcel.moneda;
        if (String(plan.moneda || '').toUpperCase() !== String(monedaRow || '').toUpperCase()) {
          stats.warnings.push({ row, block: k + 1, msg: 'moneda Excel ' + monedaRow + ' vs plan ' + plan.moneda, solicitud_id: sol.id });
        }
      } else {
        amountDue = montoExcel.monto;
        ({ status, paid_amount: paidAmount } = statusForUnpaid(dueYmd, limaToday));
        monedaRow = montoExcel.moneda;
        if (String(plan.moneda || '').toUpperCase() !== String(monedaRow || '').toUpperCase()) {
          stats.warnings.push({
            row,
            block: k + 1,
            msg: 'moneda Excel ' + monedaRow + ' vs plan ' + plan.moneda + ' (se usa Excel para monto)',
            solicitud_id: sol.id,
          });
        }
      }

      const payload = {
        week_start_date: weekStart,
        due_date: dueYmd,
        num_viajes: numViajesPlan,
        partner_fees_raw: 0,
        partner_fees_83: 0,
        bono_auto: bonoStored,
        cuota_semanal: plan.cuotaSemanal,
        amount_due: amountDue,
        paid_amount: paidAmount,
        status,
        moneda: monedaRow,
        pct_comision: plan.pctComision,
        cobro_saldo: plan.cobroSaldo,
        late_fee: 0,
      };

      const ex = await query(
        `SELECT id FROM module_miauto_cuota_semanal
         WHERE solicitud_id = $1::uuid AND week_start_date = $2::date`,
        [sol.id, weekStart]
      );

      stats.aplicables++;
      console.log(row + ':' + (k + 1) + ' sol=' + sol.id + ' ws=' + weekStart + ' due=' + dueYmd + ' ' + status + ' amt=' + amountDue);

      if (dryRun) continue;

      if (ex.rows.length > 0) {
        const upd = await query(
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
        if (upd.rowCount > 0) {
          stats.db_updates++;
          touchedSolicitudes.add(String(sol.id));
        } else stats.warnings.push({ row, id: ex.rows[0].id, msg: 'UPDATE 0 filas' });
      } else {
        await query(
          `INSERT INTO module_miauto_cuota_semanal
            (solicitud_id, week_start_date, due_date, num_viajes, partner_fees_raw, partner_fees_83, bono_auto,
             cuota_semanal, amount_due, paid_amount, status, moneda, pct_comision, cobro_saldo, late_fee)
           VALUES ($1::uuid, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            sol.id,
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
        stats.db_updates++;
        touchedSolicitudes.add(String(sol.id));
      }
    }
  }

  if (!dryRun) {
    for (const sid of touchedSolicitudes) {
      try {
        await persistPaidAmountCapsForSolicitud(sid, { onlyCapDueBeforeYmd: cutoff });
      } catch (e) {
        stats.errors.push({ solicitud_id: sid, msg: String(e.message || e) });
      }
    }
  }

  console.log(JSON.stringify({ ok: true, dryRun, cutoff, xlsxPath, stats, solicitudes_tocadas: touchedSolicitudes.size }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
