import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analizarRachaBonoTiempo,
  buildResumenBonoTiempo,
} from '../yego_miauto/services/bonos/miautoBonoTiempoService.js';

const DEPOSIT_WEEK = '2026-06-22';

function cuota(weekStart, overrides = {}) {
  return {
    id: weekStart,
    week_start_date: weekStart,
    due_date: weekStart,
    status: 'paid',
    pago_puntual: true,
    num_viajes: 120,
    ...overrides,
  };
}

test('excluye la primera semana y consolida cuatro checks consecutivos', () => {
  const result = analizarRachaBonoTiempo([
    cuota('2026-06-22'),
    cuota('2026-06-29'),
    cuota('2026-07-06'),
    cuota('2026-07-13'),
    cuota('2026-07-20'),
  ], DEPOSIT_WEEK, { cutoffYmd: '2026-07-24' });

  assert.equal(result.blocks.length, 1);
  assert.equal(result.progress, 0);
  assert.deepEqual(result.blocks[0].map((row) => row.week_start_date), [
    '2026-06-29',
    '2026-07-06',
    '2026-07-13',
    '2026-07-20',
  ]);
});

test('un check faltante elimina la racha anterior y el siguiente inicia en uno', () => {
  const result = analizarRachaBonoTiempo([
    cuota('2026-06-29'),
    cuota('2026-07-06'),
    cuota('2026-07-13'),
    cuota('2026-07-20', { pago_puntual: false }),
    cuota('2026-07-27'),
  ], DEPOSIT_WEEK, { cutoffYmd: '2026-07-27' });

  assert.equal(result.blocks.length, 0);
  assert.equal(result.progress, 1);
});

test('las cuotas futuras pendientes no reinician la racha vigente', () => {
  const result = analizarRachaBonoTiempo([
    cuota('2026-06-29'),
    cuota('2026-07-06'),
    cuota('2026-07-13'),
    cuota('2026-07-20', { status: 'pending', pago_puntual: false, num_viajes: 0 }),
    cuota('2026-07-27', { status: 'pending', pago_puntual: false, num_viajes: 0 }),
  ], DEPOSIT_WEEK, { cutoffYmd: '2026-07-19' });

  assert.equal(result.blocks.length, 0);
  assert.equal(result.progress, 3);
});

test('una cuota exigible sin check reinicia la racha aunque esté pagada', () => {
  const result = analizarRachaBonoTiempo([
    cuota('2026-06-29'),
    cuota('2026-07-06'),
    cuota('2026-07-13', { pago_puntual: false }),
  ], DEPOSIT_WEEK, { cutoffYmd: '2026-07-13' });

  assert.equal(result.blocks.length, 0);
  assert.equal(result.progress, 0);
});

test('menos de 120 viajes rompe la secuencia aunque exista check', () => {
  const result = analizarRachaBonoTiempo([
    cuota('2026-06-29'),
    cuota('2026-07-06', { num_viajes: 119 }),
    cuota('2026-07-13'),
  ], DEPOSIT_WEEK, { cutoffYmd: '2026-07-13' });

  assert.equal(result.blocks.length, 0);
  assert.equal(result.progress, 1);
});

test('ordena correctamente fechas Date devueltas por PostgreSQL', () => {
  const result = analizarRachaBonoTiempo([
    cuota(new Date('2026-07-13T05:00:00.000Z'), { id: 'semana-4' }),
    cuota(new Date('2026-06-22T05:00:00.000Z'), { id: 'deposito' }),
    cuota(new Date('2026-06-29T05:00:00.000Z'), { id: 'semana-2' }),
    cuota(new Date('2026-07-06T05:00:00.000Z'), { id: 'semana-3' }),
  ], DEPOSIT_WEEK, { cutoffYmd: '2026-07-24' });

  assert.equal(result.blocks.length, 0);
  assert.equal(result.progress, 3);
});

test('no reutiliza cuotas de un bono que ya fue aplicado', () => {
  const result = analizarRachaBonoTiempo([
    cuota('2026-06-29', { id: 'consolidada-1' }),
    cuota('2026-07-06', { id: 'consolidada-2' }),
    cuota('2026-07-13', { id: 'consolidada-3' }),
    cuota('2026-07-20', { id: 'consolidada-4' }),
    cuota('2026-07-27', { id: 'nueva-1' }),
  ], DEPOSIT_WEEK, {
    cutoffYmd: '2026-07-27',
    excludedCuotaIds: new Set([
      'consolidada-1',
      'consolidada-2',
      'consolidada-3',
      'consolidada-4',
    ]),
  });

  assert.equal(result.blocks.length, 0);
  assert.equal(result.progress, 1);
});

test('el resumen reutiliza filas cargadas y conserva solo bonos visibles', () => {
  const rows = [
    cuota('2026-06-29', { id: 'consolidada-1' }),
    cuota('2026-07-06', { id: 'consolidada-2' }),
    cuota('2026-07-13', { id: 'consolidada-3' }),
    cuota('2026-07-20', { id: 'consolidada-4' }),
    cuota('2026-07-27', { id: 'nueva-1' }),
  ];
  const aplicado = {
    id: 'bono-aplicado',
    status: 'aplicado',
    source_key: 'consolidada-1:consolidada-2:consolidada-3:consolidada-4',
    source_cuota_ids: ['consolidada-1', 'consolidada-2', 'consolidada-3', 'consolidada-4'],
  };
  const obsoleto = {
    id: 'bono-obsoleto',
    status: 'reservado',
    source_key: 'ya-no-vigente',
    source_cuota_ids: [],
  };
  const result = buildResumenBonoTiempo({
    bono_tiempo_activo: true,
    fecha_inicio_cobro_semanal: DEPOSIT_WEEK,
  }, rows, [aplicado, obsoleto]);

  assert.equal(result.enabled, true);
  assert.equal(result.racha, 1);
  assert.deepEqual(result.bonos.map((bono) => bono.id), ['bono-aplicado']);
});

test('el resumen desactivado no expone racha ni bonos', () => {
  assert.deepEqual(
    buildResumenBonoTiempo({ bono_tiempo_activo: false }, [cuota('2026-06-29')], []),
    { enabled: false, racha: 0, bonos: [] }
  );
});
