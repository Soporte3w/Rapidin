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

export function buildGpsInstallments(year, amount = 47.2) {
  return Array.from({ length: 12 }, (_, index) => ({
    number: index + 1,
    dueDate: `${year}-${String(index + 1).padStart(2, '0')}-${daysInMonth(year, index)}`,
    amount: round2(amount),
  }));
}

export function buildSoatInstallments(expirationDate, amountPerInstallment = 50) {
  return [-4, -3, -2, -1].map((offset, index) => ({
    number: index + 1,
    dueDate: addMonthsClamped(expirationDate, offset),
    amount: round2(amountPerInstallment),
  }));
}

export function secondMonday(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstMonday = 1 + ((8 - first.getUTCDay()) % 7);
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(firstMonday + 7).padStart(2, '0')}`;
}

export function splitExact(total, count) {
  const cents = Math.round(Number(total) * 100);
  const base = Math.floor(cents / count);
  const remainder = cents - base * count;
  return Array.from({ length: count }, (_, index) => (base + (index < remainder ? 1 : 0)) / 100);
}

export function buildVehicleTaxInstallments(year, total) {
  const amounts = splitExact(total, 4);
  return [1, 4, 7, 10].map((monthIndex, index) => ({
    number: index + 1,
    dueDate: secondMonday(year, monthIndex),
    amount: amounts[index],
  }));
}

export function isVehicleTaxYearEligible(vehicleYear, periodYear) {
  const age = Number(periodYear) - Number(vehicleYear);
  return age >= 1 && age <= 3;
}

export function expenseStatus({ amountDue, paidAmount, dueDate, todayYmd }) {
  const balance = round2(Math.max(0, Number(amountDue) - Number(paidAmount)));
  if (balance <= 0.005) return 'paid';
  if (String(dueDate).slice(0, 10) < todayYmd) return 'overdue';
  if (Number(paidAmount) > 0.005) return 'partial';
  return 'pending';
}
