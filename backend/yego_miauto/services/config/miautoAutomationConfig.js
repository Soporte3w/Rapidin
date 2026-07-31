import { getLimaYmd, weekdaysSinceMondayMon0 } from '../../../utils/miautoLimaWeekRange.js';

export const MIAUTO_AUTOMATION_TIMEZONE = 'America/Lima';

export const MIAUTO_AUTOMATION_DEFAULTS = Object.freeze({
  weekly_generation_enabled: true,
  weekly_generation_day: 1,
  weekly_generation_time: '06:00',
  timezone: MIAUTO_AUTOMATION_TIMEZONE,
});

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

export function normalizeMiautoAutomationTime(value, fallback = MIAUTO_AUTOMATION_DEFAULTS.weekly_generation_time) {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return `${match[1]}:${match[2]}`;
}

export function normalizeMiautoAutomationConfig(value = {}) {
  const day = Number(value.weekly_generation_day);
  return {
    weekly_generation_enabled: normalizeBoolean(
      value.weekly_generation_enabled,
      MIAUTO_AUTOMATION_DEFAULTS.weekly_generation_enabled,
    ),
    weekly_generation_day: Number.isInteger(day) && day >= 1 && day <= 6
      ? day
      : MIAUTO_AUTOMATION_DEFAULTS.weekly_generation_day,
    weekly_generation_time: normalizeMiautoAutomationTime(value.weekly_generation_time),
    timezone: MIAUTO_AUTOMATION_TIMEZONE,
  };
}

export function validateMiautoAutomationConfig(value = {}) {
  if (typeof value.weekly_generation_enabled !== 'boolean') {
    throw new Error('weekly_generation_enabled debe ser booleano');
  }

  const day = Number(value.weekly_generation_day);
  if (!Number.isInteger(day) || day < 1 || day > 6) {
    throw new Error('weekly_generation_day debe estar entre 1 (lunes) y 6 (sábado)');
  }

  const time = String(value.weekly_generation_time || '').trim();
  if (!/^\d{2}:\d{2}$/.test(time) || normalizeMiautoAutomationTime(time, null) == null) {
    throw new Error('weekly_generation_time debe tener formato HH:mm');
  }

  return {
    weekly_generation_enabled: value.weekly_generation_enabled,
    weekly_generation_day: day,
    weekly_generation_time: time,
    timezone: MIAUTO_AUTOMATION_TIMEZONE,
  };
}

export function matchesMiautoWeeklyGenerationSchedule(configValue, now = new Date()) {
  const config = normalizeMiautoAutomationConfig(configValue);
  if (!config.weekly_generation_enabled) return false;

  const limaYmd = getLimaYmd(now);
  const isoWeekday = weekdaysSinceMondayMon0(limaYmd) + 1;
  const limaTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: MIAUTO_AUTOMATION_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);

  return isoWeekday === config.weekly_generation_day
    && limaTime === config.weekly_generation_time;
}
