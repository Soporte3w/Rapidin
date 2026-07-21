import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cronogramaPermitePagoInicial,
  getTiposPagoInicialPermitidos,
  parseRequisitosGastosVehiculo,
  parseRequisitosVehiculo,
} from '../yego_miauto/services/cronograma/miautoCronogramaService.js';

test('cronogramas antiguos mantienen ambas modalidades de pago inicial', () => {
  const requirements = parseRequisitosVehiculo({ tipo_vehiculo: 'nuevo' });
  assert.deepEqual(requirements.modalidades_pago_inicial, { completo: true, parcial: true });
  assert.deepEqual(getTiposPagoInicialPermitidos(requirements), ['completo', 'parcial']);
});

test('respeta la unica modalidad de pago inicial configurada', () => {
  const requirements = parseRequisitosVehiculo({
    tipo_vehiculo: 'seminuevo',
    modalidades_pago_inicial: { completo: false, parcial: true },
  });
  assert.equal(requirements.tipo_vehiculo, 'seminuevo');
  assert.deepEqual(getTiposPagoInicialPermitidos(requirements), ['parcial']);
  assert.equal(cronogramaPermitePagoInicial(requirements, 'parcial'), true);
  assert.equal(cronogramaPermitePagoInicial(requirements, 'completo'), false);
});

test('no inventa montos ni plazos cuando el cronograma no los configura', () => {
  const config = parseRequisitosGastosVehiculo(null);
  assert.equal(config.gps.monto, 0);
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
