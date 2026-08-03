import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterMiautoFleetCuotasBySolicitud,
  filterMiautoFleetRetryCuotas,
} from '../yego_miauto/services/cuotas/miautoFleetChargeRunService.js';

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

test('el reproceso no incorpora otras cuotas pendientes fuera del proceso', () => {
  assert.deepEqual(
    filterMiautoFleetRetryCuotas([{ id: 'otra', status: 'pending' }], ['objetivo']),
    [],
  );
});

test('el cobro individual conserva solo las cuotas del contrato seleccionado', () => {
  const cuotas = [
    { id: 'a', solicitud_id: 'contrato-1' },
    { id: 'b', solicitud_id: 'contrato-2' },
    { id: 'c', solicitud_id: 'contrato-1' },
  ];

  assert.deepEqual(
    filterMiautoFleetCuotasBySolicitud(cuotas, 'contrato-1').map((row) => row.id),
    ['a', 'c'],
  );
  assert.deepEqual(filterMiautoFleetCuotasBySolicitud(cuotas, ''), []);
});
