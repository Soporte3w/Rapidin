/**
 * Carga cuotas Mi Auto desde hoja Cuotas Semanales (Excel ENTREGA INMEDIATA).
 * Uso: npm run miauto:cargar-cuotas-excel-entrega -- --dry-run
 *      npm run miauto:cargar-cuotas-excel-entrega -- --validate-only
 *      npm run miauto:cargar-cuotas-excel-entrega -- --delete-first (PELIGROSO: ver advertencia)
 *
 * --validate-only: solo valida estructura y datos, no importa.
 * --delete-first: ⚠️ borra TODAS las cuotas existentes antes de importar.
 *    Se recomienda usar --reset-solicitud-keep-week o --only-solicitud-id como alternativa.
 * No depende de cronograma rules; usa el monto del Excel directamente.
 * Marca `montos_fuente = 'excel'` en BD para que la API no recalcule cuota con mora/máximo del cronograma.
 * Moneda se determina por el cronograma vinculado a la solicitud.
 *
 * Corte: solo celdas con due_date calculado desde Excel < --cutoff-date (ej. 2026-04-13 deja fuera la cuota del 13 abr).
 *
 * --reset-solicitud-keep-week <uuid> <YYYY-MM-DD>: antes de importar, borra todas las cuotas de esa solicitud
 *   excepto la fila cuyo week_start_date (lunes) coincide con esa fecha (p. ej. regenerada en sistema).
 * --only-solicitud-id <uuid>: solo procesa la fila del Excel que resuelve a esa solicitud (no toca otros conductores).
 */
import fs from 'fs';
import XLSX from 'xlsx';
import { query } from '../config/database.js';
import { round2 } from '../yego_miauto/services/utils/miautoMoneyUtils.js';
import {
  getCronogramasByIds,
  getMonedaCuotaSemanalPorVehiculo,
} from '../yego_miauto/services/cronograma/miautoCronogramaService.js';
import { mondayOfWeekContainingYmd, computeDueDateForMiAutoCuota } from '../utils/miautoLimaWeekRange.js';
import {
  isSemanaDepositoMiAuto,
  persistPaidAmountCapsForSolicitud,
} from '../yego_miauto/services/cuotas/miautoCuotaSemanalService.js';
import { defaultEntregaInmediataXlsxPath, SHEET_CUOTAS_SEMANALES } from './miauto-entrega-inmediata-default-xlsx.js';

const SHEET_NAME = SHEET_CUOTAS_SEMANALES;
const CUOTA_BASE_COL = 15;
const COL_PLACA = 4;
const COL_DNI = 6;
const COL_PHONE = 7;
const COL_STATUS = 1;
const FIRST_DATA_ROW = 3;
const DEFAULT_CUTOFF = '2026-04-13';
const DEFAULT_XLSX = defaultEntregaInmediataXlsxPath();

function normalizePlacaAsignada(value) {
  if (value == null) return '';
  return String(value).trim().toUpperCase().replace(/\s+/g, '');
}

function normalizePhone(value) {
  if (value == null) return '';
  return String(value).replace(/\D/g, '');
}

const MAX_CUOTA_BLOCKS = 260;

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const deleteFirst = argv.includes('--delete-first');
  let cutoff = DEFAULT_CUTOFF;
  let xlsxPath = null;
  let onlySolicitudId = null;
  /** @type {{ solicitudId: string, weekYmd: string }|null} */
  let resetSolicitudKeepWeek = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cutoff-date' && argv[i + 1]) {
      cutoff = String(argv[i + 1]).trim().slice(0, 10);
      i++;
      continue;
    }
    if (argv[i] === '--only-solicitud-id' && argv[i + 1]) {
      onlySolicitudId = String(argv[i + 1]).trim();
      i++;
      continue;
    }
    if (argv[i] === '--reset-solicitud-keep-week' && argv[i + 1] && argv[i + 2]) {
      resetSolicitudKeepWeek = {
        solicitudId: String(argv[i + 1]).trim(),
        weekYmd: String(argv[i + 2]).trim().slice(0, 10),
      };
      i += 2;
      continue;
    }
    if (argv[i].startsWith('--')) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(argv[i])) continue;
    if (/\.xlsx$/i.test(argv[i]) || fs.existsSync(argv[i])) xlsxPath = argv[i];
  }
  if (!xlsxPath) xlsxPath = DEFAULT_XLSX;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error('--cutoff-date invalida: ' + cutoff);
  if (resetSolicitudKeepWeek && !/^\d{4}-\d{2}-\d{2}$/.test(resetSolicitudKeepWeek.weekYmd)) {
    throw new Error('--reset-solicitud-keep-week: fecha lunes invalida');
  }
  return { dryRun, deleteFirst, cutoff, xlsxPath, onlySolicitudId, resetSolicitudKeepWeek };
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
    return { monto: round2(Number(montoStr)), moneda: defaultMoneda || 'PEN' };
  }
  if (s === '') throw new Error('Monto vacio');
  let numPart = s;
  const upper = s.toUpperCase();
  if (/^S\/?\.?\s*/i.test(s) || /^SOLES?\b/i.test(upper)) {
    numPart = s.replace(/^S\/?\.?\s*/i, '').replace(/^SOLES?\s*/i, '').trim();
  } else if (
    /^\$/i.test(s) ||
    /^USD\b/i.test(upper) ||
    /^US\$/.test(upper) ||
    /^D[oó]L/i.test(s)
  ) {
    numPart = s.replace(/^\$/i, '').replace(/^USD\s*/i, '').replace(/^US\$\s*/i, '').replace(/^D[oó]L(?:ARES?)?\.?\s*/i, '').trim();
  } else {
    numPart = s;
  }
  const n = parseFloat(String(numPart).replace(/,/g, ''));
  if (Number.isNaN(n)) throw new Error('Monto no numerico: ' + montoStr);
  return { monto: round2(n), moneda: defaultMoneda || 'PEN' };
}

function parseMontoCell(cell, defaultMoneda) {
  if (!cell) throw new Error('Sin celda monto');
  const v = cell.v;
  if (typeof v === 'number') {
    return { monto: round2(v), moneda: defaultMoneda || 'PEN' };
  }
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

async function loadCronogramasForMoneda() {
  const res = await query(
    `SELECT DISTINCT cronograma_id FROM module_miauto_solicitud WHERE cronograma_id IS NOT NULL`
  );
  const ids = (res.rows || []).map((r) => r.cronograma_id).filter(Boolean);
  return getCronogramasByIds(ids);
}

async function findSolicitud(placaNorm, dniDigits, phoneDigits) {
  if (placaNorm) {
    const r = await query(
      `SELECT s.id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal, s.placa_asignada,
              REGEXP_REPLACE(COALESCE(TRIM(s.dni),''), '[^0-9]', '', 'g') AS sol_dni,
              REGEXP_REPLACE(COALESCE(TRIM(s.phone),''), '[^0-9]', '', 'g') AS sol_phone
       FROM module_miauto_solicitud s
       WHERE REGEXP_REPLACE(UPPER(TRIM(COALESCE(s.placa_asignada,''))), '\\s', '', 'g') = $1
       ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
      [placaNorm]
    );
    if (r.rows[0]) {
      const solDni = r.rows[0].sol_dni || '';
      const solPhone = r.rows[0].sol_phone || '';
      if (dniDigits && dniDigits.length >= 4 && solDni && solDni !== dniDigits) {
        console.warn(`[PLACA-COMPARTIDA] Placa ${placaNorm} coincide con solicitud ${r.rows[0].id} pero DNI difiere (Excel: ${dniDigits}, BD: ${solDni}). Se busca solicitud separada para no asociar cuotas a otra persona.`);
      } else {
        if (phoneDigits && phoneDigits.length >= 7 && solPhone && !solPhone.includes(phoneDigits.slice(-9))) {
          console.warn(`[MATCH-WARN] Placa ${placaNorm} coincide con solicitud ${r.rows[0].id} pero teléfono difiere (Excel: ${phoneDigits}, BD: ${solPhone}).`);
        }
        return r.rows[0];
      }
    }
  }
  if (dniDigits && dniDigits.length >= 4) {
    const r2 = await query(
      `SELECT s.id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal, s.placa_asignada
       FROM module_miauto_solicitud s
       LEFT JOIN module_rapidin_drivers rd ON rd.id::text = s.driver_id_fleet
       WHERE REGEXP_REPLACE(COALESCE(TRIM(s.dni),''), '[^0-9]', '', 'g') = $1
          OR REGEXP_REPLACE(COALESCE(TRIM(rd.dni),''), '[^0-9]', '', 'g') = $1
       ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
      [dniDigits]
    );
    if (r2.rows[0]) {
      if (placaNorm && r2.rows[0].placa_asignada && String(r2.rows[0].placa_asignada).trim().toUpperCase() !== placaNorm) {
        console.warn(`[MATCH-WARN] DNI ${dniDigits} coincide con solicitud ${r2.rows[0].id} pero placa difiere (Excel: ${placaNorm}, BD: ${r2.rows[0].placa_asignada}).`);
      }
      return r2.rows[0];
    }
  }
  if (phoneDigits && phoneDigits.length >= 7) {
    const r3 = await query(
      `SELECT s.id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal, s.placa_asignada
       FROM module_miauto_solicitud s
       WHERE REGEXP_REPLACE(COALESCE(TRIM(s.phone),''), '[^0-9]', '', 'g') LIKE '%' || $1
       ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
      [phoneDigits.slice(-9)]
    );
    if (r3.rows[0]) {
      if (placaNorm && r3.rows[0].placa_asignada && String(r3.rows[0].placa_asignada).trim().toUpperCase() !== placaNorm) {
        console.warn(`[MATCH-WARN] Teléfono ${phoneDigits} coincide con solicitud ${r3.rows[0].id} pero placa difiere (Excel: ${placaNorm}, BD: ${r3.rows[0].placa_asignada}).`);
      }
      return r3.rows[0];
    }
    return null;
  }
  return null;
}

async function findSolicitudByPlacaOnly(placaNorm) {
  if (!placaNorm) return null;
  const r = await query(
    `SELECT s.id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal, s.placa_asignada
     FROM module_miauto_solicitud s
     WHERE REGEXP_REPLACE(UPPER(TRIM(COALESCE(s.placa_asignada,''))), '\\s', '', 'g') = $1
       AND s.status = 'aprobado'
     ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
    [placaNorm]
  );
  return r.rows[0] || null;
}

function ymdFromFi(fi) {
  if (fi instanceof Date) return fi.toISOString().slice(0, 10);
  return String(fi || '').trim().slice(0, 10);
}

async function main() {
  const { dryRun, deleteFirst, cutoff, xlsxPath, onlySolicitudId, resetSolicitudKeepWeek } = parseArgs(
    process.argv.slice(2)
  );
  if (!fs.existsSync(xlsxPath)) {
    console.error('No existe el archivo:', xlsxPath);
    process.exit(1);
  }

  // Validación previa de estructura Excel
  console.log('=== Validando estructura del Excel ===');
  const validator = await import('../services/ExcelValidator.js');
  const validation = await validator.validateExcelStructure(xlsxPath, validator.CUOTAS_SEMANALES_STRUCTURE);
  if (!validation.valid) {
    console.error('ERRORES DE ESTRUCTURA:');
    for (const e of validation.errors) {
      console.error(`  Fila ${e.row}, Columna ${e.column}: ${e.reason}`);
    }
    if (validation.warnings.length > 0) {
      console.warn('ADVERTENCIAS:');
      for (const w of validation.warnings) {
        console.warn(`  Fila ${w.row}, Columna ${w.column}: ${w.reason}`);
      }
    }
    console.error('Corrija los errores antes de importar.');
    process.exit(1);
  }
  console.log(`Estructura OK: ${validation.stats.totalRows} filas de datos detectadas`);

  if (process.argv.includes('--validate-only')) {
    console.log('--validate-only activado. No se importarán datos.');
    process.exit(0);
  }

  console.log('=== Moneda por vehículo/reglas del cronograma (no por cuotas previas) ===');
  const cronogramaById = await loadCronogramasForMoneda();
  console.log('Cronogramas cargados:', cronogramaById.size);

  if (resetSolicitudKeepWeek) {
    const { solicitudId, weekYmd } = resetSolicitudKeepWeek;
    if (dryRun) {
      const c = await query(
        `SELECT COUNT(*)::int AS n FROM module_miauto_cuota_semanal
         WHERE solicitud_id = $1::uuid
           AND (week_start_date IS NULL OR week_start_date::date <> $2::date)`,
        [solicitudId, weekYmd]
      );
      console.log(
        '[DRY-RUN] --reset-solicitud-keep-week eliminaría',
        c.rows[0].n,
        'cuota(s); se mantiene week_start_date::date =',
        weekYmd
      );
    } else {
      const del = await query(
        `DELETE FROM module_miauto_cuota_semanal
         WHERE solicitud_id = $1::uuid
           AND (week_start_date IS NULL OR week_start_date::date <> $2::date)`,
        [solicitudId, weekYmd]
      );
      console.log(
        '--reset-solicitud-keep-week: eliminadas',
        del.rowCount,
        'cuota(s); conservada la fila del lunes',
        weekYmd
      );
    }
  }

  if (deleteFirst && !dryRun) {
    console.log('=== ELIMINANDO todas las cuotas semanales existentes ===');
    const del = await query('DELETE FROM module_miauto_cuota_semanal');
    console.log('Cuotas eliminadas:', del.rowCount);
  } else if (deleteFirst && dryRun) {
    const cnt = await query('SELECT COUNT(*) as total FROM module_miauto_cuota_semanal');
    console.log('[DRY-RUN] Se eliminarian', cnt.rows[0].total, 'cuotas');
  }

  const wb = XLSX.readFile(xlsxPath, { cellDates: true, raw: true });
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    console.error('No hay hoja ' + SHEET_NAME);
    process.exit(1);
  }

  const cuotasBatch = [];
  const BATCH_SIZE = 200;

  async function flushBatch() {
    if (cuotasBatch.length === 0) return;
    const deduped = new Map();
    for (const c of cuotasBatch) {
      const key = c.solicitud_id + '|' + c.week_start_date;
      if (!deduped.has(key)) deduped.set(key, c);
    }
    const dedupedArr = [...deduped.values()];
    const vals = [];
    const params = [];
    let n = 1;
    for (const c of dedupedArr) {
      vals.push(`($${n}::uuid, $${n+1}::date, $${n+2}::date, $${n+3}, $${n+4}, $${n+5}, $${n+6}, $${n+7}, $${n+8}, $${n+9}, $${n+10}, $${n+11}, $${n+12}, $${n+13}, $${n+14}, 'excel')`);
      params.push(c.solicitud_id, c.week_start_date, c.due_date, c.num_viajes, c.partner_fees_raw, c.partner_fees_83, c.bono_auto, c.cuota_semanal, c.amount_due, c.paid_amount, c.status, c.moneda, c.pct_comision, c.cobro_saldo, c.late_fee);
      n += 15;
    }
    await query(`INSERT INTO module_miauto_cuota_semanal (solicitud_id, week_start_date, due_date, num_viajes, partner_fees_raw, partner_fees_83, bono_auto, cuota_semanal, amount_due, paid_amount, status, moneda, pct_comision, cobro_saldo, late_fee, montos_fuente) VALUES ${vals.join(', ')} ON CONFLICT (solicitud_id, week_start_date) DO NOTHING`, params);
    stats.db_inserts += cuotasBatch.length;
    cuotasBatch.length = 0;
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
    skipped_bad_fecha: 0,
    skipped_bad_monto: 0,
    db_inserts: 0,
    warnings: [],
    errors: [],
  };

  const touchedSolicitudes = new Set();
  const limaToday = limaTodayYmd();

  for (let row = FIRST_DATA_ROW; row <= maxRow; row++) {
    const placaRaw = cellToString(getCell(ws, row, COL_PLACA));
    const dniRaw = cellToString(getCell(ws, row, COL_DNI));
    const phoneRaw = cellToString(getCell(ws, row, COL_PHONE));
    const placaNorm = normalizePlacaAsignada(placaRaw);
    const dniDigits = String(dniRaw || '').replace(/\D/g, '');
    const phoneDigits = normalizePhone(phoneRaw);

    if (!placaNorm && dniDigits.length < 4 && phoneDigits.length < 7) continue;

    const statusExcel = cellToString(getCell(ws, row, COL_STATUS));
    const isInactivo = String(statusExcel).trim().toUpperCase() === 'INACTIVO';

    let sol;
    if (isInactivo) {
      sol = await findSolicitudByPlacaOnly(placaNorm);
      if (!sol) {
        stats.skipped_no_solicitud++;
        stats.warnings.push({ row, msg: 'INACTIVO sin solicitud activa (placa)', placa: placaRaw });
        continue;
      }
      console.log(`[INACTIVO→ACTIVO] ${placaNorm}: cuotas del dueño transferidas al conductor activo (solicitud ${sol.id})`);
    } else {
      sol = await findSolicitud(placaNorm, dniDigits, phoneDigits);
      if (!sol) {
        stats.skipped_no_solicitud++;
        stats.warnings.push({ row, msg: 'sin solicitud', placa: placaRaw, dni: dniRaw, phone: phoneRaw });
        continue;
      }
    }

    if (onlySolicitudId && String(sol.id) !== onlySolicitudId) {
      continue;
    }

    const cr = cronogramaById.get(String(sol.cronograma_id));
    const defaultMoneda =
      cr && sol.cronograma_vehiculo_id
        ? getMonedaCuotaSemanalPorVehiculo(cr, sol.cronograma_vehiculo_id)
        : 'PEN';
    const fiYmd = ymdFromFi(sol.fecha_inicio_cobro_semanal);

    for (let k = 0; k < MAX_CUOTA_BLOCKS; k++) {
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

      const numViajes = isPrimera ? 0 : viajesParsed.num;

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

      let montoExcel;
      try {
        montoExcel = parseMontoCell(cMonto, defaultMoneda);
      } catch (e) {
        stats.skipped_bad_monto++;
        stats.warnings.push({ row, block: k + 1, msg: String(e.message) });
        continue;
      }

      let amountDue;
      let paidAmount;
      let status;
      const monedaRow = montoExcel.moneda;

      if (paidFlag === true) {
        amountDue = montoExcel.monto;
        paidAmount = amountDue;
        status = 'paid';
      } else {
        amountDue = montoExcel.monto;
        ({ status, paid_amount: paidAmount } = statusForUnpaid(dueYmd, limaToday));
      }

      const payload = {
        week_start_date: weekStart,
        due_date: dueYmd,
        num_viajes: numViajes,
        partner_fees_raw: 0,
        partner_fees_83: 0,
        bono_auto: 0,
        cuota_semanal: amountDue,
        amount_due: amountDue,
        paid_amount: paidAmount,
        status,
        moneda: monedaRow,
        pct_comision: 0,
        cobro_saldo: 0,
        late_fee: 0,
      };

      stats.aplicables++;
      console.log(row + ':' + (k + 1) + ' sol=' + sol.id + ' ws=' + weekStart + ' due=' + dueYmd + ' ' + status + ' amt=' + amountDue + ' ' + monedaRow);

      if (dryRun) continue;

      cuotasBatch.push({
        solicitud_id: sol.id,
        week_start_date: payload.week_start_date,
        due_date: payload.due_date,
        num_viajes: payload.num_viajes,
        partner_fees_raw: payload.partner_fees_raw,
        partner_fees_83: payload.partner_fees_83,
        bono_auto: payload.bono_auto,
        cuota_semanal: payload.cuota_semanal,
        amount_due: payload.amount_due,
        paid_amount: payload.paid_amount,
        status: payload.status,
        moneda: payload.moneda,
        pct_comision: payload.pct_comision,
        cobro_saldo: payload.cobro_saldo,
        late_fee: payload.late_fee,
      });
      if (cuotasBatch.length >= BATCH_SIZE) await flushBatch();
    }
  }
  // Flush remaining cuotas
  if (!dryRun) await flushBatch();

  if (!dryRun) {
    for (const sid of touchedSolicitudes) {
      try {
        await persistPaidAmountCapsForSolicitud(sid, { onlyCapDueBeforeYmd: cutoff });
      } catch (e) {
        stats.errors.push({ solicitud_id: sid, msg: String(e.message || e) });
      }
    }

    for (const sid of touchedSolicitudes) {
      const countRes = await query(
        `SELECT COUNT(*)::int AS n FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid AND (week_start_date IS NOT NULL OR due_date IS NOT NULL)`,
        [sid]
      );
      const solRes = await query(
        `SELECT v.cuotas_semanales FROM module_miauto_solicitud s
         JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id
         WHERE s.id = $1::uuid`,
        [sid]
      );
      const expected = solRes.rows[0] ? parseInt(solRes.rows[0].cuotas_semanales, 10) || 0 : 0;
      const actual = countRes.rows[0]?.n || 0;
      if (expected > 0 && actual !== expected) {
        console.warn(`[CUOTAS-COUNT] Solicitud ${sid}: esperadas ${expected} cuotas (plan vehículo), cargadas ${actual}. Diferencia: ${expected - actual}.`);
      }
      console.log(`[CUOTAS-COUNT] Solicitud ${sid}: ${actual} cuotas cargadas (plan: ${expected || 'desconocido'}).`);
    }
  }

  // Registrar en import_log para auditoría
  if (!dryRun) {
    try {
      const crypto = await import('crypto');
      const fsPromises = await import('fs/promises');
      const fileBuffer = await fsPromises.readFile(xlsxPath);
      const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const fileSize = fileBuffer.length;
      const status = stats.errors.length === 0 ? 'completed' : 'partial';
      await query(
        `INSERT INTO module_miauto_import_log (file_name, file_hash, file_size_bytes, import_type, status, total_rows, success_rows, error_rows, errors, dry_run, started_at, completed_at)
         VALUES ($1, $2, $3, 'cuotas_semanales', $4, $5, $6, $7, $8::jsonb, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [xlsxPath, fileHash, fileSize, status, stats.aplicables + stats.skipped_cutoff + stats.skipped_promedio + stats.skipped_empty_validation + stats.skipped_no_solicitud + stats.skipped_bad_fecha + stats.skipped_bad_monto, stats.db_inserts, stats.errors.length, JSON.stringify(stats.errors)]
      );
    } catch (auditErr) {
      console.warn('No se pudo registrar en import_log (no afecta la importación):', auditErr.message);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    deleteFirst,
    cutoff,
    xlsxPath,
    onlySolicitudId: onlySolicitudId || null,
    resetSolicitudKeepWeek: resetSolicitudKeepWeek || null,
    stats,
    solicitudes_tocadas: touchedSolicitudes.size,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
