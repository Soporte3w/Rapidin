import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPoolToCurrentWeeklyCharge,
  applyWaterfallPool,
  allocatePaymentByPriority,
  mergeCascadaAllocations,
  paymentApplicableToBaseAfterSettledExtra,
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

test('cascada que cierra una cuota Excel consume toda la mora extra residual', () => {
  const result = applyWaterfallPool({
    poolAmount: 14.97,
    cuotas: [{
      id: 'excel-cerrada',
      due_date: '2026-07-06',
      amount_due: 157.67,
      paid_amount: 149.56,
      late_fee: 0,
      mora_extra: 0.56,
      mora_extra_total: 0.08,
      montos_fuente: 'excel',
      status: 'overdue',
      pending: 14.97,
    }],
  });

  assert.equal(result.allocations[0].pendingDespues, 0);
  assert.equal(result.allocations[0].moraExtraAplicada, 0.56);
  assert.equal(result.allocations[0].moraExtraDespues, 0);
  assert.equal(result.allocations[0].moraExtraTotal, 0.56);
  assert.equal(result.allocations[0].statusDespues, 'paid');

  const auditRows = mergeCascadaAllocations([result.allocations]);
  assert.equal(auditRows[0].mora_extra_aplicada, 0.56);
  assert.equal(auditRows[0].mora_extra_pendiente_despues, 0);
});

test('cascada parcial cubre mora extra antes de bajar capital Excel', () => {
  const result = applyWaterfallPool({
    poolAmount: 10,
    cuotas: [{
      id: 'excel-parcial-capital',
      due_date: '2026-07-06',
      amount_due: 157.67,
      paid_amount: 149.56,
      late_fee: 0,
      mora_extra: 0.56,
      montos_fuente: 'excel',
      status: 'overdue',
      pending: 14.97,
    }],
  });

  assert.equal(result.allocations[0].pendingDespues, 4.97);
  assert.equal(result.allocations[0].moraExtraAplicada, 0.56);
  assert.equal(result.allocations[0].moraExtraDespues, 0);
  assert.equal(result.allocations[0].capitalAplicado, 9.44);
});

test('cascada menor que la mora extra reduce solo lo cubierto', () => {
  const result = applyWaterfallPool({
    poolAmount: 0.29,
    cuotas: [{
      id: 'excel-parcial-mora-extra',
      due_date: '2026-07-06',
      amount_due: 157.67,
      paid_amount: 149.56,
      late_fee: 0,
      mora_extra: 0.56,
      montos_fuente: 'excel',
      status: 'overdue',
      pending: 14.97,
    }],
  });

  assert.equal(result.allocations[0].pendingDespues, 14.68);
  assert.equal(result.allocations[0].moraExtraAplicada, 0.29);
  assert.equal(result.allocations[0].moraExtraDespues, 0.27);
});

test('cuotas generadas por sistema conservan mora extra persistida', () => {
  const result = applyWaterfallPool({
    poolAmount: 110,
    cuotas: [{
      id: 'sistema',
      due_date: '2026-07-06',
      amount_due: 100,
      paid_amount: 0,
      late_fee: 0,
      mora_extra: 10,
      montos_fuente: 'sistema',
      status: 'overdue',
      pending: 110,
    }],
  });

  assert.equal(result.allocations[0].pendingDespues, 0);
  assert.equal(result.allocations[0].moraExtraAplicada, 0);
  assert.equal(result.allocations[0].moraExtraDespues, 10);
});

test('imputacion comun respeta mora normal, mora extra y capital', () => {
  const result = allocatePaymentByPriority({
    payment: 18,
    pendingTotal: 110,
    moraNormal: 5,
    moraExtra: 10,
  });

  assert.equal(result.moraNormalApplied, 5);
  assert.equal(result.moraExtraApplied, 10);
  assert.equal(result.capitalApplied, 3);
  assert.equal(result.pendingAfter, 92);
});

test('mora extra ya cobrada no se vuelve a descontar como capital', () => {
  const applicable = paymentApplicableToBaseAfterSettledExtra({
    paidAmount: 386.83,
    moraExtra: 0,
    moraExtraTotal: 6.99,
  });

  assert.equal(applicable, 379.84);
});
