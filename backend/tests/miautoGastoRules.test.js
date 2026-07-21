import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGpsInstallments,
  buildSoatInstallments,
  buildVehicleTaxInstallments,
  buildWeeklyInstallments,
  availableFleetCharge,
  contractEndDate,
  expenseStatus,
  installmentsWithinRange,
  isVehicleTaxYearEligible,
  nextMonday,
  nextMonthEnd,
  recurringReferenceDate,
  replaceYearClamped,
} from '../yego_miauto/services/gastos/miautoGastoRules.js';

test('GPS genera doce cierres mensuales con monto fijo', () => {
  const installments = buildGpsInstallments(2027, 47.2);
  assert.equal(installments.length, 12);
  assert.deepEqual(installments[0], { number: 1, dueDate: '2027-01-31', amount: 47.2 });
  assert.deepEqual(installments[1], { number: 2, dueDate: '2027-02-28', amount: 47.2 });
  assert.deepEqual(installments[11], { number: 12, dueDate: '2027-12-31', amount: 47.2 });
});

test('GPS inicia el mes siguiente y termina con el contrato', () => {
  const endDate = contractEndDate('2026-06-22', 195);
  assert.equal(endDate, '2030-03-11');
  assert.equal(nextMonthEnd('2026-06-22'), '2026-07-31');
  const firstPeriod = installmentsWithinRange(
    buildGpsInstallments(2026, 47.2), nextMonthEnd('2026-06-22'), endDate
  );
  assert.deepEqual(firstPeriod.map((item) => item.dueDate), [
    '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31',
  ]);
  assert.deepEqual(firstPeriod.map((item) => item.number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(
    installmentsWithinRange(buildGpsInstallments(2030, 47.2), nextMonthEnd('2026-06-22'), endDate)
      .map((item) => item.dueDate),
    ['2030-01-31', '2030-02-28']
  );
});

test('SOAT divide el monto total entre los meses previos al vencimiento', () => {
  const installments = buildSoatInstallments('2027-06-30', 200, 5);
  assert.deepEqual(installments.map((item) => item.dueDate), [
    '2027-01-30', '2027-02-28', '2027-03-30', '2027-04-30', '2027-05-30',
  ]);
  assert.deepEqual(installments.map((item) => item.amount), [40, 40, 40, 40, 40]);
});

test('SOAT conserva exactamente el monto total cuando hay centavos', () => {
  const installments = buildSoatInstallments('2027-06-30', 200.03, 5);
  assert.deepEqual(installments.map((item) => item.amount), [40.01, 40.01, 40.01, 40, 40]);
  assert.equal(installments.reduce((sum, item) => sum + item.amount, 0), 200.03);
});

test('SOAT conserva la primera referencia futura y luego renueva por aniversario', () => {
  assert.equal(recurringReferenceDate('2027-06-30', 2026), '2027-06-30');
  assert.equal(recurringReferenceDate('2027-06-30', 2028), '2028-06-30');
});

test('impuesto vehicular conserva el total exacto en cuatro meses', () => {
  const installments = buildVehicleTaxInstallments(2027, 1000.01, 2, 4);
  assert.deepEqual(installments.map((item) => item.dueDate), [
    '2027-02-08', '2027-05-10', '2027-08-09', '2027-11-08',
  ]);
  assert.equal(installments.reduce((sum, item) => sum + item.amount, 0), 1000.01);
  assert.equal(isVehicleTaxYearEligible(2026, 2027, 3), true);
  assert.equal(isVehicleTaxYearEligible(2026, 2029, 3), true);
  assert.equal(isVehicleTaxYearEligible(2026, 2030, 3), false);
});

test('impuesto vehicular rechaza calendarios que salen del periodo anual', () => {
  assert.throws(
    () => buildVehicleTaxInstallments(2027, 1000, 10, 4),
    /excede el ano configurado/
  );
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

test('cobro Fleet usa solo el saldo disponible y conserva el saldo pendiente', () => {
  assert.equal(availableFleetCharge(200, 75.35), 75.35);
  assert.equal(availableFleetCharge(50, 75.35), 50);
  assert.equal(availableFleetCharge(200, 0), 0);
  const firstCharge = availableFleetCharge(50, 75.35);
  const secondCharge = availableFleetCharge(50, 75.35 - firstCharge);
  assert.equal(firstCharge, 50);
  assert.equal(secondCharge, 25.35);
  assert.equal(expenseStatus({
    amountDue: 200,
    paidAmount: 75.35,
    dueDate: '2026-07-01',
    todayYmd: '2026-07-17',
  }), 'overdue');
});
