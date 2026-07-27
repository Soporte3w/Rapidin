import { mimotoDateOnly } from './mimotoDateUtils.js';

export const MIMOTO_DOCUMENT_TYPES = Object.freeze(['CC', 'CE', 'PPT']);
export const MIMOTO_CURRENCIES = Object.freeze(['COP', 'USD']);

export function isMimotoFirstWeek(quota) {
  return Number(quota?.week_number ?? quota?.weekNumber) === 1;
}

export function applyMimotoFirstWeekRule(quota) {
  if (!isMimotoFirstWeek(quota)) return { ...quota };
  const amountDue = roundMoney(Math.max(0, Number(quota?.amount_due) || 0));
  return {
    ...quota,
    capital_paid: amountDue,
    late_fee_total: 0,
    late_fee: 0,
    late_fee_paid: 0,
    mora_extra_total: 0,
    mora_extra: 0,
    mora_extra_paid: 0,
    paid_amount: amountDue,
    mora_extra_desde: null,
    mora_extra_calculated_through: null,
    pago_puntual: false,
    status: 'paid',
  };
}

export function roundMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

export function normalizeMimotoCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  if (!MIMOTO_CURRENCIES.includes(currency)) {
    throw new Error('La moneda debe ser COP o USD');
  }
  return currency;
}

export function normalizeColombianDocument(type, number) {
  const documentType = String(type || '').trim().toUpperCase();
  if (!MIMOTO_DOCUMENT_TYPES.includes(documentType)) {
    throw new Error('El tipo de documento debe ser CC, CE o PPT');
  }
  const documentNumber = String(number || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (documentNumber.length < 5 || documentNumber.length > 30) {
    throw new Error('El número de documento colombiano no es válido');
  }
  return { documentType, documentNumber };
}

export function normalizeColombianPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0057')) digits = digits.slice(2);
  if (digits.length === 10) digits = `57${digits}`;
  if (!/^57[0-9]{10}$/.test(digits)) {
    throw new Error('El teléfono debe tener 10 dígitos colombianos');
  }
  return digits;
}

export function convertMimotoAmount(amount, from, to, usdToCop) {
  const value = roundMoney(amount);
  const source = normalizeMimotoCurrency(from);
  const target = normalizeMimotoCurrency(to);
  if (value < 0) throw new Error('El monto no puede ser negativo');
  if (source === target) return value;
  const rate = Number(usdToCop);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('El tipo de cambio USD/COP no está configurado');
  }
  return source === 'USD' ? roundMoney(value * rate) : roundMoney(value / rate);
}

export function calculateLateFee({ base, weeklyRate, days }) {
  const principal = Math.max(0, Number(base) || 0);
  const dailyRate = Math.max(0, Number(weeklyRate) || 0) / 7;
  const elapsedDays = Math.max(0, Math.trunc(Number(days) || 0));
  return roundMoney(principal * dailyRate * elapsedDays);
}

export function calculateMimotoMoraAccrual({
  capitalBalance,
  weeklyRate,
  hasPayment,
  normalDays,
  extraDays,
  normalTotal = 0,
  normalPaid = 0,
  extraTotal = 0,
  extraPaid = 0,
}) {
  const normalIncrement = hasPayment ? 0 : calculateLateFee({
    base: capitalBalance,
    weeklyRate,
    days: normalDays,
  });
  const extraIncrement = hasPayment ? calculateLateFee({
    base: capitalBalance,
    weeklyRate,
    days: extraDays,
  }) : 0;
  const nextNormalTotal = roundMoney(Number(normalTotal || 0) + normalIncrement);
  const nextExtraTotal = roundMoney(Number(extraTotal || 0) + extraIncrement);
  return {
    late_fee_total: nextNormalTotal,
    late_fee: roundMoney(Math.max(0, nextNormalTotal - Number(normalPaid || 0))),
    mora_extra_total: nextExtraTotal,
    mora_extra: roundMoney(Math.max(0, nextExtraTotal - Number(extraPaid || 0))),
  };
}

export function calculateWeeklyCharge({
  baseAmount,
  payableAmount,
  revenueAmount = 0,
  additionalCharge = 0,
}) {
  const base = roundMoney(Math.max(0, Number(baseAmount) || 0));
  const payable = roundMoney(Math.max(0, Number(payableAmount) || 0));
  if (base <= 0 || payable <= 0 || payable > base) {
    throw new Error('La cuota base y la cuota con bono no son válidas');
  }
  const extra = roundMoney(Math.max(0, Number(additionalCharge) || 0));
  const obligation = roundMoney(payable + extra);
  const revenue = roundMoney(Math.min(obligation, Math.max(0, Number(revenueAmount) || 0)));
  return {
    weekly: base,
    bonus: roundMoney(base - payable),
    additionalCharge: extra,
    obligation,
    revenue,
    amountDue: roundMoney(obligation - revenue),
  };
}

export function resolveMimotoWeeklyMetrics({ mode, incomeTrips = 0, supply, supplyDriver }) {
  const tripsFromIncome = Math.max(0, Math.trunc(Number(incomeTrips) || 0));
  if (mode !== 'viajes_horas') {
    return { valid: true, trips: tripsFromIncome, connectedHours: null, warning: null };
  }
  if (!supply?.success) {
    return {
      valid: false,
      trips: 0,
      connectedHours: 0,
      warning: null,
      error: supply?.error || 'Fleet no pudo obtener las horas Supply',
    };
  }
  if (!supplyDriver) {
    return {
      valid: true,
      trips: tripsFromIncome,
      connectedHours: 0,
      warning: 'driver_sin_supply_asumido_cero',
    };
  }
  return {
    valid: true,
    trips: Math.max(0, Math.trunc(Number(supplyDriver.completed_trips) || 0)),
    connectedHours: roundMoney(Math.max(0, Number(supplyDriver.supply_hours) || 0)),
    warning: null,
  };
}

export function quotaBalances(quota) {
  if (isMimotoFirstWeek(quota)) {
    return { lateFee: 0, extraLateFee: 0, capital: 0 };
  }
  return {
    lateFee: roundMoney(Math.max(0, Number(quota.late_fee) || 0)),
    extraLateFee: roundMoney(Math.max(0, Number(quota.mora_extra) || 0)),
    capital: roundMoney(Math.max(0, (Number(quota.amount_due) || 0) - (Number(quota.capital_paid) || 0))),
  };
}

export function distributePayment(quota, paymentAmount) {
  let remaining = roundMoney(Math.max(0, Number(paymentAmount) || 0));
  const balances = quotaBalances(quota);

  const lateFee = Math.min(remaining, balances.lateFee);
  remaining = roundMoney(remaining - lateFee);
  const extraLateFee = Math.min(remaining, balances.extraLateFee);
  remaining = roundMoney(remaining - extraLateFee);
  const capital = Math.min(remaining, balances.capital);
  remaining = roundMoney(remaining - capital);

  return {
    applied: roundMoney(lateFee + extraLateFee + capital),
    unapplied: remaining,
    lateFee: roundMoney(lateFee),
    extraLateFee: roundMoney(extraLateFee),
    capital: roundMoney(capital),
  };
}

export function deriveQuotaStatus({ dueDate, balance, paidAmount = 0, today }) {
  if (roundMoney(balance) <= 0.005) return 'paid';
  const due = mimotoDateOnly(dueDate);
  const current = mimotoDateOnly(today);
  if (due && current && due < current) return 'overdue';
  return Number(paidAmount) > 0.005 ? 'partial' : 'pending';
}

function quotaDateValue(quota) {
  return mimotoDateOnly(quota?.due_date || quota?.dueDate || quota?.week_start_date);
}

function compareQuotasChronologically(left, right) {
  const dateComparison = quotaDateValue(left).localeCompare(quotaDateValue(right));
  if (dateComparison !== 0) return dateComparison;
  const weekComparison = Number(left?.week_number || 0) - Number(right?.week_number || 0);
  return weekComparison || String(left?.id || '').localeCompare(String(right?.id || ''));
}

export function projectQuotaAfterPayment(quota, distribution, today) {
  const next = {
    ...quota,
    capital_paid: roundMoney(Number(quota.capital_paid || 0) + distribution.capital),
    late_fee: roundMoney(Math.max(0, Number(quota.late_fee || 0) - distribution.lateFee)),
    late_fee_paid: roundMoney(Number(quota.late_fee_paid || 0) + distribution.lateFee),
    mora_extra: roundMoney(Math.max(0, Number(quota.mora_extra || 0) - distribution.extraLateFee)),
    mora_extra_paid: roundMoney(Number(quota.mora_extra_paid || 0) + distribution.extraLateFee),
    paid_amount: roundMoney(Number(quota.paid_amount || 0) + distribution.applied),
  };
  const balances = quotaBalances(next);
  next.status = deriveQuotaStatus({
    dueDate: quotaDateValue(next),
    balance: roundMoney(balances.lateFee + balances.extraLateFee + balances.capital),
    paidAmount: next.paid_amount,
    today,
  });
  return next;
}

export function simulatePaymentCascade(quotas, availableAmount, { asOf = null } = {}) {
  let remaining = roundMoney(Math.max(0, Number(availableAmount) || 0));
  const applications = [];
  const projectedById = new Map((quotas || []).map((quota) => [String(quota.id), { ...quota }]));
  const eligible = [...projectedById.values()]
    .filter((quota) => !asOf || !quotaDateValue(quota) || quotaDateValue(quota) <= asOf)
    .sort(compareQuotasChronologically);

  for (const quota of eligible) {
    if (remaining <= 0.005) break;
    const distribution = distributePayment(quota, remaining);
    if (distribution.applied <= 0.005) continue;
    applications.push({
      cuota_id: quota.id,
      week_number: quota.week_number ?? null,
      due_date: quotaDateValue(quota) || null,
      ...distribution,
    });
    projectedById.set(
      String(quota.id),
      projectQuotaAfterPayment(quota, distribution, asOf || quotaDateValue(quota))
    );
    remaining = distribution.unapplied;
  }
  return {
    requested: roundMoney(availableAmount),
    applied: roundMoney((Number(availableAmount) || 0) - remaining),
    remaining,
    applications,
    projectedQuotas: [...projectedById.values()].sort(compareQuotasChronologically),
  };
}

export function planMimotoMondaySettlement({
  existingQuotas = [],
  currentQuota,
  revenuePool = 0,
  fleetBalance = 0,
  asOf,
}) {
  if (!currentQuota?.id) throw new Error('La cuota actual es requerida para simular el lunes');
  const allQuotas = [...existingQuotas, currentQuota];
  const revenue = simulatePaymentCascade(allQuotas, revenuePool, { asOf });
  const fleet = simulatePaymentCascade(revenue.projectedQuotas, fleetBalance, { asOf });
  const currentId = String(currentQuota.id);
  const revenueCurrent = revenue.applications.find((item) => String(item.cuota_id) === currentId);
  const previousRevenueApplications = revenue.applications.filter(
    (item) => String(item.cuota_id) !== currentId
  );

  return {
    as_of: asOf,
    revenue: {
      ...revenue,
      current_applied: roundMoney(revenueCurrent?.applied || 0),
      previous_applications: previousRevenueApplications,
    },
    fleet,
    finalQuotas: fleet.projectedQuotas,
  };
}

export function planMimotoFleetCharge(quota, availableCop, usdToCop) {
  const safeAvailableCop = roundMoney(Math.max(0, Number(availableCop) || 0));
  const availableInQuotaCurrency = quota.moneda === 'COP'
    ? safeAvailableCop
    : convertMimotoAmount(safeAvailableCop, 'COP', 'USD', usdToCop);
  const distribution = distributePayment(quota, availableInQuotaCurrency);
  if (distribution.applied <= 0.005) return null;
  const amountCop = quota.moneda === 'COP'
    ? distribution.applied
    : convertMimotoAmount(distribution.applied, 'USD', 'COP', usdToCop);
  return {
    amount_cop: roundMoney(Math.min(safeAvailableCop, amountCop)),
    amount_quota_currency: distribution.applied,
    quota_currency: quota.moneda,
    distribution,
  };
}

export function assertMimotoIsolationSql(sql) {
  if (/module_miauto_/i.test(String(sql || ''))) {
    throw new Error('Mi Moto no puede consultar tablas de Mi Auto');
  }
  return sql;
}

export function parseMimotoRuleRange(value) {
  const text = String(value || '').trim();
  const numbers = text.match(/\d+/g)?.map(Number) || [];
  if (numbers.length === 0) return { min: 0, max: Number.POSITIVE_INFINITY };
  if (/\+|más|mas|desde|mayor/i.test(text) && numbers.length === 1) {
    return { min: numbers[0], max: Number.POSITIVE_INFINITY };
  }
  if (numbers.length === 1) return { min: numbers[0], max: numbers[0] };
  return { min: Math.min(numbers[0], numbers[1]), max: Math.max(numbers[0], numbers[1]) };
}

export function selectMimotoRule(rules, { trips, connectedHours = null, mode = 'viajes' }) {
  const normalizedTrips = Math.max(0, Number(trips) || 0);
  if (mode === 'viajes') {
    return (rules || []).find((rule) => {
      const range = parseMimotoRuleRange(rule.viajes);
      return normalizedTrips >= range.min && normalizedTrips <= range.max;
    }) || null;
  }
  if (mode !== 'viajes_horas') throw new Error('Modo de evaluación Mi Moto no válido');
  if (connectedHours == null || !Number.isFinite(Number(connectedHours)) || Number(connectedHours) < 0) {
    throw new Error('Las horas conectadas son requeridas para este cronograma');
  }
  const normalizedHours = Number(connectedHours);
  return [...(rules || [])]
    .map((rule) => ({ rule, minTrips: parseMimotoRuleRange(rule.viajes).min }))
    .sort((left, right) => right.minTrips - left.minTrips)
    .find(({ rule, minTrips }) => (
      normalizedTrips >= minTrips
      && normalizedHours >= Math.max(0, Number(rule.horas_minimas) || 0)
    ))?.rule || null;
}
