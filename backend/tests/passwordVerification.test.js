import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { verifyStoredPassword } from '../utils/passwordVerification.js';

test('verifica contraseñas bcrypt de RR. HH.', async () => {
  const hash = await bcrypt.hash('clave-segura', 4);

  assert.equal(await verifyStoredPassword('clave-segura', hash), true);
  assert.equal(await verifyStoredPassword('clave-incorrecta', hash), false);
});

test('verifica contraseñas SHA-256 heredadas de control_loop', async () => {
  const hash = createHash('sha256').update('clave-heredada').digest('hex');

  assert.equal(await verifyStoredPassword('clave-heredada', hash), true);
  assert.equal(await verifyStoredPassword('clave-incorrecta', hash), false);
});

test('rechaza hashes desconocidos o valores incompletos', async () => {
  assert.equal(await verifyStoredPassword('clave', 'hash-desconocido'), false);
  assert.equal(await verifyStoredPassword('clave', null), false);
  assert.equal(await verifyStoredPassword(null, ''), false);
});
