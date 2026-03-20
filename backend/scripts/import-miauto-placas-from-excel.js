/**
 * Import desde Excel "ENTREGA INMEDIATA": actualiza solicitudes existentes e inserta nuevas.
 *
 * - DNI, celular, nombre, licencia: columnas del Excel. Match solicitud por DNI, celular (últimos 9) o placa.
 * - Si encuentra conductor en module_rapidin_drivers (flota Mi Auto + teléfono o DNI), guarda rapidin_driver_id
 *   para que en listados/detalle se vea el nombre desde Rapidin.
 * - Cronograma por nombre (config Yego Mi Auto). Cuotas desde bloques CUOTA 1, 2, ...
 *
 * Requisitos: migración 037 (placa_asignada), 009 (rapidin_driver_id). Opcional 038 (conductor_nombre). .env con DB_*.
 *
 * Uso:
 *   cd backend
 *   node scripts/import-miauto-placas-from-excel.js "/ruta/al/archivo.xlsx"
 *   DRY_RUN=1 node scripts/import-miauto-placas-from-excel.js "./archivo.xlsx"
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import { query } from '../config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizeHeader(h) {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/"/g, '');
}

function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '');
}

/** Misma lógica que el backend para guardar placa */
function normalizePlaca(value) {
  if (value == null || value === '') return '';
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function findColumnIndex(headers, candidates, excludeIndex = -1) {
  const norm = headers.map((h) => normalizeHeader(h));
  for (const cand of candidates) {
    const c = normalizeHeader(cand);
    const i = norm.findIndex((h, idx) => idx !== excludeIndex && (h === c || h.includes(c) || c.includes(h)));
    if (i >= 0) return i;
  }
  if (excludeIndex >= 0) return -1;
  const placaIdx = norm.findIndex((h) => h.includes('placa'));
  if (placaIdx >= 0) return placaIdx;
  return -1;
}

function sheetToMatrix(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
}

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = null;
  let sheetFilter = null;
  let headerRows = 1;
  let insertMissing = false;
  for (const a of args) {
    if (a.startsWith('--sheet=')) sheetFilter = a.slice('--sheet='.length).trim();
    else if (a.startsWith('--header-rows=')) {
      const n = parseInt(a.slice('--header-rows='.length), 10);
      if (Number.isFinite(n) && n >= 1) headerRows = n;
    } else if (a === '--insert-missing' || a === '--seed') insertMissing = true;
    else if (!a.startsWith('-')) filePath = a;
  }
  return { filePath, sheetFilter, headerRows, insertMissing };
}

async function findSolicitudIdByDni(dniDigits) {
  if (!dniDigits || dniDigits.length < 4) return { id: null, ambiguous: false };
  const r = await query(
    `SELECT id FROM module_miauto_solicitud
     WHERE regexp_replace(coalesce(dni, ''), '[^0-9]', '', 'g') = $1`,
    [dniDigits]
  );
  if (r.rows.length === 1) return { id: r.rows[0].id, ambiguous: false };
  if (r.rows.length > 1) return { id: null, ambiguous: true };
  return { id: null, ambiguous: false };
}

async function findSolicitudIdByPhoneLast9(phoneDigits) {
  const last9 = phoneDigits ? phoneDigits.slice(-9) : '';
  if (!last9 || last9.length < 9) return { id: null, ambiguous: false };
  const r = await query(
    `SELECT id FROM module_miauto_solicitud
     WHERE length(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) >= 9
       AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 9) = $1`,
    [last9]
  );
  if (r.rows.length === 1) return { id: r.rows[0].id, ambiguous: false };
  if (r.rows.length > 1) return { id: null, ambiguous: true };
  return { id: null, ambiguous: false };
}

/** Busca solicitud por placa_asignada (ya hay placas registradas en BD). */
async function findSolicitudIdByPlaca(placa) {
  if (!placa || !normalizePlaca(placa)) return { id: null, ambiguous: false };
  const norm = normalizePlaca(placa);
  const r = await query(
    `SELECT id FROM module_miauto_solicitud
     WHERE UPPER(TRIM(REGEXP_REPLACE(COALESCE(placa_asignada,''), '\\s+', '', 'g'))) = $1`,
    [norm]
  );
  if (r.rows.length === 1) return { id: r.rows[0].id, ambiguous: false };
  if (r.rows.length > 1) return { id: null, ambiguous: true };
  return { id: null, ambiguous: false };
}

const DEFAULT_COUNTRY = 'PE';

/** Park_id de Yego Mi Auto en module_rapidin_drivers (para resolver rapidin_driver_id por teléfono/DNI). */
const MIAUTO_PARK_ID = 'fafd623109d740f8a1f15af7c3dd86c6';

/**
 * Busca id en module_rapidin_drivers por flota Mi Auto y teléfono o DNI (solo dígitos).
 * Devuelve { id: uuid } o null. Así al guardar rapidin_driver_id en la solicitud, el nombre sale del JOIN.
 */
async function resolveRapidinDriverId(country, parkId, phoneDigits, dniDigits) {
  if (!country || !parkId) return null;
  const parkNorm = String(parkId).trim();
  const last9 = phoneDigits && phoneDigits.length >= 9 ? phoneDigits.slice(-9) : '';
  const dniNorm = dniDigits && dniDigits.length >= 4 ? dniDigits : '';

  const res = await query(
    `SELECT id FROM module_rapidin_drivers
     WHERE country = $1 AND COALESCE(TRIM(park_id), '') = $2
       AND (
         (LENGTH($3) >= 9 AND REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $3)
         OR (LENGTH($4) = 9 AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g'), 9) = $4)
         OR (LENGTH($5) >= 4 AND REGEXP_REPLACE(COALESCE(dni,''), '[^0-9]', '', 'g') = $5)
       )
     LIMIT 1`,
    [country, parkNorm, phoneDigits || '', last9, dniNorm]
  );
  if (res.rows && res.rows.length > 0) return { id: res.rows[0].id };
  return null;
}

/** Normaliza nombre para match: trim, un solo espacio, mayúsculas. */
function normalizeModelName(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/** Guiones y espacios que Excel/BD pueden traer (en-dash –, em-dash —, minus −, nbsp). */
const DASH_LIKE = /[\u002D\u2013\u2014\u2212\u00AD]/g;
const SPACE_LIKE = /[\s\u00A0]+/g;

/**
 * Normaliza nombre de cronograma para match: igual que en configuración "AUTOS SEMINUEVOS 2025 - I".
 * Quita espacios de más, unifica guiones (en-dash, em-dash, minus) a "-", unifica espacio alrededor del guión.
 */
function normalizeCronogramaName(s) {
  if (s == null) return '';
  let t = String(s)
    .replace(SPACE_LIKE, ' ')
    .trim()
    .replace(DASH_LIKE, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  // Quitar prefijos comunes para mejorar match con el nombre en config
  for (const prefix of ['CRONOGRAMA', 'PLAN', 'PROGRAMA']) {
    if (t.startsWith(prefix)) t = t.slice(prefix.length).replace(/^\s+/, '');
  }
  return t.trim();
}

/**
 * Busca cronograma por nombre en la configuración de Yego Mi Auto (module_miauto_cronograma).
 * Coincide con el Excel: exacto normalizado, o que el nombre del Excel esté contenido en el de config (o al revés).
 */
async function resolveCronogramaByName(country, cronogramaName) {
  if (!cronogramaName || String(cronogramaName).trim() === '') return null;
  const countryVal = country || DEFAULT_COUNTRY;
  const normalizedInput = normalizeCronogramaName(cronogramaName);
  if (!normalizedInput) return null;

  const res = await query(
    `SELECT id, name FROM module_miauto_cronograma WHERE country = $1 AND active = true ORDER BY name`,
    [countryVal]
  );
  const rows = res.rows ?? [];
  for (const row of rows) {
    const normConfig = normalizeCronogramaName(row.name);
    if (normConfig === normalizedInput) return { id: row.id };
  }
  for (const row of rows) {
    const normConfig = normalizeCronogramaName(row.name);
    if (normConfig && normalizedInput && (normConfig.includes(normalizedInput) || normalizedInput.includes(normConfig))) return { id: row.id };
  }

  const term = String(cronogramaName).trim().replace(/\s+/g, '%');
  if (term.length >= 2) {
    const r = await query(
      `SELECT id FROM module_miauto_cronograma
       WHERE country = $1 AND name ILIKE $2 AND active = true
       ORDER BY created_at
       LIMIT 1`,
      [countryVal, `%${term}%`]
    );
    if (r.rows.length > 0) return { id: r.rows[0].id };
  }
  return null;
}

/**
 * Busca cronograma_vehiculo por nombre de modelo dentro de un cronograma (evita confusión cuando hay nombres casi idénticos en otro cronograma).
 */
async function resolveVehiculoByCronogramaAndModel(cronogramaId, modelName) {
  if (!cronogramaId || !modelName || String(modelName).trim() === '') return null;
  const normalized = normalizeModelName(modelName);

  const exact = await query(
    `SELECT id, cronograma_id FROM module_miauto_cronograma_vehiculo
     WHERE cronograma_id = $1 AND UPPER(TRIM(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) = $2
     LIMIT 1`,
    [cronogramaId, normalized]
  );
  if (exact.rows.length > 0) return exact.rows[0];

  const term = String(modelName).trim().replace(/\s+/g, '%');
  const r = await query(
    `SELECT id, cronograma_id FROM module_miauto_cronograma_vehiculo
     WHERE cronograma_id = $1 AND name ILIKE $2
     ORDER BY orden NULLS LAST, created_at
     LIMIT 1`,
    [cronogramaId, `%${term}%`]
  );
  return r.rows[0] || null;
}

/**
 * Busca cronograma_vehiculo por nombre de modelo (ej. "KIA SOLUTO") sin cronograma; puede haber ambigüedad si varios cronogramas tienen modelo similar.
 */
async function resolveVehiculoByModelName(country, modelName) {
  if (!modelName || String(modelName).trim() === '') return null;
  const countryVal = country || DEFAULT_COUNTRY;
  const normalized = normalizeModelName(modelName);

  const exact = await query(
    `SELECT v.id, v.cronograma_id
     FROM module_miauto_cronograma_vehiculo v
     JOIN module_miauto_cronograma c ON c.id = v.cronograma_id
     WHERE c.country = $1
       AND UPPER(TRIM(REGEXP_REPLACE(v.name, '\\s+', ' ', 'g'))) = $2
     LIMIT 1`,
    [countryVal, normalized]
  );
  if (exact.rows.length > 0) return exact.rows[0];

  const term = String(modelName).trim().replace(/\s+/g, '%');
  const r = await query(
    `SELECT v.id, v.cronograma_id
     FROM module_miauto_cronograma_vehiculo v
     JOIN module_miauto_cronograma c ON c.id = v.cronograma_id
     WHERE c.country = $1 AND v.name ILIKE $2
     ORDER BY v.orden NULLS LAST, v.created_at
     LIMIT 1`,
    [countryVal, `%${term}%`]
  );
  return r.rows[0] || null;
}

/** Primer lunes del mes actual (para fecha_inicio_cobro_semanal al insertar desde Cuotas Semanales). */
function getFirstMondayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  let day = 1;
  while (new Date(y, m, day).getDay() !== 1) day += 1;
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Convierte valor de celda Excel (serial o string) a fecha YYYY-MM-DD.
 * Serial Excel: días desde 1899-12-30 (o 1900-01-01 con bug de Lotus).
 */
function parseExcelDate(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  if (Number.isFinite(n)) {
    // Excel serial: 25569 = 1970-01-01 en época 1899-12-30
    const date = new Date((n - 25569) * 86400 * 1000);
    if (Number.isNaN(date.getTime())) return null;
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const s = String(val).trim();
  if (!s) return null;
  // dd/mm/yy o dd/mm/yyyy
  const parts = s.split(/[/\-.]/);
  if (parts.length >= 3) {
    let day = parseInt(parts[0], 10);
    let month = parseInt(parts[1], 10) - 1;
    let year = parseInt(parts[2], 10);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    if (month < 0 || month > 11) return null;
    const date = new Date(year, month, day);
    if (Number.isNaN(date.getTime())) return null;
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Detecta bloques CUOTA 1, CUOTA 2, ... en la cabecera. Cada bloque son 4 columnas: FECHA, VIAJES, MONTO, Validación.
 * Devuelve [{ startIndex: 12 }, { startIndex: 16 }, ...] ordenados por startIndex.
 */
function buildCuotaBlocks(headerRow) {
  const blocks = [];
  const re = /cuota\s*\d+/i;
  for (let i = 0; i < (headerRow?.length ?? 0); i++) {
    const h = String(headerRow[i] ?? '').trim();
    if (re.test(h)) blocks.push({ startIndex: i });
  }
  return blocks.sort((a, b) => a.startIndex - b.startIndex);
}

function round2(n) {
  const x = Number(n);
  return Number.isNaN(x) ? 0 : Math.round(x * 100) / 100;
}

/** Indica si la celda de validación significa "pagado" (✔, Sí, depósito, validado, true, etc.). */
function isValidacionPagado(val) {
  if (val == null) return false;
  if (typeof val === 'boolean') return val === true;
  if (typeof val === 'number') return val === 1 || val > 0;
  const s = String(val).trim().toLowerCase();
  if (s === '' || s === 'false' || s === '0' || s === 'no' || s === 'pendiente') return false;
  const pagadoExact = ['sí', 'si', 'x', '✔', '✓', '1', 'true', 'yes', 'depósito', 'deposito', 'validado', 'validacion', 'validación', 'pagado', 'ok', 'okay'];
  if (pagadoExact.includes(s)) return true;
  if (s.includes('depósito') || s.includes('deposito') || s.includes('validado') || s.includes('pagado')) return true;
  return false;
}

/**
 * Arma el texto de observations: nombre, fecha entrega, y opcionalmente resumen de cuotas (atrasadas, pagadas, total).
 */
function buildObservations(nombresRaw, fechaEntregaInmediataISO, cuotasSummary = null) {
  const parts = [];
  if (nombresRaw && String(nombresRaw).trim()) parts.push(`Conductor: ${String(nombresRaw).trim()}`);
  if (fechaEntregaInmediataISO) parts.push(`Fecha entrega inmediata: ${fechaEntregaInmediataISO}`);
  if (cuotasSummary && (cuotasSummary.atrasadas > 0 || cuotasSummary.pagadas > 0 || cuotasSummary.total > 0)) {
    parts.push(`Cuotas atrasadas: ${cuotasSummary.atrasadas}. Total pagadas: ${cuotasSummary.pagadas}. Total: ${cuotasSummary.total.toFixed(2)} PEN.`);
  }
  return parts.length ? parts.join('. ') : null;
}

/**
 * Calcula resumen de cuotas desde la fila Excel (bloques CUOTA 1, 2, ...): atrasadas, pagadas, total.
 * Si la hoja tiene columnas N° CUOTAS ATRASADAS, TOTAL CUOTAS PAGADAS, TOTAL, se usan primero.
 */
function getCuotasSummaryFromRow(row, cuotaBlocks, iCuotasAtrasadas = -1, iTotalPagadas = -1, iTotalMonto = -1) {
  let atrasadas = 0;
  let pagadas = 0;
  let total = 0;
  if (iCuotasAtrasadas >= 0 && row[iCuotasAtrasadas] != null && row[iCuotasAtrasadas] !== '') {
    atrasadas = parseInt(row[iCuotasAtrasadas], 10) || 0;
  }
  if (iTotalPagadas >= 0 && row[iTotalPagadas] != null && row[iTotalPagadas] !== '') {
    pagadas = parseInt(row[iTotalPagadas], 10) || 0;
  }
  if (iTotalMonto >= 0 && row[iTotalMonto] != null && row[iTotalMonto] !== '') {
    total = round2(parseFloat(row[iTotalMonto]) || 0);
  }
  if (atrasadas === 0 && pagadas === 0 && total === 0 && cuotaBlocks && cuotaBlocks.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    for (const block of cuotaBlocks) {
      const i = block.startIndex;
      const weekStart = parseExcelDate(row[i]);
      const monto = round2(parseFloat(row[i + 2]) || 0);
      const paid = isValidacionPagado(row[i + 3]);
      if (!weekStart) continue;
      if (paid) {
        pagadas += 1;
        total += monto;
      } else if (weekStart < today) atrasadas += 1;
    }
  }
  return { atrasadas, pagadas, total };
}

async function columnExists(name) {
  const r = await query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'module_miauto_solicitud' AND column_name = $1`,
    [name]
  );
  return r.rows.length > 0;
}

/**
 * Construye un índice desde la hoja "Cuotas Semanales": por DNI, celular (últimos 9) y placa.
 * Guardamos { nombres, celular, auto, cronograma, dniDigits } para rellenar solicitud
 * cuando procesamos otra hoja o cuando encontramos la solicitud por placa.
 */
function buildExcelDataMapFromCuotasSemanales(matrix, headerRows = 1) {
  const out = { byDni: {}, byPhone: {}, byPlaca: {} };
  if (!matrix || matrix.length <= headerRows) return out;
  const headerRow = matrix[0].map((c) => String(c ?? '').trim());
  const iPlaca = findColumnIndex(headerRow, ['placa', 'auto - placa', 'auto-placa']);
  let iDni = findColumnIndex(headerRow, ['dni - ce', 'dni-ce', 'dni ce', 'dni', 'documento']);
  let iCel = findColumnIndex(headerRow, ['# celular', '#celular', 'celular']);
  if (iDni >= 0 && iCel === iDni) iCel = findColumnIndex(headerRow, ['# celular', '#celular', 'celular'], iDni);
  const iModelo = findColumnIndex(headerRow, ['auto', 'modelo auto', 'modelo', 'vehículo']);
  const iNombres = findColumnIndex(headerRow, ['nombres y apellidos', 'nombres', 'conductor', 'nombre']);
  const iCronograma = findColumnIndex(headerRow, ['cronograma']);
  const iLicenciaMap = findColumnIndex(headerRow, [
    'licencia',
    'license',
    'nro licencia',
    'n° licencia',
    'nº licencia',
    'nro. licencia',
    'lic. conducir',
    'licencia de conducir',
    '# licencia',
    'numero de licencia',
    'n° de licencia',
  ]);
  if (iPlaca < 0) return out;

  for (let r = headerRows; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || !row.length) continue;
    const placa = normalizePlaca(row[iPlaca]);
    if (!placa) continue;
    const dniDigits = iDni >= 0 ? digitsOnly(row[iDni]) : '';
    const phoneDigits = iCel >= 0 ? digitsOnly(row[iCel]) : '';
    const nombres = iNombres >= 0 ? String(row[iNombres] ?? '').trim() : '';
    const auto = iModelo >= 0 ? String(row[iModelo] ?? '').trim() : '';
    const cronograma = iCronograma >= 0 ? String(row[iCronograma] ?? '').trim() : '';
    const licenseText =
      iLicenciaMap >= 0 && row[iLicenciaMap] != null && String(row[iLicenciaMap]).trim() !== ''
        ? String(row[iLicenciaMap]).trim()
        : null;
    const data = {
      nombres,
      celular: phoneDigits || null,
      auto,
      cronograma,
      dniDigits: dniDigits.length >= 4 ? dniDigits : null,
      licenseText,
    };
    if (dniDigits.length >= 4) out.byDni[dniDigits] = data;
    if (phoneDigits.length >= 9) out.byPhone[phoneDigits.slice(-9)] = data;
    out.byPlaca[placa] = data;
  }
  return out;
}

async function processMatrix(matrix, sheetLabel, headerRows = 1, insertMissing = false, excelDataMap = null) {
  if (!matrix || matrix.length <= headerRows) {
    console.warn(`  [${sheetLabel}] Hoja vacía o sin datos`);
    return { updated: 0, inserted: 0, skipped: 0, emptyRows: 0, errors: 0, cuotasUpserted: 0 };
  }

  // La primera fila del Excel suele tener PLACA / DNI / Celular / Modelo
  const headerRow = matrix[0].map((c) => String(c ?? '').trim());

  // Columnas según Excel "Cuotas Semanales": AUTO, CRONOGRAMA, PLACA, CANT. CUOTAS, DNI - CE, # CELULAR, NOMBRES Y APELLIDOS, ...
  const iPlaca = findColumnIndex(headerRow, ['placa', 'auto - placa', 'auto-placa']);
  let iDni = findColumnIndex(headerRow, ['dni - ce', 'dni-ce', 'dni ce', 'dni', 'documento']);
  let iCel = findColumnIndex(headerRow, ['# celular', '#celular', 'celular', '# celular ']);
  if (iDni >= 0 && iCel === iDni) iCel = findColumnIndex(headerRow, ['# celular', '#celular', 'celular'], iDni);
  let iModelo = findColumnIndex(headerRow, ['auto', 'modelo auto', 'modelo', 'vehículo']);
  const iNombres = findColumnIndex(headerRow, ['nombres y apellidos', 'nombres', 'conductor', 'nombre']);
  const iFechaEntregaInmediata = findColumnIndex(headerRow, ['fecha de entrega inmediata', 'fecha entrega inmediata', 'entrega inmediata', 'fecha entrega']);
  const iCronograma = findColumnIndex(headerRow, ['cronograma']);
  const iLicencia = findColumnIndex(headerRow, [
    'licencia',
    'license',
    'nro licencia',
    'n° licencia',
    'nº licencia',
    'nro. licencia',
    'lic. conducir',
    'licencia de conducir',
    '# licencia',
    'numero de licencia',
    'n° de licencia',
  ]);
  // Columnas resumen cuotas (Excel: N° CUOTAS ATRASADAS, TOTAL CUOTAS PAGADAS, TOTAL)
  const iCuotasAtrasadas = findColumnIndex(headerRow, ['n° cuotas atrasadas', 'cuotas atrasadas', 'atrasadas', 'cant. atrasadas']);
  const iTotalPagadas = findColumnIndex(headerRow, ['total cuotas pagadas', 'cuotas pagadas', 'n° cuotas pagadas']);
  let iTotalMonto = findColumnIndex(headerRow, ['total']);
  if (iTotalMonto === iTotalPagadas && iTotalPagadas >= 0) iTotalMonto = findColumnIndex(headerRow, ['total'], iTotalPagadas);

  if (iDni === iPlaca) iDni = -1;
  if (iModelo === iPlaca) iModelo = -1;

  if (iPlaca < 0) {
    console.warn(`  [${sheetLabel}] No se encontró columna de placa; se omite la hoja.`);
    return { updated: 0, inserted: 0, skipped: 0, emptyRows: 0, errors: 0, cuotasUpserted: 0 };
  }

  const isCuotasSemanales = /cuotas\s*semanales/i.test(sheetLabel);
  const cuotaBlocks = isCuotasSemanales ? buildCuotaBlocks(headerRow) : [];
  const hasConductorNombreCol = await columnExists('conductor_nombre');

  console.log(
    `  [${sheetLabel}] Cabecera: fila 1; datos desde fila ${headerRows + 1}. Columnas: placa=${iPlaca + 1}${iDni >= 0 ? `, dni=${iDni + 1}` : ''}${iCel >= 0 ? `, celular=${iCel + 1}` : ''}${iModelo >= 0 ? `, auto=${iModelo + 1}` : ''}${iCronograma >= 0 ? `, cronograma=${iCronograma + 1}` : ''}${iNombres >= 0 ? `, nombres=${iNombres + 1}` : ''}${iLicencia >= 0 ? `, licencia=${iLicencia + 1}` : ''}${iFechaEntregaInmediata >= 0 ? `, fecha_entrega_inmediata=${iFechaEntregaInmediata + 1}` : ''}${iCuotasAtrasadas >= 0 ? `, cuotas_atrasadas=${iCuotasAtrasadas + 1}` : ''}${iTotalPagadas >= 0 ? `, total_pagadas=${iTotalPagadas + 1}` : ''}${iTotalMonto >= 0 ? `, total=${iTotalMonto + 1}` : ''}${cuotaBlocks.length ? `, ${cuotaBlocks.length} bloques cuota` : ''}${insertMissing ? ' [INSERT missing]' : ''}`
  );

  let updated = 0;
  let inserted = 0;
  let skipped = 0;
  let emptyRows = 0;
  let errors = 0;
  let cuotasUpserted = 0;
  const dry = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

  for (let r = headerRows; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || !row.length) {
      emptyRows += 1;
      continue;
    }

    const placaRaw = row[iPlaca];
    const placa = normalizePlaca(placaRaw);
    if (!placa) {
      emptyRows += 1;
      continue;
    }

    let dniDigits = iDni >= 0 ? digitsOnly(row[iDni]) : '';
    let phoneDigits = iCel >= 0 ? digitsOnly(row[iCel]) : '';
    // Completar DNI/celular desde el índice de Cuotas Semanales (por placa) si la fila no los trae
    const fromCuotasByPlaca = excelDataMap?.byPlaca?.[placa] || null;
    if (fromCuotasByPlaca) {
      if (dniDigits.length < 4 && fromCuotasByPlaca.dniDigits) dniDigits = fromCuotasByPlaca.dniDigits;
      if (phoneDigits.length < 9 && fromCuotasByPlaca.celular) phoneDigits = fromCuotasByPlaca.celular;
    }

    // DNI con menos de 6 dígitos suele ser ruido; exigir celular o DNI válido (6+ o 9+ dígitos)
    const dniOk = dniDigits.length >= 6;
    const phoneOk = phoneDigits.length >= 9;
    if (!dniOk && !phoneOk) {
      skipped += 1;
      continue;
    }

    let solId = null;
    let amb = false;
    let didInsertThisRow = false;

    if (dniDigits.length >= 4) {
      const x = await findSolicitudIdByDni(dniDigits);
      solId = x.id;
      amb = x.ambiguous;
    }
    if (!solId && !amb && phoneDigits.length >= 9) {
      const x = await findSolicitudIdByPhoneLast9(phoneDigits);
      solId = x.id;
      amb = x.ambiguous;
    }
    if (!solId && !amb) {
      const x = await findSolicitudIdByPlaca(placa);
      solId = x.id;
      amb = x.ambiguous;
    }

    if (amb) {
      console.warn(`  Fila ${r + 1}: múltiples solicitudes para DNI/tel; omitir. placa=${placa}`);
      errors += 1;
      continue;
    }
    // Insertar solicitud nueva si no existe y tenemos placa + (DNI o celular)
    if (!solId && (dniOk || phoneOk)) {
      const hasDniFromExcel = iDni >= 0 && dniDigits.length >= 4;
      const dniParaInsert = hasDniFromExcel ? dniDigits : (phoneOk ? `TEL${phoneDigits.slice(-9)}` : null);
      let phoneParaInsert = phoneOk ? phoneDigits : null;
      let nombresRaw = iNombres >= 0 ? String(row[iNombres] ?? '').trim() : '';
      let modelRaw = iModelo >= 0 ? String(row[iModelo] ?? '').trim() : '';
      let cronogramaRaw = iCronograma >= 0 ? String(row[iCronograma] ?? '').trim() : '';
      const fromCuotas = excelDataMap && (
        (dniDigits.length >= 4 && excelDataMap.byDni[dniDigits]) ||
        (phoneDigits.length >= 9 && excelDataMap.byPhone[phoneDigits.slice(-9)]) ||
        (excelDataMap.byPlaca && excelDataMap.byPlaca[placa])
      );
      if (fromCuotas) {
        if (fromCuotas.nombres) nombresRaw = fromCuotas.nombres;
        if (fromCuotas.celular) phoneParaInsert = phoneParaInsert || fromCuotas.celular;
        if (fromCuotas.auto) modelRaw = fromCuotas.auto;
        if (fromCuotas.cronograma) cronogramaRaw = fromCuotas.cronograma;
      }
      if (!phoneParaInsert && phoneDigits.length >= 9) phoneParaInsert = phoneDigits;
      const conductorNombre = nombresRaw ? String(nombresRaw).trim() || null : null;
      let cronogramaId = null;
      let cronogramaVehiculoId = null;
      if (cronogramaRaw) {
        const crono = await resolveCronogramaByName(DEFAULT_COUNTRY, cronogramaRaw);
        if (crono) cronogramaId = crono.id;
      }
      if (modelRaw) {
        let veh = null;
        if (cronogramaId) veh = await resolveVehiculoByCronogramaAndModel(cronogramaId, modelRaw);
        if (!veh) veh = await resolveVehiculoByModelName(DEFAULT_COUNTRY, modelRaw);
        if (veh) {
          cronogramaId = veh.cronograma_id;
          cronogramaVehiculoId = veh.id;
        }
      }
      const fechaInicio = isCuotasSemanales ? getFirstMondayISO() : null;
      const fechaEntregaRaw = iFechaEntregaInmediata >= 0 ? row[iFechaEntregaInmediata] : null;
      const fechaEntregaISO = fechaEntregaRaw ? parseExcelDate(fechaEntregaRaw) : null;
      const cuotasSummary = isCuotasSemanales && cuotaBlocks.length > 0 ? getCuotasSummaryFromRow(row, cuotaBlocks, iCuotasAtrasadas, iTotalPagadas, iTotalMonto) : null;
      const observations = buildObservations(nombresRaw, fechaEntregaISO, cuotasSummary);
      // Solo Excel: licencia desde columna Licencia o índice Cuotas Semanales (licenseText)
      let licenseNumber =
        iLicencia >= 0 && row[iLicencia] != null && String(row[iLicencia]).trim() !== ''
          ? String(row[iLicencia]).trim()
          : null;
      if (!licenseNumber && fromCuotas?.licenseText) licenseNumber = fromCuotas.licenseText;
      const phoneDigitsForRapidin = digitsOnly(phoneParaInsert || phoneDigits);
      const dniDigitsForRapidin =
        typeof dniParaInsert === 'string' && dniParaInsert.replace(/\D/g, '').length >= 4 ? digitsOnly(dniParaInsert) : dniDigits;
      const rapidinDriverInsert = await resolveRapidinDriverId(DEFAULT_COUNTRY, MIAUTO_PARK_ID, phoneDigitsForRapidin, dniDigitsForRapidin);
      if (dry) {
        console.log(
          `  [DRY_RUN] INSERT solicitud placa=${placa} dni=${dniParaInsert} tel=${phoneParaInsert || '—'} conductor=${conductorNombre || '—'} rapidin_driver_id=${rapidinDriverInsert?.id || '—'}`
        );
        inserted += 1;
        continue;
      }
      try {
        const insertCols = ['country', 'dni', 'phone', 'status', 'placa_asignada', 'cronograma_id', 'cronograma_vehiculo_id', 'fecha_inicio_cobro_semanal', 'pago_estado', 'observations', 'license_number'];
        const insertVals = [DEFAULT_COUNTRY, dniParaInsert, phoneParaInsert, 'aprobado', placa, cronogramaId, cronogramaVehiculoId, fechaInicio, 'completo', observations, licenseNumber];
        if (rapidinDriverInsert?.id) {
          insertCols.push('rapidin_driver_id');
          insertVals.push(rapidinDriverInsert.id);
        }
        if (hasConductorNombreCol && conductorNombre) {
          insertCols.push('conductor_nombre');
          insertVals.push(conductorNombre);
        }
        const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
        const ins = await query(
          `INSERT INTO module_miauto_solicitud (${insertCols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
          insertVals
        );
        solId = ins.rows[0].id;
        didInsertThisRow = true;
        inserted += 1;
      } catch (e) {
        console.error(`  Fila ${r + 1}: error INSERT`, e.message);
        errors += 1;
        continue;
      }
      // Continuar para insertar cuotas (cuota 1, 2, ...) si hay bloques
    }
    if (!solId) {
      console.warn(`  Fila ${r + 1}: sin solicitud en BD (dni=${dniDigits || '—'} tel=${phoneDigits || '—'}) placa=${placa} → omitida`);
      skipped += 1;
      continue;
    }

    // Actualizar desde Excel: placa, DNI, celular, nombres (conductor_nombre), cronograma, observations, license_number
    const needUpdatePlaca = solId && !dry && !didInsertThisRow;
    if (needUpdatePlaca) {
      try {
        let nombresRaw = iNombres >= 0 ? String(row[iNombres] ?? '').trim() : '';
        let modelRaw = iModelo >= 0 ? String(row[iModelo] ?? '').trim() : '';
        let cronogramaRaw = iCronograma >= 0 ? String(row[iCronograma] ?? '').trim() : '';
        let phoneParaUpdate = phoneDigits;
        let dniParaUpdate = dniDigits;
        // Si tenemos índice de Cuotas Semanales, buscar por DNI, celular o placa y usar nombre, celular, auto, cronograma (y DNI) de ahí
        const fromCuotas = excelDataMap && (
          (dniDigits.length >= 4 && excelDataMap.byDni[dniDigits]) ||
          (phoneDigits.length >= 9 && excelDataMap.byPhone[phoneDigits.slice(-9)]) ||
          (excelDataMap.byPlaca && excelDataMap.byPlaca[placa])
        );
        if (fromCuotas) {
          if (fromCuotas.nombres) nombresRaw = fromCuotas.nombres;
          if (fromCuotas.celular) phoneParaUpdate = fromCuotas.celular;
          if (fromCuotas.auto) modelRaw = fromCuotas.auto;
          if (fromCuotas.cronograma) cronogramaRaw = fromCuotas.cronograma;
          if (fromCuotas.dniDigits) dniParaUpdate = fromCuotas.dniDigits;
        }
        const conductorNombre = nombresRaw ? String(nombresRaw).trim() || null : null;
        const fechaEntregaRaw = iFechaEntregaInmediata >= 0 ? row[iFechaEntregaInmediata] : null;
        const fechaEntregaISO = fechaEntregaRaw ? parseExcelDate(fechaEntregaRaw) : null;
        const cuotasSummary = isCuotasSemanales && cuotaBlocks.length > 0 ? getCuotasSummaryFromRow(row, cuotaBlocks, iCuotasAtrasadas, iTotalPagadas, iTotalMonto) : null;
        const observations = buildObservations(nombresRaw, fechaEntregaISO, cuotasSummary);
        // Solo Excel: licencia desde columna Licencia o índice Cuotas Semanales (licenseText)
        let licenseNumber =
          iLicencia >= 0 && row[iLicencia] != null && String(row[iLicencia]).trim() !== ''
            ? String(row[iLicencia]).trim()
            : null;
        if (!licenseNumber && fromCuotas?.licenseText) licenseNumber = fromCuotas.licenseText;
        // Cronograma: nombre del Excel se consulta en config Yego Mi Auto (module_miauto_cronograma)
        let cronogramaId = null;
        let cronogramaVehiculoId = null;
        if (cronogramaRaw) {
          const crono = await resolveCronogramaByName(DEFAULT_COUNTRY, cronogramaRaw);
          if (crono) cronogramaId = crono.id;
        }
        if (modelRaw && String(modelRaw).trim()) {
          let veh = null;
          if (cronogramaId) {
            veh = await resolveVehiculoByCronogramaAndModel(cronogramaId, String(modelRaw).trim());
          }
          if (!veh) veh = await resolveVehiculoByModelName(DEFAULT_COUNTRY, String(modelRaw).trim());
          if (veh) {
            cronogramaId = veh.cronograma_id;
            cronogramaVehiculoId = veh.id;
          }
        }
        const updateParts = ['placa_asignada = $1', 'updated_at = CURRENT_TIMESTAMP'];
        const updateParams = [placa];
        let n = 2;
        if (dniParaUpdate && dniParaUpdate.length >= 4) {
          updateParts.push(`dni = $${n}`);
          updateParams.push(dniParaUpdate);
          n += 1;
        }
        const tienePhone = phoneOk || (phoneParaUpdate && String(phoneParaUpdate).replace(/\D/g, '').length >= 9);
        if (tienePhone) {
          updateParts.push(`phone = $${n}`);
          updateParams.push(phoneParaUpdate || phoneDigits);
          n += 1;
        }
        if (hasConductorNombreCol && conductorNombre) {
          updateParts.push(`conductor_nombre = $${n}`);
          updateParams.push(conductorNombre);
          n += 1;
        }
        if (cronogramaId != null) {
          updateParts.push(`cronograma_id = $${n}`);
          updateParams.push(cronogramaId);
          n += 1;
        }
        if (cronogramaVehiculoId != null) {
          updateParts.push(`cronograma_vehiculo_id = $${n}`);
          updateParams.push(cronogramaVehiculoId);
          n += 1;
        }
        // Fecha inicio cobro: si hay cuotas en la fila, usar la primera fecha para que aparezca en Alquiler y venta
        if (isCuotasSemanales && cuotaBlocks.length > 0) {
          let firstWeekStart = null;
          for (const block of cuotaBlocks) {
            const ws = parseExcelDate(row[block.startIndex]);
            if (ws) {
              firstWeekStart = firstWeekStart == null || ws < firstWeekStart ? ws : firstWeekStart;
            }
          }
          if (firstWeekStart) {
            updateParts.push(`fecha_inicio_cobro_semanal = $${n}`);
            updateParams.push(firstWeekStart);
            n += 1;
          }
        }
        if (observations !== null) {
          updateParts.push(`observations = $${n}`);
          updateParams.push(observations);
          n += 1;
        }
        const phoneDigitsForRapidin = digitsOnly(phoneParaUpdate || phoneDigits);
        const dniDigitsForRapidin = dniParaUpdate && String(dniParaUpdate).replace(/\D/g, '').length >= 4 ? digitsOnly(dniParaUpdate) : dniDigits;
        const rapidinDriver = await resolveRapidinDriverId(DEFAULT_COUNTRY, MIAUTO_PARK_ID, phoneDigitsForRapidin, dniDigitsForRapidin);
        if (rapidinDriver?.id) {
          updateParts.push(`rapidin_driver_id = $${n}`);
          updateParams.push(rapidinDriver.id);
          n += 1;
        }
        if (licenseNumber !== null && licenseNumber !== '') {
          updateParts.push(`license_number = $${n}`);
          updateParams.push(licenseNumber);
          n += 1;
        }
        updateParams.push(solId);
        await query(
          `UPDATE module_miauto_solicitud SET ${updateParts.join(', ')} WHERE id = $${n}`,
          updateParams
        );
        updated += 1;
      } catch (e) {
        console.error(`  Fila ${r + 1}: error SQL`, e.message);
        errors += 1;
      }
    } else if (solId && dry && !didInsertThisRow) {
      console.log(`  [DRY_RUN] UPDATE solicitud ${solId} → placa_asignada=${placa}`);
      updated += 1;
    }

    // Cuotas semanales: por cada bloque CUOTA con fecha válida, UPSERT en module_miauto_cuota_semanal
    if (solId && isCuotasSemanales && cuotaBlocks.length > 0 && !dry) {
      for (const block of cuotaBlocks) {
        const i = block.startIndex;
        const fechaVal = row[i];
        const weekStart = parseExcelDate(fechaVal);
        if (!weekStart) continue;
        const viajes = parseInt(row[i + 1], 10) || 0;
        const monto = round2(parseFloat(row[i + 2]) || 0);
        const validacion = row[i + 3];
        const paid = isValidacionPagado(validacion);
        const paidAmount = paid ? monto : 0;
        const status = paid ? 'paid' : 'pending';
        try {
          await query(
            `INSERT INTO module_miauto_cuota_semanal
             (solicitud_id, week_start_date, due_date, num_viajes, cuota_semanal, amount_due, paid_amount, status, moneda)
             VALUES ($1, $2, $2, $3, $4, $4, $5, $6, 'PEN')
             ON CONFLICT (solicitud_id, week_start_date) DO UPDATE SET
               due_date = EXCLUDED.due_date,
               num_viajes = EXCLUDED.num_viajes,
               cuota_semanal = EXCLUDED.cuota_semanal,
               amount_due = EXCLUDED.amount_due,
               paid_amount = EXCLUDED.paid_amount,
               status = EXCLUDED.status,
               updated_at = CURRENT_TIMESTAMP`,
            [solId, weekStart, viajes, monto, paidAmount, status]
          );
          cuotasUpserted += 1;
        } catch (e) {
          console.error(`  Fila ${r + 1} cuota ${weekStart}:`, e.message);
          errors += 1;
        }
      }
    } else if (solId && isCuotasSemanales && cuotaBlocks.length > 0 && dry) {
      let count = 0;
      for (const block of cuotaBlocks) {
        const weekStart = parseExcelDate(row[block.startIndex]);
        if (weekStart) count += 1;
      }
      if (count > 0) {
        console.log(`  [DRY_RUN] Cuotas semanales: ${count} filas para solicitud ${solId}`);
        cuotasUpserted += count;
      }
    }
  }

  return { updated, inserted, skipped, emptyRows, errors, cuotasUpserted };
}

async function main() {
  const { filePath, sheetFilter, headerRows, insertMissing } = parseArgs();
  if (!filePath) {
    console.error('Uso: node scripts/import-miauto-placas-from-excel.js <ruta-archivo.xlsx> [--sheet=NombreHoja] [--header-rows=1|2] [--insert-missing]');
    console.error('     --insert-missing  crea solicitudes nuevas si no existen (BD vacía / seed desde Excel)');
    console.error('     DRY_RUN=1 ...  # solo simulación');
    process.exit(1);
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    console.error('No existe el archivo:', resolved);
    process.exit(1);
  }

  const hasCol = await columnExists('placa_asignada');
  if (!hasCol) {
    console.error('La columna placa_asignada no existe. Ejecuta primero la migración:');
    console.error('  psql $DATABASE_URL -f database/migrations/037_miauto_solicitud_placa_asignada.sql');
    process.exit(1);
  }

  console.log('Archivo:', resolved);
  if (process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true') {
    console.log('Modo DRY_RUN: no se escribirá en la base de datos.\n');
  }

  const wb = XLSX.readFile(resolved);
  const names = sheetFilter ? [sheetFilter] : wb.SheetNames;

  // Índice desde hoja "Cuotas Semanales" por DNI, celular y placa para rellenar nombre, celular, auto, cronograma
  let excelDataMap = { byDni: {}, byPhone: {}, byPlaca: {} };
  const cuotasSheetName = wb.SheetNames.find((n) => /cuotas\s*semanales/i.test(n));
  if (cuotasSheetName && wb.Sheets[cuotasSheetName]) {
    const cuotasMatrix = sheetToMatrix(wb.Sheets[cuotasSheetName]);
    excelDataMap = buildExcelDataMapFromCuotasSemanales(cuotasMatrix, headerRows);
    const totalDni = Object.keys(excelDataMap.byDni || {}).length;
    const totalPhone = Object.keys(excelDataMap.byPhone || {}).length;
    const totalPlaca = Object.keys(excelDataMap.byPlaca || {}).length;
    if (totalDni > 0 || totalPhone > 0 || totalPlaca > 0) {
      console.log(`Índice Cuotas Semanales: ${totalDni} por DNI, ${totalPhone} por celular, ${totalPlaca} por placa (nombre/celular/auto/cronograma).`);
    }
  }

  let totalUp = 0;
  let totalIns = 0;
  let totalSkip = 0;
  let totalEmpty = 0;
  let totalErr = 0;
  let totalCuotas = 0;

  const countInDb = await query(
    'SELECT COUNT(*)::int AS n FROM module_miauto_solicitud WHERE country = $1',
    [DEFAULT_COUNTRY]
  );
  const solicitudesEnBd = countInDb.rows[0]?.n ?? 0;
  const filasConPlacaEnExcel = excelDataMap?.byPlaca ? Object.keys(excelDataMap.byPlaca).length : 0;

  for (const name of names) {
    if (!wb.Sheets[name]) {
      console.warn(`Hoja no encontrada: "${name}"`);
      continue;
    }
    const matrix = sheetToMatrix(wb.Sheets[name]);
    console.log(`\n--- Hoja: ${name} (${matrix.length} filas en el archivo) ---`);
    const { updated, inserted, skipped, emptyRows, errors, cuotasUpserted } = await processMatrix(matrix, name, headerRows, insertMissing, excelDataMap);
    totalUp += updated;
    totalIns += inserted;
    totalSkip += skipped;
    totalEmpty += emptyRows;
    totalErr += errors;
    totalCuotas += cuotasUpserted ?? 0;
  }

  console.log('\n========== Resumen ==========');
  console.log('Solicitudes en BD (' + DEFAULT_COUNTRY + '):', solicitudesEnBd, '(total en base de datos)');
  console.log('Filas con placa en Excel (índice Cuotas Semanales):', filasConPlacaEnExcel);
  console.log('Solicitudes actualizadas (placa/datos):', totalUp);
  console.log('Solicitudes insertadas (nuevas):', totalIns);
  console.log('Cuotas semanales insertadas/actualizadas:', totalCuotas);
  console.log('Filas con placa sin match (y sin DNI/celular válido para crear):', totalSkip);
  console.log('Filas vacías (sin placa):', totalEmpty);
  console.log('Errores / ambiguos:', totalErr);
  process.exit(totalErr > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
