import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGpsInstallments,
  buildSoatInstallments,
  buildVehicleTaxInstallments,
  buildWeeklyInstallments,
  expenseStatus,
  isVehicleTaxYearEligible,
  nextMonday,
  replaceYearClamped,
} from '../yego_miauto/services/gastos/miautoGastoRules.js';

test('GPS genera doce cierres mensuales con monto fijo', () => {
  const installments = buildGpsInstallments(2027);
  assert.equal(installments.length, 12);
  assert.deepEqual(installments[0], { number: 1, dueDate: '2027-01-31', amount: 47.2 });
  assert.deepEqual(installments[1], { number: 2, dueDate: '2027-02-28', amount: 47.2 });
  assert.deepEqual(installments[11], { number: 12, dueDate: '2027-12-31', amount: 47.2 });
});

test('SOAT genera cuatro cuotas de 50 antes del vencimiento', () => {
  const installments = buildSoatInstallments('2027-06-30', 50);
  assert.deepEqual(installments.map((item) => item.dueDate), [
    '2027-02-28', '2027-03-30', '2027-04-30', '2027-05-30',
  ]);
  assert.equal(installments.reduce((sum, item) => sum + item.amount, 0), 200);
});

test('impuesto vehicular conserva el total exacto en cuatro meses', () => {
  const installments = buildVehicleTaxInstallments(2027, 1000.01);
  assert.deepEqual(installments.map((item) => item.dueDate), [
    '2027-02-08', '2027-05-10', '2027-08-09', '2027-11-08',
  ]);
  assert.equal(installments.reduce((sum, item) => sum + item.amount, 0), 1000.01);
  assert.equal(isVehicleTaxYearEligible(2026, 2027), true);
  assert.equal(isVehicleTaxYearEligible(2026, 2029), true);
  assert.equal(isVehicleTaxYearEligible(2026, 2030), false);
});

test('STR e inicial empiezan el lunes siguiente y generan 26 semanas', () => {
  const start = nextMonday('2026-07-13');
  const installments = buildWeeklyInstallments(start, 26, 19.23);
  assert.equal(start, '2026-07-20');
  assert.equal(installments.length, 26);
  assert.equal(installments[0].dueDate, '2026-07-20');
  assert.equal(installments[25].dueDate, '2027-01-11');
});

test('aniversario anual ajusta correctamente una entrega del 29 de febrero', () => {
  assert.equal(replaceYearClamped('2024-02-29', 2025), '2025-02-28');
  assert.equal(replaceYearClamped('2024-02-29', 2028), '2028-02-29');
});

test('otros gastos derivan estado por saldo y fecha, sin mora', () => {
  assert.equal(expenseStatus({ amountDue: 200, paidAmount: 200, dueDate: '2026-01-01', todayYmd: '2026-07-16' }), 'paid');
  assert.equal(expenseStatus({ amountDue: 200, paidAmount: 50, dueDate: '2026-01-01', todayYmd: '2026-07-16' }), 'overdue');
  assert.equal(expenseStatus({ amountDue: 200, paidAmount: 50, dueDate: '2026-08-01', todayYmd: '2026-07-16' }), 'partial');
  assert.equal(expenseStatus({ amountDue: 200, paidAmount: 0, dueDate: '2026-08-01', todayYmd: '2026-07-16' }), 'pending');
});
