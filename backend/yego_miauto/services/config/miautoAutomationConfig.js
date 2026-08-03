import { getLimaYmd, weekdaysSinceMondayMon0 } from '../../../utils/miautoLimaWeekRange.js';

export const MIAUTO_AUTOMATION_TIMEZONE = 'America/Lima';

export const MIAUTO_AUTOMATION_DEFAULTS = Object.freeze({
  weekly_generation_enabled: true,
  weekly_generation_day: 1,
  weekly_generation_time: '06:00',
  weekly_fleet_charge_enabled: true,
  weekly_fleet_charge_day: 1,
  weekly_fleet_charge_time: '07:10',
  weekly_fleet_retry_enabled: true,
  weekly_fleet_retry_interval_minutes: 60,
  weekly_fleet_retry_max_attempts: 6,
  daily_additional_expenses_enabled: true,
  daily_additional_expenses_time: '02:15',
  timezone: MIAUTO_AUTOMATION_TIMEZONE,
});

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

function normalizeIntegerRange(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
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
  const generationDay = Number(value.weekly_generation_day);
  const fleetDay = Number(value.weekly_fleet_charge_day);
  return {
    weekly_generation_enabled: normalizeBoolean(
      value.weekly_generation_enabled,
      MIAUTO_AUTOMATION_DEFAULTS.weekly_generation_enabled,
    ),
    weekly_generation_day: Number.isInteger(generationDay) && generationDay >= 1 && generationDay <= 6
      ? generationDay
      : MIAUTO_AUTOMATION_DEFAULTS.weekly_generation_day,
    weekly_generation_time: normalizeMiautoAutomationTime(value.weekly_generation_time),
    weekly_fleet_charge_enabled: normalizeBoolean(
      value.weekly_fleet_charge_enabled,
      MIAUTO_AUTOMATION_DEFAULTS.weekly_fleet_charge_enabled,
    ),
    weekly_fleet_charge_day: Number.isInteger(fleetDay) && fleetDay >= 1 && fleetDay <= 6
      ? fleetDay
      : MIAUTO_AUTOMATION_DEFAULTS.weekly_fleet_charge_day,
    weekly_fleet_charge_time: normalizeMiautoAutomationTime(
      value.weekly_fleet_charge_time,
      MIAUTO_AUTOMATION_DEFAULTS.weekly_fleet_charge_time,
    ),
    weekly_fleet_retry_enabled: normalizeBoolean(
      value.weekly_fleet_retry_enabled,
      MIAUTO_AUTOMATION_DEFAULTS.weekly_fleet_retry_enabled,
    ),
    weekly_fleet_retry_interval_minutes: normalizeIntegerRange(
      value.weekly_fleet_retry_interval_minutes,
      MIAUTO_AUTOMATION_DEFAULTS.weekly_fleet_retry_interval_minutes,
      5,
      240,
    ),
    weekly_fleet_retry_max_attempts: normalizeIntegerRange(
      value.weekly_fleet_retry_max_attempts,
      MIAUTO_AUTOMATION_DEFAULTS.weekly_fleet_retry_max_attempts,
      1,
      12,
    ),
    daily_additional_expenses_enabled: normalizeBoolean(
      value.daily_additional_expenses_enabled,
      MIAUTO_AUTOMATION_DEFAULTS.daily_additional_expenses_enabled,
    ),
    daily_additional_expenses_time: normalizeMiautoAutomationTime(
      value.daily_additional_expenses_time,
      MIAUTO_AUTOMATION_DEFAULTS.daily_additional_expenses_time,
    ),
    timezone: MIAUTO_AUTOMATION_TIMEZONE,
  };
}

function validateWeeklySchedule(value, fields) {
  if (typeof value[fields.enabled] !== 'boolean') {
    throw new Error(`${fields.enabled} debe ser booleano`);
  }

  const day = Number(value[fields.day]);
  if (!Number.isInteger(day) || day < 1 || day > 6) {
    throw new Error(`${fields.day} debe estar entre 1 (lunes) y 6 (sábado)`);
  }

  const time = String(value[fields.time] || '').trim();
  if (!/^\d{2}:\d{2}$/.test(time) || normalizeMiautoAutomationTime(time, null) == null) {
    throw new Error(`${fields.time} debe tener formato HH:mm`);
  }

  return { enabled: value[fields.enabled], day, time };
}

function validateDailySchedule(value, fields) {
  if (typeof value[fields.enabled] !== 'boolean') {
    throw new Error(`${fields.enabled} debe ser booleano`);
  }

  const time = String(value[fields.time] || '').trim();
  if (!/^\d{2}:\d{2}$/.test(time) || normalizeMiautoAutomationTime(time, null) == null) {
    throw new Error(`${fields.time} debe tener formato HH:mm`);
  }

  return { enabled: value[fields.enabled], time };
}

export function validateMiautoAutomationConfig(value = {}) {
  const generation = validateWeeklySchedule(value, {
    enabled: 'weekly_generation_enabled',
    day: 'weekly_generation_day',
    time: 'weekly_generation_time',
  });
  const fleet = validateWeeklySchedule(value, {
    enabled: 'weekly_fleet_charge_enabled',
    day: 'weekly_fleet_charge_day',
    time: 'weekly_fleet_charge_time',
  });
  const additionalExpenses = validateDailySchedule(value, {
    enabled: 'daily_additional_expenses_enabled',
    time: 'daily_additional_expenses_time',
  });
  const retryEnabled = value.weekly_fleet_retry_enabled == null
    ? MIAUTO_AUTOMATION_DEFAULTS.weekly_fleet_retry_enabled
    : value.weekly_fleet_retry_enabled;
  if (typeof retryEnabled !== 'boolean') {
    throw new Error('weekly_fleet_retry_enabled debe ser booleano');
  }
  const retryInterval = Number(
    value.weekly_fleet_retry_interval_minutes
      ?? MIAUTO_AUTOMATION_DEFAULTS.weekly_fleet_retry_interval_minutes,
  );
  if (!Number.isInteger(retryInterval) || retryInterval < 5 || retryInterval > 240) {
    throw new Error('weekly_fleet_retry_interval_minutes debe estar entre 5 y 240');
  }
  const retryAttempts = Number(
    value.weekly_fleet_retry_max_attempts
      ?? MIAUTO_AUTOMATION_DEFAULTS.weekly_fleet_retry_max_attempts,
  );
  if (!Number.isInteger(retryAttempts) || retryAttempts < 1 || retryAttempts > 12) {
    throw new Error('weekly_fleet_retry_max_attempts debe estar entre 1 y 12');
  }

  return {
    weekly_generation_enabled: generation.enabled,
    weekly_generation_day: generation.day,
    weekly_generation_time: generation.time,
    weekly_fleet_charge_enabled: fleet.enabled,
    weekly_fleet_charge_day: fleet.day,
    weekly_fleet_charge_time: fleet.time,
    weekly_fleet_retry_enabled: retryEnabled,
    weekly_fleet_retry_interval_minutes: retryInterval,
    weekly_fleet_retry_max_attempts: retryAttempts,
    daily_additional_expenses_enabled: additionalExpenses.enabled,
    daily_additional_expenses_time: additionalExpenses.time,
    timezone: MIAUTO_AUTOMATION_TIMEZONE,
  };
}

function matchesWeeklySchedule(enabled, day, time, now) {
  if (!enabled) return false;
  const limaYmd = getLimaYmd(now);
  const isoWeekday = weekdaysSinceMondayMon0(limaYmd) + 1;
  return isoWeekday === day && limaTime(now) === time;
}

function limaTime(now) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: MIAUTO_AUTOMATION_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}

function minuteOfDay(time) {
  const [hour, minute] = String(time || '00:00').slice(0, 5).split(':').map(Number);
  return (hour * 60) + minute;
}

export function isMiautoFleetRetryWindow(configValue, now = new Date()) {
  const config = normalizeMiautoAutomationConfig(configValue);
  if (!config.weekly_fleet_charge_enabled || !config.weekly_fleet_retry_enabled) return false;
  const isoWeekday = weekdaysSinceMondayMon0(getLimaYmd(now)) + 1;
  if (isoWeekday !== config.weekly_fleet_charge_day) return false;
  return minuteOfDay(limaTime(now)) > minuteOfDay(config.weekly_fleet_charge_time);
}

export function decideMiautoFleetRetry(configValue, latestRun, now = new Date()) {
  const config = normalizeMiautoAutomationConfig(configValue);
  if (!isMiautoFleetRetryWindow(config, now)) return { due: false, reason: 'fuera_de_ventana' };
  if (!latestRun) {
    return { due: true, executionType: 'scheduled', attemptNumber: 0, reason: 'recuperacion_ejecucion_omitida' };
  }
  if (latestRun.status === 'running') return { due: false, reason: 'ejecucion_en_curso' };
  if (
    latestRun.status === 'completed'
    && Number(latestRun.remaining_count) <= 0
    && Number(latestRun.failed_count) <= 0
  ) {
    return { due: false, reason: 'sin_pendientes' };
  }

  const nextAttempt = Number(latestRun.attempt_number) + 1;
  if (nextAttempt > config.weekly_fleet_retry_max_attempts) {
    return { due: false, reason: 'maximo_reintentos_alcanzado' };
  }

  const referenceAt = new Date(latestRun.reference_at);
  const elapsedMinutes = (now.getTime() - referenceAt.getTime()) / 60000;
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < config.weekly_fleet_retry_interval_minutes) {
    return { due: false, reason: 'intervalo_pendiente' };
  }
  return { due: true, executionType: 'retry', attemptNumber: nextAttempt, reason: 'pendientes_por_reprocesar' };
}

export function matchesMiautoWeeklyGenerationSchedule(configValue, now = new Date()) {
  const config = normalizeMiautoAutomationConfig(configValue);
  return matchesWeeklySchedule(
    config.weekly_generation_enabled,
    config.weekly_generation_day,
    config.weekly_generation_time,
    now,
  );
}

export function matchesMiautoWeeklyFleetChargeSchedule(configValue, now = new Date()) {
  const config = normalizeMiautoAutomationConfig(configValue);
  return matchesWeeklySchedule(
    config.weekly_fleet_charge_enabled,
    config.weekly_fleet_charge_day,
    config.weekly_fleet_charge_time,
    now,
  );
}

export function matchesMiautoDailyAdditionalExpensesSchedule(configValue, now = new Date()) {
  const config = normalizeMiautoAutomationConfig(configValue);
  return config.daily_additional_expenses_enabled
    && limaTime(now) === config.daily_additional_expenses_time;
}

export function getMiautoWeeklyAutomationActions(configValue, now = new Date()) {
  const actions = [];
  if (matchesMiautoWeeklyGenerationSchedule(configValue, now)) actions.push('generation');
  if (matchesMiautoWeeklyFleetChargeSchedule(configValue, now)) actions.push('fleet');
  return actions;
}

export function getMiautoAutomationActions(configValue, now = new Date()) {
  const actions = [];
  if (matchesMiautoDailyAdditionalExpensesSchedule(configValue, now)) {
    actions.push('additional_expenses');
  }
  actions.push(...getMiautoWeeklyAutomationActions(configValue, now));
  return actions;
}
