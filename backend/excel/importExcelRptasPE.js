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
 *
 * Requiere: Prestamos Yego (6).xlsx en la raíz del proyecto (fuera de frontend y backend).
 *
 * Columnas del Excel (histórico):
 * - Ciclo actual → conductor.cycle (se muestra en solicitudes e info del conductor).
 * - Rptas PE: DNI, Monto Otorgado, Estado, Ciclo actual, Fecha_Programada/Primera_Cuota_Overide, etc.
 * - Cronograma PE/CO: cada fila = una cuota. En cronograma de cuotas (app) se registra exactamente:
 *   Fecha_Programada → due_date, Monto_Pagado → paid_amount, Mora → late_fee (nunca negativa; PE y CO),
 *   Fecha_Pago → paid_date, Dias_Atraso → days_overdue, Estado → status, Cuota_Programada → installment_amount.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

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
const EXCEL_PATH = path.join(__dirname, '..', '..', 'Prestamos Yego (6).xlsx');
// Priorizar Cronogramas (una fila por cuota); si no existe, usar Rptas (una fila por solicitud)
const SHEET_NAMES = COUNTRY === 'CO'
  ? ['Cronogramas CO', 'Cronograma CO', 'Rptas CO']
  : ['Cronogramas PE', 'Cronograma PE', 'Rptas PE'];

// Excel serial date: en Excel serial 1 = 1900-01-01 → epoch 31-dic-1899
function excelDateToJS(serial) {
  if (serial == null || serial === '' || isNaN(Number(serial))) return null;
  const n = Number(serial);
  const epoch = new Date(1899, 11, 31); // 31-dic-1899, +1 día = 1-ene-1900
  const d = new Date(epoch.getTime() + n * 86400000);
  return isNaN(d.getTime()) ? null : d;
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

// Quitar prefijo +51 o 51 del teléfono antes de guardar
function normalizePhone(val) {
  const s = toStr(val, 20);
  if (!s) return null;
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

/**
 * Parsear "Marca temporal" que puede venir como:
 * - String "04/09/2025 02:32:37" o "04/09/2025" (DD/MM/YYYY [HH:mm:ss])
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
  // DD/MM/YYYY HH:mm:ss
  const matchFull = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (matchFull) {
    const [, d, m, y, h, min, sec] = matchFull;
    const date = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(min, 10), parseInt(sec, 10));
    return isNaN(date.getTime()) ? null : date;
  }
  // DD/MM/YYYY
  const matchDate = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (matchDate) {
    const [, d, m, y] = matchDate;
    const date = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
    return isNaN(date.getTime()) ? null : date;
  }
  // DD-MM-YYYY
  const matchDash = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (matchDash) {
    const [, d, m, y] = matchDash;
    const date = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
    return isNaN(date.getTime()) ? null : date;
  }
  // YYYY-MM-DD (ISO)
  const matchIso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (matchIso) {
    const [, y, m, d] = matchIso;
    const date = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
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

// Obtener PrestamoID de una fila: puede venir como "PréstamoID" (con tilde) o "PrestamoID" (sin tilde)
function getPrestamoId(row) {
  return toStr(
    getCol(row, 'PréstamoID', 'PréstamoID ', 'PrestamoID', 'PrestamoID ') ??
    getColByAnyNormalized(row, 'PréstamoID', 'PrestamoID'),
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

async function ensureDriver(row, idByDni) {
  const dni = toStr(getCol(row, 'DNI - CARNÉ EXTRANJERÍA ', 'CÉDULA DE CIUDADANIA - CARNÉ EXTRANJERÍA ', 'DNI', 'Cédula'), 20);
  if (!dni) return null;

  if (idByDni.has(dni)) return idByDni.get(dni);

  const fullName = toStr(getCol(row, 'Nombres y Apellidos'), 255) || 'Sin nombre';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first_name = normalizeName(parts[0] || 'Sin nombre');
  const last_name = normalizeName(parts.slice(1).join(' ')) || '';

  const email = toStr(getCol(row, 'Dirección de correo electrónico'), 255);
  const phone = normalizePhone(getCol(row, 'Teléfono'));
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
    // Mismo conductor puede aparecer muchas veces (varias solicitudes/préstamos, fechas distintas). Buscar por dni+country; si no, por phone+country+park_id; solo si no existe, INSERT.
    const parkNorm = (flota || '').trim();
    const phoneDigits = (phone || '').toString().replace(/\D/g, '');
    const existingByDni = await query(
      `SELECT id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 LIMIT 1`,
      [dni, COUNTRY]
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
      const existingByPhone = await query(
        `SELECT id FROM module_rapidin_drivers
         WHERE country = $1 AND COALESCE(park_id, '') = $2
           AND (phone = $3 OR phone = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5)
         LIMIT 1`,
        [COUNTRY, parkNorm, phone || null, (phone && !phone.startsWith('+') ? `+51${phone}` : null), phoneDigits || null]
      );
      if (existingByPhone.rows.length > 0) {
        id = existingByPhone.rows[0].id;
        await query(
          `UPDATE module_rapidin_drivers SET dni = $1, first_name = $2, last_name = $3, email = COALESCE(NULLIF(TRIM($4), ''), email), yego_premium = $5, cycle = $6, credit_line = $7, completed_trips = $8, park_id = COALESCE(NULLIF(TRIM($9), ''), park_id), updated_at = CURRENT_TIMESTAMP WHERE id = $10`,
          [dni, first_name, last_name, email, yegoPremium, cycle, creditLine, trips, flota || null, id]
        );
      } else {
        const byPhoneOnly = await query(
          `SELECT id FROM module_rapidin_drivers
           WHERE country = $1 AND (phone = $2 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $3)
           ORDER BY COALESCE(park_id, '') = $4 DESC
           LIMIT 1`,
          [COUNTRY, phone || null, phoneDigits || '', parkNorm]
        );
        if (byPhoneOnly.rows.length > 0) {
          id = byPhoneOnly.rows[0].id;
          await query(
            `UPDATE module_rapidin_drivers SET dni = $1, first_name = $2, last_name = $3, email = COALESCE(NULLIF(TRIM($4), ''), email), cycle = $5, credit_line = $6, completed_trips = $7, park_id = COALESCE(NULLIF(TRIM($8), ''), park_id), updated_at = CURRENT_TIMESTAMP WHERE id = $9`,
            [dni, first_name, last_name, email, cycle, creditLine, trips, flota || null, id]
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
              const fallback = await query(
                `SELECT id FROM module_rapidin_drivers
                 WHERE country = $1 AND (
                   (COALESCE(park_id, '') = $2) OR
                   (phone IS NOT DISTINCT FROM $3) OR
                   ($4 != '' AND REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4)
                 )
                 ORDER BY COALESCE(park_id, '') = $2 DESC
                 LIMIT 1`,
                [COUNTRY, parkNorm, phone || null, phoneDigits || '']
              );
              if (fallback.rows.length > 0) {
                id = fallback.rows[0].id;
                await query(
                  `UPDATE module_rapidin_drivers SET dni = $1, first_name = $2, last_name = $3, email = COALESCE(NULLIF(TRIM($4), ''), email), cycle = $5, credit_line = $6, completed_trips = $7, park_id = COALESCE(NULLIF(TRIM($8), ''), park_id), updated_at = CURRENT_TIMESTAMP WHERE id = $9`,
                  [dni, first_name, last_name, email, cycle, creditLine, trips, flota || null, id]
                );
              } else throw insErr;
            } else throw insErr;
          }
        }
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

// Procesar hoja Cronograma: una fila por cuota; agrupar por PrestamoID. Si existingLoansByPrestamoId tiene el PréstamoID, solo actualizamos cuotas.
async function processCronogramaPE(rows, idByDni, stats, errors, workbook, existingLoansByPrestamoId = new Map()) {
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
  const groups = new Map(); // PrestamoID -> [rows] ordenadas por N_Cuota
  for (const row of rows) {
    const pid = getPrestamoId(row);
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
    const prestamoIdTrim = prestamoId ? String(prestamoId).trim() : '';
    const existingLoan = prestamoIdTrim && existingLoansByPrestamoId.size > 0 ? existingLoansByPrestamoId.get(prestamoIdTrim) : null;

    const first = groupRows[0];
    const dni = toStr(getCronogramaCol(first, 'DNI'), 20);
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
      // Si el préstamo ya existe (creado en Paso 1 desde Rptas con mismo PréstamoID), solo actualizamos cuotas
      if (existingLoan && !DRY_RUN) {
        const loanId = existingLoan.id;
        await query('DELETE FROM module_rapidin_installments WHERE loan_id = $1', [loanId]);
        const numInstallments = groupRows.length;
        const totalAmount = groupRows.reduce((sum, r) => sum + (toNum(getCronogramaCol(r, 'Cuota_Programada', 'cuota')) ?? 0), 0);
        const allCancelado = groupRows.every(r => /CANCELADO|CANCELLED|PAGADO|PAID/i.test(String(getCronogramaCol(r, 'Estado', 'Estado ') || '')));
        // Fecha primera cuota: SIEMPRE del Excel (con raw:true viene como número serial)
        const firstFecha = getCronogramaCol(first, 'Fecha_Programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha_Programac ', 'Fecha Programada', 'Fecha de vencimiento');
        let firstPaymentDate = parseMarcaTemporal(firstFecha);
        if (!firstPaymentDate && firstFecha != null && firstFecha !== '') {
          const numVal = toNum(firstFecha);
          if (numVal != null) firstPaymentDate = excelDateToJS(numVal);
        }
        let firstPaymentDateFinal = firstPaymentDate && !isNaN(firstPaymentDate.getTime()) ? new Date(firstPaymentDate) : null;
        if (firstPaymentDateFinal) firstPaymentDateFinal.setHours(0, 0, 0, 0);
        const pendingBalance = totalAmount;
        await query(
          `UPDATE module_rapidin_loans SET total_amount = $1, number_of_installments = $2, first_payment_date = COALESCE($3, first_payment_date), pending_balance = $4, status = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6`,
          [totalAmount, numInstallments, firstPaymentDateFinal, pendingBalance, allCancelado ? 'cancelled' : 'active', loanId]
        );
        const principalPerInstallment = montoOtorgado / numInstallments;
        const interestTotal = totalAmount - montoOtorgado;
        const interestPerInstallment = interestTotal / numInstallments;
        for (let idx = 0; idx < groupRows.length; idx++) {
          const row = groupRows[idx];
          const nCuota = toNum(getCronogramaCol(row, 'N_Cuota')) ?? idx + 1;
          // Fecha de vencimiento: siempre del Excel (Fecha_Programada / Fecha_Programac)
          const fechaProgramadaRaw = getCronogramaCol(row, 'Fecha_Programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha_Programac ', 'Fecha Programada', 'Fecha de vencimiento');
          let dueDateParsed = parseMarcaTemporal(fechaProgramadaRaw);
          if (!dueDateParsed && fechaProgramadaRaw != null && fechaProgramadaRaw !== '') {
            const numVal = toNum(fechaProgramadaRaw);
            if (numVal != null) dueDateParsed = excelDateToJS(numVal);
          }
          let dueDate = dueDateParsed && !isNaN(dueDateParsed.getTime()) ? new Date(dueDateParsed) : (firstPaymentDateFinal ? new Date(firstPaymentDateFinal.getTime() + (nCuota - 1) * 7 * 86400000) : null);
          if (dueDate) dueDate.setHours(0, 0, 0, 0);
          const cuotaAmt = toNum(getCronogramaCol(row, 'Cuota_Programada', 'cuota')) ?? 0;
          const estadoRaw = getCronogramaCol(row, 'Estado', 'Estado ') || '';
          const estadoInst = mapEstadoInstallment(estadoRaw);
          const montoPagado = toNum(getCronogramaCol(row, 'Monto_Pagado', 'Monto_Pagado ')) ?? 0;
          const paidAmt = estadoInst === 'paid' ? (montoPagado > 0 ? Math.min(montoPagado, cuotaAmt) : cuotaAmt) : (montoPagado || 0);
          // Si la cuota está vencida: calcular mora desde fecha de vencimiento hasta hoy. Si no está vencida, usar Excel (nunca negativa).
          const hoy = new Date();
          hoy.setHours(0, 0, 0, 0);
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
          let paidDate = parseMarcaTemporal(fechaPagoRaw);
          if (!paidDate && fechaPagoRaw != null && fechaPagoRaw !== '') {
            const numVal = toNum(fechaPagoRaw);
            if (numVal != null) paidDate = excelDateToJS(numVal);
          }
          const paidDateNorm = paidDate && !isNaN(paidDate.getTime()) ? paidDate : null;
          // Cronograma de cuotas: registrar tal cual del Excel → Fecha_Programada=due_date, Monto_Pagado=paid_amount, Mora=late_fee (nunca negativa), Fecha_Pago=paid_date, Dias_Atraso=days_overdue, Estado=status
          const paidAmtR = Math.round((paidAmt || 0) * 100) / 100;
          const moraR = Math.max(0, Math.round((mora || 0) * 100) / 100);
          await query(
            `INSERT INTO module_rapidin_installments (loan_id, installment_number, installment_amount, principal_amount, interest_amount, due_date, paid_date, paid_amount, late_fee, days_overdue, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [loanId, nCuota, cuotaAmt, Math.round(principalPerInstallment * 100) / 100, Math.round(interestPerInstallment * 100) / 100, dueDate, paidDateNorm, paidAmtR, moraR, diasAtraso, statusFinal]
          );
          stats.installmentsCreated++;
        }
        continue;
      }

      if (!idByDni.has(dni)) stats.driversCreated++;
      const driverId = await ensureDriverFromCronograma(dni, nombre, idByDni, cycle, flota);
      if (!driverId) continue;

      // Estado del préstamo: si todas las cuotas están CANCELADAS/PAGADAS → cancelled (préstamo completado)
      const allCancelado = groupRows.every(r => /CANCELADO|CANCELLED|PAGADO|PAID/i.test(String(getCronogramaCol(r, 'Estado', 'Estado ') || '')));
      const requestStatus = allCancelado ? 'cancelled' : 'disbursed';
      const requestedAmount = montoOtorgado;

      // Fecha primera cuota: SIEMPRE del Excel (con raw:true viene como número serial; no usar "próximo lunes")
      const firstFecha = getCronogramaCol(first, 'Fecha_Programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha_Programac ', 'Fecha Programada', 'Fecha de vencimiento');
      let firstPaymentDate = parseMarcaTemporal(firstFecha);
      if (!firstPaymentDate && firstFecha != null && firstFecha !== '') {
        const numVal = toNum(firstFecha);
        if (numVal != null) firstPaymentDate = excelDateToJS(numVal);
      }
      let firstPaymentDateFinal = firstPaymentDate && !isNaN(firstPaymentDate.getTime()) ? new Date(firstPaymentDate) : null;
      if (firstPaymentDateFinal) firstPaymentDateFinal.setHours(0, 0, 0, 0);
      if (!firstPaymentDateFinal) {
        // Último recurso: leer fecha de la primera fila del grupo
        const firstDue = getCronogramaCol(groupRows[0], 'Fecha_Programada', 'Fecha_Programada ', 'Fecha_Programac');
        const parsed = parseMarcaTemporal(firstDue) || (toNum(firstDue) != null ? excelDateToJS(toNum(firstDue)) : null);
        if (parsed && !isNaN(parsed.getTime())) {
          firstPaymentDateFinal = new Date(parsed);
          firstPaymentDateFinal.setHours(0, 0, 0, 0);
        }
      }
      if (!firstPaymentDateFinal) {
        const today = new Date();
        const nextMonday = new Date(today);
        nextMonday.setDate(today.getDate() + ((8 - today.getDay()) % 7) || 7);
        nextMonday.setHours(0, 0, 0, 0);
        firstPaymentDateFinal = nextMonday;
      }
      // Fechas del Excel: disbursed = primera cuota - 7 días
      const disbursedAtCronograma = new Date(firstPaymentDateFinal);
      disbursedAtCronograma.setDate(disbursedAtCronograma.getDate() - 7);

      let requestId = null;
      if (!DRY_RUN) {
        try {
          const reqRes = await query(
            `INSERT INTO module_rapidin_loan_requests (driver_id, country, requested_amount, status, observations, created_at, cycle)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [driverId, COUNTRY, requestedAmount, requestStatus, `Import Cronograma ${COUNTRY}`, disbursedAtCronograma, cycle]
          );
          requestId = reqRes.rows[0].id;
        } catch (e) {
          if (e.message && e.message.includes('column "cycle"')) {
            const reqRes = await query(
              `INSERT INTO module_rapidin_loan_requests (driver_id, country, requested_amount, status, observations, created_at)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id`,
              [driverId, COUNTRY, requestedAmount, requestStatus, `Import Cronograma ${COUNTRY}`, disbursedAtCronograma]
            );
            requestId = reqRes.rows[0].id;
          } else throw e;
        }
      }
      stats.requestsCreated++;

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
            [requestId, driverId, COUNTRY, montoOtorgado, totalAmount, interestRate, numInstallments, disbursedAtCronograma, firstPaymentDateFinal, initialLoanStatus, cycle]
          );
        } catch (err) {
          // Si la columna cycle no existe, insertar sin cycle
          if (err.message && err.message.includes('column "cycle"')) {
            loanRes = await query(
              `INSERT INTO module_rapidin_loans (request_id, driver_id, country, disbursed_amount, total_amount, interest_rate, number_of_installments, disbursed_at, first_payment_date, status, pending_balance)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $5)
               RETURNING id`,
              [requestId, driverId, COUNTRY, montoOtorgado, totalAmount, interestRate, numInstallments, disbursedAtCronograma, firstPaymentDateFinal, initialLoanStatus]
            );
          } else {
            throw err;
          }
        }
        const loanId = loanRes.rows[0].id;
        stats.loansCreated++;
        if (prestamoIdTrim) {
          try {
            await query('UPDATE module_rapidin_loans SET external_loan_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [prestamoIdTrim, loanId]);
          } catch (e) {
            if (!e.message.includes('external_loan_id')) logger.warn('No se pudo guardar external_loan_id en préstamo: ' + e.message);
          }
        }

        const principalPerInstallment = montoOtorgado / numInstallments;
        const interestTotal = totalAmount - montoOtorgado;
        const interestPerInstallment = interestTotal / numInstallments;

        for (const row of groupRows) {
          const nCuota = Math.max(1, Math.floor(toNum(getCronogramaCol(row, 'N_Cuota', 'N_Cuota ')) ?? 1));
          // Fecha de vencimiento: SIEMPRE del Excel (Fecha_Programada / Fecha_Programac). Fallback solo si viene vacío.
          const fechaProgramadaRaw = getCronogramaCol(row, 'Fecha_Programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha_Programac ', 'Fecha Programada', 'Fecha de vencimiento');
          let dueDateParsed = parseMarcaTemporal(fechaProgramadaRaw);
          if (!dueDateParsed && fechaProgramadaRaw != null && fechaProgramadaRaw !== '') {
            const numVal = toNum(fechaProgramadaRaw);
            if (numVal != null) dueDateParsed = excelDateToJS(numVal);
          }
          let dueDate = dueDateParsed && !isNaN(dueDateParsed.getTime()) ? new Date(dueDateParsed) : null;
          if (!dueDate && firstPaymentDateFinal) {
            dueDate = new Date(firstPaymentDateFinal);
            dueDate.setDate(firstPaymentDateFinal.getDate() + (nCuota - 1) * 7);
          }
          if (dueDate) dueDate.setHours(0, 0, 0, 0);
          
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
          const hoy = new Date();
          hoy.setHours(0, 0, 0, 0);
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
          let paidDate = parseMarcaTemporal(fechaPagoRaw);
          if (!paidDate && fechaPagoRaw != null && fechaPagoRaw !== '') {
            const numVal = toNum(fechaPagoRaw);
            if (numVal != null) paidDate = excelDateToJS(numVal);
          }
          const paidDateNorm = paidDate && !isNaN(paidDate.getTime()) ? paidDate : null;
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
              dueDate,
              paidDateNorm,
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

  logger.info('Leyendo Excel: ' + EXCEL_PATH);
  const workbook = XLSX.readFile(EXCEL_PATH);
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

  // Si hay hoja Cronogramas, solo crear préstamos en Rptas cuando el PréstamoID de la fila exista en Cronogramas (evita duplicados: un DNI con varios renglones en Rptas pero un solo préstamo en Cronograma).
  let prestamoIdsInCronograma = new Set();
  if (cronogramaSheetName) {
    const cronoSheet = workbook.Sheets[cronogramaSheetName];
    const cronoPreview = XLSX.utils.sheet_to_json(cronoSheet, { defval: null, raw: true });
    for (const r of cronoPreview) {
      const pid = getPrestamoId(r);
      if (pid && String(pid).trim()) prestamoIdsInCronograma.add(String(pid).trim());
    }
    logger.info(`PréstamoIDs en Cronograma: ${prestamoIdsInCronograma.size} (en Rptas solo se crearán préstamos con estos IDs).`);
  }

  // ——— PASO 1: Rptas (solicitudes). Una fila = una solicitud; guardamos PréstamoID en external_loan_id.
  if (hasRptas) {
    const rptasSheet = workbook.Sheets[rptasSheetName];
    const rptasData = XLSX.utils.sheet_to_json(rptasSheet, { defval: null, raw: false });
    const rptasRows = LIMIT ? rptasData.slice(0, LIMIT) : rptasData;
    logger.info(`Paso 1 - Rptas ${COUNTRY}: ${rptasData.length} filas, procesando ${rptasRows.length}.`);
  for (let i = 0; i < rptasRows.length; i++) {
    const row = rptasRows[i];
    const prestamoId = getPrestamoId(row);
    // Marca temporal como primera opción para fecha de la solicitud (probar primero por nombre normalizado)
    const marcaTimestampRaw = getColByAnyNormalized(row, 'Marca temporal') ?? getCol(row, 'Marca temporal', 'Marca temporal ');
    const marcaTimestamp = parseMarcaTemporal(marcaTimestampRaw);

    const dni = toStr(getCol(row, 'DNI - CARNÉ EXTRANJERÍA ', 'CÉDULA DE CIUDADANIA - CARNÉ EXTRANJERÍA ', 'DNI'), 20);
    if (!dni) {
      skipped++;
      continue;
    }

    try {
      if (!idByDni.has(dni)) driversCreated++;
      const driverId = await ensureDriver(row, idByDni);
      if (!driverId) continue;

      // Monto Otorgado como primera opción (vista detalle solicitud muestra requested_amount)
      const montoOtorgadoRaw =
        getCol(row, 'Monto Otorgado', 'Monto Otorgado ', 'Monto otorgado', 'Monto_Otorgado') ??
        getColByNormalizedKey(row, 'Monto Otorgado') ?? getColByNormalizedKey(row, 'Monto_Otorgado');
      const montoOtorgado = toNum(montoOtorgadoRaw);
      const montoSolicitado = toNum(getCol(row, 'Monto Solicitado', 'Monto Solicitado ')) ?? 0;
      // En info de la solicitud: primera opción Monto Otorgado, luego Monto Solicitado
      const requestedAmount = (montoOtorgado != null && montoOtorgado > 0) ? montoOtorgado : montoSolicitado;
      const montoParaLoan = (montoOtorgado != null && montoOtorgado > 0) ? montoOtorgado : requestedAmount;
      const estado = getCol(row, 'Estado', 'Estado ');
      const montoPagado = toNum(getCol(row, 'Monto_Pagado', 'Monto_Pagado ', 'Monto pagado'));
      let { requestStatus, createLoan: createLoanFromEstado } = mapEstado(estado);

      // Fecha desembolso real del histórico: FECHA DESEMBOLSO (DD/MM/YYYY o serial); no asumir "hoy"
      const fechaDesembolsoRaw = getCol(row, 'FECHA DESEMBOLSO', 'FECHA DESEMBOLSO ');
      const disbursedAt = parseMarcaTemporal(fechaDesembolsoRaw) ?? (fechaDesembolsoRaw != null && fechaDesembolsoRaw !== '' ? excelDateToJS(toNum(fechaDesembolsoRaw)) : null);
      // Fecha de vencimiento / primera cuota: siempre del Excel (Fecha_Programada / Fecha_Programac)
      const primeraCuotaRaw =
        getCol(row, 'Fecha_Programada', 'Fecha_Programada ', 'Fecha_Programac', 'Fecha_Programac ', 'Primera_Cuota_Overide', 'Primera cuota', 'Fecha primera cuota', 'Fecha de vencimiento') ??
        getColByAnyNormalized(row, 'Fecha_Programada', 'Fecha_Programac', 'Fecha de vencimiento', 'Primera_Cuota_Overide');
      const primeraCuotaOverride = parseMarcaTemporal(primeraCuotaRaw) ?? (primeraCuotaRaw != null && primeraCuotaRaw !== '' ? excelDateToJS(toNum(primeraCuotaRaw)) : null);
      // Cuota programada (Cronograma PE) o cuota (Rptas PE)
      const cuota = toNum(getCol(row, 'Cuota_Programada', 'Cuota_Programada ', 'cuota'));
      const semanasRaw = toNum(getCol(row, 'Semanas sugeridas (n)', 'Semanas sugeridas'));
      const semanas = semanasRaw != null ? Math.floor(semanasRaw) : null;
      const tasaSemanal = toNum(getCol(row, 'Tasa semanal (t)', 'Tasa semanal'));

      // Crear loan solo si el estado lo indica, hay datos y (si hay Cronograma) el PréstamoID de esta fila está en Cronograma — así no se crean préstamos “fantasma” por filas Rptas sin cronograma (ej. mismo DNI con varios renglones).
      const hasLoanData = montoParaLoan != null && montoParaLoan > 0 && cuota != null && cuota > 0 && semanas != null && semanas >= 1;
      const prestamoIdTrim = (prestamoId && String(prestamoId).trim()) || '';
      const loanAllowedByCronograma = prestamoIdsInCronograma.size === 0 || prestamoIdsInCronograma.has(prestamoIdTrim);
      let createLoan = createLoanFromEstado && hasLoanData && loanAllowedByCronograma;

      const observations = [toStr(getCol(row, 'Bitácora')), toStr(getCol(row, 'Msj Personalizado')), toStr(getCol(row, 'Mensaje Propuesta'))].filter(Boolean).join(' | ') || null;

      // Fecha de creación: Marca temporal del Excel; si es inválida (ej. 1900), futura o falta, la BD usa CURRENT_TIMESTAMP
      const createdAt = validRequestDate(marcaTimestamp);
      // Para el préstamo: disbursed_at = FECHA DESEMBOLSO si existe y es válida; si no, Marca temporal o null (BD: CURRENT_TIMESTAMP)
      const disbursedValid = disbursedAt && !isNaN(disbursedAt.getTime()) && validRequestDate(disbursedAt);
      const loanDisbursedAt = disbursedValid || createdAt;

      // Leer Ciclo actual de Rptas PE para esta solicitud
      const cycleVal = getCol(row, 'Ciclo actual', 'Ciclo actual ', 'Ciclo Actual', 'Ciclo') ?? getColByAnyNormalized(row, 'Ciclo actual', 'Ciclo');
      const cycle = toNum(cycleVal) != null && !isNaN(toNum(cycleVal)) && toNum(cycleVal) > 0 ? Math.max(1, Math.floor(toNum(cycleVal))) : 1;

      let requestId = null;
      if (!DRY_RUN) {
        // Guardar ciclo en la solicitud (el ciclo en el que estaba el conductor cuando se creó la solicitud)
        try {
          const reqRes = await query(
            `INSERT INTO module_rapidin_loan_requests (driver_id, country, requested_amount, status, observations, created_at, cycle)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP), $7)
             RETURNING id`,
            [driverId, COUNTRY, requestedAmount, requestStatus, observations, createdAt, cycle]
          );
          requestId = reqRes.rows[0].id;
        } catch (err) {
          // Si la columna cycle no existe, insertar sin cycle (el ciclo se obtiene del conductor)
          if (err.message && err.message.includes('column "cycle"')) {
            const reqRes2 = await query(
              `INSERT INTO module_rapidin_loan_requests (driver_id, country, requested_amount, status, observations, created_at)
               VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP))
               RETURNING id`,
              [driverId, COUNTRY, requestedAmount, requestStatus, observations, createdAt]
            );
            requestId = reqRes2.rows[0].id;
          } else {
            throw err;
          }
        }
      }
      requestsCreated++;

      if (createLoan) {
        const numInstallments = Math.max(1, Math.floor(semanas));
        const totalAmount = cuota * numInstallments;
        const interestRate = tasaSemanal != null ? (tasaSemanal <= 1 ? tasaSemanal * 100 : tasaSemanal) : 5;
        // first_payment_date: Fecha_Programada (Cronograma PE) guardada tal cual; si falta, fallback próximo lunes
        let firstPaymentDate;
        if (primeraCuotaOverride && !isNaN(primeraCuotaOverride.getTime())) {
          firstPaymentDate = new Date(primeraCuotaOverride);
          firstPaymentDate.setHours(0, 0, 0, 0);
        } else {
          const today = new Date();
          const nextMonday = new Date(today);
          const dayOfWeek = today.getDay();
          const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 0 : 8 - dayOfWeek;
          nextMonday.setDate(today.getDate() + daysUntilMonday);
          nextMonday.setHours(0, 0, 0, 0);
          firstPaymentDate = nextMonday;
        }

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
              [requestId, driverId, COUNTRY, montoParaLoan, totalAmount, interestRate, numInstallments, loanDisbursedAt, firstPaymentDate, driverCycle, externalId]
            );
          } catch (err) {
            if (err.message && err.message.includes('external_loan_id')) {
              loanRes = await query(
                `INSERT INTO module_rapidin_loans (request_id, driver_id, country, disbursed_amount, total_amount, interest_rate, number_of_installments, disbursed_at, first_payment_date, status, pending_balance, cycle)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP), $9, 'active', $5, $10)
                 RETURNING id`,
                [requestId, driverId, COUNTRY, montoParaLoan, totalAmount, interestRate, numInstallments, loanDisbursedAt, firstPaymentDate, driverCycle]
              );
            } else if (err.message && err.message.includes('column "cycle"')) {
              loanRes = await query(
                `INSERT INTO module_rapidin_loans (request_id, driver_id, country, disbursed_amount, total_amount, interest_rate, number_of_installments, disbursed_at, first_payment_date, status, pending_balance)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP), $9, 'active', $5)
                 RETURNING id`,
                [requestId, driverId, COUNTRY, montoParaLoan, totalAmount, interestRate, numInstallments, loanDisbursedAt, firstPaymentDate]
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
              const dueDate = new Date(firstPaymentDate);
              dueDate.setDate(dueDate.getDate() + (k - 1) * 7);
              dueDate.setHours(0, 0, 0, 0);
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
                [loanId, k, cuota, Math.round(principalPerInstallment * 100) / 100, Math.round(interestPerInstallment * 100) / 100, dueDate, paidAmt, instStatus]
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
    await processCronogramaPE(cronoRows, idByDni, stats, errors, workbook, existingLoansByPrestamoId);
    driversCreated += stats.driversCreated;
    requestsCreated += stats.requestsCreated;
    loansCreated += stats.loansCreated;
    installmentsCreated += stats.installmentsCreated;
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
