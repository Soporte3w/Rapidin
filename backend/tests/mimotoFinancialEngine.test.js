import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMimotoIsolationSql,
  calculateLateFee,
  calculateMimotoMoraAccrual,
  calculateWeeklyCharge,
  convertMimotoAmount,
  deriveQuotaStatus,
  distributePayment,
  normalizeColombianDocument,
  normalizeColombianPhone,
  planMimotoMondaySettlement,
  planMimotoFleetCharge,
  projectQuotaAfterPayment,
  selectMimotoRule,
  simulatePaymentCascade,
} from '../yego_mimoto/services/mimotoFinancialEngine.js';

test('normaliza identidad colombiana sin aceptar formatos peruanos', () => {
  assert.equal(normalizeColombianPhone('300 123 4567'), '573001234567');
  assert.equal(normalizeColombianPhone('+57 300 123 4567'), '573001234567');
  assert.deepEqual(normalizeColombianDocument('ppt', 'ab-12345'), { documentType: 'PPT', documentNumber: 'AB12345' });
  assert.throws(() => normalizeColombianDocument('DNI', '12345678'), /CC, CE o PPT/);
  assert.throws(() => normalizeColombianPhone('999999999'), /10 dígitos colombianos/);
});

test('convierte únicamente COP y USD con tasa explícita', () => {
  assert.equal(convertMimotoAmount(10, 'USD', 'COP', 4000), 40000);
  assert.equal(convertMimotoAmount(40000, 'COP', 'USD', 4000), 10);
  assert.throws(() => convertMimotoAmount(10, 'PEN', 'COP', 4000), /COP o USD/);
  assert.throws(() => convertMimotoAmount(10, 'USD', 'COP', 0), /tipo de cambio/);
});

test('un pago cubre mora normal, mora extra y capital en ese orden', () => {
  const quota = { amount_due: 500, capital_paid: 100, late_fee: 40, mora_extra: 15 };
  assert.deepEqual(distributePayment(quota, 50), {
    applied: 50, unapplied: 0, lateFee: 40, extraLateFee: 10, capital: 0,
  });
  assert.deepEqual(distributePayment(quota, 100), {
    applied: 100, unapplied: 0, lateFee: 40, extraLateFee: 15, capital: 45,
  });
});

test('el estado vencido prevalece sobre parcial mientras exista saldo', () => {
  assert.equal(deriveQuotaStatus({ dueDate: '2026-07-01', today: '2026-07-21', balance: 10, paidAmount: 5 }), 'overdue');
  assert.equal(deriveQuotaStatus({ dueDate: '2026-07-30', today: '2026-07-21', balance: 10, paidAmount: 5 }), 'partial');
  assert.equal(deriveQuotaStatus({ dueDate: '2026-07-01', today: '2026-07-21', balance: 0, paidAmount: 5 }), 'paid');
  assert.equal(deriveQuotaStatus({
    dueDate: new Date(2026, 6, 1),
    today: new Date(2026, 6, 21),
    balance: 10,
    paidAmount: 5,
  }), 'overdue');
});

test('la cascada mantiene orden cronológico y no inventa saldo', () => {
  const result = simulatePaymentCascade([
    { id: 'q1', amount_due: 100, capital_paid: 0, late_fee: 10, mora_extra: 5 },
    { id: 'q2', amount_due: 100, capital_paid: 0, late_fee: 0, mora_extra: 0 },
  ], 130);
  assert.equal(result.applied, 130);
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.applications.map((item) => item.cuota_id), ['q1', 'q2']);
  assert.deepEqual(result.applications[0], {
    cuota_id: 'q1', week_number: null, due_date: null,
    applied: 115, unapplied: 15, lateFee: 10, extraLateFee: 5, capital: 100,
  });
});

test('la cascada ordena correctamente fechas DATE devueltas por PostgreSQL', () => {
  const result = simulatePaymentCascade([
    { id: 'new', due_date: new Date(2026, 6, 20), amount_due: 100 },
    { id: 'old', due_date: new Date(2026, 6, 13), amount_due: 100 },
  ], 50, { asOf: '2026-07-20' });
  assert.equal(result.applications[0].cuota_id, 'old');
  assert.equal(result.applications[0].due_date, '2026-07-13');
});

test('el plan Fleet respeta mora, mora extra y capital también en USD', () => {
  const plan = planMimotoFleetCharge({
    moneda: 'USD', amount_due: 100, capital_paid: 0, late_fee: 10, mora_extra: 5,
  }, 240000, 4000);
  assert.deepEqual(plan, {
    amount_cop: 240000,
    amount_quota_currency: 60,
    quota_currency: 'USD',
    distribution: {
      applied: 60, unapplied: 0, lateFee: 10, extraLateFee: 5, capital: 45,
    },
  });
});

test('mora convierte la tasa semanal a diaria y usa los días explícitos', () => {
  assert.equal(calculateLateFee({ base: 480, weeklyRate: 0.04, days: 1 }), 2.74);
});

test('la mora diaria es incremental y cambia a mora extra después de un abono', () => {
  assert.deepEqual(calculateMimotoMoraAccrual({
    capitalBalance: 480,
    weeklyRate: 0.04,
    hasPayment: false,
    normalDays: 1,
    extraDays: 0,
  }), {
    late_fee_total: 2.74,
    late_fee: 2.74,
    mora_extra_total: 0,
    mora_extra: 0,
  });
  assert.deepEqual(calculateMimotoMoraAccrual({
    capitalBalance: 400,
    weeklyRate: 0.04,
    hasPayment: true,
    normalDays: 1,
    extraDays: 1,
    normalTotal: 20,
    normalPaid: 20,
    extraTotal: 5,
    extraPaid: 2,
  }), {
    late_fee_total: 20,
    late_fee: 0,
    mora_extra_total: 7.29,
    mora_extra: 5.29,
  });
});

test('bono moto conserva la cuota contractual y reduce únicamente lo pagable', () => {
  assert.deepEqual(calculateWeeklyCharge({
    baseAmount: 156600,
    payableAmount: 141600,
    revenueAmount: 0,
  }), {
    weekly: 156600,
    bonus: 15000,
    additionalCharge: 0,
    obligation: 141600,
    revenue: 0,
    amountDue: 141600,
  });
});

test('el recaudo del lunes cubre deuda antigua y luego la cuota nueva', () => {
  const result = planMimotoMondaySettlement({
    existingQuotas: [{
      id: 'old', due_date: '2026-07-13', week_number: 1,
      amount_due: 100, capital_paid: 0, late_fee: 10, mora_extra: 5, paid_amount: 0,
    }],
    currentQuota: {
      id: 'current', due_date: '2026-07-20', week_number: 2,
      amount_due: 100, capital_paid: 0, late_fee: 0, mora_extra: 0, paid_amount: 0,
    },
    revenuePool: 130,
    fleetBalance: 0,
    asOf: '2026-07-20',
  });

  assert.deepEqual(result.revenue.applications.map((item) => ({
    id: item.cuota_id,
    mora: item.lateFee,
    extra: item.extraLateFee,
    capital: item.capital,
  })), [
    { id: 'old', mora: 10, extra: 5, capital: 100 },
    { id: 'current', mora: 0, extra: 0, capital: 15 },
  ]);
  assert.equal(result.revenue.current_applied, 15);
  assert.equal(result.revenue.remaining, 0);
});

test('el cobro Fleet continúa sobre el saldo que dejó el recaudo', () => {
  const result = planMimotoMondaySettlement({
    existingQuotas: [{
      id: 'old', due_date: '2026-07-13', week_number: 1,
      amount_due: 100, capital_paid: 0, late_fee: 10, mora_extra: 5, paid_amount: 0,
    }],
    currentQuota: {
      id: 'current', due_date: '2026-07-20', week_number: 2,
      amount_due: 100, capital_paid: 0, late_fee: 0, mora_extra: 0, paid_amount: 0,
    },
    revenuePool: 8,
    fleetBalance: 120,
    asOf: '2026-07-20',
  });

  assert.deepEqual(result.revenue.applications[0], {
    cuota_id: 'old', week_number: 1, due_date: '2026-07-13',
    applied: 8, unapplied: 0, lateFee: 8, extraLateFee: 0, capital: 0,
  });
  assert.deepEqual(result.fleet.applications.map((item) => ({
    id: item.cuota_id,
    mora: item.lateFee,
    extra: item.extraLateFee,
    capital: item.capital,
  })), [
    { id: 'old', mora: 2, extra: 5, capital: 100 },
    { id: 'current', mora: 0, extra: 0, capital: 13 },
  ]);
});

test('una cuota futura no recibe recaudo ni cobro Fleet del lunes', () => {
  const result = planMimotoMondaySettlement({
    existingQuotas: [{
      id: 'future', due_date: '2026-07-27', week_number: 3,
      amount_due: 100, capital_paid: 0, late_fee: 0, mora_extra: 0, paid_amount: 0,
    }],
    currentQuota: {
      id: 'current', due_date: '2026-07-20', week_number: 2,
      amount_due: 100, capital_paid: 0, late_fee: 0, mora_extra: 0, paid_amount: 0,
    },
    revenuePool: 150,
    fleetBalance: 50,
    asOf: '2026-07-20',
  });

  assert.deepEqual(result.revenue.applications.map((item) => item.cuota_id), ['current']);
  assert.equal(result.revenue.remaining, 50);
  assert.equal(result.fleet.applied, 0);
  assert.equal(result.fleet.remaining, 50);
});

test('el excedente queda libre y nunca se inventa una aplicación a otros gastos', () => {
  const result = planMimotoMondaySettlement({
    currentQuota: {
      id: 'current', due_date: '2026-07-20', week_number: 1,
      amount_due: 100, capital_paid: 0, late_fee: 0, mora_extra: 0, paid_amount: 0,
    },
    revenuePool: 140,
    fleetBalance: 0,
    asOf: '2026-07-20',
  });

  assert.equal(result.revenue.applied, 100);
  assert.equal(result.revenue.remaining, 40);
  assert.equal(result.revenue.applications.length, 1);
});

test('la simulación completa del lunes es determinista e idempotente en memoria', () => {
  const scenario = {
    existingQuotas: [{
      id: 'old', due_date: '2026-07-13', week_number: 1,
      amount_due: 100, capital_paid: 20, late_fee: 6, mora_extra: 4, paid_amount: 20,
    }],
    currentQuota: {
      id: 'current', due_date: '2026-07-20', week_number: 2,
      amount_due: 100, capital_paid: 0, late_fee: 0, mora_extra: 0, paid_amount: 0,
    },
    revenuePool: 50,
    fleetBalance: 80,
    asOf: '2026-07-20',
  };
  assert.deepEqual(planMimotoMondaySettlement(scenario), planMimotoMondaySettlement(scenario));
});

test('un abono parcial cierra mora normal, luego nace mora extra y el siguiente cobro la prioriza', () => {
  const initial = {
    id: 'quota', due_date: '2026-07-13', week_number: 1,
    amount_due: 100, capital_paid: 0,
    late_fee_total: 10, late_fee: 10, late_fee_paid: 0,
    mora_extra_total: 0, mora_extra: 0, mora_extra_paid: 0,
    paid_amount: 0,
  };
  const firstPayment = distributePayment(initial, 12);
  const afterFirstPayment = projectQuotaAfterPayment(initial, firstPayment, '2026-07-20');
  assert.equal(afterFirstPayment.late_fee, 0);
  assert.equal(afterFirstPayment.capital_paid, 2);

  const accrued = calculateMimotoMoraAccrual({
    capitalBalance: 98,
    weeklyRate: 0.04,
    hasPayment: true,
    normalDays: 1,
    extraDays: 1,
    normalTotal: 10,
    normalPaid: 10,
  });
  assert.equal(accrued.mora_extra, 0.56);

  const withExtra = { ...afterFirstPayment, ...accrued };
  const secondPayment = distributePayment(withExtra, 1);
  assert.deepEqual(secondPayment, {
    applied: 1,
    unapplied: 0,
    lateFee: 0,
    extraLateFee: 0.56,
    capital: 0.44,
  });
});

const metricRules = [
  { id: 'base', viajes: '0-39', horas_minimas: 0 },
  { id: 'forty', viajes: '40-74', horas_minimas: 17 },
  { id: 'seventy-five', viajes: '75+', horas_minimas: 30 },
];

test('cronograma solo viajes conserva la selección por rangos', () => {
  assert.equal(selectMimotoRule(metricRules, { trips: 75, mode: 'viajes' })?.id, 'seventy-five');
  assert.equal(selectMimotoRule(metricRules, { trips: 40, mode: 'viajes' })?.id, 'forty');
});

test('cronograma combinado exige viajes y horas por umbral', () => {
  assert.equal(selectMimotoRule(metricRules, {
    trips: 75,
    connectedHours: 20,
    mode: 'viajes_horas',
  })?.id, 'forty');
  assert.equal(selectMimotoRule(metricRules, {
    trips: 75,
    connectedHours: 30,
    mode: 'viajes_horas',
  })?.id, 'seventy-five');
  assert.equal(selectMimotoRule(metricRules, {
    trips: 39,
    connectedHours: 30,
    mode: 'viajes_horas',
  })?.id, 'base');
  assert.throws(() => selectMimotoRule(metricRules, {
    trips: 75,
    mode: 'viajes_horas',
  }), /horas conectadas/);
});

test('el guard de SQL bloquea cualquier tabla de Mi Auto', () => {
  assert.equal(assertMimotoIsolationSql('SELECT * FROM module_mimoto_solicitud'), 'SELECT * FROM module_mimoto_solicitud');
  assert.throws(() => assertMimotoIsolationSql('SELECT * FROM module_miauto_solicitud'), /no puede consultar/);
});
