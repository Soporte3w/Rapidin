import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(SCRIPT_DIR, '..');
const TABLES = [
  'module_mimoto_fleet',
  'module_mimoto_import_log',
  'module_mimoto_solicitud',
  'module_mimoto_cuota_semanal',
];
const APPLY = process.argv.includes('--apply');
const SOURCE_ENV = path.resolve(BACKEND_DIR, process.env.MIMOTO_SOURCE_ENV || '.env');
const TARGET_ENV = path.resolve(BACKEND_DIR, process.env.MIMOTO_TARGET_ENV || '.env.dev');

function readEnvironment(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`No existe el archivo de entorno: ${filePath}`);
  return dotenv.parse(fs.readFileSync(filePath));
}

function databaseConfig(env) {
  if (env.DATABASE_URL) {
    return {
      connectionString: env.DATABASE_URL,
      ssl: env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    };
  }
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function columns(client, table) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

async function assertCompatibleSchemas(source, target) {
  for (const table of TABLES) {
    const sourceColumns = await columns(source, table);
    const targetColumns = await columns(target, table);
    const sourceSet = [...sourceColumns].sort();
    const targetSet = [...targetColumns].sort();
    if (JSON.stringify(sourceSet) !== JSON.stringify(targetSet)) {
      throw new Error(`El esquema de ${table} no coincide entre origen y destino`);
    }
  }
}

async function sourceData(source) {
  const solicitudes = (await source.query('SELECT * FROM module_mimoto_solicitud ORDER BY id')).rows;
  const solicitudIds = solicitudes.map((row) => row.id);
  const fleetIds = [...new Set(solicitudes.map((row) => row.fleet_id).filter(Boolean))];
  const importIds = [...new Set(solicitudes.map((row) => row.source_import_id).filter(Boolean))];
  const fleets = fleetIds.length
    ? (await source.query('SELECT * FROM module_mimoto_fleet WHERE id = ANY($1::uuid[]) ORDER BY id', [fleetIds])).rows
    : [];
  const imports = importIds.length
    ? (await source.query('SELECT * FROM module_mimoto_import_log WHERE id = ANY($1::uuid[]) ORDER BY id', [importIds])).rows
    : [];
  const cuotas = solicitudIds.length
    ? (await source.query('SELECT * FROM module_mimoto_cuota_semanal WHERE solicitud_id = ANY($1::uuid[]) ORDER BY id', [solicitudIds])).rows
    : [];
  return {
    module_mimoto_fleet: fleets,
    module_mimoto_import_log: imports,
    module_mimoto_solicitud: solicitudes,
    module_mimoto_cuota_semanal: cuotas,
  };
}

async function assertReferencesExist(target, data) {
  const cronogramaIds = [...new Set(data.module_mimoto_solicitud.map((row) => row.cronograma_id).filter(Boolean))];
  const vehicleIds = [...new Set(data.module_mimoto_solicitud.map((row) => row.cronograma_vehiculo_id).filter(Boolean))];
  const cronogramas = cronogramaIds.length
    ? Number((await target.query('SELECT COUNT(*)::int AS count FROM module_mimoto_cronograma WHERE id = ANY($1::uuid[])', [cronogramaIds])).rows[0].count)
    : 0;
  const vehicles = vehicleIds.length
    ? Number((await target.query('SELECT COUNT(*)::int AS count FROM module_mimoto_cronograma_vehiculo WHERE id = ANY($1::uuid[])', [vehicleIds])).rows[0].count)
    : 0;
  if (cronogramas !== cronogramaIds.length || vehicles !== vehicleIds.length) {
    throw new Error('Produccion no contiene todos los cronogramas o vehiculos referenciados');
  }
}

async function targetRowsById(target, table, rows) {
  const ids = rows.map((row) => row.id);
  if (!ids.length) return [];
  return (await target.query(`SELECT * FROM ${quoteIdentifier(table)} WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids])).rows;
}

async function writeBackup(target, data) {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupPath = path.join('/tmp', `mimoto-before-production-import-${timestamp}.json`);
  const existing = {};
  for (const table of TABLES) existing[table] = await targetRowsById(target, table, data[table]);
  fs.writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), existing }, null, 2));
  return backupPath;
}

async function insertRows(target, table, rows) {
  if (!rows.length) return 0;
  const tableColumns = await columns(target, table);
  const identifiers = tableColumns.map(quoteIdentifier).join(', ');
  const sql = `
    INSERT INTO ${quoteIdentifier(table)} (${identifiers})
    SELECT ${identifiers}
      FROM jsonb_populate_recordset(NULL::${quoteIdentifier(table)}, $1::jsonb)
    ON CONFLICT (id) DO NOTHING`;
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += 100) {
    const chunk = rows.slice(offset, offset + 100);
    inserted += (await target.query(sql, [JSON.stringify(chunk)])).rowCount;
  }
  return inserted;
}

async function verifyImport(target, data) {
  const verification = {};
  for (const table of TABLES) {
    const expectedIds = data[table].map((row) => row.id);
    const found = expectedIds.length
      ? Number((await target.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(table)} WHERE id = ANY($1::uuid[])`, [expectedIds])).rows[0].count)
      : 0;
    verification[table] = { expected: expectedIds.length, found };
    if (found !== expectedIds.length) throw new Error(`Verificacion incompleta para ${table}: ${found}/${expectedIds.length}`);
  }
  return verification;
}

const sourceEnv = readEnvironment(SOURCE_ENV);
const targetEnv = readEnvironment(TARGET_ENV);
if (!sourceEnv.DB_NAME?.includes('test')) throw new Error('La base origen debe ser una base de pruebas');
if (!targetEnv.DB_NAME || targetEnv.DB_NAME.includes('test')) throw new Error('La base destino debe ser produccion');
if (sourceEnv.DB_NAME === targetEnv.DB_NAME) throw new Error('Origen y destino no pueden ser la misma base');

const source = new pg.Pool(databaseConfig(sourceEnv));
const target = new pg.Pool(databaseConfig(targetEnv));

try {
  await assertCompatibleSchemas(source, target);
  const data = await sourceData(source);
  await assertReferencesExist(target, data);
  const summary = Object.fromEntries(TABLES.map((table) => [table, data[table].length]));
  if (!APPLY) {
    console.log(JSON.stringify({ mode: 'dry-run', source: sourceEnv.DB_NAME, target: targetEnv.DB_NAME, summary }, null, 2));
    process.exit(0);
  }

  const client = await target.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mimoto-production-data-import'))");
    const backupPath = await writeBackup(client, data);
    const inserted = {};
    for (const table of TABLES) inserted[table] = await insertRows(client, table, data[table]);
    const verification = await verifyImport(client, data);
    await client.query('COMMIT');
    console.log(JSON.stringify({ mode: 'applied', source: sourceEnv.DB_NAME, target: targetEnv.DB_NAME, summary, inserted, verification, backupPath }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await source.end();
  await target.end();
}
