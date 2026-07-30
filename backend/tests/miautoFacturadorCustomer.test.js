import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFacturadorCustomerByDocument } from '../yego_miauto/services/utils/miautoFacturadorCustomer.js';

test('selecciona el cliente del facturador por coincidencia exacta de DNI', () => {
  const customer = selectFacturadorCustomerByDocument([
    { id: 95, number: '40044087', name: 'Cliente correcto' },
    { id: 96, number: '70339164', name: 'Otro cliente' },
  ], '40044087');
  assert.equal(customer.id, 95);
  assert.equal(customer.number, '40044087');
});

test('no vincula resultados parciales ni documentos inválidos', () => {
  assert.equal(selectFacturadorCustomerByDocument([{ id: 95, number: '40044087' }], '4004408'), null);
  assert.equal(selectFacturadorCustomerByDocument([{ id: 95, number: '40044087' }], '0040044087'), null);
  assert.equal(selectFacturadorCustomerByDocument([], '40044087'), null);
});

test('rechaza resultados duplicados para el mismo DNI', () => {
  assert.throws(
    () => selectFacturadorCustomerByDocument([
      { id: 95, number: '40044087' },
      { id: 115, number: '40044087' },
    ], '40044087'),
    /más de un cliente/
  );
});
