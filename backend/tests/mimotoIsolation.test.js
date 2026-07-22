import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../yego_mimoto');

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : absolute;
  }));
  return nested.flat().filter((file) => file.endsWith('.js'));
}

test('el módulo no importa servicios financieros de Mi Auto', async () => {
  const files = await sourceFiles(root);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /(?:from|import\s*)[^\n]*yego_miauto/i, file);
  }
});

test('solo el guard de aislamiento puede mencionar tablas Mi Auto', async () => {
  const files = (await sourceFiles(root)).filter((file) => !file.endsWith('mimotoFinancialEngine.js'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /module_miauto_/i, file);
  }
});

test('la migración define 26 tablas y una vista aisladas', async () => {
  const migration = await readFile(path.resolve(root, '../database/migrations/028_mimoto_colombia_independent_module.sql'), 'utf8');
  assert.equal((migration.match(/CREATE TABLE IF NOT EXISTS module_mimoto_/g) || []).length, 26);
  assert.equal((migration.match(/CREATE OR REPLACE VIEW module_mimoto_/g) || []).length, 1);
  assert.doesNotMatch(migration, /module_miauto_/i);
});

test('las escrituras financieras quedan bloqueadas mientras Mi Moto esté desactivado', async () => {
  const routes = await readFile(path.join(root, 'routes/mimoto.js'), 'utf8');
  const config = await readFile(path.join(root, 'config/mimotoConfig.js'), 'utf8');
  const fleetContext = await readFile(path.join(root, 'services/mimotoFleetContext.js'), 'utf8');
  assert.match(routes, /cuotas\/generar', requireMimotoEnabledForWrite/);
  assert.match(routes, /pago-manual', requireMimotoEnabled/);
  assert.match(routes, /otros-gastos\/ciclos', requireMimotoEnabled/);
  assert.match(config, /fleetWithdrawEnabled.*envBoolean\('MIMOTO_FLEET_WITHDRAW_ENABLED', false\)/);
  assert.match(fleetContext, /!MIMOTO_CONFIG\.fleetWithdrawEnabled/);
});

test('los jobs Mi Moto separan generación, mora y cobro Fleet con interruptor real', async () => {
  const jobs = await readFile(path.resolve(root, '../jobs/mimotoJobs.js'), 'utf8');
  const fleet = await readFile(path.join(root, 'services/mimotoFleetChargeService.js'), 'utf8');
  const weekly = await readFile(path.join(root, 'services/mimotoWeeklyService.js'), 'utf8');
  assert.match(jobs, /runMimotoWeeklyGeneration\(\{ dryRun: false \}\)/);
  assert.match(jobs, /runMimotoFleetCharge\(\{ dryRun: !MIMOTO_CONFIG\.fleetWithdrawEnabled \}\)/);
  assert.match(fleet, /assertMimotoFleetWriteEnabled\(\)/);
  assert.match(fleet, /sourceKey/);
  assert.match(fleet, /q\.due_date <= \$1::date/);
  assert.match(weekly, /mimoto_weekly_generation/);
  assert.match(jobs, /defaultExpression: '0 1 \* \* \*'/);
  assert.match(jobs, /defaultExpression: '0 6 \* \* 1'/);
  assert.match(jobs, /defaultExpression: '10 7 \* \* 1'/);
  assert.match(jobs, /timezone: MIMOTO_CONFIG\.timezone/);
  assert.doesNotMatch(fleet, /module_mimoto_otros_gastos/);
});

test('Fleet Mi Moto usa una única sesión global para todas las flotas', async () => {
  const context = await readFile(path.join(root, 'services/mimotoFleetContext.js'), 'utf8');
  const weekly = await readFile(path.join(root, 'services/mimotoWeeklyService.js'), 'utf8');
  const fleet = await readFile(path.join(root, 'services/mimotoFleetChargeService.js'), 'utf8');
  const automation = await readFile(path.join(root, 'services/mimotoAutomationService.js'), 'utf8');
  assert.match(context, /process\.env\.MIMOTO_FLEET_COOKIE/);
  assert.doesNotMatch(`${context}\n${weekly}\n${fleet}\n${automation}`, /credential_ref|credentialRef/);
});

test('las cuotas congelan cronograma, regla y tasa de mora', async () => {
  const migration = await readFile(path.resolve(root, '../database/migrations/036_mimoto_financial_automation.sql'), 'utf8');
  const service = await readFile(path.join(root, 'services/mimotoWeeklyBillingService.js'), 'utf8');
  const importer = await readFile(path.join(root, 'services/mimotoExcelImportService.js'), 'utf8');
  assert.match(migration, /cronograma_snapshot JSONB/);
  assert.match(migration, /tasa_interes_mora_snapshot/);
  assert.match(service, /rule_snapshot/);
  assert.match(service, /quota\.generated/);
  assert.match(importer, /loadImportCronogramaSnapshot/);
  assert.match(importer, /tasa_interes_mora_snapshot/);
});

test('la cascada semanal conserva destinos, saldo a favor y refresca la vista', async () => {
  const migration = await readFile(
    path.resolve(root, '../database/migrations/037_mimoto_weekly_cascade_trace.sql'),
    'utf8'
  );
  const service = await readFile(path.join(root, 'services/mimotoWeeklyBillingService.js'), 'utf8');
  assert.match(migration, /recaudo_pool/);
  assert.match(migration, /recaudo_cascada_destino/);
  assert.match(migration, /saldo_favor_conductor/);
  assert.match(migration, /CREATE VIEW module_mimoto_cuota_saldo_view/);
  assert.doesNotMatch(migration, /module_miauto_/i);
  assert.match(service, /applyRevenueToPreviousQuotas/);
  assert.match(service, /mora_normal/);
  assert.match(service, /mora_extra/);
  assert.match(service, /capital/);
});

test('la generación semanal tiene un único servicio financiero', async () => {
  const core = await readFile(path.join(root, 'services/mimotoCoreService.js'), 'utf8');
  const routes = await readFile(path.join(root, 'routes/mimoto.js'), 'utf8');
  const weekly = await readFile(path.join(root, 'services/mimotoWeeklyService.js'), 'utf8');
  assert.doesNotMatch(core, /previewOrGenerateWeeklyQuota/);
  assert.match(routes, /mimotoWeeklyBillingService\.js/);
  assert.match(weekly, /mimotoWeeklyBillingService\.js/);
});

test('pagos y Fleet usan el servicio financiero dedicado', async () => {
  const core = await readFile(path.join(root, 'services/mimotoCoreService.js'), 'utf8');
  const fleet = await readFile(path.join(root, 'services/mimotoFleetChargeService.js'), 'utf8');
  assert.doesNotMatch(core, /applyPaymentToQuota|applyPaymentToExpense|simulateFleetCascade/);
  assert.match(fleet, /mimotoPaymentService\.js/);
});

test('el cronograma solo se elimina lógicamente cuando no tiene solicitudes', async () => {
  const routes = await readFile(path.join(root, 'routes/mimoto.js'), 'utf8');
  const service = await readFile(path.join(root, 'services/mimotoCoreService.js'), 'utf8');
  assert.match(routes, /router\.delete\('\/cronogramas\/:id'/);
  assert.match(service, /export async function deleteCronograma/);
  assert.match(service, /No se puede eliminar un cronograma vinculado a solicitudes/);
  assert.match(service, /UPDATE module_mimoto_cronograma\s+SET active=FALSE, deleted_at=CURRENT_TIMESTAMP/);
  assert.doesNotMatch(service, /DELETE FROM module_mimoto_cronograma(?:\s|$)/);
});

test('el tarifario inicial conserva planes y valores colombianos vigentes', async () => {
  const seed = await readFile(path.resolve(root, '../database/migrations/030_seed_mimoto_colombia_cronogramas.sql'), 'utf8');
  assert.match(seed, /Plan 78 semanas - Portafolio general/);
  assert.match(seed, /Plan 78 semanas - Oferta especial/);
  assert.match(seed, /Plan 61 semanas - Victory Combat 100/);
  assert.match(seed, /"cuota_base":156600,"bono_40":15000,"bono_75":30000/);
  assert.doesNotMatch(seed, /module_miauto_/i);
});
