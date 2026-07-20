import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRequisitosGastosVehiculo } from '../yego_miauto/services/cronograma/miautoCronogramaService.js';

test('no inventa montos ni plazos cuando el cronograma no los configura', () => {
  const config = parseRequisitosGastosVehiculo(null);
  assert.equal(config.gps.monto, 0);
  assert.equal(config.soat.cobro.cuotas, 0);
  assert.equal(config.soat.cobro.meses_anticipo, 0);
  assert.equal(config.impuesto_vehicular.cobro.cuotas, 0);
  assert.equal(config.todo_riesgo_mas_gps_agrupado.cobro.semanas, 0);
  assert.equal(config.inicial_parcial.monto, 0);
  assert.equal(config.inicial_parcial.cobro.semanas, 0);
});

test('conserva la configuracion de negocio persistida por vehiculo', () => {
  const config = parseRequisitosGastosVehiculo({
    gps: { monto: 51.4, moneda: 'PEN' },
    soat: {
      monto: 210,
      moneda: 'PEN',
      cobro: { cuotas: 5, meses_anticipo: 6 },
    },
    impuesto_vehicular: {
      monto: 900,
      moneda: 'PEN',
      cobro: { mes_inicio: 3, cuotas: 3, anios_vigencia_tras_modelo: 2 },
    },
    todo_riesgo_mas_gps_agrupado: {
      monto: 25,
      moneda: 'USD',
      cobro: { semanas: 30 },
    },
    inicial_parcial: {
      monto: 20,
      moneda: 'USD',
      cobro: { semanas: 24 },
    },
  });

  assert.equal(config.gps.monto, 51.4);
  assert.deepEqual(config.soat.cobro, {
    tipo: 'mensual_antes_vencimiento',
    meses_anticipo: 6,
    cuotas: 5,
  });
  assert.deepEqual(config.impuesto_vehicular.cobro, {
    tipo: 'sat_febrero_cuotas',
    mes_inicio: 3,
    cuotas: 3,
    anios_vigencia_tras_modelo: 2,
  });
  assert.equal(config.todo_riesgo_mas_gps_agrupado.cobro.semanas, 30);
  assert.equal(config.inicial_parcial.monto, 20);
  assert.equal(config.inicial_parcial.cobro.semanas, 24);
  assert.equal(Object.hasOwn(config, 'todo_riesgo'), false);
});
