/**
 * Importa solicitudes Mi Auto desde la hoja "Cuotas Semanales" (Excel ENTREGA INMEDIATA):
 * crea o actualiza filas en module_miauto_solicitud con cronograma, vehículo, placa y fecha_inicio_cobro_semanal.
 * Requiere que los cronogramas y vehículos ya existan en BD (admin); no crea planes nuevos.
 *
 * Uso:
 *   node scripts/miauto-import-solicitudes-entrega-excel.js --dry-run
 *   node scripts/miauto-import-solicitudes-entrega-excel.js
 *   node scripts/miauto-import-solicitudes-entrega-excel.js /ruta/al.xlsx --dry-run
 *
 * Después (cuotas): npm run miauto:cargar-cuotas-excel-entrega -- --cutoff-date 2100-01-01
 *
 * Columna TIPO (ej. COMPLETA / parcial) → pago_tipo. Montos S/. y $ en celdas MONTO: script de cuotas.
 */
import fs from 'fs';
import XLSX from 'xlsx';
import { query } from '../config/database.js';
import { normalizePhoneForDb } from '../utils/helpers.js';
import {
  ActiveSolicitudError,
  createSolicitud,
  updateSolicitud,
} from '../yego_miauto/services/miautoSolicitudService.js';
import { defaultEntregaInmediataXlsxPath, SHEET_CUOTAS_SEMANALES } from './miauto-entrega-inmediata-default-xlsx.js';

const DEFAULT_XLSX = defaultEntregaInmediataXlsxPath();
const SHEET_NAME = SHEET_CUOTAS_SEMANALES;
const FIRST_DATA_ROW = 3;
const COL_STATUS = 1;
const COL_AUTO = 2;
const COL_CRONO = 3;
const COL_PLACA = 4;
const COL_DNI = 6;
const COL_PHONE = 7;
const COL_NOMBRE = 8;
const COL_TIPO_PAGO = 10;
const CUOTA_BASE_COL = 15;

function mapPagoTipoFromExcelTipo(raw) {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (!s) return undefined;
  if (s.includes('PARCIAL')) return 'parcial';
  if (s.includes('COMPLET')) return 'completo';
  return undefined;
}

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const country = (() => {
    const i = argv.indexOf('--country');
    return i >= 0 && argv[i + 1] ? String(argv[i + 1]).trim().toUpperCase() : 'PE';
  })();
  let xlsxPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) continue;
    if (/\.xlsx$/i.test(argv[i]) || fs.existsSync(argv[i])) xlsxPath = argv[i];
  }
  if (!xlsxPath) xlsxPath = DEFAULT_XLSX;
  return { dryRun, country, xlsxPath };
}

function normalizePlacaAsignada(value) {
  if (value == null) return '';
  return String(value).trim().toUpperCase().replace(/\s+/g, '');
}

function normalizePhoneDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(0km|km|nuevo|seminuevo|semiusado)\b/g, ' ')
    .replace(/\b(20\d{2})\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function excelSerialToYmd(n) {
  const intPart = Math.floor(Number(n));
  const base = Date.UTC(1899, 11, 30);
  const d = new Date(base + intPart * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
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

async function findSolicitudByPhoneLast9(phoneDigits) {
  if (!phoneDigits || phoneDigits.length < 7) return null;
  const r = await query(
    `SELECT s.id FROM module_miauto_solicitud s
     WHERE REGEXP_REPLACE(COALESCE(TRIM(s.phone),''), '[^0-9]', '', 'g') LIKE '%' || $1
     ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
    [phoneDigits.slice(-9)]
  );
  return r.rows[0] || null;
}

async function findSolicitud(placaNorm, dniDigits, phoneDigits) {
  if (placaNorm) {
    const r = await query(
      `SELECT s.id FROM module_miauto_solicitud s
       WHERE REGEXP_REPLACE(UPPER(TRIM(COALESCE(s.placa_asignada,''))), '\\s', '', 'g') = $1
       ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
      [placaNorm]
    );
    if (r.rows[0]) return r.rows[0];
  }
  if (dniDigits && dniDigits.length >= 4) {
    const r2 = await query(
      `SELECT s.id FROM module_miauto_solicitud s
       LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
       WHERE REGEXP_REPLACE(COALESCE(TRIM(s.dni),''), '[^0-9]', '', 'g') = $1
          OR REGEXP_REPLACE(COALESCE(TRIM(rd.dni),''), '[^0-9]', '', 'g') = $1
       ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
      [dniDigits]
    );
    if (r2.rows[0]) return r2.rows[0];
  }
  if (phoneDigits && phoneDigits.length >= 7) {
    const r3 = await query(
      `SELECT s.id FROM module_miauto_solicitud s
       WHERE REGEXP_REPLACE(COALESCE(TRIM(s.phone),''), '[^0-9]', '', 'g') LIKE '%' || $1
       ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,
      [phoneDigits.slice(-9)]
    );
    return r3.rows[0] || null;
  }
  return null;
}

function scoreCronograma(excelCron, dbName) {
  const a = normalizeKey(excelCron);
  const b = normalizeKey(dbName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80;
  const ta = new Set(a.split(' ').filter((t) => t.length > 2));
  const tb = new Set(b.split(' ').filter((t) => t.length > 2));
  let hit = 0;
  for (const x of ta) if (tb.has(x)) hit++;
  if (hit >= 2) return 50 + hit;
  return 0;
}

function scoreVehiculo(excelAuto, dbName) {
  const a = normalizeKey(excelAuto);
  const b = normalizeKey(dbName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;
  const ta = a.split(' ').filter((t) => t.length > 2);
  const tb = b.split(' ').filter((t) => t.length > 2);
  if (ta.length === 0 || tb.length === 0) return 0;
  let hit = 0;
  for (const x of ta) {
    if (tb.some((y) => x.includes(y) || y.includes(x))) hit++;
  }
  if (hit >= 2) return 70 + hit;
  if (hit === 1 && ta.length <= 3) return 55;
  return 0;
}

function pickCronogramaVehiculo(excelCron, excelAuto, pairs) {
  let best = null;
  let bestScore = -1;
  for (const p of pairs) {
    const sc = scoreCronograma(excelCron, p.cronograma_name);
    if (sc < 40) continue;
    const sv = scoreVehiculo(excelAuto, p.vehiculo_name);
    if (sv < 40) continue;
    const total = sc * 10 + sv;
    if (total > bestScore) {
      bestScore = total;
      best = p;
    }
  }
  return best;
}

async function loadCronogramaVehiculos() {
  const res = await query(`
    SELECT v.id AS vehiculo_id,
           v.name AS vehiculo_name,
           c.id AS cronograma_id,
           c.name AS cronograma_name
    FROM module_miauto_cronograma_vehiculo v
    JOIN module_miauto_cronograma c ON c.id = v.cronograma_id
    ORDER BY c.name, v.name
  `);
  return res.rows;
}

async function main() {
  const { dryRun, country, xlsxPath } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(xlsxPath)) {
    console.error('No existe el archivo:', xlsxPath);
    process.exit(1);
  }

  const pairs = await loadCronogramaVehiculos();
  if (pairs.length === 0) {
    console.error('No hay vehículos en cronogramas (module_miauto_cronograma_vehiculo vacío).');
    process.exit(1);
  }

  const wb = XLSX.readFile(xlsxPath, { cellDates: true, raw: true });
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    console.error('No hay hoja', SHEET_NAME);
    process.exit(1);
  }

  const ref = ws['!ref'];
  const range = ref ? XLSX.utils.decode_range(ref) : { e: { r: 0, c: 0 } };
  const maxRow = range.e.r + 1;

  const stats = {
    rows: 0,
    created: 0,
    updated: 0,
    skipped_no_dni: 0,
    skipped_no_cronoveh: 0,
    skipped_no_fecha_inicio: 0,
    skipped_bad_phone: 0,
    errors: [],
    warnings: [],
  };

  for (let row = FIRST_DATA_ROW; row <= maxRow; row++) {
    const placaRaw = cellToString(getCell(ws, row, COL_PLACA));
    const dniRaw = cellToString(getCell(ws, row, COL_DNI));
    const phoneRaw = cellToString(getCell(ws, row, COL_PHONE));
    const nombre = cellToString(getCell(ws, row, COL_NOMBRE));
    const tipoPagoExcel = cellToString(getCell(ws, row, COL_TIPO_PAGO));
    const excelCron = cellToString(getCell(ws, row, COL_CRONO));
    const excelAuto = cellToString(getCell(ws, row, COL_AUTO));
    const statusExcel = cellToString(getCell(ws, row, COL_STATUS));

    const placaNorm = normalizePlacaAsignada(placaRaw);
    const dniDigits = normalizePhoneDigits(dniRaw);
    const phoneDigits = normalizePhoneDigits(phoneRaw);

    if (!placaNorm && dniDigits.length < 4 && phoneDigits.length < 7) continue;

    if (!dniDigits || dniDigits.length < 4) {
      stats.skipped_no_dni++;
      stats.warnings.push({ row, msg: 'DNI vacío o muy corto', placa: placaRaw });
      continue;
    }

    const match = pickCronogramaVehiculo(excelCron, excelAuto, pairs);
    if (!match) {
      stats.skipped_no_cronoveh++;
      stats.warnings.push({
        row,
        msg: 'sin match cronograma/vehículo',
        excelCron,
        excelAuto,
        placa: placaRaw,
      });
      continue;
    }

    const cFecha = getCell(ws, row, CUOTA_BASE_COL);
    const fechaInicio = fechaCellToYmd(cFecha);
    if (!fechaInicio) {
      stats.skipped_no_fecha_inicio++;
      stats.warnings.push({ row, msg: 'fecha depósito / cuota 1 ilegible', placa: placaRaw });
      continue;
    }

    let phoneDb = null;
    try {
      phoneDb = phoneDigits.length >= 7 ? normalizePhoneForDb(phoneRaw, country) : null;
    } catch {
      stats.skipped_bad_phone++;
      stats.warnings.push({ row, msg: 'teléfono inválido', phone: phoneRaw });
      continue;
    }

    stats.rows++;
    const pagoTipo = mapPagoTipoFromExcelTipo(tipoPagoExcel);
    const desc = `Import ENTREGA INMEDIATA (${statusExcel || '—'}) — ${nombre || 'sin nombre'}`.slice(0, 2000);

    const existing = await findSolicitud(placaNorm, dniDigits, phoneDigits);

    console.log(
      `[${row}] ${placaRaw} DNI=${dniDigits} -> cron=${match.cronograma_name} veh=${match.vehiculo_name} fi=${fechaInicio} ${existing ? 'UPDATE' : 'CREATE'} dry=${dryRun}`
    );

    if (dryRun) {
      if (existing) stats.updated++;
      else stats.created++;
      continue;
    }

    const applyUpdate = async (sid) => {
      const patch = {
        status: 'aprobado',
        cronograma_id: match.cronograma_id,
        cronograma_vehiculo_id: match.vehiculo_id,
        fecha_inicio_cobro_semanal: fechaInicio,
        placa_asignada: placaNorm || null,
        observations: desc,
      };
      if (pagoTipo) patch.pago_tipo = pagoTipo;
      await updateSolicitud(sid, patch, null);
    };

    try {
      if (existing) {
        await applyUpdate(existing.id);
        stats.updated++;
      } else {
        try {
          const created = await createSolicitud({
            country,
            dni: dniDigits,
            phone: phoneDb,
            email: null,
            license_number: null,
            description: desc,
            apps: [],
            rapidin_driver_id: null,
          });
          await applyUpdate(created.id);
          stats.created++;
        } catch (e) {
          if (e instanceof ActiveSolicitudError) {
            const alt = await findSolicitudByPhoneLast9(phoneDigits);
            if (alt) {
              await applyUpdate(alt.id);
              stats.updated++;
            } else {
              throw e;
            }
          } else {
            throw e;
          }
        }
      }
    } catch (e) {
      stats.errors.push({ row, placa: placaRaw, msg: String(e.message || e) });
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: stats.errors.length === 0,
        dryRun,
        xlsxPath,
        stats,
        warnings_sample: stats.warnings.slice(0, 30),
        warnings_total: stats.warnings.length,
      },
      null,
      2
    )
  );
  process.exit(stats.errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
