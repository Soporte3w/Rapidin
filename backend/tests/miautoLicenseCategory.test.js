import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMiautoLicenseCategoryValid,
  normalizeMiautoLicenseCategory,
} from '../yego_miauto/services/licencia/miautoLicenseCategory.js';

test('normaliza variantes de la categoría básica A1', () => {
  assert.equal(normalizeMiautoLicenseCategory('A1'), 'A1');
  assert.equal(normalizeMiautoLicenseCategory('A 1'), 'A1');
  assert.equal(normalizeMiautoLicenseCategory('A I'), 'AI');
});

test('rechaza A1, A 1 y A I', () => {
  for (const category of ['A1', 'A 1', 'A I', 'a i']) {
    assert.equal(isMiautoLicenseCategoryValid(category), false, category);
  }
});

test('acepta categorías superiores no vacías', () => {
  for (const category of ['A IIa', 'A IIb', 'A IIIa', 'B IIc']) {
    assert.equal(isMiautoLicenseCategoryValid(category), true, category);
  }
});

test('no valida una categoría ausente', () => {
  assert.equal(isMiautoLicenseCategoryValid(null), false);
  assert.equal(isMiautoLicenseCategoryValid('  '), false);
});
