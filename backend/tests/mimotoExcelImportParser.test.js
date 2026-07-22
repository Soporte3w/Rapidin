import assert from 'node:assert/strict';
import test from 'node:test';
import { mimotoExcelImportParserInternals } from '../yego_mimoto/services/mimotoExcelImportParser.js';

const {
  normalizeMoney,
  parseDate,
  parseIdentityAndPhone,
  parseTripsAndHours,
  repairSequenceDates,
} = mimotoExcelImportParserInternals;

test('expande solo montos semanales abreviados conocidos', () => {
  assert.deepEqual(normalizeMoney(139.5, { weekly: true }), { amount: 139500, corrected: true });
  assert.deepEqual(normalizeMoney(150, { weekly: true }), { amount: 150000, corrected: true });
  assert.deepEqual(normalizeMoney(321, { weekly: true }), { amount: 321, corrected: false });
});

test('normaliza inicial abreviada sin alterar montos completos', () => {
  assert.deepEqual(normalizeMoney(500), { amount: 500000, corrected: true });
  assert.deepEqual(normalizeMoney('$1.192.800'), { amount: 1192800, corrected: false });
});

test('extrae documento y teléfono colombiano', () => {
  assert.deepEqual(parseIdentityAndPhone('COL1143443696 / 3232978151'), {
    raw: 'COL1143443696 / 3232978151',
    documentType: 'CC',
    documentNumber: '1143443696',
    phone: '573232978151',
  });
  assert.equal(parseIdentityAndPhone('V25988919/ 573025777174').documentType, 'CE');
});

test('separa viajes y horas de la columna viaje-hora', () => {
  assert.deepEqual(parseTripsAndHours('27-22h'), {
    raw: '27-22h',
    trips: 27,
    observedHours: 22,
    recognized: true,
  });
  assert.equal(parseTripsAndHours('40 - 17').observedHours, 17);
  assert.equal(parseTripsAndHours('33-00:33h').observedHours, 0.55);
  assert.equal(parseTripsAndHours('1-15m').observedHours, 0.25);
  assert.deepEqual(parseTripsAndHours('95'), {
    raw: '95',
    trips: 95,
    observedHours: null,
    recognized: true,
  });
});

test('repara una fecha aislada usando las semanas vecinas', () => {
  const quotas = [
    { number: 1, date: '2026-03-16', dateRaw: '2026-03-16', dateMalformed: false },
    { number: 2, date: '2026-06-23', dateRaw: '2026-06-23', dateMalformed: false },
    { number: 3, date: '2026-03-30', dateRaw: '2026-03-30', dateMalformed: false },
  ];
  const warnings = [];
  repairSequenceDates(quotas, warnings);
  assert.equal(quotas[1].date, '2026-03-23');
  assert.equal(warnings[0].type, 'date_repaired_from_sequence');
});

test('acepta fechas ISO y marca formatos manuales para revisión contextual', () => {
  assert.deepEqual(parseDate('2026-07-20'), { date: '2026-07-20', malformed: false });
  assert.deepEqual(parseDate('27/004/2026'), { date: '2026-04-27', malformed: true });
});
