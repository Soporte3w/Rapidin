/**
 * Yego Rapidín 4.0 — Import Service
 *
 * Servicio unificado para importaciones Excel.
 * Garantiza:
 *   1. Validación previa (estructura, duplicados, relaciones)
 *   2. Registro de auditoría (module_miauto_import_log)
 *   3. Errores por fila que no detienen el proceso
 *   4. Cada importación deja trazabilidad completa
 */
import XLSX from 'xlsx';
import fs from 'fs';
import crypto from 'crypto';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { validateExcelStructure, validateDuplicates, validateRelations } from './ExcelValidator.js';
import { auditService } from './auditService.js';

/**
 * Ejecuta una importación con ciclo completo de validación → importación → auditoría.
 *
 * @param {object} params
 * @param {string} params.filePath - Ruta al archivo Excel
 * @param {object} params.expectedStructure - Estructura esperada (de ExcelValidator)
 * @param {string} params.importType - 'cuotas_semanales' | 'solicitudes'
 * @param {Function} params.rowProcessor - async (rowData, rowIndex, context) => { success, error? }
 * @param {object} params.options - { dryRun, actorId, correlationId }
 * @returns {ImportResult}
 */
export async function executeExcelImport({
  filePath,
  expectedStructure,
  importType,
  rowProcessor,
  options = {},
}) {
  const dryRun = !!options.dryRun;
  const actorId = options.actorId || null;
  const correlationId = options.correlationId || null;

  const fileHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const fileSize = fs.statSync(filePath).size;

  // --- 1. Crear registro de importación ---
  let importLogId;
  if (!dryRun) {
    const logRes = await query(
      `INSERT INTO module_miauto_module_miauto_import_log (file_name, file_hash, file_size_bytes, import_type, status, dry_run, imported_by, correlation_id)
       VALUES ($1, $2, $3, $4, 'validating', $5, $6, $7)
       RETURNING id`,
      [filePath, fileHash, fileSize, importType, dryRun, actorId, correlationId]
    );
    importLogId = logRes.rows[0].id;
  }

  // --- 2. Validar estructura ---
  const validation = await validateExcelStructure(filePath, expectedStructure);

  if (!validation.valid) {
    if (!dryRun && importLogId) {
      await query(
        `UPDATE module_miauto_import_log SET status = 'failed', error_rows = $1, errors = $2::jsonb, completed_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [validation.stats.errorRows, JSON.stringify(validation.errors), importLogId]
      );
    }
    return {
      success: false,
      importLogId,
      errors: validation.errors,
      stats: validation.stats,
      stage: 'validation_failed',
    };
  }

  // --- 3. Importar ---
  if (!dryRun && importLogId) {
    await query(
      `UPDATE module_miauto_import_log SET status = 'importing', total_rows = $1 WHERE id = $2`,
      [validation.stats.totalRows, importLogId]
    );
  }

  const wb = XLSX.readFile(filePath, { cellDates: true, raw: true });
  const ws = wb.Sheets[expectedStructure.sheetName];
  const ref = ws['!ref'];
  const range = ref ? XLSX.utils.decode_range(ref) : { e: { r: 0, c: 0 } };
  const maxRow = range.e.r + 1;

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  const importErrors = [];

  for (let row = expectedStructure.dataStartRow; row <= maxRow; row++) {
    const rowData = {};
    let hasData = false;

    for (const col of expectedStructure.columns) {
      const cell = ws[XLSX.utils.encode_cell({ r: row - 1, c: col.col })];
      rowData[col.name] = cell ? cellToString(cell) : '';
      if (rowData[col.name]) hasData = true;
    }

    if (!hasData) {
      skippedCount++;
      continue;
    }

    try {
      const result = await rowProcessor(rowData, row, { filePath, importType, dryRun, actorId, correlationId });
      if (result.success) {
        successCount++;
      } else {
        errorCount++;
        importErrors.push({
          row: String(row),
          reason: result.error || 'Error desconocido',
          data: Object.fromEntries(
            expectedStructure.columns.map((c) => [c.name, rowData[c.name]])
          ),
        });
      }
    } catch (err) {
      errorCount++;
      importErrors.push({
        row: String(row),
        reason: err.message,
        data: Object.fromEntries(
          expectedStructure.columns.map((c) => [c.name, rowData[c.name]])
        ),
      });
    }
  }

  // --- 4. Actualizar registro de importación ---
  const finalStatus = errorCount === 0 ? 'completed' : (successCount > 0 ? 'partial' : 'failed');

  if (!dryRun && importLogId) {
    await query(
      `UPDATE module_miauto_import_log SET status = $1, success_rows = $2, skipped_rows = $3, error_rows = $4, errors = $5::jsonb, completed_at = CURRENT_TIMESTAMP WHERE id = $6`,
      [finalStatus, successCount, skippedCount, errorCount, JSON.stringify(importErrors), importLogId]
    );
  }

  // --- 5. Registrar evento de auditoría ---
  await auditService.recordBusinessEvent(
    'excel.imported',
    'import',
    importLogId,
    {
      importType,
      filePath,
      fileHash,
      fileSize,
      dryRun,
      totalRows: validation.stats.totalRows,
      successRows: successCount,
      errorRows: errorCount,
      skippedRows: skippedCount,
      status: finalStatus,
    },
    actorId
  );

  logger.info(`Import ${importType}: ${successCount} OK, ${errorCount} errores, ${skippedCount} skip (dryRun=${dryRun})`);

  return {
    success: finalStatus === 'completed' || finalStatus === 'partial',
    importLogId,
    errors: importErrors,
    stats: {
      totalRows: validation.stats.totalRows,
      successRows: successCount,
      errorRows: errorCount,
      skippedRows: skippedCount,
    },
    stage: finalStatus,
    fileHash,
  };
}

function cellToString(cell) {
  if (!cell) return '';
  if (cell.w != null && String(cell.w).trim() !== '') return String(cell.w).trim();
  const v = cell.v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (v == null) return '';
  return String(v).trim();
}
