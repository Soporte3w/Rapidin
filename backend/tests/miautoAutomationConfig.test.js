import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
    timezone: 'America/Lima',
  });
  assert.equal(normalizeMiautoAutomationTime('07:15:00'), '07:15');
});

test('valida día y hora administrables', () => {
  assert.deepEqual(validateMiautoAutomationConfig({
    weekly_generation_enabled: false,
    weekly_generation_day: 6,
    weekly_generation_time: '21:30',
  }), {
    weekly_generation_enabled: false,
    weekly_generation_day: 6,
    weekly_generation_time: '21:30',
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
