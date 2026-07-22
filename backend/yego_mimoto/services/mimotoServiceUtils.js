import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';
import { roundMoney } from './mimotoFinancialEngine.js';

export function positiveNumber(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} debe ser mayor que cero`);
  return roundMoney(parsed);
}

export function bogotaToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MIMOTO_CONFIG.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function addDays(dateYmd, days) {
  const date = new Date(`${dateYmd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
