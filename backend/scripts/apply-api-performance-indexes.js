import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool, { getClient } from '../config/database.js';

const EXPECTED_INDEXES = [
  'idx_rapidin_payment_installments_installment_payment',
  'idx_rapidin_loans_driver_country_status',
  'idx_rapidin_loan_requests_driver_status_created',
  'idx_rapidin_installments_loan_status_due',
  'idx_miauto_cuota_schedule_active',
  'idx_miauto_comp_cuota_pending_by_sol',
  'idx_rapidin_drivers_park_id_not_blank',
  'idx_rapidin_audit_entity_changed',
];

const TABLES_TO_ANALYZE = [
  'module_rapidin_payment_installments',
  'module_rapidin_loans',
  'module_rapidin_loan_requests',
  'module_rapidin_installments',
  'module_miauto_cuota_semanal',
  'module_miauto_comprobante_cuota_semanal',
  'module_rapidin_drivers',
  'module_rapidin_data_audit_log',
];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  scriptDirectory,
  '../database/migrations/041_api_performance_indexes.sql'
);
const checkOnly = process.argv.includes('--check');

function parseStatements(sql) {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function getIndexStatus(client) {
  const result = await client.query(
    `SELECT c.relname AS index_name, i.indisvalid, i.indisready
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY($1::text[])
     ORDER BY c.relname`,
    [EXPECTED_INDEXES]
  );

  const byName = new Map(result.rows.map((row) => [row.index_name, row]));
  return EXPECTED_INDEXES.map((indexName) => ({
    indexName,
    present: byName.has(indexName),
    valid: byName.get(indexName)?.indisvalid === true,
    ready: byName.get(indexName)?.indisready === true,
  }));
}

function printStatus(status) {
  console.table(
    status.map(({ indexName, present, valid, ready }) => ({
      indice: indexName,
      presente: present,
      valido: valid,
      listo: ready,
    }))
  );
}

let client;
try {
  client = await getClient();

  if (!checkOnly) {
    const sql = await fs.readFile(migrationPath, 'utf8');
    const statements = parseStatements(sql);

    console.log(`Aplicando ${statements.length} sentencias de ${path.basename(migrationPath)}`);
    for (const [index, statement] of statements.entries()) {
      const label = statement.replace(/\s+/g, ' ').slice(0, 100);
      console.log(`[${index + 1}/${statements.length}] ${label}`);
      await client.query(statement);
    }

    for (const tableName of TABLES_TO_ANALYZE) {
      console.log(`Actualizando estadísticas: ${tableName}`);
      await client.query(`ANALYZE public.${tableName}`);
    }
  }

  const status = await getIndexStatus(client);
  printStatus(status);

  const failed = status.filter(({ present, valid, ready }) => !present || !valid || !ready);
  if (failed.length > 0) {
    throw new Error(`${failed.length} índice(s) faltan o no quedaron válidos`);
  }

  console.log(checkOnly
    ? 'Verificación correcta: los índices de rendimiento están activos.'
    : 'Migración 041 aplicada correctamente: los índices están activos.');
} catch (error) {
  console.error('No se pudo aplicar/verificar la migración 041:', error.message);
  process.exitCode = 1;
} finally {
  if (client) {
    await client.query("RESET statement_timeout").catch(() => {});
    await client.query("RESET lock_timeout").catch(() => {});
    client.release();
  }
  await pool.end();
}
