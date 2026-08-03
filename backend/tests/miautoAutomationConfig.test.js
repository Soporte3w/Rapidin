import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideMiautoFleetRetry,
  getMiautoAutomationActions,
  getMiautoWeeklyAutomationActions,
  isMiautoFleetRetryWindow,
  matchesMiautoDailyAdditionalExpensesSchedule,
  matchesMiautoWeeklyFleetChargeSchedule,
  matchesMiautoWeeklyGenerationSchedule,
  normalizeMiautoAutomationConfig,
  normalizeMiautoAutomationTime,
  validateMiautoAutomationConfig,
} from '../yego_miauto/services/config/miautoAutomationConfig.js';

test('normaliza la configuración histórica al horario vigente', () => {
  assert.deepEqual(normalizeMiautoAutomationConfig({}), {
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
    timezone: 'America/Lima',
  });
  assert.equal(normalizeMiautoAutomationTime('07:15:00'), '07:15');
});

test('valida día y hora administrables', () => {
  assert.deepEqual(validateMiautoAutomationConfig({
    weekly_generation_enabled: false,
    weekly_generation_day: 6,
    weekly_generation_time: '21:30',
    weekly_fleet_charge_enabled: true,
    weekly_fleet_charge_day: 6,
    weekly_fleet_charge_time: '22:40',
    weekly_fleet_retry_enabled: true,
    weekly_fleet_retry_interval_minutes: 45,
    weekly_fleet_retry_max_attempts: 4,
    daily_additional_expenses_enabled: false,
    daily_additional_expenses_time: '03:25',
  }), {
    weekly_generation_enabled: false,
    weekly_generation_day: 6,
    weekly_generation_time: '21:30',
    weekly_fleet_charge_enabled: true,
    weekly_fleet_charge_day: 6,
    weekly_fleet_charge_time: '22:40',
    weekly_fleet_retry_enabled: true,
    weekly_fleet_retry_interval_minutes: 45,
    weekly_fleet_retry_max_attempts: 4,
    daily_additional_expenses_enabled: false,
    daily_additional_expenses_time: '03:25',
    timezone: 'America/Lima',
  });

  assert.throws(
    () => validateMiautoAutomationConfig({
      weekly_generation_enabled: true,
      weekly_generation_day: 0,
      weekly_generation_time: '06:00',
    }),
    /entre 1 \(lunes\) y 6 \(sábado\)/,
  );
  assert.throws(
    () => validateMiautoAutomationConfig({
      weekly_generation_enabled: true,
      weekly_generation_day: 1,
      weekly_generation_time: '25:00',
    }),
    /formato HH:mm/,
  );
  assert.throws(
    () => validateMiautoAutomationConfig({
      weekly_generation_enabled: true,
      weekly_generation_day: 1,
      weekly_generation_time: '06:00',
      weekly_fleet_charge_enabled: true,
      weekly_fleet_charge_day: 7,
      weekly_fleet_charge_time: '07:10',
    }),
    /weekly_fleet_charge_day debe estar entre 1/,
  );
  assert.throws(
    () => validateMiautoAutomationConfig({
      weekly_generation_enabled: true,
      weekly_generation_day: 1,
      weekly_generation_time: '06:00',
      weekly_fleet_charge_enabled: true,
      weekly_fleet_charge_day: 1,
      weekly_fleet_charge_time: '07:10',
      daily_additional_expenses_enabled: true,
      daily_additional_expenses_time: '24:00',
    }),
    /daily_additional_expenses_time debe tener formato HH:mm/,
  );
  assert.throws(
    () => validateMiautoAutomationConfig({
      weekly_generation_enabled: true,
      weekly_generation_day: 1,
      weekly_generation_time: '06:00',
      weekly_fleet_charge_enabled: true,
      weekly_fleet_charge_day: 1,
      weekly_fleet_charge_time: '07:10',
      weekly_fleet_retry_interval_minutes: 2,
      daily_additional_expenses_enabled: true,
      daily_additional_expenses_time: '02:15',
    }),
    /retry_interval_minutes debe estar entre 5 y 240/,
  );
});

test('ejecuta únicamente en el minuto configurado de Lima', () => {
  const mondaySixLima = new Date('2026-07-27T11:00:00.000Z');
  const mondaySixOhOneLima = new Date('2026-07-27T11:01:00.000Z');
  const config = {
    weekly_generation_enabled: true,
    weekly_generation_day: 1,
    weekly_generation_time: '06:00',
  };

  assert.equal(matchesMiautoWeeklyGenerationSchedule(config, mondaySixLima), true);
  assert.equal(matchesMiautoWeeklyGenerationSchedule(config, mondaySixOhOneLima), false);
  assert.equal(matchesMiautoWeeklyGenerationSchedule({ ...config, weekly_generation_enabled: false }, mondaySixLima), false);
});

test('respeta un día y hora distintos sin reiniciar el scheduler', () => {
  const wednesdayAtNineLima = new Date('2026-07-29T14:00:00.000Z');
  assert.equal(matchesMiautoWeeklyGenerationSchedule({
    weekly_generation_enabled: true,
    weekly_generation_day: 3,
    weekly_generation_time: '09:00',
  }, wednesdayAtNineLima), true);
});

test('el cobro Fleet usa su propia programación administrable', () => {
  const mondaySevenTenLima = new Date('2026-07-27T12:10:00.000Z');
  const config = {
    weekly_fleet_charge_enabled: true,
    weekly_fleet_charge_day: 1,
    weekly_fleet_charge_time: '07:10',
  };

  assert.equal(matchesMiautoWeeklyFleetChargeSchedule(config, mondaySevenTenLima), true);
  assert.equal(matchesMiautoWeeklyGenerationSchedule(config, mondaySevenTenLima), false);
  assert.equal(matchesMiautoWeeklyFleetChargeSchedule({
    ...config,
    weekly_fleet_charge_enabled: false,
  }, mondaySevenTenLima), false);
});

test('abre reintentos solo después del cobro y en el mismo día configurado', () => {
  const config = {
    weekly_fleet_charge_enabled: true,
    weekly_fleet_charge_day: 1,
    weekly_fleet_charge_time: '07:10',
    weekly_fleet_retry_enabled: true,
  };
  assert.equal(isMiautoFleetRetryWindow(config, new Date('2026-08-03T12:10:00.000Z')), false);
  assert.equal(isMiautoFleetRetryWindow(config, new Date('2026-08-03T12:11:00.000Z')), true);
  assert.equal(isMiautoFleetRetryWindow(config, new Date('2026-08-04T13:00:00.000Z')), false);
  assert.equal(isMiautoFleetRetryWindow({ ...config, weekly_fleet_retry_enabled: false }, new Date('2026-08-03T13:00:00.000Z')), false);
});

test('recupera una ejecución omitida y reintenta únicamente tras el intervalo', () => {
  const config = {
    weekly_fleet_charge_enabled: true,
    weekly_fleet_charge_day: 1,
    weekly_fleet_charge_time: '07:10',
    weekly_fleet_retry_enabled: true,
    weekly_fleet_retry_interval_minutes: 60,
    weekly_fleet_retry_max_attempts: 6,
  };
  const now = new Date('2026-08-03T13:30:00.000Z');
  assert.deepEqual(decideMiautoFleetRetry(config, null, now), {
    due: true,
    executionType: 'scheduled',
    attemptNumber: 0,
    reason: 'recuperacion_ejecucion_omitida',
  });
  assert.deepEqual(decideMiautoFleetRetry(config, {
    status: 'completed',
    attempt_number: 0,
    remaining_count: 2,
    failed_count: 2,
    reference_at: '2026-08-03T13:00:00.000Z',
  }, now), { due: false, reason: 'intervalo_pendiente' });
  assert.deepEqual(decideMiautoFleetRetry(config, {
    status: 'completed',
    attempt_number: 0,
    remaining_count: 2,
    failed_count: 2,
    reference_at: '2026-08-03T12:00:00.000Z',
  }, now), {
    due: true,
    executionType: 'retry',
    attemptNumber: 1,
    reason: 'pendientes_por_reprocesar',
  });
});

test('si ambos horarios coinciden ordena generación antes de Fleet', () => {
  const mondaySixLima = new Date('2026-07-27T11:00:00.000Z');
  assert.deepEqual(getMiautoWeeklyAutomationActions({
    weekly_generation_enabled: true,
    weekly_generation_day: 1,
    weekly_generation_time: '06:00',
    weekly_fleet_charge_enabled: true,
    weekly_fleet_charge_day: 1,
    weekly_fleet_charge_time: '06:00',
  }, mondaySixLima), ['generation', 'fleet']);
});

test('otros gastos usa una hora diaria administrable', () => {
  const fridayTwoFifteenLima = new Date('2026-07-31T07:15:00.000Z');
  const saturdayTwoFifteenLima = new Date('2026-08-01T07:15:00.000Z');
  const config = {
    daily_additional_expenses_enabled: true,
    daily_additional_expenses_time: '02:15',
  };

  assert.equal(matchesMiautoDailyAdditionalExpensesSchedule(config, fridayTwoFifteenLima), true);
  assert.equal(matchesMiautoDailyAdditionalExpensesSchedule(config, saturdayTwoFifteenLima), true);
  assert.equal(matchesMiautoDailyAdditionalExpensesSchedule({
    ...config,
    daily_additional_expenses_enabled: false,
  }, fridayTwoFifteenLima), false);
});

test('si coinciden ejecuta otros gastos antes de generación y Fleet', () => {
  const mondaySixLima = new Date('2026-07-27T11:00:00.000Z');
  assert.deepEqual(getMiautoAutomationActions({
    daily_additional_expenses_enabled: true,
    daily_additional_expenses_time: '06:00',
    weekly_generation_enabled: true,
    weekly_generation_day: 1,
    weekly_generation_time: '06:00',
    weekly_fleet_charge_enabled: true,
    weekly_fleet_charge_day: 1,
    weekly_fleet_charge_time: '06:00',
  }, mondaySixLima), ['additional_expenses', 'generation', 'fleet']);
});
