/**
 * Importa el historial de PAGOS POST ENTREGA sin recalcular ni sobrescribir.
 *
 * Uso:
 *   node scripts/miauto-import-otros-gastos-excel.js archivo.xlsx --dry-run
 *   node scripts/miauto-import-otros-gastos-excel.js archivo.xlsx --apply
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import pool, { getClient, query } from '../config/database.js';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function normalize(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function money(value) {
  const parsed = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function monthEnd(year, month) {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateHeader(value, fallbackYear = 2026, monthEndDate = false) {
  const text = String(value || '').trim();
  const monthYear = /^([a-z]+)\s*-?\s*(\d{4})$/i.exec(text);
  if (monthYear) {
    const month = MONTHS[monthYear[1].toLowerCase()];
    return month ? (monthEndDate ? monthEnd(Number(monthYear[2]), month) : `${monthYear[2]}-${String(month).padStart(2, '0')}-01`) : null;
  }
  const dayMonthName = /^(\d{1,2})\s*-?\s*([a-z]+)$/i.exec(text.replace(/\s+/g, ' '));
  if (dayMonthName) {
    const month = MONTHS[dayMonthName[2].toLowerCase()];
    return month ? `${fallbackYear}-${String(month).padStart(2, '0')}-${String(Number(dayMonthName[1])).padStart(2, '0')}` : null;
  }
  const dayMonth = /^(\d{1,2})\/(\d{1,2})$/.exec(text);
  return dayMonth
    ? `${fallbackYear}-${String(Number(dayMonth[2])).padStart(2, '0')}-${String(Number(dayMonth[1])).padStart(2, '0')}`
    : null;
}

function statusFromCell(value, dueDate) {
  const status = normalize(value);
  if (status === 'PAGADO' || status === 'TRUE' || status === 'SI' || status === 'SÍ') return 'paid';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return dueDate < today ? 'overdue' : 'pending';
}

function nonEmptyRows(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false })
    .filter((row) => Array.isArray(row) && row.some((cell) => String(cell || '').trim()));
}

function buildRecords(workbook) {
  const records = [];
  const definitions = [
    { sheet: 'GPS', concept: 'gps', currency: 'PEN', idType: 'plate', idIndex: 1, start: 3, monthEnd: true, amount: () => 47.2 },
    { sheet: 'SOAT', concept: 'soat', currency: 'PEN', idType: 'plate', idIndex: 1, phoneIndex: 2, start: 5, step: 2, statusOffset: 1, amount: (row, index) => money(row[index]) },
    { sheet: 'IMPUESTO VEHICULAR', concept: 'impuesto_vehicular', currency: 'PEN', idType: 'plate', idIndex: 2, phoneIndex: 3, start: 5, step: 2, statusOffset: 1, amount: (row, index) => money(row[index]) },
    { sheet: 'STR + GPS', concept: 'str_gps', currency: 'USD', idType: 'license', idIndex: 1, phoneIndex: 2, start: 6, amount: (row) => money(row[3]) },
    { sheet: 'Inicial Parcial', concept: 'inicial_parcial', currency: 'USD', idType: 'license', idIndex: 1, phoneIndex: 2, start: 6, amount: (row) => money(row[3]) },
  ];

  for (const definition of definitions) {
    const sheet = workbook.Sheets[definition.sheet];
    if (!sheet) continue;
    const rows = nonEmptyRows(sheet);
    const header = rows[0] || [];
    const step = definition.step || 1;
    const dateColumns = [];
    for (let index = definition.start; index < header.length; index += step) {
      const dueDate = parseDateHeader(header[index], 2026, Boolean(definition.monthEnd));
      if (dueDate) dateColumns.push({ index, dueDate });
    }

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const driverName = String(row[0] || '').trim();
      const identifier = String(row[definition.idIndex] || '').trim();
      if (!driverName || !identifier) continue;
      const positionByYear = new Map();
      for (const column of dateColumns) {
        const amount = definition.amount(row, column.index);
        if (amount == null || amount <= 0) continue;
        const periodYear = Number(column.dueDate.slice(0, 4));
        const number = (positionByYear.get(periodYear) || 0) + 1;
        positionByYear.set(periodYear, number);
        const statusCell = definition.statusOffset ? row[column.index + definition.statusOffset] : row[column.index];
        records.push({
          sheet: definition.sheet,
          concept: definition.concept,
          currency: definition.currency,
          idType: definition.idType,
          identifier,
          phone: definition.phoneIndex != null ? digits(row[definition.phoneIndex]) : null,
          driverName,
          number,
          total: dateColumns.filter((item) => Number(item.dueDate.slice(0, 4)) === periodYear).length,
          dueDate: column.dueDate,
          periodYear,
          amount,
          status: statusFromCell(statusCell, column.dueDate),
          sourceCell: `${definition.sheet}!R${rowIndex + 1}C${column.index + 1}`,
        });
      }
    }
  }
  return records;
}

async function resolveSolicitud(record) {
  const value = record.idType === 'phone' ? digits(record.identifier) : normalize(record.identifier).replace(/\s/g, '');
  const result = await query(
    record.idType === 'plate'
      ? `SELECT id FROM module_miauto_solicitud
         WHERE UPPER(REGEXP_REPLACE(COALESCE(placa_asignada, ''), '\\s', '', 'g')) = $1
           AND status = 'aprobado' AND deleted_at IS NULL`
      : `SELECT id FROM module_miauto_solicitud
         WHERE UPPER(REGEXP_REPLACE(COALESCE(license_number, ''), '\\s', '', 'g')) = $1
           AND status = 'aprobado' AND deleted_at IS NULL`,
    [value]
  );
  if (result.rows.length === 1) return { id: result.rows[0].id, matches: 1, matchedBy: record.idType };
  if (result.rows.length > 1 || !record.phone) return { id: null, matches: result.rows.length };
  const phone = digits(record.phone).slice(-9);
  const phoneResult = await query(
    `SELECT id FROM module_miauto_solicitud
     WHERE RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 9) = $1
       AND status = 'aprobado' AND deleted_at IS NULL`,
    [phone]
  );
  return phoneResult.rows.length === 1
    ? { id: phoneResult.rows[0].id, matches: 1, matchedBy: 'phone' }
    : { id: null, matches: phoneResult.rows.length };
}

async function importRecord(client, record, solicitudId, fileHash) {
  const cycleLockKey = `miauto-import-cycle:${solicitudId}:${record.concept}:${record.periodYear}:${fileHash}:${record.sheet}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cycleLockKey]);
  let cycle = await client.query(
    `SELECT id
     FROM module_miauto_gasto_ciclo
     WHERE solicitud_id = $1::uuid
       AND concepto = $2
       AND periodo_anio = $3
       AND config_snapshot->>'source_file_hash' = $4
       AND config_snapshot->>'source_sheet' = $5
     LIMIT 1`,
    [solicitudId, record.concept, record.periodYear, fileHash, record.sheet]
  );
  if (!cycle.rows[0]) {
    cycle = await client.query(
      `INSERT INTO module_miauto_gasto_ciclo
         (solicitud_id, concepto, periodo_anio, ciclo_numero, moneda, monto_total,
          fecha_inicio, fecha_fin, numero_cuotas, estado, origen, config_snapshot)
       SELECT $1::uuid, $2, $3, COALESCE(MAX(existing.ciclo_numero), 0) + 1,
              $4, NULL, $5::date, $5::date, $6, 'activo', 'excel_import', $7::jsonb
       FROM module_miauto_gasto_ciclo existing
       WHERE existing.solicitud_id = $1::uuid
         AND existing.concepto = $2
         AND existing.periodo_anio = $3
       RETURNING id`,
      [solicitudId, record.concept, record.periodYear, record.currency, record.dueDate,
        record.total, JSON.stringify({ source_file_hash: fileHash, source_sheet: record.sheet })]
    );
  } else {
    await client.query(
      `UPDATE module_miauto_gasto_ciclo
       SET fecha_inicio = LEAST(fecha_inicio, $1::date),
           fecha_fin = GREATEST(fecha_fin, $1::date),
           numero_cuotas = GREATEST(numero_cuotas, $2),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3::uuid`,
      [record.dueDate, record.total, cycle.rows[0].id]
    );
  }
  const sourceKey = `excel:${fileHash}:${record.sheet}:${solicitudId}:${record.number}:${record.dueDate}`;
  const expense = await client.query(
    `INSERT INTO module_miauto_otros_gastos
       (solicitud_id, ciclo_id, tipo, week_index, numero_cuota, total_cuotas,
        periodo_anio, due_date, amount_due, paid_amount, status, moneda,
        source_key, origen)
     VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7::date, $8,
             CASE WHEN $9 = 'paid' THEN $8 ELSE 0 END, $9, $10, $11, 'excel_import')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [solicitudId, cycle.rows[0].id, record.concept, record.number, record.total, record.periodYear,
      record.dueDate, record.amount, record.status, record.currency, sourceKey]
  );
  if (!expense.rows[0]) return false;
  if (record.status === 'paid') {
    await client.query(
      `INSERT INTO module_miauto_gasto_pago_aplicacion
         (solicitud_id, otros_gastos_id, origen, source_key, monto_original,
          moneda_original, tipo_cambio, monto_aplicado, moneda_aplicada, metadata)
       VALUES ($1::uuid, $2::uuid, 'import', $3, $4, $5, 1, $4, $5, $6::jsonb)
       ON CONFLICT (source_key) DO NOTHING`,
      [solicitudId, expense.rows[0].id, `${sourceKey}:payment`, record.amount,
        record.currency, JSON.stringify({ source_cell: record.sourceCell })]
    );
  }
  return true;
}

async function main() {
  const fileArg = process.argv.find((arg) => arg.toLowerCase().endsWith('.xlsx'));
  const apply = process.argv.includes('--apply');
  if (!fileArg) throw new Error('Indica la ruta del archivo .xlsx');
  const filePath = path.resolve(fileArg);
  const fileHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const records = buildRecords(XLSX.readFile(filePath));
  const summary = {
    records: records.length,
    matched: 0,
    inserted: 0,
    duplicate: 0,
    notFound: 0,
    ambiguous: 0,
    unresolved: [],
  };
  const resolutionCache = new Map();
  const unresolvedKeys = new Set();

  for (const record of records) {
    const cacheKey = `${record.idType}:${record.identifier}:${record.phone || ''}`;
    let resolution = resolutionCache.get(cacheKey);
    if (!resolution) {
      resolution = await resolveSolicitud(record);
      resolutionCache.set(cacheKey, resolution);
    }
    if (!resolution.id) {
      if (resolution.matches > 1) summary.ambiguous += 1;
      else summary.notFound += 1;
      if (!unresolvedKeys.has(cacheKey)) {
        unresolvedKeys.add(cacheKey);
        summary.unresolved.push({
          sheet: record.sheet,
          driverName: record.driverName,
          identifier: record.identifier,
          phone: record.phone,
          reason: resolution.matches > 1 ? 'ambiguous' : 'not_found',
        });
      }
      continue;
    }
    summary.matched += 1;
    if (!apply) continue;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const inserted = await importRecord(client, record, resolution.id, fileHash);
      await client.query('COMMIT');
      if (inserted) summary.inserted += 1;
      else summary.duplicate += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  if (apply) {
    const finalized = await query(
      `UPDATE module_miauto_gasto_ciclo c
       SET monto_total = totals.monto_total,
           estado = CASE WHEN totals.pendientes = 0 THEN 'completado' ELSE 'activo' END,
           updated_at = CURRENT_TIMESTAMP
       FROM (
         SELECT og.ciclo_id,
                SUM(og.amount_due) AS monto_total,
                COUNT(*) FILTER (
                  WHERE COALESCE(og.paid_amount, 0) < COALESCE(og.amount_due, 0) - 0.005
                ) AS pendientes
         FROM module_miauto_otros_gastos og
         JOIN module_miauto_gasto_ciclo source_cycle ON source_cycle.id = og.ciclo_id
         WHERE source_cycle.config_snapshot->>'source_file_hash' = $1
           AND og.deleted_at IS NULL
         GROUP BY og.ciclo_id
       ) totals
       WHERE c.id = totals.ciclo_id
       RETURNING c.id`,
      [fileHash]
    );
    summary.cyclesFinalized = finalized.rowCount;
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', file: filePath, fileHash, summary }, null, 2));
  if (!apply) console.log('Sin escrituras. Usa --apply despues de revisar el resumen.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
