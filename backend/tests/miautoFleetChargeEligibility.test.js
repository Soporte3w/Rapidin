import assert from 'node:assert/strict';
import test from 'node:test';
import { isMiautoFleetCuotaDueForCharge } from '../yego_miauto/services/cuotas/miautoFleetChargeService.js';

test('el cobro Fleet incluye únicamente cuotas exigibles hoy o vencidas', () => {
  const today = '2026-08-03';
  assert.equal(isMiautoFleetCuotaDueForCharge({ due_date: '2026-08-02' }, today), true);
  assert.equal(isMiautoFleetCuotaDueForCharge({ due_date: '2026-08-03' }, today), true);
  assert.equal(isMiautoFleetCuotaDueForCharge({ due_date: '2026-08-10' }, today), false);
});

test('usa la semana como respaldo y excluye filas sin fecha exigible', () => {
  const today = '2026-08-03';
  assert.equal(isMiautoFleetCuotaDueForCharge({ week_start_date: '2026-08-03' }, today), true);
  assert.equal(isMiautoFleetCuotaDueForCharge({ week_start_date: '2026-08-10' }, today), false);
  assert.equal(isMiautoFleetCuotaDueForCharge({}, today), false);
});
