import assert from 'node:assert/strict';
import test from 'node:test';
import { factilizaDateToIso } from '../yego_miauto/services/soat/miautoSoatValidationService.js';

test('convierte fechas Factiliza de SOAT a ISO', () => {
  assert.equal(factilizaDateToIso('09/08/2026'), '2026-08-09');
  assert.equal(factilizaDateToIso('31/02/2026'), null);
  assert.equal(factilizaDateToIso('2026-08-09'), null);
  assert.equal(factilizaDateToIso(''), null);
});
