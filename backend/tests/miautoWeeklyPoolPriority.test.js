import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPoolToCurrentWeeklyCharge,
  applyWaterfallPool,
} from '../yego_miauto/services/cobros/CascadaPoolManager.js';

test('sin cuotas vencidas el recaudo reduce primero la cuota semanal actual', () => {
  const current = applyPoolToCurrentWeeklyCharge({
    poolAmount: 262.47,
    cuotaSemanal: 430,
    cobroSaldo: 0,
  });

  assert.deepEqual(current, {
    applied: 262.47,
    amountDue: 167.53,
    remainingPool: 0,
    obligation: 430,
  });
});

test('la cascada cubre deuda anterior y luego la cuota actual', () => {
  const previous = applyWaterfallPool({
    poolAmount: 600,
    cuotas: [{
      id: 'anterior',
      due_date: '2026-07-13',
      amount_due: 100,
      paid_amount: 0,
      late_fee: 0,
      mora_extra: 0,
      status: 'overdue',
      pending: 100,
    }],
  });
  const current = applyPoolToCurrentWeeklyCharge({
    poolAmount: previous.remainingPool,
    cuotaSemanal: 480,
    cobroSaldo: 0,
  });

  assert.equal(previous.applied, 100);
  assert.equal(current.applied, 480);
  assert.equal(current.amountDue, 0);
  assert.equal(current.remainingPool, 20);
});

test('otros gastos no reciben recaudo mientras la cuota actual mantiene saldo', () => {
  const current = applyPoolToCurrentWeeklyCharge({
    poolAmount: 150,
    cuotaSemanal: 480,
    cobroSaldo: 0,
  });

  assert.equal(current.amountDue, 330);
  assert.equal(current.remainingPool, 0);
});
