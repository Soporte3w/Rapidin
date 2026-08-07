import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendDirectory = path.resolve(testsDirectory, '..');

async function readBackendFile(relativePath) {
  return fs.readFile(path.join(backendDirectory, relativePath), 'utf8');
}

test('la autenticación administrativa exige una identidad vinculada con RR. HH.', async () => {
  const [middlewareSource, authServiceSource] = await Promise.all([
    readBackendFile('middleware/auth.js'),
    readBackendFile('services/authService.js'),
  ]);

  assert.doesNotMatch(middlewareSource, /LEFT JOIN \$\{RRHH_USERS_TABLE\}/);
  assert.doesNotMatch(authServiceSource, /LEFT JOIN \$\{RRHH_USERS_TABLE\}/);
  assert.match(middlewareSource, /JOIN \$\{RRHH_USERS_TABLE\} h ON h\.id = u\.rrhh_user_id/);
  assert.match(authServiceSource, /WHERE LOWER\(h\.username\) = LOWER\(\$1\)/);
  assert.match(authServiceSource, /OR LOWER\(h\.email\) = LOWER\(\$1\)/);
  assert.match(authServiceSource, /OR h\.dni = \$1/);
});

test('el login acepta usuario, correo o DNI de RR. HH.', async () => {
  const validationsSource = await readBackendFile('middleware/validations.js');

  const loginValidation = validationsSource.slice(
    validationsSource.indexOf('export const validateLogin'),
    validationsSource.indexOf('export const validateDNI'),
  );
  assert.doesNotMatch(loginValidation, /isEmail/);
  assert.match(loginValidation, /isLength\(\{ min: 1, max: 255 \}\)/);
});

test('la administración de usuarios solo concede acceso desde el directorio de RR. HH.', async () => {
  const routesSource = await readBackendFile('routes/users.js');

  assert.match(routesSource, /FROM \$\{RRHH_USERS_TABLE\} h/);
  assert.match(routesSource, /LEFT JOIN \$\{SYSTEM_USERS_TABLE\} u ON u\.rrhh_user_id = h\.id/);
  assert.match(routesSource, /\(u\.id IS NOT NULL AND u\.active AND h\.is_active\) AS active/);
  assert.match(routesSource, /router\.put\('\/directory\/:id\/access'/);
  assert.doesNotMatch(routesSource, /router\.post\('\/'/);
  assert.doesNotMatch(routesSource, /router\.put\('\/:id'/);
  assert.doesNotMatch(routesSource, /router\.delete\('\/:id'/);
});

test('la migración desactiva todas las cuentas sin vínculo de RR. HH.', async () => {
  const migrationSource = await readBackendFile('database/migrations/051_disable_unlinked_system_users.sql');

  assert.match(migrationSource, /UPDATE systems_users_financiator/);
  assert.match(migrationSource, /WHERE rrhh_user_id IS NULL/);
  assert.match(migrationSource, /SET active = false/);
  assert.match(migrationSource, /UPDATE module_rapidin_users/);
});
