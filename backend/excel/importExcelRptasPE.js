/**
 * Importación HISTÓRICA: datos del Excel "Rptas PE" / "Cronograma PE" (Prestamos Yego) a PostgreSQL.
 * Todo lo que se muestra (Ciclo, Fecha de vencimiento) sale del Excel; no se aplican reglas ni
 * cláusulas del sistema. Las fechas son las del histórico aunque sean pasadas.
 *
 * Uso (desde backend/):
 *   node excel/importExcelRptasPE.js                  # importar Perú (PE)
 *   node excel/importExcelRptasPE.js --country=CO     # importar Colombia (CO)
 *   node excel/importExcelRptasPE.js --dry-run        # solo simular
 *   node excel/importExcelRptasPE.js --limit=20       # solo 20 filas
 *   node excel/importExcelRptasPE.js --debug          # ver columnas y ejemplo
 *   node excel/importExcelRptasPE.js --google-sheet-id=1mXdVRuSsOK9IlbpY1CQaNe_AHEVeePiU   # usar Excel desde Google Sheets (descarga y usa ese archivo)
 *
 * Requiere: Prestamos Yego (6).xlsx en la raíz del proyecto (fuera de frontend y backend).
 *
 * Columnas del Excel (histórico):
 * - Ciclo actual → conductor.cycle (se muestra en solicitudes e info del conductor).
 * - Rptas PE: DNI, Monto Otorgado, Estado, Ciclo actual, Fecha_Programada/Primera_Cuota_Overide, etc.
 * - Cronograma PE/CO: cada fila = una cuota. En cronograma de cuotas (app) se registra exactamente:
 *   Fecha_Programada → due_date, Monto_Pagado → paid_amount, Mora → late_fee (nunca negativa; PE y CO),
 *   Fecha_Pago → paid_date, Dias_Atraso → days_overdue, Estado → status, Cuota_Programada → installment_amount.
 *
 * SECUENCIA DE GUARDADO (orden para que todo quede correcto):
 *
 * 1) PASO 1 — Rptas PE/CO (hoja "Rptas PE" o "Rptas CO")
 *    - Por cada fila con DNI:
 *      a) Crear o actualizar CONDUCTOR (ensureDriver): DNI, nombre, teléfono, email, Ciclo actual, Flota, etc.
 *      b) Crear SOLICITUD (loan_request) con:
 *         - requested_amount = Monto Otorgado; si no hay valor → Monto Solicitado
 *         - status = según Estado (rechazado, cancelado, pendiente, aprobado, desembolsado)
 *         - created_at (fecha): rechazado/aprobado → Marca temporal; desembolsado/cancelado → FECHA DESEMBOLSO (si no hay → Marca temporal); resto → Marca temporal (fecha y hora como en el Excel)
 *         - observations = Flota; si "¿A dónde te abonamos?" = "A UNA CUENTA BANCARIA" → Numero de cuenta y Tipo de cuenta;
 *           si contiene "YANGO" → "Tipo de cuenta: Yango Pro"; más Tasa y Cuota si existen
 *         - cycle = Ciclo actual
 *    - Se guardan mapas: requestIdByRptasRow (fila Excel → request_id), prestamoIdToRequestId (PréstamoID → request_id).
 *    - NO se crean préstamos ni cuotas en este paso.
 *
 * 2) PASO 2 — Cronogramas PE/CO (hoja "Cronogramas PE" o "Cronogramas CO")
 *    - Se lee Ciclo y Flota desde Rptas por DNI (para completar datos si faltan en Cronograma).
 *    - Se agrupan filas por PréstamoID (cada grupo = un préstamo con N cuotas).
 *    - Por cada grupo:
 *      a) Buscar request_id: primero por columna "row" (fila de Rptas), luego por PréstamoID (prestamoIdToRequestId).
 *         Si no hay, se crea una nueva solicitud desde Cronograma.
 *      b) Si ya existe un préstamo con ese PréstamoID (external_loan_id): solo se actualizan cuotas y fechas.
 *      c) Si no existe préstamo: crear o actualizar conductor si hace falta; luego crear préstamo (loan) y cuotas (installments).
 *      d) Monto, tasa, primera cuota y fechas vienen del Cronograma (Monto_Otorgado, Tasa_Semanal, Fecha_Programada, Cuota_Programada).
 *      e) Fecha desembolso: de columna correspondiente en Cronograma o de primera cuota - 7 días.
 *      f) Si estado = cancelado en todas las cuotas: se actualiza la solicitud con "Cancelado fecha: YYYY-MM-DD" (fecha de la última cuota).
 *
 * 3) Resultado: conductores y solicitudes quedan en Paso 1; préstamos y cuotas en Paso 2, enlazados por row o PréstamoID.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { query } = await import('../config/database.js');
const { logger } = await import('../utils/logger.js');

const DRY_RUN = process.argv.includes('--dry-run');
const DEBUG = process.argv.includes('--debug');
const limitArg = process.argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? (limitArg.includes('=') ? parseInt(limitArg.split('=')[1], 10) : parseInt(process.argv[process.argv.indexOf(limitArg) + 1], 10)) : null;
if (LIMIT != null && isNaN(LIMIT)) throw new Error('--limit debe ser un número');

const countryArg = process.argv.find(a => a.startsWith('--country='));
const COUNTRY = countryArg ? String(countryArg.split('=')[1]).toUpperCase() === 'CO' ? 'CO' : 'PE' : 'PE';
const fileArg = process.argv.find(a => a.startsWith('--file='));
const excelFileName = fileArg ? fileArg.split('=')[1].trim().replace(/^["']|["']$/g, '') : 'Prestamos Yego (6).xlsx';
const EXCEL_PATH = path.join(__dirname, '..', '..', excelFileName);
const dniArg = process.argv.find(a => a.startsWith('--dni='));
const FILTER_DNI = dniArg ? String(dniArg.split('=')[1]).trim() : null;
const googleSheetIdArg = process.argv.find(a => a.startsWith('--google-sheet-id='));
const GOOGLE_SHEET_ID = (googleSheetIdArg ? googleSheetIdArg.split('=')[1].trim() : null) || process.env.EXCEL_GOOGLE_SHEET_ID || null;
// Priorizar Cronogramas (una fila por cuota); si no existe, usar Rptas (una fila por solicitud)
const SHEET_NAMES = COUNTRY === 'CO'
  ? ['Cronogramas CO', 'Cronograma CO', 'Rptas CO']
  : ['Cronogramas PE', 'Cronograma PE', 'Rptas PE'];

// Excel serial date: 1 = 1900-01-01. Se usa el valor de la columna tal cual, sin sumar ni restar días.
const EXCEL_EPOCH_1970_DAYS = 25569; // días desde 1900-01-01 hasta 1970-01-01 UTC
function excelDateToJS(serial) {
  if (serial == null || serial === '' || isNaN(Number(serial))) return null;
  const n = Number(serial);
  const utcMs = (n - EXCEL_EPOCH_1970_DAYS) * 86400000;
  const d = new Date(utcMs);
  return isNaN(d.getTime()) ? null : d;
}

// Normalizar a medianoche UTC del mismo día civil. Usa componentes UTC del Date para que Fecha_Programada (serial Excel = 16 feb UTC) y fechas parseadas en UTC coincidan con el día del Excel (16, no 14 ni 15).
function toUTCMidnight(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/** Fecha para INSERT en BD: string YYYY-MM-DD con el día civil (UTC) para que no se guarde un día menos por zona horaria (ej. 8 → 8, no 7). */
function dateToDateString(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// La primera cuota debe ser siempre lunes (día 1 en UTC). Dom 25 → Lun 26; Mar 27 → Lun 26 (mismo lunes).
function toUTCMonday(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return null;
  const day = d.getUTCDay(); // 0=Dom, 1=Lun, ..., 6=Sab
  if (day === 1) return toUTCMidnight(d);
  let monday;
  if (day === 0) monday = new Date(d.getTime() + 86400000); // Domingo → +1 día = lunes siguiente (ej. 25 → 26)
  else monday = new Date(d.getTime() - (day - 1) * 86400000); // Mar→-1, Mié→-2, ... = lunes de esa semana
  return new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate(), 0, 0, 0, 0));
}


function toNum(val) {
  if (val == null || val === '') return null;
  const n = parseFloat(String(val).replace(',', '.'));
  return isNaN(n) ? null : n;
}

function toStr(val, maxLen = 255) {
  if (val == null) return null;
  const s = String(val).trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s || null;
}

/** Normaliza número de cuenta: quita espacios y deja solo dígitos. Si viene en notación científica (string), la expande sin redondear con Math.round (para no perder dígitos como 7443086129220 → 7443090000000). */
function normalizeAccountNumber(val) {
  if (val == null || val === '') return '';
  const s = String(val).trim();
  if (!s) return '';
  // Si es string en notación científica, expandir sin redondear: "7.44308612922E+12" → dígitos (evitar Math.round que no pierde en JS para < 15 dígitos, pero el número ya puede venir redondeado del Excel)
  const sciMatch = s.match(/^([\d.]+)\s*e\s*([+-]?\d+)$/i);
  if (sciMatch) {
    const base = parseFloat(sciMatch[1]);
    const exp = parseInt(sciMatch[2], 10);
    if (Number.isFinite(base) && Number.isFinite(exp)) {
      const num = base * Math.pow(10, exp);
      if (num <= Number.MAX_SAFE_INTEGER && num >= Number.MIN_SAFE_INTEGER) return String(Math.round(num));
      return String(num).replace(/\.\d+$/, '').replace(/\D/g, '') || String(Math.round(num));
    }
  }
  // Solo dígitos (preservar el string tal cual si ya viene completo del Excel como texto)
  const digits = s.replace(/\s/g, '').replace(/[-.]/g, '').replace(/\D/g, '');
  return digits.length > 0 ? digits : s;
}

/**
 * Construye observations como JSON para que el front muestre "Cuenta para desembolso" (deposit_type, bank, account_type, account_number).
 * Incluye notes con Flota, Tasa, Cuota si existen.
 * Si hay banco, tipo de cuenta o número de cuenta, se arma el objeto bancario aunque "¿A dónde te abonamos?" esté vacío o sea distinto.
 */
function buildObservationsJson({ flota, adondeAbonamos, numCuenta, tipoCuenta, banco, tasaSemanal, cuota }) {
  const notesParts = [];
  if (flota) notesParts.push(`Flota: ${flota}`);
  if (tasaSemanal != null && !isNaN(tasaSemanal)) notesParts.push(`Tasa: ${tasaSemanal}`);
  if (cuota != null && cuota > 0) notesParts.push(`Cuota: ${cuota}`);
  const notes = notesParts.length ? notesParts.join('; ') : undefined;

  if (adondeAbonamos && /YANGO/i.test(adondeAbonamos)) {
    const obj = { deposit_type: 'yango', ...(notes && { notes }) };
    return JSON.stringify(obj);
  }

  const bancoStr = toStr(banco, 100);
  const tipoStr = toStr(tipoCuenta, 50);
  let account_type = '';
  if (/corriente/i.test(tipoStr)) account_type = 'checking';
  else if (/ahorro/i.test(tipoStr)) account_type = 'savings';
  else if (tipoStr) account_type = tipoStr;
  const account_number = normalizeAccountNumber(numCuenta);
  const hasBankData = bancoStr || account_type || account_number;

  if (hasBankData || adondeAbonamos && /UNA CUENTA BANCARIA|CUENTA BANCARIA|BANCO/i.test(adondeAbonamos)) {
    const obj = {
      deposit_type: 'bank',
      ...(bancoStr && { bank: bancoStr }),
      ...(account_type && { account_type }),
      ...(account_number && { account_number }),
      ...(notes && { notes }),
    };
    return JSON.stringify(obj);
  }
  // Si no viene nada (sin banco/cuenta ni "A dónde te abonamos"), asumir Yango Pro en el type
  if (notes) return JSON.stringify({ deposit_type: 'yango', notes });
  return JSON.stringify({ deposit_type: 'yango' });
}

/** Devuelve observations actualizado con "Cancelado fecha: YYYY-MM-DD". Si observations es JSON válido, añade a notes; si no, concatena texto. */
function appendCancelledToObservations(currentObservations, fechaStr) {
  const suffix = ` Cancelado fecha: ${fechaStr}`;
  if (!currentObservations || typeof currentObservations !== 'string') return suffix.trim();
  try {
    const parsed = JSON.parse(currentObservations);
    if (parsed && typeof parsed === 'object') {
      const prevNotes = parsed.notes ? `${parsed.notes};` : '';
      parsed.notes = (prevNotes + suffix).trim();
      return JSON.stringify(parsed);
    }
  } catch (_) {}
  return (currentObservations + suffix).trim();
}

// Normalizar teléfono: PE quita +51; CO normaliza a +57 + 10 dígitos para consistencia en BD
function normalizePhone(val, country = 'PE') {
  const s = toStr(val, 20);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (country === 'CO') {
    if (digits.length === 12 && digits.startsWith('57')) return `+${digits}`;
    if (digits.length === 10) return `+57${digits}`;
    if (digits.length > 0) return `+57${digits.slice(-10)}`;
    return null;
  }
  return s.replace(/^\+?51/, '').trim() || null;
}

// Nombres: primera letra mayúscula, resto minúscula por palabra (ej. "BRYAN ANDRÉS" → "Bryan Andrés")
function normalizeName(val) {
  const s = toStr(val, 255);
  if (!s) return '';
  return s.split(/\s+/).map((word) => {
    if (!word.length) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

// Clave para match por nombre entre Rptas y Cronograma: normalizar para comparar (minúsculas, sin espacios extra)
function normalizeNameForMatch(val) {
  const s = toStr(val, 255);
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Obtener valor de fila por posible nombre de columna (con alias)
function getCol(row, ...names) {
  for (const n of names) {
    if (row[n] != null && row[n] !== '') return row[n];
  }
  return null;
}

// Buscar valor de columna por nombre normalizado (trim + minúsculas) por si el Excel trae espacios/capitalización distinta
function getColByNormalizedKey(row, normalizedName) {
  const target = normalizedName.trim().toLowerCase();
  for (const key of Object.keys(row)) {
    if (key != null && String(key).trim().toLowerCase() === target) {
      const val = row[key];
      if (val != null && val !== '') return val;
      return null;
    }
  }
  return null;
}

// Probar varios nombres normalizados (para columnas del histórico: Ciclo, Fecha de vencimiento, etc.)
function getColByAnyNormalized(row, ...normalizedNames) {
  for (const name of normalizedNames) {
    const val = getColByNormalizedKey(row, name);
    if (val != null && val !== '') return val;
  }
  return null;
}

const NUMERO_CUENTA_HEADERS = ['NUMERO DE CUENTA', 'NUMERO DE CUENTA ', 'Número de cuenta', 'Numero de cuenta'];

/** Obtiene el índice de columna (0-based) de "NUMERO DE CUENTA" en la primera fila del sheet, o -1 si no existe. */
function getNumeroCuentaColIndex(sheet) {
  if (!sheet || !sheet['!ref']) return -1;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cellAddr = XLSX.utils.encode_cell({ r: 0, c });
    const cell = sheet[cellAddr];
    const raw = cell && (cell.w != null ? cell.w : (cell.v != null ? cell.v : ''));
    const header = raw != null && raw !== '' ? String(raw).trim() : '';
    if (NUMERO_CUENTA_HEADERS.some(h => header === h || header.toLowerCase() === h.toLowerCase())) return c;
  }
  return -1;
}

/**
 * Lee el número de cuenta desde la celda del sheet. Siempre devuelve string (texto) o null.
 * - Si la celda es texto (t==='s'): se usa el string completo.
 * - Si la celda es numérica (t==='n'): se prioriza cell.w cuando es solo dígitos; si no, se convierte el número a string sin redondear para no perder dígitos.
 */
function getNumeroCuentaFromSheet(sheet, dataRowIndex0Based, colIndex) {
  if (!sheet || colIndex < 0) return null;
  const cellAddr = XLSX.utils.encode_cell({ r: dataRowIndex0Based + 1, c: colIndex });
  const cell = sheet[cellAddr];
  if (!cell) return null;
  if (cell.t === 's') return (cell.v != null && cell.v !== '') ? String(cell.v).trim() : null;
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

/** Convierte string en notación científica a string de solo dígitos sin redondear (usa BigInt si hace falta para > 15 dígitos). */
function expandScientificNotationString(s) {
  const m = s.match(/^([\d.]+)\s*e\s*([+-]?\d+)$/i);
  if (!m) return null;
  const base = parseFloat(m[1]);
  const exp = parseInt(m[2], 10);
  if (!Number.isFinite(base) || !Number.isFinite(exp)) return null;
  const num = base * Math.pow(10, exp);
  if (num <= Number.MAX_SAFE_INTEGER && num >= Number.MIN_SAFE_INTEGER) return String(Math.round(num));
  return String(num).replace(/\.\d+$/, '').replace(/\D/g, '') || String(Math.round(num));
}

/**
 * Un solo punto de mapeo para celdas de fecha del Excel. Según el TIPO de columna:
 * - number → serial Excel → excelDateToJS (más fácil, sin ambigüedad). Cronograma con raw:true devuelve esto.
 * - string → parseMarcaTemporal (DD/MM/YYYY o serial como texto). Rptas con raw:false puede devolver esto.
 * Así evitamos complicaciones y duplicar lógica.
 */
function parseDateCell(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && !isNaN(val)) return excelDateToJS(val);
  if (typeof val === 'string') return parseMarcaTemporal(val);
  const n = toNum(val);
  return n != null ? excelDateToJS(n) : null;
}

/**
 * Fecha_Programada viene como texto sin formato (solo copiar el valor). Se interpreta solo como string de fecha (DD/MM/YYYY, YYYY-MM-DD, etc.), nunca como serial Excel.
 */
function parseDateCellFechaProgramada(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (!s) return null;
  return parseDateFromStringOnly(s);
}

/** Parsea solo strings de fecha (DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, con o sin hora). No usa serial Excel. */
function parseDateFromStringOnly(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  function fullYear(yStr) {
    const y = parseInt(yStr, 10);
    if (y >= 100) return y;
    return y <= 40 ? 2000 + y : 1900 + y;
  }
  function toDayMonth(n1, n2) {
    const a = parseInt(n1, 10);
    const b = parseInt(n2, 10);
    if (a > 12) return { day: a, month: b };
    if (b > 12) return { day: b, month: a };
    return { day: a, month: b };
  }
  const yUtc = (yy) => fullYear(yy);
  const matchFull = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (matchFull) {
    const [, n1, n2, y, h, min, sec] = matchFull;
    const { day, month } = toDayMonth(n1, n2);
    const date = new Date(Date.UTC(yUtc(y), month - 1, day, parseInt(h, 10), parseInt(min, 10), parseInt(sec, 10)));
    return isNaN(date.getTime()) ? null : date;
  }
  const matchDate = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (matchDate) {
    const [, n1, n2, y] = matchDate;
    const { day, month } = toDayMonth(n1, n2);
    const date = new Date(Date.UTC(yUtc(y), month - 1, day, 0, 0, 0, 0));
    return isNaN(date.getTime()) ? null : date;
  }
  const matchDash = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})/);
  if (matchDash) {
    const [, n1, n2, y] = matchDash;
    const { day, month } = toDayMonth(n1, n2);
    const date = new Date(Date.UTC(yUtc(y), month - 1, day, 0, 0, 0, 0));
    return isNaN(date.getTime()) ? null : date;
  }
  const matchIso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (matchIso) {
    const [, y, m, d] = matchIso;
    const date = new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), 0, 0, 0, 0));
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Parsear CUALQUIER fecha que venga del Excel (Marca temporal, FECHA DESEMBOLSO, Fecha_Programada, Fecha_Pago, etc.).
 * Acepta:
 * - String "04/09/2025 02:32:37" o "8/30/2025 16:26:48": DD/MM/YYYY o MM/DD/YYYY (si el segundo número > 12 se asume MM/DD)
 * - Número serial Excel
 * Devuelve Date con fecha y hora, o null.
 */
function parseMarcaTemporal(val) {
  if (val == null || val === '') return null;
  // Si ya es un objeto Date (p. ej. cellDates: true en xlsx)
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  // Si es número (Excel serial) — priorizar para no depender del formato de texto
  const numVal = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
  if (typeof numVal === 'number' && !isNaN(numVal) && numVal > 0) {
    const d = excelDateToJS(numVal);
    // Evitar que números pequeños (ej. número de fila 8, 10) se interpreten como fecha → 8 ene 1900
    if (d && d.getFullYear() >= 2020 && d.getFullYear() <= 2030) return d;
  }
  const str = String(val).trim();
  // Año 2 cifras → 4 cifras: 00-40 → 2000-2040, 41-99 → 1941-1999
  function fullYear(yStr) {
    const y = parseInt(yStr, 10);
    if (y >= 100) return y;
    return y <= 40 ? 2000 + y : 1900 + y;
  }
  // Columna fecha: día/mes/año (DD/MM/YYYY). Si el primer número > 12 es el día; si el segundo > 12 es MM/DD (US); si ambos ≤ 12 → DD/MM (ej. 22/10/2025 = 22 oct, 8/30/2025 = 30 ago)
  function toDayMonth(n1, n2) {
    const a = parseInt(n1, 10);
    const b = parseInt(n2, 10);
    if (a > 12) return { day: a, month: b }; // DD/MM (ej. 22/10/2025 → 22 octubre)
    if (b > 12) return { day: b, month: a }; // MM/DD (ej. 8/30/2025 → 30 agosto)
    return { day: a, month: b }; // ambos ≤ 12 → DD/MM (Perú/Latam: primero día, segundo mes)
  }
  // Construir en UTC para que el día no cambie por zona horaria del servidor (16/02/2026 → siempre 16 feb UTC).
  const yUtc = (yy) => fullYear(yy);
  // DD/MM/YYYY o MM/DD/YYYY HH:mm:ss
  const matchFull = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (matchFull) {
    const [, n1, n2, y, h, min, sec] = matchFull;
    const { day, month } = toDayMonth(n1, n2);
    const date = new Date(Date.UTC(yUtc(y), month - 1, day, parseInt(h, 10), parseInt(min, 10), parseInt(sec, 10)));
    return isNaN(date.getTime()) ? null : date;
  }
  // DD/MM/YYYY o MM/DD/YYYY o DD/MM/YY (solo fecha; ej. 05/09/25 → 5 sept 2025, 16/02/2026 → 16 feb 2026)
  const matchDate = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (matchDate) {
    const [, n1, n2, y] = matchDate;
    const { day, month } = toDayMonth(n1, n2);
    const date = new Date(Date.UTC(yUtc(y), month - 1, day, 0, 0, 0, 0));
    return isNaN(date.getTime()) ? null : date;
  }
  // DD-MM-YYYY o DD-MM-YY
  const matchDash = str.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})/);
  if (matchDash) {
    const [, n1, n2, y] = matchDash;
    const { day, month } = toDayMonth(n1, n2);
    const date = new Date(Date.UTC(yUtc(y), month - 1, day, 0, 0, 0, 0));
    return isNaN(date.getTime()) ? null : date;
  }
  // YYYY-MM-DD (ISO)
  const matchIso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (matchIso) {
    const [, y, m, d] = matchIso;
    const date = new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), 0, 0, 0, 0));
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

// Si la fecha es futura, no usarla (devolver null para que la BD use CURRENT_TIMESTAMP)
function noFutureDate(date) {
  if (!date || isNaN(date.getTime())) return null;
  if (date.getTime() > Date.now()) return null;
  return date;
}

// Fechas de solicitud/préstamo: rechazar año 1900 o cualquier fecha fuera de rango razonable (evita que números como 8 o 10 se interpreten como serial Excel)
function validRequestDate(date) {
  if (!date || isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  if (year < 2020 || year > 2030) return null;
  if (date.getTime() > Date.now()) return null;
  return date;
}

// Para importación histórica: aceptar cualquier fecha razonable del Excel (no rechazar por ser futura); solo descartar años absurdos
function validRequestDateForImport(date) {
  if (!date || isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear ? date.getUTCFullYear() : date.getFullYear();
  if (year < 2015 || year > 2040) return null;
  return date;
}

// Mapeo Estado Excel -> status loan_request / si crear loan
function mapEstado(estado) {
  const e = (toStr(estado) || '').toUpperCase();
  if (e.includes('RECHAZADO')) return { requestStatus: 'rejected', createLoan: false };
  if (e.includes('CANCELADO') || e.includes('CANCELLED')) return { requestStatus: 'cancelled', createLoan: false };
  // Desembolsado -> status 'disbursed' en la solicitud y se crea préstamo
  if (e.includes('DESEMBOLSO') || e.includes('DESEMBOLSADO')) return { requestStatus: 'disbursed', createLoan: true };
  if (e.includes('APROBADO') || e.includes('FIRMADO') || e.includes('ENTREGADO') || e.includes('ACTIVO')) return { requestStatus: 'approved', createLoan: true };
  if (e.includes('PENDIENTE') || e.includes('PENDING')) return { requestStatus: 'pending', createLoan: false };
  return { requestStatus: 'pending', createLoan: false };
}

// Estado (Cronograma PE) -> status de cuota: CANCELADO = pagado, PENDIENTE = pending
function mapEstadoInstallment(estado) {
  const e = (toStr(estado) || '').toUpperCase();
  if (e.includes('CANCELADO') || e.includes('CANCELLED') || e.includes('PAGADO') || e.includes('PAID')) return 'paid';
  return 'pending';
}

// Obtener PréstamoID de una fila (Rptas PE/CO o Cronograma PE/CO): puede venir como "PréstamoID" (con tilde) o "PrestamoID" (sin tilde).
// Relación: la columna "row" del Cronograma apunta a la fila de Rptas; ambas hojas tienen PréstamoID y deben corresponder al mismo préstamo.
function getPrestamoId(row) {
  return toStr(
    getCol(row, 'PréstamoID', 'PréstamoID ', 'PrestamoID', 'PrestamoID ') ??
    getColByAnyNormalized(row, 'PréstamoID', 'PrestamoID'),
    100
  );
}

// En filas del Cronograma PE/CO puede venir "PréstamoID" o "PrestamoID" (nombres con/sin tilde).
function getPrestamoIdCronograma(row) {
  return toStr(
    getCronogramaCol(row, 'PréstamoID', 'PréstamoID ', 'PrestamoID', 'PrestamoID '),
    100
  );
}

// Detectar si la hoja es Cronogramas (PE o CO): una fila por cuota, tiene N_Cuota y PrestamoID se repite
function isCronogramaSheet(rows, sheetName) {
  if (sheetName === 'Cronogramas PE' || sheetName === 'Cronograma PE') return true;
  if (sheetName === 'Cronogramas CO' || sheetName === 'Cronograma CO') return true;
  if (rows.length === 0) return false;
  const first = rows[0];
  const hasNCuota = getCol(first, 'N_Cuota', 'N_Cuota ') != null || getColByNormalizedKey(first, 'N_Cuota') != null;
  return !!hasNCuota;
}

// Crear/obtener conductor desde fila de Cronograma PE (DNI, Nombre, Ciclo actual → cycle)
async function ensureDriverFromCronograma(dni, nombre, idByDni, cycle = 1, flota = null) {
  if (!dni) return null;
  if (idByDni.has(dni)) return idByDni.get(dni);
  const parts = String(nombre || 'Sin nombre').trim().split(/\s+/).filter(Boolean);
  const first_name = normalizeName(parts[0] || 'Sin nombre');
  const last_name = normalizeName(parts.slice(1).join(' ')) || '';
  const cycleNum = cycle != null && !isNaN(cycle) ? Math.max(1, Math.floor(Number(cycle))) : 1;
  const flotaStr = flota ? toStr(flota, 100) : null;
  if (!DRY_RUN) {
    const existing = await query(
      `SELECT id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 LIMIT 1`,
      [dni, COUNTRY]
    );
    let id;
    if (existing.rows.length > 0) {
      await query(
        `UPDATE module_rapidin_drivers SET first_name = $1, last_name = $2, cycle = $3, park_id = COALESCE(NULLIF(TRIM($4), ''), park_id), updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
        [first_name, last_name, cycleNum, flotaStr, existing.rows[0].id]
      );
      id = existing.rows[0].id;
    } else {
      const r = await query(
        `INSERT INTO module_rapidin_drivers (dni, country, first_name, last_name, phone, email, yego_premium, cycle, credit_line, completed_trips, park_id)
         VALUES ($1, $2, $3, $4, NULL, NULL, false, $5, 0, 0, $6) RETURNING id`,
        [dni, COUNTRY, first_name, last_name, cycleNum, flotaStr]
      );
      id = r.rows[0].id;
    }
    idByDni.set(dni, id);
    return id;
  }
  idByDni.set(dni, 'dry-run-uuid');
  return 'dry-run-uuid';
}

async function ensureDriver(row, idByDni, canonicalDniOverride = null) {
  let dni = toStr(getCol(row, 'DNI - CARNÉ EXTRANJERÍA ', 'CÉDULA DE CIUDADANIA - CARNÉ EXTRANJERÍA ', 'DNI', 'Cédula'), 20);
  if (!dni) return null;
  const dniForDb = canonicalDniOverride != null ? (String(canonicalDniOverride).trim() || dni) : dni;
  if (dniForDb) dni = dniForDb;

  if (idByDni.has(dni)) return idByDni.get(dni);

  const fullName = toStr(getCol(row, 'Nombres y Apellidos'), 255) || 'Sin nombre';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first_name = normalizeName(parts[0] || 'Sin nombre');
  const last_name = normalizeName(parts.slice(1).join(' ')) || '';

  const email = toStr(getCol(row, 'Dirección de correo electrónico'), 255);
  const phone = normalizePhone(getCol(row, 'Teléfono'), COUNTRY);
  const yegoPremium = /sí|si|yes|1|oro/i.test(String(getCol(row, '¿Eres Yego Premium Oro?') || ''));
  // Ciclo actual: del Excel histórico; se guarda en conductor y se muestra en solicitudes / info conductor
  const cycleVal =
    getCol(row, 'Ciclo actual', 'Ciclo actual ', 'Ciclo Actual', 'Ciclo') ??
    getColByAnyNormalized(row, 'Ciclo actual', 'Ciclo');
  const cycleRaw = toNum(cycleVal);
  const cycle = cycleRaw != null && !isNaN(cycleRaw) ? Math.max(1, Math.floor(cycleRaw)) : 1;
  const creditLine = toNum(getCol(row, 'Linea aprobada')) ?? 0;
  const tripsRaw = toNum(getCol(row, 'viajes'));
  const trips = tripsRaw != null ? Math.floor(tripsRaw) : 0;
  // Flota: guardar nombre tal cual viene del Excel (puede ser ID o nombre)
  const flota = toStr(getCol(row, 'Flota'), 100);

  if (!DRY_RUN) {
    // Rptas: solo por DNI para evitar duplicidad. No buscar por teléfono (no mezclar personas). Primero insertar toda la hoja Rptas; luego Cronograma solo valida/vincula.
    const existingByDni = await query(
      `SELECT id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 LIMIT 1`,
      [dniForDb || dni, COUNTRY]
    );
    let id;
    if (existingByDni.rows.length > 0) {
      id = existingByDni.rows[0].id;
      await query(
        `UPDATE module_rapidin_drivers SET
           first_name = $1, last_name = $2, phone = COALESCE(NULLIF(TRIM($3), ''), phone),
           email = COALESCE(NULLIF(TRIM($4), ''), email), yego_premium = $5, cycle = $6,
           credit_line = $7, completed_trips = $8, park_id = COALESCE(NULLIF(TRIM($9), ''), park_id),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $10`,
        [first_name, last_name, phone, email, yegoPremium, cycle, creditLine, trips, flota, id]
      );
    } else {
      try {
        const r = await query(
          `INSERT INTO module_rapidin_drivers (dni, country, first_name, last_name, phone, email, yego_premium, cycle, credit_line, completed_trips, park_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [dni, COUNTRY, first_name, last_name, phone || null, email || null, yegoPremium, cycle, creditLine, trips, flota || null]
        );
        id = r.rows[0].id;
      } catch (insErr) {
        if (insErr.code === '23505') {
          const again = await query(
            `SELECT id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 LIMIT 1`,
            [dni, COUNTRY]
          );
          if (again.rows.length > 0) {
            id = again.rows[0].id;
          } else if (insErr.message && insErr.message.includes('idx_rapidin_drivers_phone_country_park')) {
            // (phone, country, park_id) ya existe con otro DNI: insertar este conductor sin phone/park para no mezclar y no duplicar
            const r2 = await query(
              `INSERT INTO module_rapidin_drivers (dni, country, first_name, last_name, phone, email, yego_premium, cycle, credit_line, completed_trips, park_id)
               VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, NULL) RETURNING id`,
              [dni, COUNTRY, first_name, last_name, email || null, yegoPremium, cycle, creditLine, trips]
            );
            id = r2.rows[0].id;
          } else {
            throw insErr;
          }
        } else throw insErr;
      }
    }
    idByDni.set(dni, id);
    return id;
  }
  idByDni.set(dni, 'dry-run-uuid');
  return 'dry-run-uuid';
}

// Leer valor de fila Cronograma PE: prueba nombres exactos Y normalizados de TODOS los nombres
function getCronogramaCol(row, ...names) {
  // Primero probar nombres exactos
  const exactMatch = getCol(row, ...names);
  if (exactMatch != null && exactMatch !== '') return exactMatch;
  // Luego probar TODOS los nombres normalizados
  for (const name of names) {
    const normalized = getColByNormalizedKey(row, name);
    if (normalized != null && normalized !== '') return normalized;
  }
  return null;
}

/** Calcular mora en el script (misma lógica que calculate_late_fee en BD). Tasa semanal / 7 = diaria; cada día se acumula sobre el saldo. */
function calculateLateFeeAtImport(baseAmount, daysOverdue, conditions) {
  if (!conditions || daysOverdue <= 0 || baseAmount <= 0) return 0;
  const rate = parseFloat(conditions.late_fee_rate) || 0;
  const dailyRate = rate / 100 / 7; // tasa semanal → diaria
  let lateFee = 0;
  if (conditions.late_fee_type === 'compound') {
    lateFee = baseAmount * (Math.pow(1 + dailyRate, daysOverdue) - 1);
  } else {
    lateFee = baseAmount * dailyRate * daysOverdue;
  }
  const cap = conditions.late_fee_cap != null ? parseFloat(conditions.late_fee_cap) : null;
  if (cap != null) {
    lateFee = Math.min(lateFee, baseAmount * cap / 100);
  }
  return Math.round(lateFee * 100) / 100;
}

/**
 * Paso final tras importar: actualiza estados de préstamos según cuotas.
 * 1) Cuotas vencidas y no pagadas → status = 'overdue', days_overdue.
 * 2) Préstamos active con al menos una cuota overdue → status = 'defaulted' (incumplido).
 * 3) Préstamos active con todas las cuotas pagadas → status = 'cancelled'; solicitud asociada → 'cancelled'.
 * Solo sobre préstamos del país importado (COUNTRY).
 */
async function syncLoanStatusAfterImport() {
  // 1) Marcar cuotas vencidas como overdue
  const updOverdue = await query(`
    UPDATE module_rapidin_installments i
    SET status = 'overdue',
        days_overdue = GREATEST(0, (CURRENT_DATE - i.due_date::date)::integer)
    FROM module_rapidin_loans l
    WHERE i.loan_id = l.id AND l.country = $1
      AND i.due_date::date < CURRENT_DATE
      AND i.status != 'paid'
      AND (i.paid_amount IS NULL OR i.paid_amount < i.installment_amount)
  `, [COUNTRY]);
  const nOverdue = updOverdue.rowCount ?? 0;
  if (nOverdue > 0) logger.info(`Paso final: ${nOverdue} cuota(s) marcadas como overdue (vencidas).`);

  // 2) Préstamos active con al menos una cuota overdue → defaulted (incumplido)
  const toDefaulted = await query(`
    SELECT l.id FROM module_rapidin_loans l
    WHERE l.country = $1 AND l.status = 'active'
      AND EXISTS (SELECT 1 FROM module_rapidin_installments i WHERE i.loan_id = l.id AND i.status = 'overdue')
  `, [COUNTRY]);
  const idsDefaulted = (toDefaulted.rows || []).map((r) => r.id);
  if (idsDefaulted.length > 0) {
    await query(
      `UPDATE module_rapidin_loans SET status = 'defaulted', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`,
      [idsDefaulted]
    );
    logger.info(`Paso final: ${idsDefaulted.length} préstamo(s) actualizados a defaulted (incumplido).`);
  }

  // 3) Préstamos active con todas las cuotas pagadas → cancelled
  const toCancelled = await query(`
    SELECT l.id FROM module_rapidin_loans l
    WHERE l.country = $1 AND l.status = 'active'
      AND (SELECT COUNT(*) FROM module_rapidin_installments i WHERE i.loan_id = l.id) > 0
      AND (SELECT COUNT(*) FROM module_rapidin_installments i WHERE i.loan_id = l.id)
          = (SELECT COUNT(*) FROM module_rapidin_installments i WHERE i.loan_id = l.id AND (i.status = 'paid' OR (i.installment_amount > 0 AND i.paid_amount >= i.installment_amount)))
  `, [COUNTRY]);
  const idsCancelled = (toCancelled.rows || []).map((r) => r.id);
  if (idsCancelled.length > 0) {
    await query(
      `UPDATE module_rapidin_loans SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`,
      [idsCancelled]
    );
    await query(`
      UPDATE module_rapidin_loan_requests r
      SET status = 'cancelled'
      WHERE r.status != 'cancelled'
        AND EXISTS (SELECT 1 FROM module_rapidin_loans l WHERE l.request_id = r.id AND l.id = ANY($1::uuid[]))
    `, [idsCancelled]);
    logger.info(`Paso final: ${idsCancelled.length} préstamo(s) actualizados a cancelled (todas las cuotas pagadas).`);
  }

  // 4) Ciclo del conductor: actualizar module_rapidin_drivers.cycle al mayor cycle entre sus créditos (solicitudes y préstamos)
  const updCycle = await query(`
    UPDATE module_rapidin_drivers d
    SET cycle = sub.max_cycle, updated_at = CURRENT_TIMESTAMP
    FROM (
      SELECT driver_id, MAX(cycle) AS max_cycle
      FROM (
        SELECT driver_id, cycle FROM module_rapidin_loan_requests WHERE country = $1 AND driver_id IS NOT NULL
        UNION ALL
        SELECT driver_id, cycle FROM module_rapidin_loans WHERE country = $1 AND driver_id IS NOT NULL
      ) u
      GROUP BY driver_id
    ) sub
    WHERE d.id = sub.driver_id AND d.country = $1
  `, [COUNTRY]);
  const nCycle = updCycle.rowCount ?? 0;
  if (nCycle > 0) logger.info(`Paso final: ${nCycle} conductor(es) con cycle actualizado al mayor ciclo de sus créditos.`);
}

// Procesar hoja Cronograma: una fila por cuota; agrupar por PrestamoID. Si existingLoansByPrestamoId tiene el PréstamoID, solo actualizamos cuotas.
// rptasByExcelRow: mapa número de fila Excel (Rptas PE/CO) → datos de esa fila (para columna "row" del Cronograma).
// requestIdByRptasRow: mapa número de fila Excel → request_id ya creado en Paso 1.
// prestamoIdToRequestId: mapa PréstamoID → request_id (match por PréstamoID cuando no hay "row").
async function processCronogramaPE(rows, idByDni, stats, errors, workbook, existingLoansByPrestamoId = new Map(), rptasByExcelRow = null, requestIdByRptasRow = null, prestamoIdToRequestId = null, requestIdsByDni = null, requestIdsByNombre = null) {
  // Crear mapa DNI -> Ciclo actual y Flota desde Rptas (PE o CO según país)
  const cicloByDni = new Map();
  const flotaByDni = new Map();
  const rptasSheetName = `Rptas ${COUNTRY}`;
  if (workbook) {
    const rptasSheet = workbook.Sheets[rptasSheetName];
    if (rptasSheet) {
      logger.info(`Leyendo Ciclo actual y Flota desde ${rptasSheetName}...`);
      const rptasData = XLSX.utils.sheet_to_json(rptasSheet, { defval: null, raw: false });
      for (const rptasRow of rptasData) {
        const dniRptas = toStr(getCol(rptasRow, 'DNI - CARNÉ EXTRANJERÍA ', 'CÉDULA DE CIUDADANIA - CARNÉ EXTRANJERÍA ', 'DNI'), 20);
        if (dniRptas) {
          // Leer Ciclo actual de Rptas PE (columna "Ciclo actual")
          const cycleVal = getCol(rptasRow, 'Ciclo actual', 'Ciclo actual ', 'Ciclo Actual', 'Ciclo') ?? getColByAnyNormalized(rptasRow, 'Ciclo actual', 'Ciclo');
          const cycle = toNum(cycleVal) != null && !isNaN(toNum(cycleVal)) && toNum(cycleVal) > 0 ? Math.max(1, Math.floor(toNum(cycleVal))) : null;
          // Guardar el ciclo (si hay múltiples filas del mismo DNI, siempre usar el último valor encontrado)
          if (cycle != null) {
            cicloByDni.set(dniRptas, cycle);
          }
          // Leer Flota de Rptas PE (puede ser ID o nombre)
          const flotaRptas = toStr(getCol(rptasRow, 'Flota'), 100);
          if (flotaRptas) {
            flotaByDni.set(dniRptas, flotaRptas);
          }
        }
      }
      logger.info(`Ciclos leídos desde ${rptasSheetName}: ${cicloByDni.size}`);
      logger.info(`Flotas leídas desde ${rptasSheetName}: ${flotaByDni.size}`);
    }
  }
  // Cargar condiciones de préstamo (PE/CO) para calcular mora al importar: si la cuota está vencida, mora = desde fecha vencimiento hasta hoy
  let loanConditionsPE = null;
  if (!DRY_RUN) {
    try {
      const condRes = await query(
        'SELECT late_fee_type, late_fee_rate, late_fee_cap FROM module_rapidin_loan_conditions WHERE country = $1 AND active = true ORDER BY version DESC LIMIT 1',
        [COUNTRY]
      );
      if (condRes.rows.length > 0) loanConditionsPE = condRes.rows[0];
    } catch (e) {
      logger.warn('No se pudieron cargar condiciones de préstamo para calcular mora: ' + e.message);
    }
  }
  if (rows.length > 0 && DEBUG) {
    logger.info(`Cronograma ${COUNTRY} - Columnas encontradas: ` + Object.keys(rows[0]).join(' | '));
    const r = rows[0];
    logger.info('Ejemplo PrestamoID: ' + getPrestamoId(r));
    logger.info('Ejemplo DNI: ' + getCronogramaCol(r, 'DNI'));
    logger.info('Ejemplo Nombre: ' + getCronogramaCol(r, 'Nombre'));
    logger.info('Ejemplo N_Cuota: ' + getCronogramaCol(r, 'N_Cuota'));
    logger.info('Ejemplo Fecha_Programada: ' + getCronogramaCol(r, 'Fecha_Programada'));
    logger.info('Ejemplo Cuota_Programada: ' + getCronogramaCol(r, 'Cuota_Programada'));
    logger.info('Ejemplo Estado: ' + getCronogramaCol(r, 'Estado'));
    logger.info('Ejemplo Monto_Pagado: ' + getCronogramaCol(r, 'Monto_Pagado'));
    logger.info('Ejemplo Fecha_Pago: ' + getCronogramaCol(r, 'Fecha_Pago'));
    logger.info('Ejemplo Mora: ' + getCronogramaCol(r, 'Mora'));
    logger.info('Ejemplo Monto_Otorgado: ' + getCronogramaCol(r, 'Monto_Otorgado'));
    logger.info('Ejemplo Tasa_Semanal: ' + getCronogramaCol(r, 'Tasa_Semanal'));
    logger.info('Ejemplo Ciclo actual: ' + getCronogramaCol(r, 'Ciclo actual'));
  }
  const groups = new Map(); // PréstamoID (Cronograma) -> [rows] ordenadas por N_Cuota. Relación: columna "row" del Cronograma = fila en Rptas; ambas tienen PréstamoID.
  for (const row of rows) {
    const pid = getPrestamoIdCronograma(row) || getPrestamoId(row);
    const dni = toStr(getCronogramaCol(row, 'DNI'), 20);
    if (!pid || !dni) continue;
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(row);
  }
  for (const [, groupRows] of groups) {
    groupRows.sort((a, b) => {
      const na = toNum(getCronogramaCol(a, 'N_Cuota')) ?? 0;
      const nb = toNum(getCronogramaCol(b, 'N_Cuota')) ?? 0;
      return na - nb;
    });
  }

  for (const [prestamoId, groupRows] of groups) {
    const first = groupRows[0];
    const dni = toStr(getCronogramaCol(first, 'DNI'), 20);
    if (FILTER_DNI && dni !== FILTER_DNI) continue;

    const prestamoIdTrim = prestamoId ? String(prestamoId).trim() : '';
    const existingLoan = prestamoIdTrim && existingLoansByPrestamoId.size > 0 ? existingLoansByPrestamoId.get(prestamoIdTrim) : null;
    const nombre = toStr(getCronogramaCol(first, 'Nombre'), 255);
    const montoOtorgado = toNum(getCronogramaCol(first, 'Monto_Otorgado', 'Monto Otorgado', 'Monto Otorgado '));
    const tasaSemanal = toNum(getCronogramaCol(first, 'Tasa_Semanal', 'Tasa semanal (t)', 'Tasa semanal'));
    // Ciclo actual: primero buscar en Cronogramas, si no existe buscar en Rptas (mapa cicloByDni)
    // El ciclo se guarda en el conductor y se muestra en cada solicitud
    let cycleVal = getCronogramaCol(first, 'Ciclo actual', 'Ciclo actual ', 'Ciclo Actual', 'Ciclo');
    let cycle = toNum(cycleVal) != null && !isNaN(toNum(cycleVal)) && toNum(cycleVal) > 0 ? Math.max(1, Math.floor(toNum(cycleVal))) : null;
    // Si no está en Cronogramas PE, buscar en Rptas PE por DNI (columna "Ciclo actual")
    if (cycle == null && cicloByDni.has(dni)) {
      cycle = cicloByDni.get(dni);
    }
    // Si tampoco está, usar 1 por defecto
    if (cycle == null) cycle = 1;
    // Flota: primero buscar en Cronogramas PE, si no existe buscar en Rptas PE (mapa flotaByDni)
    let flota = toStr(getCronogramaCol(first, 'Flota'), 100);
    if (!flota && flotaByDni.has(dni)) {
      flota = flotaByDni.get(dni);
    }
    const numInstallments = groupRows.length;
    const totalAmount = groupRows.reduce((sum, r) => sum + (toNum(getCronogramaCol(r, 'Cuota_Programada', 'cuota')) ?? 0), 0);
    const interestRate = tasaSemanal != null ? (tasaSemanal <= 1 ? tasaSemanal * 100 : tasaSemanal) : 5;

    if (!dni) continue;
    if (montoOtorgado == null || montoOtorgado <= 0) continue;

    try {
      // Si el préstamo ya existe (creado en Paso 1 desde Rptas con mismo PréstamoID), solo actualizamos cuotas.
      // Cronograma de pago: Fecha_Programada (Cronograma PE/CO) es la fuente para cada vencimiento de cuota.
      if (existingLoan && !DRY_RUN) {
        const loanId = existingLoan.id;
        await query('DELETE FROM module_rapidin_installments WHERE loan_id = $1', [loanId]);
        const numInstallments = groupRows.length;
        const totalAmount = groupRows.reduce((sum, r) => sum + (toNum(getCronogramaCol(r, 'Cuota_Programada', 'cuota')) ?? 0), 0);
        const allCancelado = groupRows.every(r => /CANCELADO|CANCELLED|PAGADO|PAID/i.test(String(getCronogramaCol(r, 'Estado', 'Estado ') || '')));
        // Primera cuota: Fecha_Programada (fuente del cronograma de pago). Si hay "row", priorizar Fecha_Programada de esa fila de Rptas.
        const rptasRowNumUpdate = toNum(getCronogramaCol(first, 'row', 'Row', 'Rptas PE row', 'Rptas CO row'));
        const rptasRowUpdate = rptasRowNumUpdate != null && rptasByExcelRow && rptasByExcelRow.get(rptasRowNumUpdate);
        let firstPaymentDate = null;
        if (rptasRowUpdate) {
          const primeraCuotaRaw = getCol(rptasRowUpdate, 'Primera_Cuota_Overide', 'Fecha_Programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha de vencimiento');
          if (primeraCuotaRaw != null && primeraCuotaRaw !== '') {
            firstPaymentDate = parseDateCellFechaProgramada(primeraCuotaRaw);
          }
        }
        if (!firstPaymentDate || isNaN(firstPaymentDate.getTime())) {
          const firstFecha = getCronogramaCol(first, 'Fecha_Programada', 'Fecha_programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha Programada', 'Fecha de vencimiento');
          if (firstFecha != null && firstFecha !== '') {
            firstPaymentDate = parseDateCellFechaProgramada(firstFecha);
          }
        }
        let firstPaymentDateFinal = firstPaymentDate && !isNaN(firstPaymentDate.getTime()) ? toUTCMidnight(firstPaymentDate) : null;
        const pendingBalance = totalAmount;
        await query(
          `UPDATE module_rapidin_loans SET total_amount = $1, number_of_installments = $2, first_payment_date = COALESCE($3, first_payment_date), pending_balance = $4, status = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6`,
          [totalAmount, numInstallments, dateToDateString(firstPaymentDateFinal), pendingBalance, allCancelado ? 'cancelled' : 'active', loanId]
        );
        const principalPerInstallment = montoOtorgado / numInstallments;
        const interestTotal = totalAmount - montoOtorgado;
        const interestPerInstallment = interestTotal / numInstallments;
        for (let idx = 0; idx < groupRows.length; idx++) {
          const row = groupRows[idx];
          const nCuota = toNum(getCronogramaCol(row, 'N_Cuota')) ?? idx + 1;
          // Cronograma: due_date = Fecha_Programada (serial Excel o texto sin formato; parseDateCell acepta ambos).
          const fechaProgramadaRaw = getCronogramaCol(row, 'Fecha_Programada', 'Fecha_programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha Programada', 'Fecha de vencimiento');
          let dueDateParsed = null;
          if (fechaProgramadaRaw != null && fechaProgramadaRaw !== '') {
            dueDateParsed = parseDateCell(fechaProgramadaRaw);
          }
          let dueDate = dueDateParsed && !isNaN(dueDateParsed.getTime()) ? toUTCMidnight(dueDateParsed) : (firstPaymentDateFinal ? new Date(firstPaymentDateFinal.getTime() + (nCuota - 1) * 7 * 86400000) : null);
          if (dueDate && dueDate !== firstPaymentDateFinal) dueDate = toUTCMidnight(dueDate);
          const cuotaAmt = toNum(getCronogramaCol(row, 'Cuota_Programada', 'cuota')) ?? 0;
          const estadoRaw = getCronogramaCol(row, 'Estado', 'Estado ') || '';
          const estadoInst = mapEstadoInstallment(estadoRaw);
          const montoPagado = toNum(getCronogramaCol(row, 'Monto_Pagado', 'Monto_Pagado ')) ?? 0;
          const paidAmt = estadoInst === 'paid' ? (montoPagado > 0 ? Math.min(montoPagado, cuotaAmt) : cuotaAmt) : (montoPagado || 0);
          // Si la cuota está vencida: calcular mora desde fecha de vencimiento hasta hoy. Si no está vencida, usar Excel (nunca negativa).
          const hoy = toUTCMidnight(new Date());
          let statusFinal = estadoInst;
          const moraRaw = toNum(getCronogramaCol(row, 'Mora', 'Mora ')) ?? 0;
          let mora = Math.max(0, Number(moraRaw) || 0);
          const diasAtrasoRaw = toNum(getCronogramaCol(row, 'Dias_Atraso', 'Dias_Atraso ')) ?? 0;
          let diasAtraso = diasAtrasoRaw > 0 ? Math.floor(diasAtrasoRaw) : 0;
          // Reglas de estado en importación (PE y CO): no confiar solo en el Excel.
          if (cuotaAmt > 0 && paidAmt >= cuotaAmt) {
            statusFinal = 'paid';
          } else if (dueDate && dueDate.getTime() < hoy.getTime() && paidAmt < cuotaAmt) {
            statusFinal = 'overdue';
          } else if (statusFinal === 'pending' && dueDate && (mora > 0 || diasAtraso > 0) && paidAmt < cuotaAmt) {
            statusFinal = 'overdue';
          }
          if (statusFinal === 'overdue' && dueDate && dueDate.getTime() < hoy.getTime() && paidAmt < cuotaAmt) {
            diasAtraso = Math.max(0, Math.floor((hoy.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000)));
            if (loanConditionsPE) {
              const saldoPendiente = Math.max(0, cuotaAmt - paidAmt);
              mora = Math.max(0, calculateLateFeeAtImport(saldoPendiente, diasAtraso, loanConditionsPE));
            }
          }
          const fechaPagoRaw = getCronogramaCol(row, 'Fecha_Pago', 'Fecha_Pago ', 'Fecha_Pagc', 'Fecha_Pagc ');
          let paidDate = parseDateCell(fechaPagoRaw);
          const paidDateNorm = paidDate && !isNaN(paidDate.getTime()) ? toUTCMidnight(paidDate) : null;
          // Cronograma de cuotas: registrar tal cual del Excel → Fecha_Programada=due_date, Monto_Pagado=paid_amount, Mora=late_fee (nunca negativa), Fecha_Pago=paid_date, Dias_Atraso=days_overdue, Estado=status
          const paidAmtR = Math.round((paidAmt || 0) * 100) / 100;
          const moraR = Math.max(0, Math.round((mora || 0) * 100) / 100);
          await query(
            `INSERT INTO module_rapidin_installments (loan_id, installment_number, installment_amount, principal_amount, interest_amount, due_date, paid_date, paid_amount, late_fee, days_overdue, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [loanId, nCuota, cuotaAmt, Math.round(principalPerInstallment * 100) / 100, Math.round(interestPerInstallment * 100) / 100, dateToDateString(dueDate), dateToDateString(paidDateNorm), paidAmtR, moraR, diasAtraso, statusFinal]
          );
          stats.installmentsCreated++;
        }
        if (allCancelado && existingLoan.request_id) {
          const lastRowUpd = groupRows[groupRows.length - 1];
          const fechaRawUpd = getCronogramaCol(lastRowUpd, 'Fecha_Pago', 'Fecha_Pago ', 'Fecha_Programada', 'Fecha_programada', 'Fecha_Programada ', 'Fecha_Programac');
          const fechaCanceladoUpd = parseDateCell(fechaRawUpd);
          if (fechaCanceladoUpd && !isNaN(fechaCanceladoUpd.getTime())) {
            const dUpd = toUTCMidnight(fechaCanceladoUpd);
            const fechaStr = dUpd ? `${dUpd.getUTCFullYear()}-${String(dUpd.getUTCMonth() + 1).padStart(2, '0')}-${String(dUpd.getUTCDate()).padStart(2, '0')}` : null;
            if (fechaStr) {
              const curr = await query('SELECT observations FROM module_rapidin_loan_requests WHERE id = $1', [existingLoan.request_id]);
              const currentObs = curr.rows[0]?.observations ?? '';
              const newObs = appendCancelledToObservations(currentObs, fechaStr);
              await query(
                `UPDATE module_rapidin_loan_requests SET observations = $1, status = 'cancelled' WHERE id = $2`,
                [newObs, existingLoan.request_id]
              );
            }
          }
        }
        continue;
      }

      // Estado del préstamo: si todas las cuotas están CANCELADAS/PAGADAS → cancelled (préstamo completado)
      const allCancelado = groupRows.every(r => /CANCELADO|CANCELLED|PAGADO|PAID/i.test(String(getCronogramaCol(r, 'Estado', 'Estado ') || '')));
      const requestStatus = allCancelado ? 'cancelled' : 'disbursed';
      const requestedAmount = montoOtorgado;
      // Cuando estado es cancelado: usar columna fecha (última cuota) para la solicitud
      let fechaCanceladoStr = null;
      if (allCancelado && groupRows.length > 0) {
        const lastRow = groupRows[groupRows.length - 1];
        const fechaRaw = getCronogramaCol(lastRow, 'Fecha_Pago', 'Fecha_Pago ', 'Fecha_Programada', 'Fecha_programada', 'Fecha_Programada ', 'Fecha_Programac');
        const fechaCancelado = parseDateCell(fechaRaw);
        if (fechaCancelado && !isNaN(fechaCancelado.getTime())) {
          const d = toUTCMidnight(fechaCancelado);
          fechaCanceladoStr = d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` : null;
        }
      }

      // Relación Rptas ↔ Cronograma: columna "row" = fila en Rptas PE/CO; PréstamoID en Rptas y PréstamoID en Cronograma corresponden al mismo préstamo.
      // Fecha primera cuota (cronograma de pago): prioridad (1) Fecha_Programada de la fila Rptas indicada por "row", (2) Fecha_Programada del Cronograma, (3) próximo lunes.
      const rptasRowNum = toNum(getCronogramaCol(first, 'row', 'Row', 'Rptas PE row', 'Rptas CO row'));
      const rptasRow = rptasRowNum != null && rptasByExcelRow && rptasByExcelRow.get(rptasRowNum);
      const prestamoIdFromRptas = rptasRow ? (getPrestamoId(rptasRow) && String(getPrestamoId(rptasRow)).trim()) || null : null;
      if (prestamoIdFromRptas && prestamoIdTrim && String(prestamoIdFromRptas) !== String(prestamoIdTrim)) {
        logger.warn(`Cronograma ${COUNTRY} PréstamoID "${prestamoIdTrim}" vs Rptas row ${rptasRowNum} PréstamoID "${prestamoIdFromRptas}": se usa PréstamoID de Rptas para el préstamo.`);
      }
      let firstPaymentDate = null;
      let disbursedAtCronograma = null;
      if (rptasRow) {
        const primeraCuotaRaw = getCol(rptasRow, 'Primera_Cuota_Overide', 'Fecha_Programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha de vencimiento');
        firstPaymentDate = parseDateCellFechaProgramada(primeraCuotaRaw);
        const fechaDesembolsoRaw = getCol(rptasRow, 'FECHA DESEMBOLSO', 'FECHA DESEMBOLSO ');
        disbursedAtCronograma = parseDateCell(fechaDesembolsoRaw);
      }
      if (!firstPaymentDate || isNaN(firstPaymentDate.getTime())) {
        const firstFecha = getCronogramaCol(first, 'Fecha_Programada', 'Fecha_programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha_Programac ', 'Fecha Programada', 'Fecha de vencimiento');
        firstPaymentDate = parseDateCell(firstFecha);
      }
      let firstPaymentDateFinal = firstPaymentDate && !isNaN(firstPaymentDate.getTime()) ? toUTCMidnight(firstPaymentDate) : null;
      if (!firstPaymentDateFinal) {
        const firstDue = getCronogramaCol(groupRows[0], 'Fecha_Programada', 'Fecha_programada', 'Fecha_Programada ', 'Fecha_Programac');
        const parsed = parseDateCell(firstDue);
        if (parsed && !isNaN(parsed.getTime())) firstPaymentDateFinal = toUTCMidnight(parsed);
      }
      if (!firstPaymentDateFinal) {
        const today = new Date();
        const nextMonday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + (((8 - today.getUTCDay()) % 7) || 7), 0, 0, 0, 0));
        firstPaymentDateFinal = nextMonday;
      }
      if (!disbursedAtCronograma || isNaN(disbursedAtCronograma.getTime())) {
        disbursedAtCronograma = new Date(firstPaymentDateFinal.getTime() - 7 * 86400000);
      } else {
        disbursedAtCronograma = toUTCMidnight(disbursedAtCronograma);
      }

      // Match solo con solicitudes ya creadas en Rptas: por row, PréstamoID, DNI o nombre. No crear por crear.
      let requestId = null;
      if (rptasRowNum != null && requestIdByRptasRow && requestIdByRptasRow.has(rptasRowNum)) {
        requestId = requestIdByRptasRow.get(rptasRowNum);
      }
      if (requestId == null && prestamoIdTrim && prestamoIdToRequestId && prestamoIdToRequestId.has(prestamoIdTrim)) {
        requestId = prestamoIdToRequestId.get(prestamoIdTrim);
      }
      if (requestId == null && dni && requestIdsByDni && requestIdsByDni.has(dni)) {
        const arr = requestIdsByDni.get(dni);
        if (arr && arr.length > 0) requestId = arr[0];
      }
      if (requestId == null && nombre && requestIdsByNombre) {
        const nomKey = normalizeNameForMatch(nombre);
        if (nomKey && requestIdsByNombre.has(nomKey)) {
          const arr = requestIdsByNombre.get(nomKey);
          if (arr && arr.length > 0) requestId = arr[0];
        }
      }
      if (requestId == null) {
        logger.debug(`Cronograma ${COUNTRY}: sin match en Rptas (DNI ${dni}, PréstamoID ${prestamoIdTrim || 'N/A'}) — se omite, no se crea solicitud ni préstamo.`);
        continue;
      }

      // driverId siempre desde la solicitud existente en Rptas (no crear conductor desde Cronograma)
      let driverId = idByDni.get(dni);
      if (!driverId && requestId && !DRY_RUN) {
        const reqRow = await query('SELECT driver_id FROM module_rapidin_loan_requests WHERE id = $1', [requestId]);
        driverId = reqRow.rows[0]?.driver_id;
        if (driverId) idByDni.set(dni, driverId);
      }
      if (!driverId) {
        logger.warn(`Cronograma ${COUNTRY}: no se pudo obtener driver_id para request ${requestId}, se omite.`);
        continue;
      }

      const observationsCrono = fechaCanceladoStr ? `Import Cronograma ${COUNTRY}. Cancelado fecha: ${fechaCanceladoStr}` : `Import Cronograma ${COUNTRY}`;
      if (!DRY_RUN && requestId && allCancelado && fechaCanceladoStr) {
        const curr = await query('SELECT observations FROM module_rapidin_loan_requests WHERE id = $1', [requestId]);
        const currentObs = curr.rows[0]?.observations ?? '';
        const newObs = appendCancelledToObservations(currentObs, fechaCanceladoStr);
        await query(
          `UPDATE module_rapidin_loan_requests SET observations = $1, status = 'cancelled' WHERE id = $2`,
          [newObs, requestId]
        );
      }

      if (!DRY_RUN && requestId) {
        // Estado inicial: se actualizará después según las cuotas
        const initialLoanStatus = allCancelado ? 'cancelled' : 'active';
        // Guardar ciclo histórico del préstamo (el ciclo en el que estaba el conductor cuando se desembolsó)
        let loanRes;
        try {
          loanRes = await query(
            `INSERT INTO module_rapidin_loans (request_id, driver_id, country, disbursed_amount, total_amount, interest_rate, number_of_installments, disbursed_at, first_payment_date, status, pending_balance, cycle)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $5, $11)
             RETURNING id`,
            [requestId, driverId, COUNTRY, montoOtorgado, totalAmount, interestRate, numInstallments, disbursedAtCronograma, dateToDateString(firstPaymentDateFinal), initialLoanStatus, cycle]
          );
        } catch (err) {
          // Si la columna cycle no existe, insertar sin cycle
          if (err.message && err.message.includes('column "cycle"')) {
            loanRes = await query(
              `INSERT INTO module_rapidin_loans (request_id, driver_id, country, disbursed_amount, total_amount, interest_rate, number_of_installments, disbursed_at, first_payment_date, status, pending_balance)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $5)
               RETURNING id`,
              [requestId, driverId, COUNTRY, montoOtorgado, totalAmount, interestRate, numInstallments, disbursedAtCronograma, dateToDateString(firstPaymentDateFinal), initialLoanStatus]
            );
          } else {
            throw err;
          }
        }
        const loanId = loanRes.rows[0].id;
        stats.loansCreated++;
        const externalIdToSave = (prestamoIdFromRptas && String(prestamoIdFromRptas).trim()) || (prestamoIdTrim && String(prestamoIdTrim).trim()) || null;
        if (externalIdToSave) {
          try {
            await query('UPDATE module_rapidin_loans SET external_loan_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [externalIdToSave, loanId]);
          } catch (e) {
            if (!e.message.includes('external_loan_id')) logger.warn('No se pudo guardar external_loan_id en préstamo: ' + e.message);
          }
        }

        const principalPerInstallment = montoOtorgado / numInstallments;
        const interestTotal = totalAmount - montoOtorgado;
        const interestPerInstallment = interestTotal / numInstallments;

        for (const row of groupRows) {
          const nCuota = Math.max(1, Math.floor(toNum(getCronogramaCol(row, 'N_Cuota', 'N_Cuota ')) ?? 1));
          // Cronograma: due_date = Fecha_Programada (serial Excel o texto sin formato; parseDateCell acepta ambos).
          const fechaProgramadaRaw = getCronogramaCol(row, 'Fecha_Programada', 'Fecha_programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha Programada', 'Fecha de vencimiento');
          let dueDateParsed = null;
          if (fechaProgramadaRaw != null && fechaProgramadaRaw !== '') {
            dueDateParsed = parseDateCell(fechaProgramadaRaw);
          }
          let dueDate = dueDateParsed && !isNaN(dueDateParsed.getTime()) ? toUTCMidnight(dueDateParsed) : null;
          if (!dueDate && firstPaymentDateFinal) {
            dueDate = new Date(firstPaymentDateFinal.getTime() + (nCuota - 1) * 7 * 86400000);
            dueDate = toUTCMidnight(dueDate);
          }
          // Primera cuota siempre lunes
          if (nCuota === 1 && firstPaymentDateFinal && dueDate && dueDate.getUTCDay() !== 1) dueDate = firstPaymentDateFinal;
          // Datos históricos del Excel: copiar tal cual (Fecha_Programada → due_date, Monto_Pagado → paid_amount, Mora → late_fee, Dias_Atraso → days_overdue)
          const cuotaAmt = toNum(getCronogramaCol(row, 'Cuota_Programada', 'cuota')) ?? 0;
          const estadoRaw = getCronogramaCol(row, 'Estado', 'Estado ') || '';
          const estadoInst = mapEstadoInstallment(estadoRaw);
          // Si Estado = CANCELADO/PAGADO → cuota pagada completamente; usar Monto_Pagado del Excel o cuota completa
          const montoPagado = toNum(getCronogramaCol(row, 'Monto_Pagado', 'Monto_Pagado ')) ?? 0;
          const paidAmt = estadoInst === 'paid' 
            ? (montoPagado > 0 ? Math.min(montoPagado, cuotaAmt) : cuotaAmt) 
            : (montoPagado || 0);
          
          // Si la cuota está vencida: calcular mora desde fecha de vencimiento hasta hoy. Si no está vencida, usar Excel (nunca negativa).
          const hoy = toUTCMidnight(new Date());
          let statusFinal = estadoInst;
          const moraRaw = toNum(getCronogramaCol(row, 'Mora', 'Mora ')) ?? 0;
          let mora = Math.max(0, Number(moraRaw) || 0);
          const diasAtrasoRaw = toNum(getCronogramaCol(row, 'Dias_Atraso', 'Dias_Atraso ')) ?? 0;
          let diasAtraso = diasAtrasoRaw > 0 ? Math.floor(diasAtrasoRaw) : 0;
          // Reglas de estado en importación (PE y CO): no confiar solo en el Excel.
          if (cuotaAmt > 0 && paidAmt >= cuotaAmt) {
            statusFinal = 'paid';
          } else if (dueDate && dueDate.getTime() < hoy.getTime() && paidAmt < cuotaAmt) {
            statusFinal = 'overdue';
          } else if (statusFinal === 'pending' && dueDate && (mora > 0 || diasAtraso > 0) && paidAmt < cuotaAmt) {
            statusFinal = 'overdue';
          }
          if (statusFinal === 'overdue' && dueDate && dueDate.getTime() < hoy.getTime() && paidAmt < cuotaAmt) {
            diasAtraso = Math.max(0, Math.floor((hoy.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000)));
            if (loanConditionsPE) {
              const saldoPendiente = Math.max(0, cuotaAmt - paidAmt);
              mora = Math.max(0, calculateLateFeeAtImport(saldoPendiente, diasAtraso, loanConditionsPE));
            }
          }
          
          // Fecha_Pago / Fecha_Pagc → paid_date: del Excel
          const fechaPagoRaw = getCronogramaCol(row, 'Fecha_Pago', 'Fecha_Pago ', 'Fecha_Pagc', 'Fecha_Pagc ');
          let paidDate = parseDateCell(fechaPagoRaw);
          const paidDateNorm = paidDate && !isNaN(paidDate.getTime()) ? toUTCMidnight(paidDate) : null;
          // Cronograma de cuotas: todo del Excel — Fecha_Programada→due_date, Monto_Pagado→paid_amount, Mora→late_fee (nunca negativa), Fecha_Pago→paid_date, Dias_Atraso→days_overdue, Estado→status
          const paidAmtR = Math.round((paidAmt || 0) * 100) / 100;
          const moraR = Math.max(0, Math.round((mora || 0) * 100) / 100);
          await query(
            `INSERT INTO module_rapidin_installments (loan_id, installment_number, installment_amount, principal_amount, interest_amount, due_date, paid_date, paid_amount, late_fee, days_overdue, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              loanId,
              nCuota,
              cuotaAmt,
              Math.round(principalPerInstallment * 100) / 100,
              Math.round(interestPerInstallment * 100) / 100,
              dateToDateString(dueDate),
              dateToDateString(paidDateNorm),
              paidAmtR,
              moraR,
              diasAtraso,
              statusFinal
            ]
          );
          stats.installmentsCreated++;
        }

        // Si todas las cuotas están CANCELADAS/PAGADAS, el préstamo ya está cancelled desde el INSERT
        // (se estableció en initialLoanStatus = allCancelado ? 'cancelled' : 'active')
      } else {
        stats.loansCreated++;
        stats.installmentsCreated += numInstallments;
      }
    } catch (err) {
      errors.push({ prestamoId, msg: err.message });
      logger.warn(`Cronograma ${COUNTRY} PrestamoID ${prestamoId}: ${err.message}`);
    }
  }
}

async function run() {
  // Asegurar columnas necesarias: cycle en loans y loan_requests, external_loan_id en loans
  if (!DRY_RUN) {
    try {
      await query(`ALTER TABLE module_rapidin_loans ADD COLUMN IF NOT EXISTS cycle INTEGER DEFAULT 1`);
      logger.info('Columna cycle verificada/agregada en module_rapidin_loans');
    } catch (err) {
      if (!err.message.includes('already exists')) {
        logger.warn('No se pudo agregar columna cycle en loans: ' + err.message);
      }
    }
    try {
      await query(`ALTER TABLE module_rapidin_loan_requests ADD COLUMN IF NOT EXISTS cycle INTEGER DEFAULT 1`);
      logger.info('Columna cycle verificada/agregada en module_rapidin_loan_requests');
    } catch (err) {
      if (!err.message.includes('already exists')) {
        logger.warn('No se pudo agregar columna cycle en loan_requests: ' + err.message);
      }
    }
    try {
      await query(`ALTER TABLE module_rapidin_loans ADD COLUMN IF NOT EXISTS external_loan_id VARCHAR(255)`);
      logger.info('Columna external_loan_id verificada/agregada (PréstamoID del Excel)');
    } catch (err) {
      if (!err.message.includes('already exists')) {
        logger.warn('No se pudo agregar columna external_loan_id: ' + err.message);
      }
    }
  }

  let excelPathToUse = EXCEL_PATH;
  let tempExcelPath = null;
  if (GOOGLE_SHEET_ID) {
    const exportUrl = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=xlsx`;
    logger.info('Descargando Excel desde Google Sheets: ' + exportUrl);
    const res = await axios.get(exportUrl, { responseType: 'arraybuffer', timeout: 60000 });
    tempExcelPath = path.join(os.tmpdir(), `prestamos-yego-import-${Date.now()}.xlsx`);
    fs.writeFileSync(tempExcelPath, Buffer.from(res.data));
    excelPathToUse = tempExcelPath;
    logger.info('Descargado en: ' + tempExcelPath);
  }
  logger.info('Leyendo Excel: ' + excelPathToUse);
  const workbook = XLSX.readFile(excelPathToUse);
  if (tempExcelPath) {
    try { fs.unlinkSync(tempExcelPath); } catch (_) {}
  }
  logger.info('Hojas disponibles en el Excel: ' + workbook.SheetNames.join(', '));

  const rptasSheetName = `Rptas ${COUNTRY}`;
  const cronogramaSheetNames = COUNTRY === 'CO' ? ['Cronogramas CO', 'Cronograma CO'] : ['Cronogramas PE', 'Cronograma PE'];
  const hasRptas = !!workbook.Sheets[rptasSheetName];
  const cronogramaSheetName = cronogramaSheetNames.find(name => workbook.Sheets[name]) || null;
  if (!hasRptas && !cronogramaSheetName) {
    logger.error('No se encontró ninguna hoja. Se buscan: ' + [rptasSheetName, ...cronogramaSheetNames].join(', '));
    process.exit(1);
  }

  const idByDni = new Map();
  let driversCreated = 0;
  let requestsCreated = 0;
  let loansCreated = 0;
  let installmentsCreated = 0;
  let skipped = 0;
  const errors = [];
  let rptasRows = [];
  const rptasByExcelRow = new Map();
  const requestIdByRptasRow = new Map();
  const prestamoIdToRequestId = new Map();
  const requestIdsByDni = new Map();
  const requestIdsByNombre = new Map();

  // Números de fila Rptas que existen en Cronograma (columna "row" / "Rptas PE row" / "Rptas CO row") — para validar existencia en todos los estados
  const rptasRowNumbersInCronograma = new Set();
  if (cronogramaSheetName) {
    const cronogramaSheet = workbook.Sheets[cronogramaSheetName];
    const cronoDataForValidation = XLSX.utils.sheet_to_json(cronogramaSheet, { defval: null, raw: true });
    for (const cRow of cronoDataForValidation) {
      const rowNum = toNum(getCronogramaCol(cRow, 'row', 'Row', 'Rptas PE row', 'Rptas CO row'));
      if (rowNum != null && !isNaN(rowNum)) rptasRowNumbersInCronograma.add(Math.floor(rowNum));
    }
    logger.info(`Validación: ${rptasRowNumbersInCronograma.size} números de fila Rptas encontrados en Cronograma ${COUNTRY}.`);
  }

  // PASO 1: Rptas PE/CO — Solo conductores y solicitudes. Estado, Monto Otorgado (si vacío → Monto Solicitado), Ciclo, Flota. Préstamos se crean en Cronograma.
  if (hasRptas) {
    const rptasSheet = workbook.Sheets[rptasSheetName];
    // raw: true para que Marca temporal y FECHA DESEMBOLSO vengan como número (serial Excel) y se parseen bien; evita que todas queden con la misma fecha (ej. 23 feb) por formato de texto
    const rptasData = XLSX.utils.sheet_to_json(rptasSheet, { defval: null, raw: true });
    let rptasFiltered = rptasData;
    if (FILTER_DNI) {
      const filterNorm = FILTER_DNI.replace(/^0+/, '') || FILTER_DNI;
      rptasFiltered = rptasData.filter((row) => {
        const d = toStr(getCol(row, 'DNI - CARNÉ EXTRANJERÍA ', 'CÉDULA DE CIUDADANIA - CARNÉ EXTRANJERÍA ', 'DNI', 'Cédula'), 20);
        if (!d) return false;
        const dNorm = d.replace(/^0+/, '') || d;
        return d === FILTER_DNI || dNorm === filterNorm || d === filterNorm || dNorm === FILTER_DNI;
      });
      logger.info(`Filtro --dni=${FILTER_DNI} (incl. con/sin ceros): ${rptasFiltered.length} filas en Rptas ${COUNTRY}.`);
    }
    rptasRows = LIMIT ? rptasFiltered.slice(0, LIMIT) : rptasFiltered;
    for (let idx = 0; idx < rptasRows.length; idx++) {
      rptasByExcelRow.set(2 + idx, rptasRows[idx]);
    }
    const colIndexNumCuenta = getNumeroCuentaColIndex(rptasSheet);
    logger.info(`Paso 1 - Rptas ${COUNTRY}: ${rptasData.length} filas. Solo conductores + solicitudes (Estado, Monto Otorgado/Monto Solicitado, Ciclo, Flota). Préstamos en Cronograma.`);
  for (let i = 0; i < rptasRows.length; i++) {
    const row = rptasRows[i];
    const prestamoId = getPrestamoId(row);
    const prestamoIdTrim = (prestamoId && String(prestamoId).trim()) || '';

    const dni = toStr(getCol(row, 'DNI - CARNÉ EXTRANJERÍA ', 'CÉDULA DE CIUDADANIA - CARNÉ EXTRANJERÍA ', 'DNI'), 20);
    if (!dni) {
      skipped++;
      continue;
    }

    const excelRowNum = 2 + i;
    if (rptasRowNumbersInCronograma.size > 0 && !rptasRowNumbersInCronograma.has(excelRowNum)) {
      const estadoVal = getCol(row, 'Estado', 'Estado ');
      const msg = `Rptas ${COUNTRY} fila Excel ${excelRowNum} (DNI ${dni}, Estado ${estadoVal || 'N/A'}) no tiene fila correspondiente en Cronograma — validar existencia.`;
      if (/DESEMBOLSO|DESEMBOLSADO/i.test(String(estadoVal || ''))) {
        logger.warn(msg + ' [DESEMBOLSADO]');
      } else {
        logger.info(msg);
      }
    }

    try {
      if (!idByDni.has(dni)) driversCreated++;
      const driverId = await ensureDriver(row, idByDni);
      if (!driverId) continue;

      // Solo Estado, Monto Otorgado (si no hay valor → Monto Solicitado), Ciclo, Flota
      const montoOtorgado = toNum(getCol(row, 'Monto Otorgado', 'Monto Otorgado ', 'Monto otorgado', 'Monto_Otorgado') ?? getColByNormalizedKey(row, 'Monto Otorgado') ?? getColByNormalizedKey(row, 'Monto_Otorgado'));
      const montoSolicitado = toNum(getCol(row, 'Monto Solicitado', 'Monto Solicitado ')) ?? 0;
      const requestedAmount = (montoOtorgado != null && montoOtorgado > 0) ? montoOtorgado : montoSolicitado;
      const estado = getCol(row, 'Estado', 'Estado ');
      const { requestStatus } = mapEstado(estado);
      const prestamoIdsInCronograma = new Set();
      const montoParaLoan = requestedAmount;
      const marcaTimestamp = parseDateCell(getColByAnyNormalized(row, 'Marca temporal') ?? getCol(row, 'Marca temporal', 'Marca temporal '));

      // Fecha desembolso real del histórico: FECHA DESEMBOLSO (DD/MM/YYYY o serial); no asumir "hoy"
      const fechaDesembolsoRaw = getCol(row, 'FECHA DESEMBOLSO', 'FECHA DESEMBOLSO ') ?? getColByAnyNormalized(row, 'FECHA DESEMBOLSO');
      const disbursedAt = parseDateCell(fechaDesembolsoRaw);
      // Fecha de vencimiento / primera cuota: en Rptas PE/CO la columna real es "Primera_Cuota_Overide" (no hay Fecha_Programada en Rptas)
      const primeraCuotaRaw =
        getCol(row, 'Primera_Cuota_Overide', 'Fecha_Programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha de vencimiento', 'Primera cuota') ??
        getColByAnyNormalized(row, 'Primera_Cuota_Overide', 'Fecha_Programada', 'Fecha_Programac', 'Fecha de vencimiento');
      const primeraCuotaOverride = parseDateCellFechaProgramada(primeraCuotaRaw);
      // Cuota programada (Cronograma PE) o cuota (Rptas PE)
      const cuota = toNum(getCol(row, 'Cuota_Programada', 'Cuota_Programada ', 'cuota'));
      const semanasRaw = toNum(getCol(row, 'Semanas sugeridas (n)', 'Semanas sugeridas'));
      const semanas = semanasRaw != null ? Math.floor(semanasRaw) : null;
      const tasaSemanal = toNum(getCol(row, 'Tasa semanal (t)', 'Tasa semanal'));

      // Crear loan solo si el estado lo indica, hay datos y (si hay Cronograma) el PréstamoID de esta fila está en Cronograma — así no se crean préstamos “fantasma” por filas Rptas sin cronograma (ej. mismo DNI con varios renglones).
      const hasLoanData = false;
      const loanAllowedByCronograma = false;
      let createLoan = false;

      const flota = toStr(getCol(row, 'Flota'), 100);
      // created_at: RECHAZADO y APROBADO → solo Marca temporal. DESEMBOLSADO/CANCELADO → FECHA DESEMBOLSO (si no hay → Marca temporal). Resto → Marca temporal. Se guarda fecha y hora como en el Excel.
      let dateForRequestFull = null; // fecha y hora completas del Excel
      if (requestStatus === 'rejected' || requestStatus === 'approved') {
        // RECHAZADO y APROBADO: solo Marca temporal (nunca FECHA DESEMBOLSO)
        dateForRequestFull = marcaTimestamp && !isNaN(marcaTimestamp.getTime()) ? marcaTimestamp : null;
      } else if (requestStatus === 'disbursed' || requestStatus === 'cancelled') {
        if (disbursedAt && !isNaN(disbursedAt.getTime())) dateForRequestFull = disbursedAt;
        if (!dateForRequestFull && marcaTimestamp && !isNaN(marcaTimestamp.getTime())) dateForRequestFull = marcaTimestamp;
      } else {
        if (marcaTimestamp && !isNaN(marcaTimestamp.getTime())) dateForRequestFull = marcaTimestamp;
      }
      const createdAt = validRequestDateForImport(dateForRequestFull ? toUTCMidnight(dateForRequestFull) : null);
      // Cuenta para desembolso: leer número de cuenta desde la celda del sheet (como texto si es posible) para no perder dígitos (evitar 7443086129220 → 7443090000000 por redondeo de Excel).
      const adondeAbonamos = toStr(getCol(row, '¿A dónde te abonamos?', '¿A dónde te abonamos? ') ?? getColByAnyNormalized(row, 'A dónde te abonamos'), 200);
      const numCuentaRaw = getNumeroCuentaFromSheet(rptasSheet, i, colIndexNumCuenta) ?? getCol(row, 'NUMERO DE CUENTA', 'NUMERO DE CUENTA ', 'Número de cuenta') ?? getColByAnyNormalized(row, 'NUMERO DE CUENTA', 'Numero de cuenta');
      // Siempre en texto (string) para no perder dígitos, venga la celda como número o texto en Excel
      const numCuenta = (numCuentaRaw != null && numCuentaRaw !== '') ? String(numCuentaRaw).trim().slice(0, 100) : null;
      const tipoCuenta = toStr(getCol(row, 'TIPO DE CUENTA', 'TIPO DE CUENTA ', 'Tipo de cuenta') ?? getColByAnyNormalized(row, 'TIPO DE CUENTA', 'Tipo de cuenta'), 50);
      const banco = toStr(getCol(row, 'BANCO', 'BANCO '), 100);
      const observations = buildObservationsJson({
        flota,
        adondeAbonamos,
        numCuenta,
        tipoCuenta,
        banco,
        tasaSemanal,
        cuota,
      });

      const cycleVal = getCol(row, 'Ciclo actual', 'Ciclo actual ', 'Ciclo Actual', 'Ciclo') ?? getColByAnyNormalized(row, 'Ciclo actual', 'Ciclo');
      const cycle = toNum(cycleVal) != null && !isNaN(toNum(cycleVal)) && toNum(cycleVal) > 0 ? Math.max(1, Math.floor(toNum(cycleVal))) : 1;

      // Valor para created_at: fecha y hora del Excel en ISO (ej. 30/08/2025 16:26:48 → se guarda con esa hora para que concuerde en el front)
      const loan_request_created_at =
        dateForRequestFull && !isNaN(dateForRequestFull.getTime()) && createdAt
          ? dateForRequestFull.toISOString()
          : null;

      let requestId = null;
      if (!DRY_RUN) {
        // Guardar ciclo en la solicitud (el ciclo en el que estaba el conductor cuando se creó la solicitud)
        try {
          // created_at ($6): fecha del Excel (Marca temporal / FECHA DESEMBOLSO) o CURRENT_TIMESTAMP si loan_request_created_at es null
          const reqRes = await query(
            `INSERT INTO module_rapidin_loan_requests (driver_id, country, requested_amount, status, observations, created_at, cycle)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP), $7)
             RETURNING id`,
            [driverId, COUNTRY, requestedAmount, requestStatus, observations, loan_request_created_at, cycle]
          );
          requestId = reqRes.rows[0].id;
        } catch (err) {
          // Si la columna cycle no existe, insertar sin cycle (el ciclo se obtiene del conductor)
          if (err.message && err.message.includes('column "cycle"')) {
            // created_at ($6): misma lógica que arriba
            const reqRes2 = await query(
              `INSERT INTO module_rapidin_loan_requests (driver_id, country, requested_amount, status, observations, created_at)
               VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP))
               RETURNING id`,
              [driverId, COUNTRY, requestedAmount, requestStatus, observations, loan_request_created_at]
            );
            requestId = reqRes2.rows[0].id;
          } else {
            throw err;
          }
        }
      }
      if (requestId != null) {
        requestIdByRptasRow.set(2 + i, requestId);
        if (prestamoIdTrim && !prestamoIdToRequestId.has(prestamoIdTrim)) {
          prestamoIdToRequestId.set(prestamoIdTrim, requestId);
        }
        if (!requestIdsByDni.has(dni)) requestIdsByDni.set(dni, []);
        requestIdsByDni.get(dni).push(requestId);
        const fullNameRptas = toStr(getCol(row, 'Nombres y Apellidos'), 255) || '';
        const nomKey = normalizeNameForMatch(fullNameRptas);
        if (nomKey) {
          if (!requestIdsByNombre.has(nomKey)) requestIdsByNombre.set(nomKey, []);
          requestIdsByNombre.get(nomKey).push(requestId);
        }
      }
      requestsCreated++;

      if (createLoan) {
        const numInstallments = Math.max(1, Math.floor(semanas));
        const totalAmount = cuota * numInstallments;
        const interestRate = tasaSemanal != null ? (tasaSemanal <= 1 ? tasaSemanal * 100 : tasaSemanal) : 5;
        // first_payment_date: valor de la columna (Primera_Cuota_Overide en Rptas) tal cual, o próximo lunes si falta.
        let firstPaymentDate;
        if (primeraCuotaOverride && !isNaN(primeraCuotaOverride.getTime())) {
          firstPaymentDate = toUTCMidnight(primeraCuotaOverride);
        } else {
          const today = new Date();
          const nextMonday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + (((8 - today.getUTCDay()) % 7) || 7), 0, 0, 0, 0));
          firstPaymentDate = nextMonday;
        }
        const loanDisbursedAtNorm = loanDisbursedAt && !isNaN(loanDisbursedAt.getTime()) ? toUTCMidnight(loanDisbursedAt) : null;

        if (!DRY_RUN && requestId) {
          // Obtener ciclo del conductor para guardarlo en el préstamo histórico
          const driverCycleResult = await query(`SELECT cycle FROM module_rapidin_drivers WHERE id = $1`, [driverId]);
          const driverCycle = driverCycleResult?.rows?.[0]?.cycle || 1;
          const externalId = (prestamoId && String(prestamoId).trim()) ? String(prestamoId).trim() : null;
          let loanRes;
          try {
            loanRes = await query(
              `INSERT INTO module_rapidin_loans (request_id, driver_id, country, disbursed_amount, total_amount, interest_rate, number_of_installments, disbursed_at, first_payment_date, status, pending_balance, cycle, external_loan_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP), $9, 'active', $5, $10, $11)
               RETURNING id`,
              [requestId, driverId, COUNTRY, montoParaLoan, totalAmount, interestRate, numInstallments, loanDisbursedAtNorm || loanDisbursedAt, dateToDateString(firstPaymentDate), driverCycle, externalId]
            );
          } catch (err) {
            if (err.message && err.message.includes('external_loan_id')) {
              loanRes = await query(
                `INSERT INTO module_rapidin_loans (request_id, driver_id, country, disbursed_amount, total_amount, interest_rate, number_of_installments, disbursed_at, first_payment_date, status, pending_balance, cycle)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP), $9, 'active', $5, $10)
                 RETURNING id`,
                [requestId, driverId, COUNTRY, montoParaLoan, totalAmount, interestRate, numInstallments, loanDisbursedAtNorm || loanDisbursedAt, dateToDateString(firstPaymentDate), driverCycle]
              );
            } else if (err.message && err.message.includes('column "cycle"')) {
              loanRes = await query(
                `INSERT INTO module_rapidin_loans (request_id, driver_id, country, disbursed_amount, total_amount, interest_rate, number_of_installments, disbursed_at, first_payment_date, status, pending_balance)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP), $9, 'active', $5)
                 RETURNING id`,
                [requestId, driverId, COUNTRY, montoParaLoan, totalAmount, interestRate, numInstallments, loanDisbursedAtNorm || loanDisbursedAt, dateToDateString(firstPaymentDate)]
              );
            } else {
              throw err;
            }
          }

          const loanId = loanRes.rows[0].id;
          loansCreated++;

          // Si este préstamo está en Cronograma, NO crear cuotas aquí: Paso 2 las creará con Fecha_Programada real del Excel (evita fechas “próxima semana”).
          const skipInstallmentsInRptas = loanAllowedByCronograma && prestamoIdTrim;
          if (!skipInstallmentsInRptas) {
            const principalPerInstallment = montoParaLoan / numInstallments;
            const interestTotal = totalAmount - montoParaLoan;
            const interestPerInstallment = interestTotal / numInstallments;
            const estadoUpper = (toStr(estado) || '').toUpperCase();
            const loanFullyPaid =
              /PAGADO|PAID/.test(estadoUpper) ||
              (montoPagado != null && totalAmount != null && montoPagado >= totalAmount);
            for (let k = 1; k <= numInstallments; k++) {
              const dueDate = toUTCMidnight(new Date(firstPaymentDate.getTime() + (k - 1) * 7 * 86400000));
              const isFirst = k === 1;
              let paidAmt = 0;
              let instStatus = 'pending';
              if (loanFullyPaid) {
                paidAmt = cuota;
                instStatus = 'paid';
              } else if (isFirst && montoPagado != null && montoPagado > 0) {
                paidAmt = Math.min(montoPagado, cuota);
                instStatus = paidAmt >= cuota ? 'paid' : 'pending';
              }
              await query(
                `INSERT INTO module_rapidin_installments (loan_id, installment_number, installment_amount, principal_amount, interest_amount, due_date, paid_amount, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [loanId, k, cuota, Math.round(principalPerInstallment * 100) / 100, Math.round(interestPerInstallment * 100) / 100, dateToDateString(dueDate), paidAmt, instStatus]
              );
              installmentsCreated++;
            }
          }
        } else {
          loansCreated++;
          installmentsCreated += numInstallments;
        }
      }
    } catch (err) {
      errors.push({ row: i + 2, prestamoId, msg: err.message });
      logger.warn(`Rptas fila ${i + 2}: ${err.message}`);
    }
  }
  } // fin Paso 1 Rptas

  // ——— PASO 2: Cronogramas (detalle de cuotas). Si el préstamo ya existe por external_loan_id (PréstamoID), solo actualizamos cuotas.
  let existingLoansByPrestamoId = new Map();
  if (!DRY_RUN && cronogramaSheetName) {
    try {
      const existing = await query(
        'SELECT id, request_id, driver_id, external_loan_id FROM module_rapidin_loans WHERE country = $1 AND external_loan_id IS NOT NULL AND external_loan_id != \'\'',
        [COUNTRY]
      );
      for (const r of existing.rows) {
        if (r.external_loan_id) existingLoansByPrestamoId.set(String(r.external_loan_id).trim(), r);
      }
      logger.info(`Paso 2 - Préstamos existentes por PréstamoID: ${existingLoansByPrestamoId.size}`);
    } catch (e) {
      logger.warn('No se pudo cargar préstamos por external_loan_id: ' + e.message);
    }
  }
  if (cronogramaSheetName) {
    const cronogramaSheet = workbook.Sheets[cronogramaSheetName];
    // raw: true para que Fecha_Programada/Fecha_Pago vengan como número (serial Excel) y se parseen con excelDateToJS
    const cronoData = XLSX.utils.sheet_to_json(cronogramaSheet, { defval: null, raw: true });
    const cronoRows = LIMIT ? cronoData.slice(0, LIMIT) : cronoData;
    logger.info(`Paso 2 - Cronogramas ${COUNTRY}: ${cronoData.length} filas, procesando ${cronoRows.length}.`);
    const stats = { driversCreated: 0, requestsCreated: 0, loansCreated: 0, installmentsCreated: 0 };
    await processCronogramaPE(cronoRows, idByDni, stats, errors, workbook, existingLoansByPrestamoId, rptasByExcelRow, requestIdByRptasRow, prestamoIdToRequestId, requestIdsByDni, requestIdsByNombre);
    driversCreated += stats.driversCreated;
    requestsCreated += stats.requestsCreated;
    loansCreated += stats.loansCreated;
    installmentsCreated += stats.installmentsCreated;
  }

  // Paso final: actualizar estados de préstamos (cuotas vencidas → overdue; préstamos con cuota vencida → defaulted; todos pagados → cancelled)
  if (!DRY_RUN) {
    await syncLoanStatusAfterImport();
  }

  logger.info('--- Resumen ---');
  logger.info(`Conductores (insert/update): ${driversCreated}`);
  logger.info(`Solicitudes creadas: ${requestsCreated}`);
  logger.info(`Préstamos creados: ${loansCreated}`);
  logger.info(`Cuotas creadas: ${installmentsCreated}`);
  logger.info(`Filas omitidas (sin DNI): ${skipped}`);
  if (errors.length > 0) {
    logger.warn(`Errores (${errors.length}):`);
    errors.slice(0, 20).forEach(e => logger.warn(`  Fila ${e.row}: ${e.msg}`));
    if (errors.length > 20) logger.warn(`  ... y ${errors.length - 20} más`);
  }
  if (DRY_RUN) logger.info('Modo --dry-run: no se escribió en la base de datos.');
  process.exit(errors.length > 0 ? 1 : 0);
}

run().catch(err => {
  logger.error(err);
  process.exit(1);
});
