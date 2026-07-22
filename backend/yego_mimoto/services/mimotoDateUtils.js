import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

export function mimotoDateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return '';
    return `${value.getFullYear()}-${padDatePart(value.getMonth() + 1)}-${padDatePart(value.getDate())}`;
  }
  const text = String(value).trim();
  const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDate) return isoDate[1];
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? mimotoDateOnly(parsed) : '';
}

export function addMimotoDays(yyyyMmDd, days) {
  const [year, month, day] = String(yyyyMmDd).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + Number(days) * 86400000).toISOString().slice(0, 10);
}

export function mimotoMondayOf(yyyyMmDd) {
  const [year, month, day] = String(yyyyMmDd).split('-').map(Number);
  const sundayBased = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addMimotoDays(yyyyMmDd, -((sundayBased + 6) % 7));
}

export function mimotoToday(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MIMOTO_CONFIG.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function mimotoWeeklyContext(date = new Date()) {
  const cuotaWeekMonday = mimotoMondayOf(mimotoToday(date));
  const incomeWeekMonday = addMimotoDays(cuotaWeekMonday, -7);
  const incomeSunday = addMimotoDays(incomeWeekMonday, 6);
  return {
    cuotaWeekMonday,
    incomeWeekMonday,
    incomeSunday,
    dateFrom: `${incomeWeekMonday}T00:00:00-05:00`,
    dateTo: `${incomeSunday}T23:59:59-05:00`,
  };
}
