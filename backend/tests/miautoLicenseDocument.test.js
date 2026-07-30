import test from 'node:test';
import assert from 'node:assert/strict';
import { getDniFromPeruvianLicense } from '../yego_miauto/services/utils/miautoLicenseDocument.js';

test('obtiene los 8 dígitos después de la letra inicial de la licencia', () => {
  assert.equal(getDniFromPeruvianLicense('X70339164'), '70339164');
  assert.equal(getDniFromPeruvianLicense(' q04031906 '), '04031906');
});

test('rechaza licencias que no tengan una letra inicial y exactamente 8 dígitos', () => {
  assert.equal(getDniFromPeruvianLicense('70339164'), null);
  assert.equal(getDniFromPeruvianLicense('XX70339164'), null);
  assert.equal(getDniFromPeruvianLicense('X7033916'), null);
  assert.equal(getDniFromPeruvianLicense('X7033916A'), null);
  assert.equal(getDniFromPeruvianLicense(''), null);
});
