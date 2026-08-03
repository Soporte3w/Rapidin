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
