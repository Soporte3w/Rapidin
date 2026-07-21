import assert from 'node:assert/strict';
import test from 'node:test';
import {
  amountChanged,
  configuredExpenseAmount,
} from '../yego_miauto/services/gastos/miautoGastoConfigSync.js';

const requirements = {
  gps: { monto: 63.75 },
  soat: { monto: 200 },
  src: { monto: 45 },
  impuesto_vehicular: { monto: 990, cobro: { cuotas: 4 } },
  todo_riesgo_mas_gps_agrupado: { monto: 31.5 },
  inicial_parcial: { monto: 19.23 },
};

test('resuelve montos directos configurados por concepto', () => {
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'gps' }), 63.75);
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'soat' }), 200);
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'src' }), 45);
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'str_gps' }), 31.5);
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'todo_riesgo_mas_gps_agrupado' }), 31.5);
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'inicial_parcial' }), 19.23);
});

test('divide el impuesto entre las cuotas existentes sin perder centavos', () => {
  const amounts = Array.from({ length: 4 }, (_, index) => configuredExpenseAmount(requirements, {
    tipo: 'impuesto_vehicular',
    numero_cuota: index + 1,
    total_cuotas: 4,
  }));
  assert.deepEqual(amounts, [247.5, 247.5, 247.5, 247.5]);
  assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), 990);
});

test('reparte centavos del impuesto de forma exacta', () => {
  const custom = { impuesto_vehicular: { monto: 100, cobro: { cuotas: 3 } } };
  const amounts = [1, 2, 3].map((numero_cuota) => configuredExpenseAmount(custom, {
    tipo: 'impuesto_vehicular', numero_cuota, total_cuotas: 3,
  }));
  assert.deepEqual(amounts, [33.34, 33.33, 33.33]);
  assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), 100);
});

test('ignora conceptos sin monto y compara importes con tolerancia monetaria', () => {
  assert.equal(configuredExpenseAmount({}, { tipo: 'gps' }), null);
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'generico' }), null);
  assert.equal(amountChanged(47.2, 47.2), false);
  assert.equal(amountChanged(47.2, 50), true);
  assert.equal(amountChanged(47.2, null), false);
});
