import assert from 'node:assert/strict';
import test from 'node:test';
import { filterMiautoFleetRetryCuotas } from '../yego_miauto/services/cuotas/miautoFleetChargeRunService.js';

test('el reproceso selecciona solo cuotas solicitadas que continúan abiertas', () => {
  const cuotas = [
    { id: 'a', status: 'pending' },
    { id: 'b', status: 'partial' },
    { id: 'c', status: 'paid' },
    { id: 'd', status: 'overdue' },
    { id: 'e', status: 'pending' },
  ];

  assert.deepEqual(
    filterMiautoFleetRetryCuotas(cuotas, new Set(['a', 'b', 'c', 'd'])).map((row) => row.id),
    ['a', 'b', 'd'],
  );
});

test('el reproceso no incorpora otras cuotas pendientes fuera de la corrida', () => {
  assert.deepEqual(
    filterMiautoFleetRetryCuotas([{ id: 'otra', status: 'pending' }], ['objetivo']),
    [],
  );
});
