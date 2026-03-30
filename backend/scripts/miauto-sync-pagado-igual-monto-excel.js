/**
 * Sincroniza en BD paid_amount con la columna MONTO del Excel (Cuotas Semanales).
 * late_fee = 0. due calculado desde Excel debe ser < --cutoff-date (default 2026-03-30).
 *
 *   node scripts/miauto-sync-pagado-igual-monto-excel.js --dry-run
 *   node scripts/miauto-sync-pagado-igual-monto-excel.js [ruta.xlsx] [--cutoff-date YYYY-MM-DD]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import { query } from '../config/database.js';
import { round2 } from '../services/miautoMoneyUtils.js';
import { mondayOfWeekContainingYmd, computeDueDateForMiAutoCuota } from '../utils/miautoLimaWeekRange.js';
import { isSemanaDepositoMiAuto, persistPaidAmountCapsForSolicitud } from '../services/miautoCuotaSemanalService.js';

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

function parseViajesCell(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return { skip: false };
  if (/^promedio$/i.test(t)) return { skip: true };
  return { skip: false };
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

async function findSolicitud(placaNorm, dniDigits) {
  if (placaNorm) {
    const r = await query(
      `SELECT s.id, s.fecha_inicio_cobro_semanal
       FROM module_miauto_solicitud s
       WHERE REGEXP_REPLACE(UPPER(TRIM(COALESCE(s.placa_asignada,''))), '\\s', '', 'g') = $1
       ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
      [placaNorm]
    );
    if (r.rows[0]) return r.rows[0];
  }
  if (dniDigits && dniDigits.length >= 4) {
    const r2 = await query(
      `SELECT s.id, s.fecha_inicio_cobro_semanal
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
    actualizados: 0,
    skipped_cutoff: 0,
    skipped_promedio: 0,
    skipped_sin_fila_bd: 0,
    skipped_bad_fecha: 0,
    skipped_bad_monto: 0,
    dry_skipped: 0,
    warnings: [],
  };

  const touched = new Set();

  for (let row = FIRST_DATA_ROW; row <= maxRow; row++) {
    const placaNorm = normalizePlacaAsignada(cellToString(getCell(ws, row, COL_PLACA)));
    const dniDigits = String(cellToString(getCell(ws, row, COL_DNI)) || '').replace(/\D/g, '');
    if (!placaNorm && dniDigits.length < 4) continue;

    const sol = await findSolicitud(placaNorm, dniDigits);
    if (!sol) {
      stats.warnings.push({ row, msg: 'sin solicitud' });
      continue;
    }

    const fiYmd = ymdFromFi(sol.fecha_inicio_cobro_semanal);

    for (let k = 0; k < 40; k++) {
      const c0 = CUOTA_BASE_COL + k * 4;
      const cFecha = getCell(ws, row, c0);
      const cViajes = getCell(ws, row, c0 + 1);
      const cMonto = getCell(ws, row, c0 + 2);

      const fechaStr = cellToString(cFecha);
      const viajesStr = cellToString(cViajes);
      const montoStr = cellToString(cMonto);
      if (!fechaStr && !viajesStr && !montoStr) {
        if (k === 0) break;
        continue;
      }

      if (parseViajesCell(viajesStr).skip) {
        stats.skipped_promedio++;
        continue;
      }

      const ymd = fechaCellToYmd(cFecha);
      if (!ymd) {
        stats.skipped_bad_fecha++;
        continue;
      }

      const weekStart = mondayOfWeekContainingYmd(ymd);
      const isPrimera = isSemanaDepositoMiAuto(weekStart, sol.fecha_inicio_cobro_semanal);
      const dueDate = computeDueDateForMiAutoCuota(weekStart, fiYmd, isPrimera);
      const dueYmd = String(dueDate).trim().slice(0, 10);

      if (dueYmd >= cutoff) {
        stats.skipped_cutoff++;
        continue;
      }

      let parsed;
      try {
        parsed = parseMontoCell(cMonto, 'USD');
      } catch (e) {
        stats.skipped_bad_monto++;
        stats.warnings.push({ row, block: k + 1, msg: String(e.message) });
        continue;
      }

      const ex = await query(
        `SELECT id, paid_amount::text, moneda FROM module_miauto_cuota_semanal
         WHERE solicitud_id = $1::uuid AND week_start_date = $2::date`,
        [sol.id, weekStart]
      );

      if (ex.rows.length === 0) {
        stats.skipped_sin_fila_bd++;
        stats.warnings.push({ row, block: k + 1, msg: 'sin fila cuota en BD', weekStart, solicitud_id: sol.id });
        continue;
      }

      const cuotaId = ex.rows[0].id;
      console.log(
        row + ':' + (k + 1) + ' sol=' + sol.id + ' ws=' + weekStart + ' paid_amount:=' + parsed.monto + ' ' + parsed.moneda + ' (era ' + ex.rows[0].paid_amount + ')'
      );

      if (dryRun) {
        stats.dry_skipped++;
        continue;
      }

      await query(
        `UPDATE module_miauto_cuota_semanal
         SET paid_amount = $1, late_fee = 0, moneda = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3::uuid`,
        [parsed.monto, parsed.moneda, cuotaId]
      );
      stats.actualizados++;
      touched.add(String(sol.id));
    }
  }

  if (!dryRun) {
    for (const sid of touched) {
      try {
        await persistPaidAmountCapsForSolicitud(sid);
      } catch (e) {
        stats.warnings.push({ solicitud_id: sid, msg: 'persistPaidAmountCaps: ' + String(e.message || e) });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        script: 'miauto-sync-pagado-igual-monto-excel',
        dryRun,
        cutoff,
        xlsxPath,
        stats,
        solicitudes_tocadas: touched.size,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
