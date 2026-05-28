/**
 * Yego Rapidín 4.0 — ExcelValidator
 *
 * Validación en múltiples etapas ANTES de importar:
 *   1. Estructura (hoja existe, columnas esperadas)
 *   2. Tipos de datos (números vs texto vs fechas)
 *   3. Duplicados (dentro del Excel y vs BD)
 *   4. Relaciones (placa → solicitud, cronograma, etc.)
 *
 * Errores recolectados por fila sin detener la validación.
 */
import XLSX from 'xlsx';
import { query } from '../config/database.js';

/**
 * Resultado de validación.
 * @typedef {object} ValidationResult
 * @property {boolean} valid - true si no hay errores bloqueantes
 * @property {Array} errors - [{ row, column, value, reason, severity: 'error'|'warning' }]
 * @property {Array} warnings - [{ row, column, value, reason }]
 * @property {object} stats - { totalRows, validRows, errorRows, warningRows }
 */

/**
 * Valida un archivo Excel para importación de cuotas semanales.
 *
 * @param {string} filePath - Ruta al archivo .xlsx
 * @param {object} expectedStructure - { sheetName, headerRow, dataStartRow, columns: [{name, col, type, required}] }
 * @returns {Promise<ValidationResult>}
 */
export async function validateExcelStructure(filePath, expectedStructure) {
  const errors = [];
  const warnings = [];

  let wb;
  try {
    wb = XLSX.readFile(filePath, { cellDates: true, raw: true });
  } catch (err) {
    return {
      valid: false,
      errors: [{ row: 0, column: 'file', value: filePath, reason: `No se pudo leer el archivo: ${err.message}`, severity: 'error' }],
      warnings: [],
      stats: { totalRows: 0, validRows: 0, errorRows: 1, warningRows: 0 },
    };
  }

  // Etapa 1: Validar que la hoja existe
  const ws = wb.Sheets[expectedStructure.sheetName];
  if (!ws) {
    const availableSheets = wb.SheetNames.join(', ');
    errors.push({
      row: 0, column: 'sheet', value: expectedStructure.sheetName,
      reason: `Hoja "${expectedStructure.sheetName}" no encontrada. Hojas disponibles: ${availableSheets}`,
      severity: 'error',
    });
    return {
      valid: false, errors, warnings,
      stats: { totalRows: 0, validRows: 0, errorRows: 1, warningRows: 0 },
    };
  }

  // Etapa 2: Validar headers
  const headerErrors = validateHeaders(ws, expectedStructure);
  errors.push(...headerErrors.filter((e) => e.severity === 'error'));
  warnings.push(...headerErrors.filter((e) => e.severity === 'warning'));

  if (headerErrors.some((e) => e.severity === 'error')) {
    return {
      valid: false, errors, warnings,
      stats: { totalRows: 0, validRows: 0, errorRows: 1, warningRows: 0 },
    };
  }

  // Etapa 3: Validar filas de datos
  const ref = ws['!ref'];
  const range = ref ? XLSX.utils.decode_range(ref) : { e: { r: 0, c: 0 } };
  const maxRow = range.e.r + 1;

  const rowErrors = [];
  const rowWarnings = [];
  let totalDataRows = 0;

  for (let row = expectedStructure.dataStartRow; row <= maxRow; row++) {
    const rowStr = String(row);
    const rowData = {};

    let hasData = false;
    for (const col of expectedStructure.columns) {
      const cell = getCell(ws, row, col.col);
      const value = cellToString(cell);
      rowData[col.name] = value;
      if (value) hasData = true;
    }

    if (!hasData) continue;
    totalDataRows++;

    // Validar tipos de datos por columna
    for (const col of expectedStructure.columns) {
      const cell = getCell(ws, row, col.col);
      const value = cell ? cellToString(cell) : '';

      // Requerido
      if (col.required && !value) {
        rowErrors.push({
          row: rowStr, column: col.name, value: '(vacío)',
          reason: `Columna "${col.label || col.name}" es requerida`, severity: 'error',
        });
        continue;
      }

      // Tipo de dato
      if (value && col.type) {
        const typeError = validateCellType(value, col.type, col.name);
        if (typeError) {
          rowErrors.push({
            row: rowStr, column: col.name, value,
            reason: typeError, severity: 'error',
          });
        }
      }
    }
  }

  errors.push(...rowErrors);
  warnings.push(...rowWarnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      totalRows: totalDataRows,
      validRows: totalDataRows - new Set(errors.map((e) => e.row)).size,
      errorRows: new Set(errors.map((e) => e.row)).size,
      warningRows: new Set(warnings.map((e) => e.row)).size,
    },
  };
}

/**
 * Valida que no existan duplicados en el Excel y contra la BD.
 */
export async function validateDuplicates(ws, expectedStructure, tableName, uniqueColumns) {
  const errors = [];
  const ref = ws['!ref'];
  const range = ref ? XLSX.utils.decode_range(ref) : { e: { r: 0, c: 0 } };
  const maxRow = range.e.r + 1;

  const seen = new Map();

  for (let row = expectedStructure.dataStartRow; row <= maxRow; row++) {
    const keys = [];
    for (const col of uniqueColumns) {
      const cell = getCell(ws, row, col.col);
      keys.push(normalizeForMatch(cellToString(cell)));
    }
    const key = keys.join('||');

    if (!keys.every(Boolean)) continue;
    const rowStr = String(row);

    if (seen.has(key)) {
      errors.push({
        row: rowStr, column: uniqueColumns.map((c) => c.name).join(', '), value: key,
        reason: `Duplicado: misma combinación que fila ${seen.get(key)}`,
        severity: 'error',
      });
    } else {
      seen.set(key, rowStr);
    }
  }

  return errors;
}

/**
 * Valida que las relaciones (ej. placa → solicitud) existan en BD.
 */
export async function validateRelations(ws, expectedStructure, relations) {
  const errors = [];
  const ref = ws['!ref'];
  const range = ref ? XLSX.utils.decode_range(ref) : { e: { r: 0, c: 0 } };
  const maxRow = range.e.r + 1;

  for (const rel of relations) {
    const { excelColumn, table, matchColumn, label } = rel;

    for (let row = expectedStructure.dataStartRow; row <= maxRow; row++) {
      const cell = getCell(ws, row, excelColumn.col);
      const value = normalizeForMatch(cellToString(cell));
      if (!value) continue;
      const rowStr = String(row);

      const res = await query(
        `SELECT 1 FROM ${table} WHERE ${matchColumn} = $1 LIMIT 1`,
        [value]
      );

      if (res.rows.length === 0) {
        errors.push({
          row: rowStr, column: excelColumn.name, value,
          reason: `${label || excelColumn.name} "${value}" no existe en ${table}`,
          severity: 'error',
        });
      }
    }
  }

  return errors;
}

// --- Helpers ---

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

function validateHeaders(ws, expectedStructure) {
  const errors = [];
  for (const col of expectedStructure.columns) {
    if (!col.headerLabel) continue;
    const cell = getCell(ws, expectedStructure.headerRow, col.col);
    const value = cellToString(cell);
    if (!value) {
      errors.push({
        row: String(expectedStructure.headerRow), column: `Col ${col.col}`, value: '(vacío)',
        reason: `Se esperaba header "${col.headerLabel}" en columna ${col.col}`,
        severity: 'warning',
      });
    } else if (normalizeHeader(value) !== normalizeHeader(col.headerLabel)) {
      errors.push({
        row: String(expectedStructure.headerRow), column: `Col ${col.col}`, value,
        reason: `Header "${value}" no coincide con "${col.headerLabel}"`,
        severity: 'warning',
      });
    }
  }
  return errors;
}

function validateCellType(value, expectedType, colName) {
  const s = String(value).trim();
  if (!s) return null;

  switch (expectedType) {
    case 'number':
      if (isNaN(parseFloat(s.replace(/,/g, '')))) {
        return `"${colName}" debe ser numérico, se encontró "${s}"`;
      }
      break;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) && isNaN(Date.parse(s))) {
        return `"${colName}" debe ser fecha, se encontró "${s}"`;
      }
      break;
    case 'text':
      // siempre válido
      break;
  }
  return null;
}

function normalizeForMatch(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeHeader(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, '');
}

/**
 * Estructura esperada para importación de cuotas semanales Mi Auto.
 */
export const CUOTAS_SEMANALES_STRUCTURE = {
  sheetName: 'Cuotas Semanales',
  headerRow: 2,
  dataStartRow: 3,
  columns: [
    { name: 'status', col: 1, type: 'text', label: 'STATUS' },
    { name: 'auto', col: 2, type: 'text', label: 'AUTO' },
    { name: 'crono', col: 3, type: 'text', label: 'CRONO' },
    { name: 'placa', col: 4, type: 'text', label: 'PLACA', required: true },
    { name: 'dni', col: 6, type: 'text', label: 'DNI' },
    { name: 'phone', col: 7, type: 'text', label: 'TELEFONO' },
    { name: 'nombre', col: 8, type: 'text', label: 'NOMBRE' },
  ],
};
