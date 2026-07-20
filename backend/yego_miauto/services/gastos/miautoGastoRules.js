const DAY_MS = 24 * 60 * 60 * 1000;

function round2(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function parseYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim());
  if (!match) throw new Error(`Fecha invalida: ${value || 'vacia'}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonthsClamped(value, months) {
  const date = parseYmd(value);
  const day = date.getUTCDate();
  const anchor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  anchor.setUTCDate(Math.min(day, daysInMonth(anchor.getUTCFullYear(), anchor.getUTCMonth())));
  return toYmd(anchor);
}

function addDays(value, days) {
  const date = parseYmd(value);
  return toYmd(new Date(date.getTime() + Number(days) * DAY_MS));
}

export function contractEndDate(startDate, totalWeeks) {
  const weeks = Number(totalWeeks);
  if (!Number.isInteger(weeks) || weeks <= 0) return null;
  return addDays(startDate, (weeks - 1) * 7);
}

export function nextMonthEnd(value) {
  const date = parseYmd(value);
  const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 0));
  return toYmd(nextMonth);
}

export function installmentsWithinRange(installments, startDate, endDate) {
  return installments
    .filter(({ dueDate }) => (
      (!startDate || dueDate >= startDate) && (!endDate || dueDate <= endDate)
    ))
    .map((installment, index) => ({ ...installment, number: index + 1 }));
}

export function recurringReferenceDate(referenceDate, periodYear) {
  const referenceYear = parseYmd(referenceDate).getUTCFullYear();
  return replaceYearClamped(referenceDate, Math.max(referenceYear, Number(periodYear)));
}

export function replaceYearClamped(value, year) {
  const date = parseYmd(value);
  const targetYear = Number(year);
  if (!Number.isInteger(targetYear)) throw new Error(`Ano invalido: ${year}`);
  const monthIndex = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), daysInMonth(targetYear, monthIndex));
  return `${targetYear}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function nextMonday(value) {
  const date = parseYmd(value);
  const weekday = date.getUTCDay();
  const days = weekday === 1 ? 7 : (8 - weekday) % 7;
  return toYmd(new Date(date.getTime() + days * DAY_MS));
}

export function buildWeeklyInstallments(startDate, count, amount) {
  const first = parseYmd(startDate);
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    dueDate: toYmd(new Date(first.getTime() + index * 7 * DAY_MS)),
    amount: round2(amount),
  }));
}

export function buildGpsInstallments(year, amount) {
  return Array.from({ length: 12 }, (_, index) => ({
    number: index + 1,
    dueDate: `${year}-${String(index + 1).padStart(2, '0')}-${daysInMonth(year, index)}`,
    amount: round2(amount),
  }));
}

export function buildSoatInstallments(
  expirationDate,
  installmentAmount,
  installmentCount,
  monthsBeforeExpiration
) {
  const count = Number(installmentCount);
  const monthsBefore = Number(monthsBeforeExpiration);
  if (!Number.isInteger(count) || count <= 0) throw new Error('Cantidad de cuotas SOAT invalida');
  if (!Number.isInteger(monthsBefore) || monthsBefore < count) {
    throw new Error('Meses de anticipacion SOAT invalidos');
  }
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    dueDate: addMonthsClamped(expirationDate, index - monthsBefore),
    amount: round2(installmentAmount),
  }));
}

function secondMonday(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstMonday = 1 + ((8 - first.getUTCDay()) % 7);
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(firstMonday + 7).padStart(2, '0')}`;
}

function splitExact(total, count) {
  const cents = Math.round(Number(total) * 100);
  const base = Math.floor(cents / count);
  const remainder = cents - base * count;
  return Array.from({ length: count }, (_, index) => (base + (index < remainder ? 1 : 0)) / 100);
}

export function buildVehicleTaxInstallments(year, total, startMonth, installmentCount) {
  const count = Number(installmentCount);
  const firstMonth = Number(startMonth);
  if (!Number.isInteger(count) || count <= 0 || count > 12) {
    throw new Error('Cantidad de cuotas de impuesto vehicular invalida');
  }
  if (!Number.isInteger(firstMonth) || firstMonth < 1 || firstMonth > 12) {
    throw new Error('Mes inicial de impuesto vehicular invalido');
  }
  const amounts = splitExact(total, count);
  const interval = 12 / count;
  if (!Number.isInteger(interval)) throw new Error('Las cuotas del impuesto deben distribuirse uniformemente en el ano');
  if (firstMonth - 1 + (count - 1) * interval > 11) {
    throw new Error('El calendario del impuesto excede el ano configurado');
  }
  return amounts.map((amount, index) => ({
    number: index + 1,
    dueDate: secondMonday(year, firstMonth - 1 + index * interval),
    amount,
  }));
}

export function isVehicleTaxYearEligible(vehicleYear, periodYear, eligibleYears) {
  const age = Number(periodYear) - Number(vehicleYear);
  return age >= 1 && age <= Number(eligibleYears);
}

export function expenseStatus({ amountDue, paidAmount, dueDate, todayYmd }) {
  const balance = round2(Math.max(0, Number(amountDue) - Number(paidAmount)));
  if (balance <= 0.005) return 'paid';
  if (String(dueDate).slice(0, 10) < todayYmd) return 'overdue';
  if (Number(paidAmount) > 0.005) return 'partial';
  return 'pending';
}

export function availableFleetCharge(pendingAmount, fleetBalance) {
  const pending = round2(Math.max(0, Number(pendingAmount) || 0));
  const balance = round2(Math.max(0, Number(fleetBalance) || 0));
  return round2(Math.min(pending, balance));
}
