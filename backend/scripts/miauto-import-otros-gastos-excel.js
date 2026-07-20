/**
 * Concilia el Excel PAGOS POST ENTREGA con los gastos de Mi Auto.
 *
 * Uso:
 *   node scripts/miauto-import-otros-gastos-excel.js archivo.xlsx --year=YYYY --gps-amount=MONTO --dry-run
 *   node scripts/miauto-import-otros-gastos-excel.js archivo.xlsx --year=YYYY --gps-amount=MONTO --apply
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import pool, { getClient, query } from '../config/database.js';
import { expenseStatus } from '../yego_miauto/services/gastos/miautoGastoRules.js';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const PAID_MARKERS = new Set(['PAGADO', 'PAGADA', 'TRUE', 'SI', 'SÍ', 'OK', 'X', '1', '✔', '✓', '☑']);
const STR_GPS_CONCEPT = 'todo_riesgo_mas_gps_agrupado';
const CONCEPT_ALIASES = {
  [STR_GPS_CONCEPT]: [STR_GPS_CONCEPT, 'str_gps'],
};
const SUMMARY_FIELD_BY_ACTION = {
  insert: 'inserted',
  update: 'updated',
  unchanged: 'unchanged',
  conflict: 'conflicts',
};

function normalize(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function money(value) {
  const matches = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g);
  const parsed = Number(matches?.at(-1));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function limaTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function monthEnd(year, month) {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseDateHeader(value, fallbackYear, useMonthEnd = false) {
  const text = String(value ?? '').trim();
  const monthYear = /^([a-z]+)\s*-?\s*(\d{4})$/i.exec(text);
  if (monthYear) {
    const month = MONTHS[monthYear[1].toLowerCase()];
    if (!month) return null;
    return useMonthEnd
      ? monthEnd(Number(monthYear[2]), month)
      : `${monthYear[2]}-${String(month).padStart(2, '0')}-01`;
  }
  const dayMonthName = /^(\d{1,2})\s*-?\s*([a-z]+)$/i.exec(text.replace(/\s+/g, ' '));
  if (dayMonthName) {
    const month = MONTHS[dayMonthName[2].toLowerCase()];
    return month && Number.isInteger(Number(fallbackYear))
      ? `${fallbackYear}-${String(month).padStart(2, '0')}-${String(Number(dayMonthName[1])).padStart(2, '0')}`
      : null;
  }
  const dayMonth = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(text);
  if (!dayMonth) return null;
  const rawYear = dayMonth[3] ? Number(dayMonth[3]) : Number(fallbackYear);
  if (!Number.isInteger(rawYear)) return null;
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  return `${year}-${String(Number(dayMonth[2])).padStart(2, '0')}-${String(Number(dayMonth[1])).padStart(2, '0')}`;
}

export function statusFromCell(value, dueDate, todayYmd = limaTodayYmd()) {
  if (value === true || (typeof value === 'number' && value > 0)) return 'paid';
  const normalized = normalize(value);
  if (PAID_MARKERS.has(normalized) || (/^\d+(?:[.,]\d+)?$/.test(normalized) && money(normalized) > 0)) return 'paid';
  if (normalized === 'PROGRAMADO') return 'pending';
  return dueDate < todayYmd ? 'overdue' : 'pending';
}

export function calculateReconciliation({ existing, payments, record, todayYmd = limaTodayYmd() }) {
  const imported = round2(payments.imported);
  const operational = round2(payments.operational);
  const untrackedPaid = round2(Math.max(0, Number(existing.paid_amount) - imported - operational));
  const protectedPaid = round2(operational + untrackedPaid);
  const desiredImport = record.status === 'paid' ? round2(Math.max(0, record.amount - protectedPaid)) : 0;
  const paidAmount = round2(Math.min(record.amount, protectedPaid + desiredImport));
  return {
    protectedPaid,
    desiredImport,
    paidAmount,
    status: expenseStatus({
      amountDue: record.amount,
      paidAmount,
      dueDate: record.dueDate,
      todayYmd,
    }),
  };
}

function nonEmptyRows(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false })
    .filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim()));
}

const SHEET_DEFINITIONS = [
  {
    sheet: 'GPS', concept: 'gps', currency: 'PEN', idType: 'plate', idIndex: 1,
    start: 3, monthEnd: true, statusRequired: true, fixedAmountOption: 'gpsMonthlyAmount',
  },
  {
    sheet: 'SOAT', concept: 'soat', currency: 'PEN', idType: 'plate', idIndex: 1,
    phoneIndex: 2, start: 5, step: 2, statusOffset: 1,
    amount: (row, index) => money(row[index]),
  },
  {
    sheet: 'IMPUESTO VEHICULAR', concept: 'impuesto_vehicular', currency: 'PEN',
    idType: 'plate', idIndex: 2, phoneIndex: 3, start: 5, step: 2, statusOffset: 1,
    amount: (row, index) => money(row[index]),
  },
  {
    sheet: 'STR + GPS', concept: STR_GPS_CONCEPT, currency: 'USD', idType: 'license',
    idIndex: 1, phoneIndex: 2, start: 6, statusRequired: true, amount: (row) => money(row[3]),
  },
  {
    sheet: 'Inicial Parcial', concept: 'inicial_parcial', currency: 'USD', idType: 'license',
    idIndex: 1, phoneIndex: 2, start: 6, statusRequired: true, amount: (row) => money(row[3]),
  },
];

function rowIdentity(row, definition) {
  const driverName = String(row[0] ?? '').trim();
  const identifier = String(row[definition.idIndex] ?? '').trim();
  if (!driverName || !identifier) return null;
  return {
    idType: definition.idType,
    identifier,
    phone: definition.phoneIndex == null ? null : digits(row[definition.phoneIndex]),
    driverName,
  };
}

export function buildInitialPartialDrivers(workbook) {
  const definition = SHEET_DEFINITIONS.find(({ concept }) => concept === 'inicial_parcial');
  const sheet = workbook.Sheets[definition.sheet];
  if (!sheet) return [];
  return nonEmptyRows(sheet).slice(1)
    .map((row) => rowIdentity(row, definition))
    .filter(Boolean);
}

function importAmount(definition, row, columnIndex, options) {
  if (definition.fixedAmountOption) return money(options[definition.fixedAmountOption]);
  return definition.amount(row, columnIndex);
}

export function buildRecords(workbook, todayYmd = limaTodayYmd(), options = {}) {
  const fallbackYear = Number(options.fallbackYear);
  if (!Number.isInteger(fallbackYear)) {
    throw new Error('Indica el ano de las fechas sin ano del Excel');
  }
  const gpsMonthlyAmount = money(options.gpsMonthlyAmount);
  if (workbook.Sheets.GPS && (!gpsMonthlyAmount || gpsMonthlyAmount <= 0)) {
    throw new Error('Indica el monto mensual GPS usado por el Excel');
  }
  const importOptions = { ...options, gpsMonthlyAmount };
  const records = [];
  for (const definition of SHEET_DEFINITIONS) {
    const sheet = workbook.Sheets[definition.sheet];
    if (!sheet) continue;
    const rows = nonEmptyRows(sheet);
    const header = rows[0] || [];
    const dateColumns = [];
    for (let index = definition.start; index < header.length; index += definition.step || 1) {
      const dueDate = parseDateHeader(header[index], fallbackYear, Boolean(definition.monthEnd));
      if (dueDate) dateColumns.push({ index, dueDate });
    }

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const identity = rowIdentity(row, definition);
      if (!identity) continue;
      const applicableColumns = dateColumns.filter((column) => {
        const amount = importAmount(definition, row, column.index, importOptions);
        const statusCell = definition.statusOffset == null
          ? row[column.index]
          : row[column.index + definition.statusOffset];
        const marker = normalize(statusCell);
        return amount != null && amount > 0
          && (!definition.statusRequired || (marker && marker !== '-'));
      });
      const positionByYear = new Map();
      for (const column of applicableColumns) {
        const amount = importAmount(definition, row, column.index, importOptions);
        const periodYear = Number(column.dueDate.slice(0, 4));
        const number = (positionByYear.get(periodYear) || 0) + 1;
        positionByYear.set(periodYear, number);
        const statusCell = definition.statusOffset == null
          ? row[column.index]
          : row[column.index + definition.statusOffset];
        records.push({
          sheet: definition.sheet,
          concept: definition.concept,
          currency: definition.currency,
          ...identity,
          number,
          total: applicableColumns.filter((item) => Number(item.dueDate.slice(0, 4)) === periodYear).length,
          dueDate: column.dueDate,
          periodYear,
          amount,
          status: statusFromCell(statusCell, column.dueDate, todayYmd),
          sourceCell: `${definition.sheet}!R${rowIndex + 1}C${column.index + 1}`,
        });
      }
    }
  }
  return records;
}

async function loadSolicitudIndex() {
  const result = await query(
    `SELECT id,
            UPPER(REGEXP_REPLACE(COALESCE(placa_asignada, ''), '\\s', '', 'g')) AS plate,
            UPPER(REGEXP_REPLACE(COALESCE(license_number, ''), '\\s', '', 'g')) AS license,
            REGEXP_REPLACE(COALESCE(dni, ''), '[^0-9]', '', 'g') AS dni,
            RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 9) AS phone
     FROM module_miauto_solicitud
     WHERE status = 'aprobado' AND deleted_at IS NULL`
  );
  const index = { plate: new Map(), license: new Map(), dni: new Map(), phone: new Map() };
  for (const row of result.rows) {
    if (row.plate) indexPush(index.plate, row.plate, row.id);
    if (row.license) indexPush(index.license, row.license, row.id);
    if (row.dni) indexPush(index.dni, row.dni, row.id);
    if (row.phone) indexPush(index.phone, row.phone, row.id);
  }
  return index;
}

export function resolveSolicitud(record, solicitudIndex) {
  const identifier = normalize(record.identifier).replace(/\s/g, '');
  const identifierMatches = solicitudIndex[record.idType].get(identifier) || [];
  if (identifierMatches.length === 1) {
    return { id: identifierMatches[0], matches: 1, matchedBy: record.idType };
  }
  if (identifierMatches.length > 1) {
    return { id: null, matches: identifierMatches.length };
  }
  if (record.idType === 'license') {
    const dniMatches = solicitudIndex.dni.get(digits(record.identifier)) || [];
    if (dniMatches.length === 1) {
      return { id: dniMatches[0], matches: 1, matchedBy: 'dni' };
    }
    if (dniMatches.length > 1) return { id: null, matches: dniMatches.length };
  }
  if (!record.phone) return { id: null, matches: 0 };
  const phoneMatches = solicitudIndex.phone.get(digits(record.phone).slice(-9)) || [];
  return phoneMatches.length === 1
    ? { id: phoneMatches[0], matches: 1, matchedBy: 'phone' }
    : { id: null, matches: phoneMatches.length };
}

function resolutionKey(record) {
  return `${record.idType}:${record.identifier}:${record.phone || ''}`;
}

function resolveCached(record, solicitudIndex, cache) {
  const key = resolutionKey(record);
  if (!cache.has(key)) cache.set(key, resolveSolicitud(record, solicitudIndex));
  return { key, resolution: cache.get(key) };
}

function resolveInitialPartialScope(drivers, solicitudIndex, cache) {
  const solicitudIds = new Set();
  const unresolved = [];
  for (const driver of drivers) {
    const { resolution } = resolveCached(driver, solicitudIndex, cache);
    if (resolution.id) solicitudIds.add(resolution.id);
    else unresolved.push(driver);
  }
  if (unresolved.length) {
    throw new Error(
      `Importacion cancelada: ${unresolved.length} conductores de Inicial Parcial no se pudieron vincular`
    );
  }
  return [...solicitudIds];
}

function stableSourceKey(record, solicitudId) {
  return `excel:${record.sheet}:${solicitudId}:${record.concept}:${record.dueDate}`;
}

function canonicalConcept(concept) {
  return CONCEPT_ALIASES[STR_GPS_CONCEPT].includes(concept) ? STR_GPS_CONCEPT : concept;
}

function indexPush(index, key, value) {
  const values = index.get(key) || [];
  values.push(value);
  index.set(key, values);
}

async function loadExpenseSnapshot(client, resolved) {
  const solicitudIds = [...new Set(resolved.map((item) => item.solicitudId))];
  if (!solicitudIds.length) return { source: new Map(), due: new Map(), slot: new Map() };
  const concepts = [...new Set(resolved.flatMap(({ record }) => CONCEPT_ALIASES[record.concept] || [record.concept]))];
  const result = await client.query(
    `SELECT og.id, og.solicitud_id, og.ciclo_id, og.tipo, og.numero_cuota,
            og.periodo_anio, og.due_date::text, og.amount_due, og.paid_amount,
            og.status, og.moneda, og.source_key,
            COALESCE(SUM(pa.monto_aplicado) FILTER (
              WHERE pa.reversed_at IS NULL AND pa.origen = 'import'
            ), 0) AS imported,
            COALESCE(SUM(pa.monto_aplicado) FILTER (
              WHERE pa.reversed_at IS NULL AND pa.origen <> 'import'
            ), 0) AS operational
     FROM module_miauto_otros_gastos og
     LEFT JOIN module_miauto_gasto_pago_aplicacion pa ON pa.otros_gastos_id = og.id
     WHERE og.solicitud_id = ANY($1::uuid[]) AND og.tipo = ANY($2::text[])
       AND og.deleted_at IS NULL
     GROUP BY og.id`,
    [solicitudIds, concepts]
  );
  const snapshot = { source: new Map(), due: new Map(), slot: new Map() };
  for (const row of result.rows) {
    const concept = canonicalConcept(row.tipo);
    if (row.source_key) indexPush(snapshot.source, `${row.solicitud_id}:${row.source_key}`, row);
    indexPush(snapshot.due, `${row.solicitud_id}:${concept}:${String(row.due_date).slice(0, 10)}`, row);
    if (row.periodo_anio != null && row.numero_cuota != null) {
      indexPush(snapshot.slot, `${row.solicitud_id}:${concept}:${row.periodo_anio}:${row.numero_cuota}`, row);
    }
  }
  return snapshot;
}

function findSnapshotMatches(snapshot, record, solicitudId) {
  const sourceMatches = snapshot.source.get(`${solicitudId}:${stableSourceKey(record, solicitudId)}`);
  if (sourceMatches?.length) return sourceMatches;
  const concept = canonicalConcept(record.concept);
  const slotMatches = snapshot.slot.get(`${solicitudId}:${concept}:${record.periodYear}:${record.number}`);
  if (slotMatches?.length) return slotMatches;
  return snapshot.due.get(`${solicitudId}:${concept}:${record.dueDate}`) || [];
}

async function findOrCreateCycle(client, record, solicitudId, fileHash) {
  const aliases = CONCEPT_ALIASES[record.concept] || [record.concept];
  const found = await client.query(
    `SELECT id FROM module_miauto_gasto_ciclo
     WHERE solicitud_id = $1::uuid AND concepto = ANY($2::text[]) AND periodo_anio = $3
       AND estado <> 'cancelado'
     ORDER BY CASE origen WHEN 'excel_import' THEN 0 WHEN 'legacy' THEN 1 ELSE 2 END,
              ciclo_numero, created_at
     LIMIT 1`,
    [solicitudId, aliases, record.periodYear]
  );
  if (found.rows[0]) return found.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO module_miauto_gasto_ciclo
       (solicitud_id, concepto, periodo_anio, ciclo_numero, moneda, monto_total,
        fecha_inicio, fecha_fin, numero_cuotas, estado, origen, config_snapshot)
     SELECT $1::uuid, $2::varchar, $3::smallint, COALESCE(MAX(ciclo_numero), 0) + 1, $4::varchar, 0,
            $5::date, $5::date, $6, 'activo', 'excel_import', $7::jsonb
     FROM module_miauto_gasto_ciclo
     WHERE solicitud_id = $1::uuid AND concepto = $2::varchar AND periodo_anio = $3::smallint
     RETURNING id`,
    [solicitudId, record.concept, record.periodYear, record.currency, record.dueDate,
      record.total, JSON.stringify({ last_import_file_hash: fileHash, source_sheet: record.sheet })]
  );
  return inserted.rows[0].id;
}

async function reconcileRecord(client, record, solicitudId, fileHash, apply, matches) {
  if (matches.length > 1) return { action: 'conflict', reason: 'duplicate_expenses', matches: matches.length };
  const existing = matches[0] || null;
  if (!existing) {
    if (!apply) return { action: 'insert' };
    const cycleId = await findOrCreateCycle(client, record, solicitudId, fileHash);
    const sourceKey = stableSourceKey(record, solicitudId);
    const inserted = await client.query(
      `INSERT INTO module_miauto_otros_gastos
         (solicitud_id, ciclo_id, tipo, week_index, numero_cuota, total_cuotas,
          periodo_anio, due_date, amount_due, paid_amount, status, moneda, source_key, origen)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7::date, $8, 0, $9, $10, $11, 'excel_import')
       RETURNING id`,
      [solicitudId, cycleId, record.concept, record.number, record.total, record.periodYear,
        record.dueDate, record.amount, record.status, record.currency, sourceKey]
    );
    const created = inserted.rows[0];
    if (record.status === 'paid') {
      await upsertImportPayment(client, created.id, solicitudId, sourceKey, record, record.amount, fileHash);
      await client.query(
        `UPDATE module_miauto_otros_gastos SET paid_amount = amount_due, status = 'paid' WHERE id = $1::uuid`,
        [created.id]
      );
    }
    return { action: 'insert', cycleId };
  }

  const cycleId = existing.ciclo_id;
  const payments = {
    imported: round2(existing.imported),
    operational: round2(existing.operational),
  };
  const { protectedPaid, desiredImport, paidAmount, status } = calculateReconciliation({
    existing,
    payments,
    record,
  });
  const sourceKey = stableSourceKey(record, solicitudId);
  const changed = round2(existing.amount_due) !== record.amount
    || round2(existing.paid_amount) !== paidAmount
    || existing.status !== status
    || existing.moneda !== record.currency
    || String(existing.due_date).slice(0, 10) !== record.dueDate
    || Number(existing.numero_cuota) !== record.number
    || Number(existing.periodo_anio) !== record.periodYear
    || existing.source_key !== sourceKey
    || existing.tipo !== record.concept
    || round2(payments.imported) !== desiredImport;
  if (!changed) return { action: 'unchanged', cycleId };
  if (!apply) {
    return {
      action: 'update',
      cycleId,
      before: { amount: round2(existing.amount_due), paid: round2(existing.paid_amount), status: existing.status },
      after: { amount: record.amount, paid: paidAmount, status },
      protectedPaid,
    };
  }

  await client.query(
    `UPDATE module_miauto_otros_gastos
     SET ciclo_id = $1::uuid, tipo = $2, week_index = $3, numero_cuota = $3,
         total_cuotas = $4, periodo_anio = $5, due_date = $6::date,
         amount_due = $7, paid_amount = $8, status = $9, moneda = $10,
         source_key = $11, origen = 'excel_import',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $12::uuid`,
    [cycleId, record.concept, record.number, record.total, record.periodYear, record.dueDate,
      record.amount, paidAmount, status, record.currency, sourceKey, existing.id]
  );
  await reconcileImportPayments(client, existing.id, solicitudId, sourceKey, record, desiredImport, fileHash);
  return { action: 'update', cycleId };
}

async function upsertImportPayment(client, expenseId, solicitudId, sourceKey, record, amount, fileHash) {
  await client.query(
    `INSERT INTO module_miauto_gasto_pago_aplicacion
       (solicitud_id, otros_gastos_id, origen, source_key, monto_original,
        moneda_original, tipo_cambio, monto_aplicado, moneda_aplicada, metadata)
     VALUES ($1::uuid, $2::uuid, 'import', $3, $4, $5, 1, $4, $5, $6::jsonb)
     ON CONFLICT (source_key) DO UPDATE SET
       monto_original = EXCLUDED.monto_original,
       moneda_original = EXCLUDED.moneda_original,
       tipo_cambio = EXCLUDED.tipo_cambio,
       monto_aplicado = EXCLUDED.monto_aplicado,
       moneda_aplicada = EXCLUDED.moneda_aplicada,
       reversed_at = NULL,
       reversed_by = NULL,
       reversal_reason = NULL,
       metadata = module_miauto_gasto_pago_aplicacion.metadata || EXCLUDED.metadata`,
    [solicitudId, expenseId, `${sourceKey}:payment`, amount, record.currency,
      JSON.stringify({ source_cell: record.sourceCell, source_file_hash: fileHash })]
  );
}

async function reconcileImportPayments(client, expenseId, solicitudId, sourceKey, record, amount, fileHash) {
  const existing = await client.query(
    `SELECT id FROM module_miauto_gasto_pago_aplicacion
     WHERE otros_gastos_id = $1::uuid AND origen = 'import'
     ORDER BY (source_key = $2) DESC, (reversed_at IS NULL) DESC, applied_at, id
     FOR UPDATE`,
    [expenseId, `${sourceKey}:payment`]
  );
  if (amount <= 0.005) {
    await client.query(
      `UPDATE module_miauto_gasto_pago_aplicacion
       SET reversed_at = CURRENT_TIMESTAMP, reversal_reason = 'Excel actualizado: cuota no marcada como pagada'
       WHERE otros_gastos_id = $1::uuid AND origen = 'import' AND reversed_at IS NULL`,
      [expenseId]
    );
    return;
  }
  const [primary, ...duplicates] = existing.rows;
  if (!primary) {
    await upsertImportPayment(client, expenseId, solicitudId, sourceKey, record, amount, fileHash);
    return;
  }
  await client.query(
    `UPDATE module_miauto_gasto_pago_aplicacion
     SET source_key = $1, monto_original = $2, moneda_original = $3, tipo_cambio = 1,
         monto_aplicado = $2, moneda_aplicada = $3,
         reversed_at = NULL, reversed_by = NULL, reversal_reason = NULL,
         metadata = metadata || $4::jsonb
     WHERE id = $5::uuid`,
    [`${sourceKey}:payment`, amount, record.currency,
      JSON.stringify({ source_cell: record.sourceCell, source_file_hash: fileHash }), primary.id]
  );
  if (duplicates.length) {
    await client.query(
      `UPDATE module_miauto_gasto_pago_aplicacion
       SET reversed_at = CURRENT_TIMESTAMP, reversal_reason = 'Importacion consolidada'
       WHERE id = ANY($1::uuid[]) AND reversed_at IS NULL`,
      [duplicates.map((item) => item.id)]
    );
  }
}

async function updateTouchedCycles(client, cycleIds, fileHash) {
  if (!cycleIds.length) return;
  await client.query(
    `UPDATE module_miauto_gasto_ciclo c
     SET monto_total = totals.monto_total,
         fecha_inicio = totals.fecha_inicio,
         fecha_fin = totals.fecha_fin,
         numero_cuotas = totals.numero_cuotas,
         estado = CASE WHEN totals.pendientes = 0 THEN 'completado' ELSE 'activo' END,
         config_snapshot = config_snapshot || jsonb_build_object('last_import_file_hash', $2::text),
         updated_at = CURRENT_TIMESTAMP
     FROM (
       SELECT ciclo_id, SUM(amount_due) monto_total, MIN(due_date) fecha_inicio,
              MAX(due_date) fecha_fin, COUNT(*)::int numero_cuotas,
              COUNT(*) FILTER (WHERE paid_amount < amount_due - 0.005) pendientes
       FROM module_miauto_otros_gastos
       WHERE ciclo_id = ANY($1::uuid[]) AND deleted_at IS NULL
       GROUP BY ciclo_id
     ) totals
     WHERE c.id = totals.ciclo_id`,
    [cycleIds, fileHash]
  );
}

async function reconcileInitialPartialScope(client, allowedSolicitudIds, apply) {
  if (!allowedSolicitudIds.length) {
    throw new Error('Importacion cancelada: no se resolvio ningun conductor de Inicial Parcial');
  }
  const result = await client.query(
    `SELECT og.id, og.solicitud_id, og.ciclo_id, og.paid_amount,
            COALESCE(SUM(pa.monto_aplicado) FILTER (
              WHERE pa.reversed_at IS NULL
            ), 0) AS active_payments
     FROM module_miauto_otros_gastos og
     LEFT JOIN module_miauto_gasto_pago_aplicacion pa ON pa.otros_gastos_id = og.id
     WHERE og.tipo = 'inicial_parcial' AND og.deleted_at IS NULL
       AND NOT (og.solicitud_id = ANY($1::uuid[]))
     GROUP BY og.id
     ORDER BY og.solicitud_id, og.due_date, og.id`,
    [allowedSolicitudIds]
  );
  const protectedRows = result.rows.filter((row) => (
    round2(row.paid_amount) > 0.005 || round2(row.active_payments) > 0.005
  ));
  if (protectedRows.length) {
    throw new Error(
      `Importacion cancelada: ${protectedRows.length} cuotas Inicial Parcial fuera del Excel tienen pagos`
    );
  }
  const expenseIds = result.rows.map((row) => row.id);
  const solicitudIds = [...new Set(result.rows.map((row) => row.solicitud_id))];
  const cycleIds = [...new Set(result.rows.map((row) => row.ciclo_id).filter(Boolean))];
  if (apply && expenseIds.length) {
    await client.query(
      'SELECT id FROM module_miauto_otros_gastos WHERE id = ANY($1::uuid[]) FOR UPDATE',
      [expenseIds]
    );
    await client.query(
      `UPDATE module_miauto_otros_gastos
       SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1::uuid[])`,
      [expenseIds]
    );
    if (cycleIds.length) {
      await client.query(
        `UPDATE module_miauto_gasto_ciclo
         SET estado = 'cancelado', updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1::uuid[])`,
        [cycleIds]
      );
    }
  }
  if (apply) {
    await client.query(
      `UPDATE module_miauto_solicitud
       SET inicial_parcial_activa = (id = ANY($1::uuid[])), updated_at = CURRENT_TIMESTAMP
       WHERE status = 'aprobado' AND deleted_at IS NULL
         AND inicial_parcial_activa IS DISTINCT FROM (id = ANY($1::uuid[]))`,
      [allowedSolicitudIds]
    );
  }
  return {
    allowedDrivers: allowedSolicitudIds.length,
    removedDrivers: solicitudIds.length,
    removedExpenses: expenseIds.length,
  };
}

function registerResult(summary, item, result, apply, touchedCycles) {
  const sheetSummary = summary.bySheet[item.record.sheet]
    || { insert: 0, update: 0, unchanged: 0, conflict: 0 };
  sheetSummary[result.action] += 1;
  summary.bySheet[item.record.sheet] = sheetSummary;
  summary[SUMMARY_FIELD_BY_ACTION[result.action]] += 1;
  if (result.before && summary.changeSamples.length < 50) {
    summary.changeSamples.push({
      sheet: item.record.sheet,
      driverName: item.record.driverName,
      dueDate: item.record.dueDate,
      ...result,
    });
  }
  if (apply && result.cycleId) touchedCycles.add(result.cycleId);
}

async function main() {
  const fileArg = process.argv.find((arg) => arg.toLowerCase().endsWith('.xlsx'));
  const apply = process.argv.includes('--apply');
  if (!fileArg) throw new Error('Indica la ruta del archivo .xlsx');
  const optionValue = (name, envName) => {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
      || process.env[envName];
  };
  const fallbackYear = Number(optionValue('year', 'MIAUTO_GASTOS_IMPORT_YEAR'));
  const gpsMonthlyAmount = money(optionValue('gps-amount', 'MIAUTO_GPS_MONTHLY_AMOUNT'));
  const filePath = path.resolve(fileArg);
  const fileHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const workbook = XLSX.readFile(filePath);
  const records = buildRecords(workbook, limaTodayYmd(), { fallbackYear, gpsMonthlyAmount });
  const summary = {
    records: records.length, matched: 0, inserted: 0, updated: 0, unchanged: 0,
    conflicts: 0, notFound: 0, ambiguous: 0, unresolved: [], bySheet: {}, changeSamples: [],
    initialPartialScope: null,
  };
  const solicitudIndex = await loadSolicitudIndex();
  const resolutionCache = new Map();
  const unresolvedKeys = new Set();
  const resolved = [];
  const initialPartialSolicitudIds = resolveInitialPartialScope(
    buildInitialPartialDrivers(workbook), solicitudIndex, resolutionCache
  );

  for (const record of records) {
    const { key: cacheKey, resolution } = resolveCached(record, solicitudIndex, resolutionCache);
    if (!resolution.id) {
      if (resolution.matches > 1) summary.ambiguous += 1;
      else summary.notFound += 1;
      if (!unresolvedKeys.has(cacheKey)) {
        unresolvedKeys.add(cacheKey);
        summary.unresolved.push({
          sheet: record.sheet, driverName: record.driverName, identifier: record.identifier,
          phone: record.phone, reason: resolution.matches > 1 ? 'ambiguous' : 'not_found',
        });
      }
      continue;
    }
    summary.matched += 1;
    resolved.push({ record, solicitudId: resolution.id });
  }

  const client = await getClient();
  const touchedCycles = new Set();
  try {
    if (apply) await client.query('BEGIN');
    const expenseSnapshot = await loadExpenseSnapshot(client, resolved);
    if (apply) {
      const expenseIds = [...new Set(resolved.flatMap(({ record, solicitudId }) =>
        findSnapshotMatches(expenseSnapshot, record, solicitudId).map((row) => row.id)))];
      if (expenseIds.length) {
        await client.query(
          `SELECT id FROM module_miauto_otros_gastos WHERE id = ANY($1::uuid[]) FOR UPDATE`,
          [expenseIds]
        );
      }
    }
    for (const item of resolved) {
      const matches = findSnapshotMatches(expenseSnapshot, item.record, item.solicitudId);
      const result = await reconcileRecord(
        client, item.record, item.solicitudId, fileHash, apply, matches
      );
      registerResult(summary, item, result, apply, touchedCycles);
    }
    summary.initialPartialScope = await reconcileInitialPartialScope(
      client, initialPartialSolicitudIds, apply
    );
    if (apply) {
      if (summary.conflicts) throw new Error(`Importacion cancelada: ${summary.conflicts} cuotas tienen duplicados`);
      await updateTouchedCycles(client, [...touchedCycles], fileHash);
      await client.query('COMMIT');
    }
  } catch (error) {
    if (apply) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', file: filePath, fileHash, summary }, null, 2));
  if (!apply) console.log('Sin escrituras. Usa --apply despues de revisar el resumen.');
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
