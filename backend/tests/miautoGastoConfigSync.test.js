import assert from 'node:assert/strict';
import test from 'node:test';
import {
  amountChanged,
  configuredExpenseAmount,
  resolveEffectiveExpenseConfiguration,
} from '../yego_miauto/services/gastos/miautoGastoConfigSync.js';

const requirements = {
  gps: { monto: 63.75 },
  soat: { monto: 200, cobro: { meses_anticipo: 5 } },
  src: { monto: 45 },
  impuesto_vehicular: { monto: 990, cobro: { cuotas: 4 } },
  todo_riesgo_mas_gps_agrupado: { monto: 31.5 },
  inicial_parcial: { monto: 19.23 },
};

test('resuelve montos directos configurados por concepto', () => {
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'gps' }), 63.75);
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'src' }), 45);
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'str_gps' }), 31.5);
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'todo_riesgo_mas_gps_agrupado' }), 31.5);
  assert.equal(configuredExpenseAmount(requirements, { tipo: 'inicial_parcial' }), 19.23);
});

test('divide el monto total del SOAT entre los meses configurados', () => {
  const amounts = Array.from({ length: 5 }, (_, index) => configuredExpenseAmount(requirements, {
    tipo: 'soat', numero_cuota: index + 1, total_cuotas: 5,
  }));
  assert.deepEqual(amounts, [40, 40, 40, 40, 40]);
  assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), 200);
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

test('la configuración efectiva hereda datos del vehículo sin reemplazar overrides del contrato', () => {
  const inherited = resolveEffectiveExpenseConfiguration({
    vehiculo_name: 'Glory 560 - 2026',
    vehiculo_anio: null,
    str_gps_monto_semanal: null,
    str_gps_moneda: 'USD',
    requisitos_gastos: {
      todo_riesgo_mas_gps_agrupado: { monto: 25.31, moneda: 'PEN' },
    },
  });
  assert.equal(inherited.vehiculo_anio, 2026);
  assert.equal(inherited.str_gps_heredado, true);
  assert.equal(inherited.str_gps_monto_semanal, 25.31);
  assert.equal(inherited.str_gps_moneda, 'PEN');

  const overridden = resolveEffectiveExpenseConfiguration({
    vehiculo_name: 'Glory 560 - 2026',
    vehiculo_anio: 2025,
    str_gps_monto_semanal: 30,
    str_gps_moneda: 'USD',
    requisitos_gastos: {
      todo_riesgo_mas_gps_agrupado: { monto: 25.31, moneda: 'PEN' },
    },
  });
  assert.equal(overridden.vehiculo_anio, 2025);
  assert.equal(overridden.str_gps_heredado, false);
  assert.equal(overridden.str_gps_monto_semanal, 30);
  assert.equal(overridden.str_gps_moneda, 'USD');
});
