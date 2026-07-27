/**
 * Ejecuta los procesos Mi Moto en dry-run sobre una base de pruebas y comprueba
 * que no cambien datos financieros ni datos de Mi Auto/Rapidin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_TABLES = [
  'module_mimoto_solicitud',
  'module_mimoto_cuota_semanal',
  'module_mimoto_evidencia_cobro_fleet',
  'module_mimoto_billing_audit_trail',
  'module_miauto_solicitud',
  'module_miauto_cuota_semanal',
  'module_rapidin_loan_requests',
  'module_rapidin_loans',
  'module_rapidin_installments',
];

function parseArgs(argv) {
  const options = { envFile: '.env' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--env') options.envFile = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Argumento no reconocido: ${arg}`);
  }
  return options;
}

function summarize(result) {
  const errors = (result?.results || []).filter((item) => item.status === 'error');
  return {
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
    dry_run: result?.dry_run !== false,
    affected: Number(result?.affected || 0),
    summary: result?.summary || {},
    errors: errors.slice(0, 20).map((item) => ({
      solicitud_id: item.solicitud_id,
      cuota_id: item.cuota_id || null,
      reason: item.reason || null,
      error: item.error || null,
    })),
    error_count: errors.length,
  };
}

async function snapshot(query) {
  const output = {};
  for (const table of SNAPSHOT_TABLES) {
    const result = await query(
      `SELECT COUNT(*)::int AS rows,
              MD5(COALESCE(STRING_AGG(ROW_TO_JSON(t)::text, '' ORDER BY id::text), '')) AS digest
       FROM ${table} t`
    );
    output[table] = result.rows[0];
  }
  return output;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Uso: node scripts/mimoto-dry-run-validation.js [--env .env]');
    return;
  }

  const envPath = path.isAbsolute(options.envFile)
    ? options.envFile
    : path.resolve(backendDir, options.envFile);
  const env = dotenv.parse(fs.readFileSync(envPath));
  if (!String(env.DB_NAME || '').toLowerCase().includes('test')) {
    throw new Error('La validacion integrada solo puede ejecutarse en una base de pruebas');
  }
  if (String(env.MIMOTO_FLEET_WITHDRAW_ENABLED || '').toLowerCase() === 'true') {
    throw new Error('MIMOTO_FLEET_WITHDRAW_ENABLED debe estar en false');
  }

  dotenv.config({ path: envPath, override: true });
  process.env.MIMOTO_FLEET_WITHDRAW_ENABLED = 'false';

  const [{ query, default: pool }, automation, weekly, fleet] = await Promise.all([
    import('../config/database.js'),
    import('../yego_mimoto/services/mimotoAutomationService.js'),
    import('../yego_mimoto/services/mimotoWeeklyService.js'),
    import('../yego_mimoto/services/mimotoFleetChargeService.js'),
  ]);

  try {
    const before = await snapshot(query);
    const now = new Date();
    const asOf = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);

    const results = {
      mora: summarize(await automation.runMimotoDailyMora({ dryRun: true, asOf })),
      gastos: summarize(await automation.runMimotoExpenseMaintenance({ dryRun: true, asOf })),
      generacion_semanal: summarize(await weekly.runMimotoWeeklyGeneration({ dryRun: true, now })),
      cobro_fleet: summarize(await fleet.runMimotoFleetCharge({ dryRun: true, asOf })),
    };
    const after = await snapshot(query);
    const changedTables = SNAPSHOT_TABLES.filter(
      (table) => before[table].rows !== after[table].rows || before[table].digest !== after[table].digest
    );
    const processErrors = Object.entries(results)
      .filter(([, result]) => result.error_count > 0)
      .map(([name, result]) => ({ process: name, count: result.error_count, errors: result.errors }));

    const report = {
      ok: changedTables.length === 0 && processErrors.length === 0,
      database: env.DB_NAME,
      as_of: asOf,
      fleet_withdraw_enabled: false,
      results,
      unchanged_financial_tables: changedTables.length === 0,
      changed_tables: changedTables,
      process_errors: processErrors,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
