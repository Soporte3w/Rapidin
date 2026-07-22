import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMimotoDays,
  mimotoDateOnly,
  mimotoMondayOf,
  mimotoWeeklyContext,
} from '../yego_mimoto/services/mimotoDateUtils.js';

test('la semana financiera Mi Moto usa lunes y métricas de la semana anterior', () => {
  const context = mimotoWeeklyContext(new Date('2026-07-27T12:00:00Z'));
  assert.equal(context.cuotaWeekMonday, '2026-07-27');
  assert.equal(context.incomeWeekMonday, '2026-07-20');
  assert.equal(context.incomeSunday, '2026-07-26');
  assert.equal(context.dateFrom, '2026-07-20T00:00:00-05:00');
  assert.equal(context.dateTo, '2026-07-26T23:59:59-05:00');
});

test('las utilidades de fecha no dependen de la zona horaria del servidor', () => {
  assert.equal(mimotoMondayOf('2026-07-22'), '2026-07-20');
  assert.equal(addMimotoDays('2026-07-31', 1), '2026-08-01');
});

test('normaliza fechas PostgreSQL y cadenas ISO al mismo día financiero', () => {
  assert.equal(mimotoDateOnly(new Date(2026, 6, 20)), '2026-07-20');
  assert.equal(mimotoDateOnly('2026-07-20T05:00:00.000Z'), '2026-07-20');
  assert.equal(mimotoDateOnly('sin-fecha'), '');
});
