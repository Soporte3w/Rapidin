/**
 * Lee el Excel (Rptas PE/CO), filtra por DNI, y por cada fila:
 * - Resuelve el nombre de flota (columna Flota) al park_id real (id de la API de partners). NUNCA se guarda el nombre en BD.
 * - Un mismo conductor (mismo DNI, misma persona) puede tener varias filas en module_rapidin_drivers: el único diferenciador es park_id (flota). Cada fila = una flota; puede tener préstamos en cada flota.
 * - Busca conductor existente por (dni, country, park_id). Si no existe, INSERT con park_id = id de la API (validado: solo ids, nunca nombres).
 * - Asigna cada préstamo (por PréstamoID/external_loan_id) al conductor de esa flota.
 * - Incluye rechazados: filas sin PréstamoID aseguran conductor por flota y asignan la solicitud a ese conductor.
 * - Actualiza observations con Flota y Número de cuenta.
 *
 * Validación en INSERT: park_id debe ser vacío o un id válido (formato API). No se aceptan nombres (ej. "Yego Pro") en park_id.
 *
 * Requiere migración 003 (UNIQUE por dni, country, park_id).
 *
 * Uso (desde backend/):
 *   node excel/update-by-dni-from-excel.js --dni=42864766
 *   node excel/update-by-dni-from-excel.js --dni=42864766 --google-sheet-id=1mXdVRuSsOK9IlbpY1CQaNe_AHEVeePiU
 *   node excel/update-by-dni-from-excel.js --dni=42864766 --country=CO --file="ruta/al.xlsx"
 *   node excel/update-by-dni-from-excel.js --dni=42864766 --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { query } = await import('../config/database.js');
const { logger } = await import('../utils/logger.js');
const { fetchPartners } = await import('../services/partnersService.js');

const dniArg = process.argv.find((a) => a.startsWith('--dni='));
const DNI = dniArg ? String(dniArg.split('=')[1]).trim() : null;
const countryArg = process.argv.find((a) => a.startsWith('--country='));
const COUNTRY = countryArg && String(countryArg.split('=')[1]).toUpperCase() === 'CO' ? 'CO' : 'PE';
const fileArg = process.argv.find((a) => a.startsWith('--file='));
const excelFileName = fileArg ? fileArg.split('=')[1].trim().replace(/^["']|["']$/g, '') : 'Prestamos Yego (6).xlsx';
const EXCEL_PATH = path.join(__dirname, '..', '..', excelFileName);
const googleSheetIdArg = process.argv.find((a) => a.startsWith('--google-sheet-id='));
const GOOGLE_SHEET_ID = (googleSheetIdArg ? googleSheetIdArg.split('=')[1].trim() : null) || process.env.EXCEL_GOOGLE_SHEET_ID || null;
const DRY_RUN = process.argv.includes('--dry-run');

if (!DNI) {
  logger.error('Uso: node excel/update-by-dni-from-excel.js --dni=42864766 [--country=PE|CO] [--file=...] [--google-sheet-id=...] [--dry-run]');
  process.exit(1);
}

function toStr(val, maxLen = 255) {
  if (val == null) return null;
  const s = String(val).trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s || null;
}
function toNum(val) {
  if (val == null || val === '') return null;
  const n = parseFloat(String(val).replace(',', '.'));
  return isNaN(n) ? null : n;
}
function getCol(row, ...names) {
  for (const n of names) {
    if (row[n] != null && row[n] !== '') return row[n];
  }
  return null;
}
function getColByNormalizedKey(row, normalizedName) {
  const target = String(normalizedName).trim().toLowerCase();
  for (const key of Object.keys(row || {})) {
    if (key != null && String(key).trim().toLowerCase() === target) return row[key] != null && row[key] !== '' ? row[key] : null;
  }
  return null;
}
function getColByAnyNormalized(row, ...names) {
  for (const name of names) {
    const val = getColByNormalizedKey(row, name);
    if (val != null && val !== '') return val;
  }
  return null;
}
function getPrestamoId(row) {
  return toStr(getCol(row, 'PréstamoID', 'PréstamoID ', 'PrestamoID', 'PrestamoID ') ?? getColByAnyNormalized(row, 'PréstamoID', 'PrestamoID'), 100);
}
function normalizeName(val) {
  const s = toStr(val, 255) || '';
  return s.split(/\s+/).map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w)).join(' ');
}
function normalizeAccountNumber(val) {
  if (val == null || val === '') return '';
  const s = String(val).trim().replace(/\s/g, '');
  if (!s) return '';
  return s.replace(/\D/g, '').slice(0, 50) || '';
}
function buildObservationsJson({ flota, adondeAbonamos, numCuenta, tipoCuenta, banco, tasaSemanal, cuota }) {
  const notesParts = [];
  if (flota) notesParts.push(`Flota: ${flota}`);
  if (tasaSemanal != null && !isNaN(tasaSemanal)) notesParts.push(`Tasa: ${tasaSemanal}`);
  if (cuota != null && cuota > 0) notesParts.push(`Cuota: ${cuota}`);
  const notes = notesParts.length ? notesParts.join('; ') : undefined;
  if (adondeAbonamos && /YANGO/i.test(adondeAbonamos)) {
    return JSON.stringify({ deposit_type: 'yango', ...(notes && { notes }) });
  }
  const bancoStr = toStr(banco, 100);
  const tipoStr = toStr(tipoCuenta, 50);
  let account_type = '';
  if (/corriente/i.test(tipoStr)) account_type = 'checking';
  else if (/ahorro/i.test(tipoStr)) account_type = 'savings';
  else if (tipoStr) account_type = tipoStr;
  const account_number = normalizeAccountNumber(numCuenta);
  const hasBankData = bancoStr || account_type || account_number;
  if (hasBankData || (adondeAbonamos && /UNA CUENTA BANCARIA|CUENTA BANCARIA|BANCO/i.test(adondeAbonamos))) {
    return JSON.stringify({
      deposit_type: 'bank',
      ...(bancoStr && { bank: bancoStr }),
      ...(account_type && { account_type }),
      ...(account_number && { account_number }),
      ...(notes && { notes }),
    });
  }
  if (notes) return JSON.stringify({ deposit_type: 'yango', notes });
  return JSON.stringify({ deposit_type: 'yango' });
}

const NUMERO_CUENTA_HEADERS = ['NUMERO DE CUENTA', 'NUMERO DE CUENTA ', 'Número de cuenta', 'Numero de cuenta'];
function getNumeroCuentaColIndex(sheet) {
  if (!sheet || !sheet['!ref']) return -1;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cellAddr = XLSX.utils.encode_cell({ r: 0, c });
    const cell = sheet[cellAddr];
    const raw = cell && (cell.w != null ? cell.w : (cell.v != null ? cell.v : ''));
    const header = raw != null && raw !== '' ? String(raw).trim() : '';
    if (NUMERO_CUENTA_HEADERS.some((h) => header === h || header.toLowerCase() === h.toLowerCase())) return c;
  }
  return -1;
}
/** Convierte string en notación científica a string de solo dígitos (evitar 7.44E+12 → redondeo). */
function expandScientificNotationString(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*e\s*([+-]?\d+)$/i);
  if (!m) return null;
  const base = parseFloat(m[1]);
  const exp = parseInt(m[2], 10);
  if (!Number.isFinite(base) || !Number.isFinite(exp)) return null;
  const num = base * Math.pow(10, exp);
  if (num <= Number.MAX_SAFE_INTEGER && num >= Number.MIN_SAFE_INTEGER) return String(Math.round(num));
  return String(num).replace(/\.\d+$/, '').replace(/\D/g, '') || String(Math.round(num));
}

/** Lee número de cuenta desde la celda del sheet: texto tal cual; numérico usando cell.w para no perder dígitos; notación científica expandida. */
function getNumeroCuentaFromSheet(sheet, dataRowIndex0Based, colIndex) {
  if (!sheet || colIndex < 0) return null;
  const cellAddr = XLSX.utils.encode_cell({ r: dataRowIndex0Based + 1, c: colIndex });
  const cell = sheet[cellAddr];
  if (!cell) return null;
  if (cell.t === 's') return cell.v != null && cell.v !== '' ? String(cell.v).trim() : null;
  if (cell.t === 'n' && cell.v != null) {
    const num = Number(cell.v);
    if (cell.w != null && typeof cell.w === 'string') {
      const w = String(cell.w).trim().replace(/\s/g, '').replace(/,/g, '');
      if (/^\d+$/.test(w) && w.length >= 8) return w;
      if (/^[\d.]+e[+-]?\d+$/i.test(w)) {
        const expanded = expandScientificNotationString(w);
        if (expanded) return expanded;
      }
    }
    if (Number.isSafeInteger(num)) return String(num);
    if (Number.isFinite(num)) return String(Math.round(num));
    return String(cell.v);
  }
  if (cell.w != null && String(cell.w).trim() !== '') return String(cell.w).trim();
  return null;
}

function normalizePhone(val, country = 'PE') {
  const s = toStr(val, 20);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (country === 'CO') {
    if (digits.length >= 10) return `+57${digits.slice(-10)}`;
    return null;
  }
  return s.replace(/^\+?51/, '').trim() || null;
}

function normalizePartnerName(s) {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}
function normalizePartnerId(s) {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/-/g, '');
}

/** Verifica que el valor sea un park_id válido (id de la API: 32 hex o UUID). No permite nombres (espacios, etc.). */
function isValidParkIdFormat(val) {
  if (val == null || val === '') return true;
  const s = String(val).trim();
  if (!s) return true;
  return /^[a-f0-9]{32}$/i.test(s) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
}

function getLicenseCountryForDrivers(country) {
  return country === 'PE' ? 'per' : country === 'CO' ? 'col' : (country || '').toLowerCase().slice(0, 3);
}
function digitsOnly(str) {
  return (str || '').toString().replace(/\D/g, '');
}
/** Busca en drivers por DNI y por la misma flota (park_id). Solo devuelve fila si existe ese conductor en esa flota en drivers. Del Excel vienen conductores y flotas; por cada flota hay préstamos; solo enlazamos cuando drivers tiene esa flota. */
async function findInDriversByDni(dni, country, parkIdOptional = null) {
  const trimmed = (dni || '').toString().trim();
  if (!trimmed || trimmed.length < 4) return [];
  const digits = digitsOnly(trimmed);
  const licenseCountry = getLicenseCountryForDrivers(country);
  const parkNorm = (parkIdOptional || '').toString().trim();
  const r = await query(
    `SELECT driver_id, park_id FROM drivers
     WHERE license_country = $1
       AND (
         TRIM(COALESCE(license_number, '')) = $2
         OR REGEXP_REPLACE(COALESCE(license_number, ''), '[^0-9]', '', 'g') = $3
         OR TRIM(COALESCE(document_number, '')) = $2
         OR REGEXP_REPLACE(COALESCE(document_number, ''), '[^0-9]', '', 'g') = $3
         OR (LENGTH($3) >= 6 AND REGEXP_REPLACE(COALESCE(license_number, ''), '[^0-9]', '', 'g') LIKE '%' || $3 || '%')
       )
       AND ($4 = '' OR COALESCE(TRIM(park_id), '') = $4)
     ORDER BY park_id NULLS LAST
     LIMIT 1`,
    [licenseCountry, trimmed, digits, parkNorm]
  );
  return r.rows || [];
}

/** Construye mapa nombre flota → id (park_id) desde la API de partners. Incluye ids de FLOTA_ALIASES. */
async function buildFlotaNameToParkId() {
  const partners = await fetchPartners();
  const nameToId = new Map();
  const idSet = new Set();
  if (partners?.length) {
    for (const p of partners) {
      const id = p?.id != null ? String(p.id).trim() : '';
      const name = normalizePartnerName(p?.name);
      if (id) idSet.add(normalizePartnerId(id));
      if (name && id) nameToId.set(name, id);
    }
  }
  for (const [name, id] of FLOTA_ALIASES) {
    idSet.add(normalizePartnerId(id));
    if (!nameToId.has(name)) nameToId.set(name, id);
  }
  return { map: nameToId, idSet };
}

/** Quita sufijos entre paréntesis del nombre de flota (ej. "Yego Pro (alquiler - venta)" → "Yego Pro"). */
function stripFlotaParenthetical(s) {
  if (s == null || typeof s !== 'string') return '';
  return s.replace(/\s*\([^)]*\)\s*$/g, '').trim();
}

/** Ids conocidos que deben parsearse siempre desde el Excel (nombre → id). */
const PARK_ID_YEGO_MI_AUTO = 'fafd623109d740f8a1f15af7c3dd86c6';
const PARK_ID_YEGO_PRO = '64085dd85e124e2c808806f70d527ea8';

/** Alias nombre flota (normalizado) → park_id cuando no vienen en la API de partners. */
const FLOTA_ALIASES = new Map([
  ['yego mi auto', PARK_ID_YEGO_MI_AUTO],
  ['yego pro', PARK_ID_YEGO_PRO],
  ['yego pro (alquiler - venta)', PARK_ID_YEGO_PRO],
  ['yego pro (alquiler -venta)', PARK_ID_YEGO_PRO],
]);

/**
 * Resuelve flota (nombre o ya id) a park_id (id de la API).
 * - Si flota está vacío → ''.
 * - Nombres como "Yego Pro (alquiler - venta)" se tratan como "Yego Pro".
 * - Si flota ya es un id conocido (idSet) → se devuelve tal cual.
 * - Si flota es un nombre (nameToId) → se devuelve el id.
 * - Aliases fijos: "Yego Mi Auto", "Yego Pro" → park_id conocidos.
 * - Si no hay match → null (no insertar conductor con nombre crudo).
 */
function resolveFlotaToParkId(flotaStr, nameToId, idSet) {
  const raw = flotaStr ? toStr(flotaStr, 100) : '';
  if (!raw) return '';
  const trimmed = raw.trim();
  if (idSet.has(normalizePartnerId(trimmed))) return trimmed;
  const forMatch = stripFlotaParenthetical(trimmed) || trimmed;
  if (idSet.has(normalizePartnerId(forMatch))) return trimmed;
  const nameNormStripped = normalizePartnerName(forMatch);
  const byName = nameToId.get(nameNormStripped);
  if (byName) return byName;
  const byAlias = FLOTA_ALIASES.get(nameNormStripped);
  if (byAlias) return byAlias;
  const nameNormRaw = normalizePartnerName(trimmed);
  const byAliasRaw = FLOTA_ALIASES.get(nameNormRaw);
  if (byAliasRaw) return byAliasRaw;
  return null;
}

/**
 * Asegura conductor por (dni, country, park_id). Mismo DNI = mismo conductor; park_id es el único diferenciador (una fila por flota).
 * - park_id debe ser id de la API (nunca el nombre). En INSERT se valida formato; si viene nombre, se rechaza.
 * - Si no existe fila para ese (dni, country, park_id), INSERT con park_id = id de flota.
 */
async function ensureDriverByDniFlota(dni, country, parkIdResolved, row) {
  const parkVal = parkIdResolved != null && parkIdResolved !== '' ? String(parkIdResolved).trim() : '';
  if (parkVal && !isValidParkIdFormat(parkVal)) {
    logger.warn(`park_id rechazado en INSERT: debe ser id de la API, no nombre. Valor recibido: "${parkIdResolved}". Resuelva la flota con la API o FLOTA_ALIASES.`);
    throw new Error('park_id inválido: solo se permite id de la API (32 hex), no nombres de flota.');
  }
  const existing = await query(
    `SELECT id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 AND COALESCE(TRIM(park_id), '') = $3 LIMIT 1`,
    [dni, country, parkVal]
  );
  let id;
  if (existing.rows.length > 0) {
    id = existing.rows[0].id;
    const fullName = toStr(getCol(row, 'Nombres y Apellidos'), 255) || 'Sin nombre';
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    const first_name = normalizeName(parts[0] || 'Sin nombre');
    const last_name = normalizeName(parts.slice(1).join(' ')) || '';
    const phone = normalizePhone(getCol(row, 'Teléfono'), country);
    const email = toStr(getCol(row, 'Dirección de correo electrónico'), 255);
    await query(
      `UPDATE module_rapidin_drivers SET first_name = $1, last_name = $2, phone = COALESCE(NULLIF(TRIM($3),''), phone), email = COALESCE(NULLIF(TRIM($4),''), email), park_id = COALESCE(NULLIF(TRIM($5),''), park_id), updated_at = CURRENT_TIMESTAMP WHERE id = $6`,
      [first_name, last_name, phone, email, parkVal || null, id]
    );
  } else {
    const fullName = toStr(getCol(row, 'Nombres y Apellidos'), 255) || 'Sin nombre';
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    const first_name = normalizeName(parts[0] || 'Sin nombre');
    const last_name = normalizeName(parts.slice(1).join(' ')) || '';
    const phone = normalizePhone(getCol(row, 'Teléfono'), country);
    const email = toStr(getCol(row, 'Dirección de correo electrónico'), 255);
    const cycleVal = getCol(row, 'Ciclo actual', 'Ciclo actual ', 'Ciclo') ?? getColByAnyNormalized(row, 'Ciclo actual', 'Ciclo');
    const cycle = Math.max(1, Math.floor(toNum(cycleVal) || 1));
    const r = await query(
      `INSERT INTO module_rapidin_drivers (dni, country, first_name, last_name, phone, email, yego_premium, cycle, credit_line, completed_trips, park_id)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, 0, 0, $8) RETURNING id`,
      [dni, country, first_name, last_name, phone || null, email || null, cycle, parkVal || null]
    );
    id = r.rows[0].id;
  }

  try {
    const driversMatch = await findInDriversByDni(dni, country, parkVal || null);
    if (driversMatch.length > 0 && driversMatch[0].driver_id != null) {
      const extId = String(driversMatch[0].driver_id).trim();
      await query(
        `UPDATE module_rapidin_drivers SET external_driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [extId, id]
      );
    }
  } catch (errDrivers) {
    logger.warn('ensureDriverByDniFlota: no se pudo enlazar con drivers por DNI', { dni, message: errDrivers.message });
  }
  return id;
}

async function run() {
  let excelPathToUse = EXCEL_PATH;
  let tempExcelPath = null;

  if (GOOGLE_SHEET_ID) {
    const exportUrl = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=xlsx`;
    logger.info('Descargando Excel desde Google Sheets: ' + exportUrl);
    const res = await axios.get(exportUrl, { responseType: 'arraybuffer', timeout: 60000 });
    tempExcelPath = path.join(os.tmpdir(), `prestamos-yego-update-dni-${Date.now()}.xlsx`);
    fs.writeFileSync(tempExcelPath, Buffer.from(res.data));
    excelPathToUse = tempExcelPath;
    logger.info('Descargado en: ' + tempExcelPath);
  } else if (!fs.existsSync(EXCEL_PATH)) {
    logger.error('No se encontró el Excel: ' + EXCEL_PATH);
    process.exit(1);
  }

  logger.info('Leyendo Excel: ' + excelPathToUse);
  const workbook = XLSX.readFile(excelPathToUse);
  if (tempExcelPath) {
    try {
      fs.unlinkSync(tempExcelPath);
    } catch (_) {}
  }

  const rptasSheetName = COUNTRY === 'CO' ? 'Rptas CO' : 'Rptas PE';
  const sheet = workbook.Sheets[rptasSheetName];
  if (!sheet) {
    logger.error('No se encontró la hoja "' + rptasSheetName + '" en el Excel.');
    process.exit(1);
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
  const colIndexNumCuenta = getNumeroCuentaColIndex(sheet);

  const dniNorm = String(DNI).replace(/^0+/, '') || DNI;
  const filterRow = (row) => {
    const d = toStr(getCol(row, 'DNI - CARNÉ EXTRANJERÍA ', 'CÉDULA DE CIUDADANIA - CARNÉ EXTRANJERÍA ', 'DNI', 'Cédula'), 20);
    if (!d) return false;
    const dNorm = d.replace(/^0+/, '') || d;
    return d === DNI || dNorm === dniNorm || d === dniNorm || dNorm === DNI;
  };

  const filtered = rows.map((row, excelIndex) => ({ row, excelIndex })).filter(({ row }) => filterRow(row));
  logger.info(`DNI ${DNI} (${COUNTRY}): ${filtered.length} fila(s) en ${rptasSheetName}.`);

  if (filtered.length === 0) {
    logger.info('Nada que actualizar.');
    process.exit(0);
    return;
  }

  const { map: flotaNameToParkId, idSet: flotaIdSet } = await buildFlotaNameToParkId();
  logger.info(`Flotas desde API: ${flotaNameToParkId.size} nombres → id; ${flotaIdSet.size} ids.`);

  const rechazadosRes = await query(
    `SELECT r.id AS request_id
     FROM module_rapidin_loan_requests r
     INNER JOIN module_rapidin_drivers d ON d.id = r.driver_id
     LEFT JOIN module_rapidin_loans l ON l.request_id = r.id
     WHERE d.dni = $1 AND r.country = $2 AND l.id IS NULL
     ORDER BY r.id`,
    [DNI, COUNTRY]
  );
  const rechazadosIds = (rechazadosRes.rows || []).map((r) => r.request_id);
  let rechazadoIndex = 0;
  if (rechazadosIds.length > 0) logger.info(`Rechazados (solicitudes sin préstamo) para DNI ${DNI}: ${rechazadosIds.length}. Se asignarán por orden de fila en el sheet.`);

  for (const { row, excelIndex } of filtered) {
    const prestamoId = getPrestamoId(row);
    const prestamoIdTrim = (prestamoId && String(prestamoId).trim()) || '';
    const flotaCol = toStr(getCol(row, 'Flota'), 100);
    const parkIdResolved = resolveFlotaToParkId(flotaCol, flotaNameToParkId, flotaIdSet);
    if (flotaCol && parkIdResolved === null) {
      logger.warn(`Flota "${flotaCol}" no se pudo resolver a park_id (no está en la API). Ejecute sync-park-id-from-drivers o revise el nombre. Se omite la fila.`);
      continue;
    }
    const numCuentaRaw = getNumeroCuentaFromSheet(sheet, excelIndex, colIndexNumCuenta) ?? getCol(row, 'NUMERO DE CUENTA', 'Número de cuenta', 'Numero de cuenta') ?? getColByAnyNormalized(row, 'NUMERO DE CUENTA', 'Numero de cuenta');
    const numCuenta = numCuentaRaw != null && String(numCuentaRaw).trim() !== '' ? String(numCuentaRaw).trim().slice(0, 100) : null;
    const tipoCuenta = toStr(getCol(row, 'TIPO DE CUENTA', 'Tipo de cuenta') ?? getColByAnyNormalized(row, 'TIPO DE CUENTA', 'Tipo de cuenta'), 50);
    const banco = toStr(getCol(row, 'BANCO', 'BANCO '), 100);
    const adondeAbonamos = toStr(getCol(row, '¿A dónde te abonamos?') ?? getColByAnyNormalized(row, 'A dónde te abonamos'), 200);
    const tasaSemanal = toNum(getCol(row, 'Tasa semanal (t)', 'Tasa semanal'));
    const cuota = toNum(getCol(row, 'Cuota_Programada', 'cuota'));

    let driverId;
    if (!DRY_RUN) {
      driverId = await ensureDriverByDniFlota(DNI, COUNTRY, parkIdResolved !== null ? parkIdResolved : '', row);
    } else {
      driverId = 'dry-run-driver-id';
    }

    if (prestamoIdTrim) {
      const loanRes = await query(
        `SELECT l.id AS loan_id, l.request_id
         FROM module_rapidin_loans l
         INNER JOIN module_rapidin_drivers d ON d.id = l.driver_id
         WHERE d.dni = $1 AND l.country = $2 AND (TRIM(COALESCE(l.external_loan_id, '')) = $3 OR l.external_loan_id = $3)`,
        [DNI, COUNTRY, prestamoIdTrim]
      );

      if (loanRes.rows.length === 0) {
        logger.warn(`Préstamo no encontrado para PréstamoID="${prestamoIdTrim}" (DNI ${DNI}).`);
        continue;
      }

      const { loan_id, request_id } = loanRes.rows[0];
      const observations = buildObservationsJson({ flota: flotaCol, adondeAbonamos, numCuenta, tipoCuenta, banco, tasaSemanal, cuota });

      if (!DRY_RUN) {
        await query(`UPDATE module_rapidin_loans SET driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [driverId, loan_id]);
        await query(`UPDATE module_rapidin_loan_requests SET driver_id = $1, observations = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`, [driverId, observations, request_id]);
        logger.info(`Préstamo ${prestamoIdTrim} → conductor park_id=${parkIdResolved || '(sin flota)'} "${flotaCol || '(sin flota)'}", observations actualizadas.`);
      } else {
        logger.info(`[DRY-RUN] Préstamo ${prestamoIdTrim} → park_id=${parkIdResolved || '(sin flota)'} "${flotaCol || '(sin flota)'}", observations con Nº cuenta y flota.`);
      }
      continue;
    }

    if (rechazadoIndex >= rechazadosIds.length) {
      logger.warn(`Fila sin PréstamoID (rechazado) flota "${flotaCol || '(sin flota)'}": no queda solicitud sin préstamo para asignar. Conductor ya creado/actualizado.`);
      continue;
    }

    const requestId = rechazadosIds[rechazadoIndex];
    rechazadoIndex++;
    const observations = buildObservationsJson({ flota: flotaCol, adondeAbonamos, numCuenta, tipoCuenta, banco, tasaSemanal, cuota });

    if (!DRY_RUN) {
      await query(`UPDATE module_rapidin_loan_requests SET driver_id = $1, observations = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`, [driverId, observations, requestId]);
      logger.info(`Solicitud rechazada (sin PréstamoID) → conductor park_id=${parkIdResolved || '(sin flota)'} "${flotaCol || '(sin flota)'}", observations actualizadas.`);
    } else {
      logger.info(`[DRY-RUN] Solicitud rechazada → park_id=${parkIdResolved || '(sin flota)'} "${flotaCol || '(sin flota)'}".`);
    }
  }

  logger.info('Listo.');
  process.exit(0);
}

run().catch((err) => {
  logger.error(err);
  process.exit(1);
});
