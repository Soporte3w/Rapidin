import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  normalizeMiautoPlate,
  selectWorkingDriverForPlate,
} from '../yego_miauto/services/utils/miautoPlateIdentity.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..');
const read = (relativePath) => readFileSync(resolve(backendRoot, relativePath), 'utf8');

test('normaliza la placa con la misma identidad para guiones y espacios', () => {
  assert.equal(normalizeMiautoPlate(' abc-123 '), 'ABC123');
  assert.equal(normalizeMiautoPlate('ABC 123'), 'ABC123');
  assert.equal(normalizeMiautoPlate(null), '');
});

test('elige la coincidencia exacta del conductor cuando una placa tiene filas repetidas', () => {
  const selected = selectWorkingDriverForPlate([
    { driver_id: 'driver-a', park_id: 'park' },
    { driver_id: 'driver-b', park_id: 'park' },
  ], 'driver-b');
  assert.equal(selected.driver_id, 'driver-b');
});

test('acepta un único conductor de placa y bloquea una atribución ambigua', () => {
  assert.equal(
    selectWorkingDriverForPlate([{ driver_id: 'driver-a' }]).driver_id,
    'driver-a',
  );
  assert.throws(
    () => selectWorkingDriverForPlate([{ driver_id: 'driver-a' }, { driver_id: 'driver-b' }]),
    /más de un conductor activo/,
  );
  assert.throws(() => selectWorkingDriverForPlate([]), /no tiene un conductor activo/);
});

test('la migración modela conductor 1:N y protege la placa activa', () => {
  const migration = read('database/migrations/050_miauto_conductor_multiple_contracts.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS module_miauto_conductor/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS conductor_id UUID/);
  assert.match(migration, /contrato_adicional/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_miauto_active_contract_plate/);
  assert.match(migration, /WHERE status = 'aprobado'/);
});

test('el alta adicional usa una ruta propia y no la creación de solicitudes', () => {
  const route = read('yego_miauto/routes/miauto/solicitudes.js');
  const service = read('yego_miauto/services/solicitud/miautoSolicitudService.js');
  assert.match(route, /post\('\/solicitudes\/:id\/contratos-adicionales'/);
  assert.match(route, /req\.user\?\.role === 'driver'/);
  assert.match(service, /origen_registro, country/);
  assert.match(service, /'contrato_adicional'/);
  assert.match(service, /WHERE s\.conductor_id = \$1/);
});

test('viajes y recaudo semanal usan la misma identidad activa de la placa', () => {
  const weeklyJob = read('jobs/miautoWeeklyCharge.js');
  const service = read('yego_miauto/services/solicitud/miautoSolicitudService.js');
  const metricsRoute = read('yego_miauto/routes/miauto/cuotas.js');
  const plateLookup = read('yego_miauto/services/utils/miautoPlateDriverLookup.js');

  assert.match(plateLookup, /work_status = 'working'/);
  assert.match(plateLookup, /car_number/);
  assert.match(weeklyJob, /resolveWorkingMiautoDriverForPlate/);
  assert.match(weeklyJob, /count_completed: plateIncome\.count_completed/);
  assert.match(weeklyJob, /partner_fees: plateIncome\.partner_fees/);
  assert.doesNotMatch(weeklyJob, /const recaudoDriver = sol\.recaudo_driver_id/);

  assert.match(service, /plateDriver = await resolveWorkingMiautoDriverForPlate/);
  assert.match(service, /plateDriver\.driver_id,[\s\S]*plateDriver\.park_id/);
  assert.doesNotMatch(service, /let driverId = solData\?\.driver_id_fleet/);

  assert.match(metricsRoute, /plateDriver = await resolveWorkingMiautoDriverForPlate/);
  assert.match(metricsRoute, /getDriverGoals\(plateDriver\.driver_id\)/);
  assert.doesNotMatch(metricsRoute, /getDriverGoals\(sol\.driver_id_fleet\)/);
});

test('la reparación de la Semana 38 retira solo el recaudo duplicado y conserva el cobro Fleet', () => {
  const migration = read('database/migrations/051_fix_miauto_duplicated_plate_income.sql');

  assert.match(migration, /f76513b5-62db-4e6a-a551-8a60314cc40e/);
  assert.match(migration, /90ae700e-38e6-4037-b682-0087ef95cc12/);
  assert.match(migration, /partner_fees_raw = 0/);
  assert.match(migration, /partner_fees_83 = 0/);
  assert.match(migration, /partner_fees_yango_raw = NULL/);
  assert.match(migration, /amount_due = 520\.00/);
  assert.match(migration, /c\.paid_amount = 260\.00/);
  assert.doesNotMatch(migration, /SET[\s\S]*paid_amount\s*=/);
  assert.match(migration, /data_migration_051/);
});
