import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../config/database.js';
import {
  PENDING_EXIT_CODE,
  baselineMigrationNames,
  migrationChecksum,
  sortMigrationNames,
  transactionPlan,
} from './migration-utils.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(scriptDirectory, '../database/migrations');
const historyTable = 'public.rapidin_schema_migrations';
const advisoryLockNamespace = 72617;
const advisoryLockId = 1;

function parseMode(args) {
  if (args.length === 0) return 'apply';
  if (args.length === 1 && args[0] === '--check') return 'check';
  throw new Error('Uso: node scripts/run-migrations.js [--check]');
}

async function readMigrations() {
  const names = sortMigrationNames(
    (await fs.readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')),
  );
  return Promise.all(names.map(async (filename) => {
    const sql = await fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
    return { filename, sql, checksum: migrationChecksum(sql) };
  }));
}

async function relationExists(client, qualifiedName) {
  const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [qualifiedName]);
  return result.rows[0].present;
}

async function readApplied(client) {
  const result = await client.query(
    `SELECT filename, checksum, mode, applied_at
     FROM ${historyTable}
     ORDER BY filename`,
  );
  return new Map(result.rows.map((row) => [row.filename, row]));
}

function validateHistory(migrations, applied) {
  const available = new Map(migrations.map((migration) => [migration.filename, migration]));
  for (const [filename, record] of applied) {
    const migration = available.get(filename);
    if (!migration) throw new Error(`La migración aplicada ${filename} ya no existe en el repositorio`);
    if (migration.checksum !== record.checksum) {
      throw new Error(`La migración aplicada ${filename} fue modificada; restaure su contenido original`);
    }
  }
}

function printStatus({ migrations, applied, pending, registryPresent, baselineRequired }) {
  console.log(`Migraciones SQL: ${migrations.length} archivos, ${applied.size} registradas, ${pending.length} pendientes.`);
  if (!registryPresent) {
    console.log(
      baselineRequired
        ? 'El historial se inicializará para la base existente antes de aplicar migraciones nuevas.'
        : 'El historial se creará al aplicar las migraciones.',
    );
  }
  for (const migration of pending) console.log(`  pendiente: ${migration.filename}`);
}

async function inspect(client, migrations) {
  const registryPresent = await relationExists(client, historyTable);
  const existingDatabase = await relationExists(client, 'public.module_rapidin_loans');
  const baselineNames = registryPresent ? [] : baselineMigrationNames(migrations, existingDatabase);
  const baseline = new Set(baselineNames);
  const applied = registryPresent ? await readApplied(client) : new Map();
  validateHistory(migrations, applied);
  const pending = migrations.filter(
    (migration) => !applied.has(migration.filename) && !baseline.has(migration.filename),
  );
  return {
    registryPresent,
    existingDatabase,
    baselineNames,
    applied,
    pending,
    baselineRequired: !registryPresent && baselineNames.length > 0,
  };
}

async function createHistory(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${historyTable} (
      filename TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('baseline', 'transactional', 'non_transactional')),
      execution_ms BIGINT NOT NULL DEFAULT 0,
      applied_by TEXT NOT NULL DEFAULT CURRENT_USER,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function recordMigration(client, migration, mode, executionMs) {
  await client.query(
    `INSERT INTO ${historyTable} (filename, checksum, mode, execution_ms)
     VALUES ($1, $2, $3, $4)`,
    [migration.filename, migration.checksum, mode, executionMs],
  );
}

async function initializeBaseline(client, migrations, baselineNames) {
  if (baselineNames.length === 0) return;
  const baseline = new Set(baselineNames);
  await client.query('BEGIN');
  try {
    for (const migration of migrations) {
      if (baseline.has(migration.filename)) {
        await recordMigration(client, migration, 'baseline', 0);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  console.log(`Historial inicializado hasta ${baselineNames.at(-1)}.`);
}

async function applyMigration(client, migration) {
  const plan = transactionPlan(migration.sql);
  const startedAt = Date.now();
  console.log(`Aplicando ${migration.filename}${plan.noTransaction ? ' sin transacción' : ''}...`);

  if (plan.noTransaction) {
    for (const statement of plan.statements) await client.query(statement);
    await recordMigration(client, migration, 'non_transactional', Date.now() - startedAt);
    return;
  }

  await client.query('BEGIN');
  try {
    for (const statement of plan.statements) await client.query(statement);
    await recordMigration(client, migration, 'transactional', Date.now() - startedAt);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const migrations = await readMigrations();
  const client = await pool.connect();

  try {
    if (mode === 'check') {
      const state = await inspect(client, migrations);
      printStatus({ migrations, ...state });
      if (!state.registryPresent || state.pending.length > 0) process.exitCode = PENDING_EXIT_CODE;
      return;
    }

    await client.query('SELECT pg_advisory_lock($1, $2)', [advisoryLockNamespace, advisoryLockId]);
    try {
      const initialState = await inspect(client, migrations);
      await createHistory(client);
      await initializeBaseline(client, migrations, initialState.baselineNames);

      const applied = await readApplied(client);
      validateHistory(migrations, applied);
      const pending = migrations.filter((migration) => !applied.has(migration.filename));
      if (pending.length === 0) console.log('No hay migraciones SQL pendientes.');
      for (const migration of pending) await applyMigration(client, migration);

      const finalApplied = await readApplied(client);
      validateHistory(migrations, finalApplied);
      const missing = migrations.filter((migration) => !finalApplied.has(migration.filename));
      if (missing.length > 0) throw new Error(`Quedaron migraciones pendientes: ${missing.map((item) => item.filename).join(', ')}`);
      console.log(`Migraciones completas: ${finalApplied.size}/${migrations.length} registradas.`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [advisoryLockNamespace, advisoryLockId]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Error de migración: ${error.message}`);
  process.exitCode = 1;
});
