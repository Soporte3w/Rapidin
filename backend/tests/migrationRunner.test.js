import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXISTING_DATABASE_BASELINE,
  baselineMigrationNames,
  migrationChecksum,
  requiresNoTransaction,
  sortMigrationNames,
  splitSqlStatements,
  transactionPlan,
} from '../scripts/migration-utils.js';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(testsDirectory, '../database/migrations');

test('ordena y valida nombres de migraciones sin confundir prefijos repetidos', () => {
  assert.deepEqual(
    sortMigrationNames(['010_final.sql', '002_segunda.sql', '002_primera.sql']),
    ['002_primera.sql', '002_segunda.sql', '010_final.sql'],
  );
  assert.throws(() => sortMigrationNames(['42_invalida.sql']), /inválidos/);
});

test('el checksum cambia cuando cambia el contenido SQL', () => {
  assert.equal(migrationChecksum('SELECT 1;'), migrationChecksum('SELECT 1;'));
  assert.notEqual(migrationChecksum('SELECT 1;'), migrationChecksum('SELECT 2;'));
});

test('separa sentencias sin cortar funciones, comentarios ni textos', () => {
  const sql = `
    -- comentario con ;
    CREATE FUNCTION demo() RETURNS void AS $$
    BEGIN
      PERFORM 'valor;interno';
    END;
    $$ LANGUAGE plpgsql;
    INSERT INTO demo_log(value) VALUES ('a; b');
  `;
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /CREATE FUNCTION/);
  assert.match(statements[1], /INSERT INTO demo_log/);
});

test('el plan absorbe BEGIN y COMMIT externos en la transacción controlada', () => {
  const plan = transactionPlan('BEGIN; CREATE TABLE demo(id int); COMMIT;');
  assert.equal(plan.noTransaction, false);
  assert.equal(plan.statements.length, 1);
  assert.match(plan.statements[0], /CREATE TABLE/);
});

test('los índices concurrentes se ejecutan fuera de una transacción', () => {
  const sql = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_demo ON demo(id);';
  assert.equal(requiresNoTransaction(sql), true);
  assert.equal(transactionPlan(sql).noTransaction, true);
});

test('una base existente solo deja pendientes migraciones posteriores al baseline', () => {
  const migrations = [
    { filename: '001_inicial.sql' },
    { filename: EXISTING_DATABASE_BASELINE },
    { filename: '041_indices.sql' },
    { filename: '042_nueva.sql' },
  ];
  assert.deepEqual(
    baselineMigrationNames(migrations, true),
    ['001_inicial.sql', EXISTING_DATABASE_BASELINE],
  );
  assert.deepEqual(baselineMigrationNames(migrations, false), []);
});

test('todas las migraciones versionadas pueden ser interpretadas por el ejecutor', async () => {
  const filenames = sortMigrationNames(
    (await fs.readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')),
  );
  for (const filename of filenames) {
    const sql = await fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
    assert.doesNotThrow(() => transactionPlan(sql), filename);
  }
});
