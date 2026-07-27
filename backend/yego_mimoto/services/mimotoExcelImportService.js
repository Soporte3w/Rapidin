import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { getClient } from '../../config/database.js';
import { parseMimotoWorkbook } from './mimotoExcelImportParser.js';

const IMPORT_TYPE = 'mimoto_weekly_payments_excel_v1';
const CRONOGRAMA_IDS = {
  'Cronograma 1': 'c0780000-0000-4000-8000-000000000001',
  'Cronograma 2': 'c0780000-0000-4000-8000-000000000002',
  'Cronograma 3': 'c0610000-0000-4000-8000-000000000002',
  'Cronograma 4': 'c0610000-0000-4000-8000-000000000001',
};

const GENERAL_VEHICLE_IDS = new Map([
  ['SPORT 100 ELS', '78010000-0000-4000-8000-000000000005'],
  ['RAIDER 125 ACC', '78010000-0000-4000-8000-000000000011'],
  ['RAIDER 125 RACING', '78010000-0000-4000-8000-000000000012'],
]);

function cleanIdentifier(value) {
  const text = String(value || '').trim();
  return text && text !== '-' ? text : null;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  const valueDigits = digits(value);
  if (valueDigits.length === 10 && valueDigits.startsWith('3')) return `57${valueDigits}`;
  if (valueDigits.length === 12 && valueDigits.startsWith('573')) return valueDigits;
  return null;
}

function normalizeCity(value) {
  return String(value || 'Colombia').trim().toLocaleLowerCase('es-CO').replace(/(^|\s)\p{L}/gu, (letter) => letter.toUpperCase());
}

function fleetName(city, parkId) {
  return `Yego Mi Moto - ${normalizeCity(city)} (${parkId.slice(-6)})`;
}

function vehicleIdFor(driver) {
  if (driver.schedule === 'Cronograma 1') return GENERAL_VEHICLE_IDS.get(driver.vehicle.toUpperCase()) || null;
  if (driver.schedule === 'Cronograma 2') return '78020000-0000-4000-8000-000000000003';
  const lowInitial = Number(driver.initialAmount || 0) < 800000;
  if (driver.schedule === 'Cronograma 3') {
    return lowInitial
      ? '61020000-0000-4000-8000-000000000002'
      : '61020000-0000-4000-8000-000000000001';
  }
  if (driver.schedule === 'Cronograma 4') {
    return lowInitial
      ? '61010000-0000-4000-8000-000000000002'
      : '61010000-0000-4000-8000-000000000001';
  }
  return null;
}

function bogotaToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function documentFromFleet(candidate) {
  return digits(candidate?.license_number) || null;
}

async function findDriverCandidate(client, source) {
  const sourceDriverId = cleanIdentifier(source.driverId);
  const sourceParkId = cleanIdentifier(source.parkId);
  if (sourceDriverId && sourceParkId) {
    const exact = await client.query(
      `SELECT driver_id, park_id, first_name, last_name, phone, license_number, work_status, updated_at
       FROM drivers WHERE driver_id=$1 AND park_id=$2`,
      [sourceDriverId, sourceParkId]
    );
    if (exact.rows.length === 1) return { candidate: exact.rows[0], resolution: 'driver_id_fleet' };
  }

  const documentNumber = source.identity.documentNumber;
  if (!documentNumber) return { candidate: null, resolution: null, error: 'Documento colombiano ausente' };
  const byDocument = await client.query(
    `SELECT driver_id, park_id, first_name, last_name, phone, license_number, work_status, updated_at
     FROM drivers
     WHERE regexp_replace(COALESCE(license_number,''), '[^0-9]', '', 'g')=$1
     ORDER BY (work_status='working') DESC, updated_at DESC NULLS LAST`,
    [documentNumber]
  );
  if (byDocument.rows.length === 0) return { candidate: null, resolution: null, error: 'Conductor no encontrado en Fleet' };
  return {
    candidate: byDocument.rows[0],
    resolution: byDocument.rows.length === 1 ? 'document_unique' : 'document_latest_active',
    warning: byDocument.rows.length > 1 ? `Se eligió el registro Fleet vigente entre ${byDocument.rows.length} coincidencias` : null,
  };
}

async function verifyCatalog(client) {
  const cronogramaIds = Object.values(CRONOGRAMA_IDS);
  const vehicleIds = [
    ...GENERAL_VEHICLE_IDS.values(),
    '78020000-0000-4000-8000-000000000003',
    '61020000-0000-4000-8000-000000000001',
    '61020000-0000-4000-8000-000000000002',
    '61010000-0000-4000-8000-000000000001',
    '61010000-0000-4000-8000-000000000002',
  ];
  const cronogramas = await client.query(
    'SELECT id::text FROM module_mimoto_cronograma WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL',
    [cronogramaIds]
  );
  const vehicles = await client.query(
    'SELECT id::text FROM module_mimoto_cronograma_vehiculo WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL',
    [vehicleIds]
  );
  return {
    cronogramas: new Set(cronogramas.rows.map((row) => row.id)),
    vehicles: new Set(vehicles.rows.map((row) => row.id)),
  };
}

async function buildPlan(client, parsed) {
  const catalog = await verifyCatalog(client);
  const errors = [];
  const warnings = [];
  const drivers = [];
  const fleetCities = new Map();

  for (const source of parsed.drivers) {
    const rowWarnings = [...source.warnings];
    const resolution = await findDriverCandidate(client, source);
    if (resolution.warning) rowWarnings.push({ type: 'fleet_resolution', message: resolution.warning });
    if (!resolution.candidate) {
      errors.push({ sourceRow: source.sourceRow, driver: source.fullName, error: resolution.error });
      continue;
    }

    const candidate = resolution.candidate;
    const phone = source.identity.phone || normalizePhone(candidate.phone);
    const documentNumber = source.identity.documentNumber || documentFromFleet(candidate);
    const parkId = candidate.park_id;
    const cronogramaId = CRONOGRAMA_IDS[source.schedule];
    const vehicleId = vehicleIdFor(source);
    if (!phone) errors.push({ sourceRow: source.sourceRow, driver: source.fullName, error: 'Teléfono colombiano inválido o ausente' });
    if (!documentNumber) errors.push({ sourceRow: source.sourceRow, driver: source.fullName, error: 'Documento colombiano inválido o ausente' });
    if (!catalog.cronogramas.has(cronogramaId)) errors.push({ sourceRow: source.sourceRow, driver: source.fullName, error: `Cronograma no instalado: ${source.schedule}` });
    if (!vehicleId || !catalog.vehicles.has(vehicleId)) errors.push({ sourceRow: source.sourceRow, driver: source.fullName, error: `Moto no mapeada: ${source.vehicle}` });

    const previousCity = fleetCities.get(parkId);
    const city = normalizeCity(source.city);
    if (previousCity && previousCity !== city) {
      rowWarnings.push({ type: 'fleet_city_conflict', message: `La flota también aparece como ${previousCity}` });
    } else {
      fleetCities.set(parkId, city);
    }

    const importableQuotas = source.quotas.filter((quota) => !quota.skipReason);
    const skippedQuotas = source.quotas.filter((quota) => quota.skipReason);
    for (const quota of skippedQuotas) {
      rowWarnings.push({ type: 'quota_skipped', quota: quota.number, reason: quota.skipReason, date: quota.dateRaw, amount: quota.amountRaw });
    }
    if (importableQuotas.length === 0) {
      errors.push({ sourceRow: source.sourceRow, driver: source.fullName, error: 'No tiene cuotas importables' });
    }

    drivers.push({
      ...source,
      phone,
      documentNumber,
      driverId: candidate.driver_id,
      parkId,
      licenseNumber: candidate.license_number || `COL${documentNumber}`,
      cronogramaId,
      vehicleId,
      resolution: resolution.resolution,
      quotas: importableQuotas,
      skippedQuotas,
      warnings: rowWarnings,
    });
    warnings.push(...rowWarnings.map((warning) => ({ sourceRow: source.sourceRow, driver: source.fullName, ...warning })));
  }

  const duplicateKeys = await client.query(
    `SELECT f.park_id, s.driver_id_fleet
     FROM module_mimoto_solicitud s
     JOIN module_mimoto_fleet f ON f.id=s.fleet_id
     WHERE s.deleted_at IS NULL AND s.status NOT IN ('rechazado','retirado','cancelado')`
  );
  const existing = new Set(duplicateKeys.rows.map((row) => `${row.park_id}:${row.driver_id_fleet}`));
  for (const driver of drivers) {
    if (existing.has(`${driver.parkId}:${driver.driverId}`)) {
      errors.push({ sourceRow: driver.sourceRow, driver: driver.fullName, error: 'Ya existe una solicitud Mi Moto activa para conductor y flota' });
    }
  }

  return {
    parsed,
    drivers,
    fleets: [...fleetCities.entries()].map(([parkId, city]) => ({ parkId, city, name: fleetName(city, parkId) })),
    errors,
    warnings,
    summary: {
      sourceDrivers: parsed.drivers.length,
      importableDrivers: drivers.length,
      fleets: fleetCities.size,
      sourceQuotas: parsed.drivers.reduce((sum, driver) => sum + driver.quotas.length, 0),
      importableQuotas: drivers.reduce((sum, driver) => sum + driver.quotas.length, 0),
      skippedQuotas: drivers.reduce((sum, driver) => sum + driver.skippedQuotas.length, 0),
      paidQuotas: drivers.reduce((sum, driver) => sum + driver.quotas.filter((quota) => quota.validation === 'paid').length, 0),
      unpaidQuotas: drivers.reduce((sum, driver) => sum + driver.quotas.filter((quota) => quota.validation !== 'paid').length, 0),
      errors: errors.length,
      warnings: warnings.length,
    },
  };
}

async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function assertFileNotImported(client, fileHash) {
  const result = await client.query(
    `SELECT id FROM module_mimoto_import_log
     WHERE file_hash=$1 AND import_type=$2 AND status='completed' AND dry_run=FALSE`,
    [fileHash, IMPORT_TYPE]
  );
  if (result.rows[0]) {
    throw new Error(`Este archivo ya fue importado correctamente (${result.rows[0].id})`);
  }
}

async function startImportLog(client, { fileName, fileHash, fileSize, totalRows, actorId }) {
  const existing = await client.query(
    'SELECT id, status, dry_run FROM module_mimoto_import_log WHERE file_hash=$1 AND import_type=$2 FOR UPDATE',
    [fileHash, IMPORT_TYPE]
  );
  if (existing.rows[0]?.status === 'completed' && existing.rows[0]?.dry_run === false) {
    throw new Error('Este archivo ya fue importado correctamente');
  }
  if (existing.rows[0]) {
    const result = await client.query(
      `UPDATE module_mimoto_import_log
       SET file_name=$1, file_size_bytes=$2, status='importing', dry_run=FALSE,
           total_rows=$3, success_rows=0, skipped_rows=0, error_rows=0,
           errors='[]'::jsonb, imported_by=$4, completed_at=NULL
       WHERE id=$5 RETURNING id`,
      [fileName, fileSize, totalRows, actorId, existing.rows[0].id]
    );
    return result.rows[0].id;
  }
  const result = await client.query(
    `INSERT INTO module_mimoto_import_log
       (file_name,file_hash,file_size_bytes,import_type,status,dry_run,total_rows,imported_by)
     VALUES ($1,$2,$3,$4,'importing',FALSE,$5,$6) RETURNING id`,
    [fileName, fileHash, fileSize, IMPORT_TYPE, totalRows, actorId]
  );
  return result.rows[0].id;
}

async function upsertFleet(client, fleet, actorId) {
  const result = await client.query(
    `INSERT INTO module_mimoto_fleet
       (park_id,name,country,timezone,currency,active,updated_by)
     VALUES ($1,$2,'CO','America/Bogota','COP',TRUE,$3)
     ON CONFLICT (park_id) DO UPDATE SET deleted_at=NULL
     RETURNING id`,
    [fleet.parkId, fleet.name, actorId]
  );
  return result.rows[0].id;
}

async function loadImportCronogramaSnapshot(client, cronogramaId, vehicleId) {
  const result = await client.query(
    `SELECT jsonb_build_object(
       'cronograma_id', c.id,
       'name', c.name,
       'tasa_interes_mora', c.tasa_interes_mora,
       'modo_evaluacion', c.modo_evaluacion,
       'bono_tiempo_activo', c.bono_tiempo_activo,
       'cuotas_otros_gastos', c.cuotas_otros_gastos,
       'requisitos_vehiculo', c.requisitos_vehiculo,
       'vehicle', to_jsonb(v),
       'rules', COALESCE((
         SELECT jsonb_agg(to_jsonb(r) ORDER BY r.orden)
         FROM module_mimoto_cronograma_rule r
         WHERE r.cronograma_id=c.id
       ), '[]'::jsonb),
       'captured_at', CURRENT_TIMESTAMP
     ) AS snapshot
     FROM module_mimoto_cronograma c
     JOIN module_mimoto_cronograma_vehiculo v
       ON v.id=$2 AND v.cronograma_id=c.id
     WHERE c.id=$1 AND c.deleted_at IS NULL AND v.deleted_at IS NULL`,
    [cronogramaId, vehicleId]
  );
  if (!result.rows[0]?.snapshot) throw new Error('El cronograma de la importación no está disponible');
  return result.rows[0].snapshot;
}

async function insertDriver(client, driver, fleetId, importId, actorId, sourceFile) {
  const firstDueDate = driver.quotas.map((quota) => quota.date).sort()[0] || null;
  const cronogramaSnapshot = await loadImportCronogramaSnapshot(client, driver.cronogramaId, driver.vehicleId);
  const result = await client.query(
    `INSERT INTO module_mimoto_solicitud
       (fleet_id,country,document_type,document_number,first_name,last_name,phone,
        license_number,driver_id_fleet,cronograma_id,cronograma_vehiculo_id,
        cronograma_snapshot,fecha_inicio_cobro_semanal,fecha_entrega_vehiculo,status,pago_estado,
        inicial_acordada,inicial_moneda,import_context,source_import_id,observations,updated_by)
     VALUES ($1,'CO',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,'activo','pendiente',
             $14,'COP',$15::jsonb,$16,$17,$18)
     RETURNING id`,
    [fleetId, driver.identity.documentType, driver.documentNumber, driver.firstName, driver.lastName,
      driver.phone, driver.licenseNumber, driver.driverId, driver.cronogramaId, driver.vehicleId,
      JSON.stringify(cronogramaSnapshot), firstDueDate, driver.deliveryDate, driver.initialAmount,
      JSON.stringify({
        source: 'excel', file: sourceFile, sheet: driver.sourceSheet, row: driver.sourceRow,
        full_name_raw: driver.fullName, identity_phone_raw: driver.identity.raw,
        schedule_raw: driver.schedule, vehicle_raw: driver.vehicle, fleet_resolution: driver.resolution,
      }),
      importId, `Importado desde ${sourceFile}, fila ${driver.sourceRow}`, actorId]
  );
  return { solicitudId: result.rows[0].id, cronogramaSnapshot };
}

async function insertQuotas(client, solicitudId, quotas, importId, actorId, sourceFile, usesConnectedHours, cronogramaSnapshot) {
  const today = bogotaToday();
  const rows = quotas.map((quota) => {
    const firstWeekCovered = Number(quota.number) === 1;
    const paid = firstWeekCovered || quota.validation === 'paid';
    const paidAmount = paid ? quota.amount : 0;
    return {
      due_date: quota.date,
      week_number: quota.number,
      viajes: quota.trips,
      horas_conectadas: usesConnectedHours ? quota.observedHours : null,
      amount: quota.amount,
      paid_amount: paidAmount,
      status: paid ? 'paid' : quota.date < today ? 'overdue' : 'pending',
      mora_calculated_through: quota.date < today ? today : quota.date,
      generation_context: {
        source: 'excel', file: sourceFile, source_date: quota.dateRaw,
        trips_hours_raw: quota.tripHoursRaw, observed_hours: quota.observedHours,
        amount_raw: quota.amountRaw, payment_source_raw: quota.sourceRaw,
        evidence_file_raw: quota.fileRaw, validation_raw: quota.validationRaw,
        first_week_covered_by_rule: firstWeekCovered,
      },
      payment_chunks: paid
        ? [{ source: 'excel_import', amount: paidAmount, applied_to_capital: paidAmount }]
        : [],
    };
  });
  await client.query(
    `INSERT INTO module_mimoto_cuota_semanal
       (solicitud_id,week_start_date,due_date,week_number,viajes,horas_conectadas,cuota_semanal,amount_due,
       moneda,capital_paid,paid_amount,status,montos_fuente,generation_context,payment_chunks,
        source_import_id,tasa_interes_mora_snapshot,rule_snapshot,mora_calculated_through,updated_by)
     SELECT $1, x.due_date::date, x.due_date::date, x.week_number, x.viajes, x.horas_conectadas,
            x.amount, x.amount, 'COP', x.paid_amount, x.paid_amount, x.status,
            'excel', x.generation_context, x.payment_chunks, $3, $4::numeric,
            jsonb_build_object('source','excel_import'), x.mora_calculated_through::date, $5
     FROM jsonb_to_recordset($2::jsonb) AS x(
       due_date text, week_number integer, viajes integer, horas_conectadas numeric, amount numeric,
       paid_amount numeric, status text, mora_calculated_through text,
       generation_context jsonb, payment_chunks jsonb
     )`,
    [solicitudId, JSON.stringify(rows), importId,
      Number(cronogramaSnapshot.tasa_interes_mora) || 0, actorId]
  );
}

async function applyPlan(client, plan, fileMeta, actorId) {
  const totalRows = plan.summary.importableDrivers + plan.summary.importableQuotas;
  const importId = await startImportLog(client, { ...fileMeta, totalRows, actorId });
  const fleetIds = new Map();
  for (const fleet of plan.fleets) fleetIds.set(fleet.parkId, await upsertFleet(client, fleet, actorId));

  for (const driver of plan.drivers) {
    driver.sourceSheet = plan.parsed.sheetName;
    const { solicitudId, cronogramaSnapshot } = await insertDriver(
      client,
      driver,
      fleetIds.get(driver.parkId),
      importId,
      actorId,
      fileMeta.fileName
    );
    await insertQuotas(
      client,
      solicitudId,
      driver.quotas,
      importId,
      actorId,
      fileMeta.fileName,
      cronogramaSnapshot.modo_evaluacion === 'viajes_horas',
      cronogramaSnapshot
    );
  }

  await client.query(
    `UPDATE module_mimoto_import_log
     SET status='completed', success_rows=$1, skipped_rows=$2, error_rows=0,
         errors=$3::jsonb, completed_at=CURRENT_TIMESTAMP
     WHERE id=$4`,
    [totalRows, plan.summary.skippedQuotas, JSON.stringify(plan.warnings), importId]
  );
  return importId;
}

export async function importMimotoExcel({ filePath, apply = false, actorId = null }) {
  const [parsed, fileHash, fileStats] = await Promise.all([
    Promise.resolve(parseMimotoWorkbook(filePath)),
    hashFile(filePath),
    stat(filePath),
  ]);
  const client = await getClient();
  try {
    if (apply) await assertFileNotImported(client, fileHash);
    const plan = await buildPlan(client, parsed);
    const report = {
      mode: apply ? 'apply' : 'dry-run',
      file: parsed.fileName,
      fileHash,
      summary: plan.summary,
      errors: plan.errors,
      warnings: plan.warnings,
      drivers: plan.drivers.map((driver) => ({
        sourceRow: driver.sourceRow,
        name: driver.fullName,
        document: driver.documentNumber,
        phone: driver.phone,
        parkId: driver.parkId,
        driverId: driver.driverId,
        schedule: driver.schedule,
        cronogramaId: driver.cronogramaId,
        vehicle: driver.vehicle,
        vehicleId: driver.vehicleId,
        quotaCount: driver.quotas.length,
        paidQuotas: driver.quotas.filter((quota) => quota.validation === 'paid').length,
        skippedQuotas: driver.skippedQuotas.length,
      })),
    };
    if (!apply) return report;
    if (plan.errors.length > 0) throw new Error(`La importación tiene ${plan.errors.length} errores; ejecute dry-run y corríjalos`);

    await client.query('BEGIN');
    try {
      report.importId = await applyPlan(client, plan, {
        fileName: parsed.fileName,
        fileHash,
        fileSize: fileStats.size,
      }, actorId);
      await client.query('COMMIT');
      return report;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}
