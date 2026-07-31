import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('el pago manual se limita a otros gastos y no invoca Fleet', () => {
  const route = read('yego_miauto/routes/miauto/otros.js');
  const paymentService = read('yego_miauto/services/gastos/miautoGastoPagoService.js');

  assert.match(route, /otros-gastos\/:expenseId\/marcar-pagado/);
  assert.match(route, /markExpensePaidManually/);
  assert.match(paymentService, /source:\s*'manual'/);
  assert.match(paymentService, /affects_fleet_balance:\s*false/);
  assert.doesNotMatch(paymentService, /withdrawFromContractor|getContractorBalance/);
});

test('el pago manual bloquea comprobantes o cobros Fleet en curso', () => {
  const paymentService = read('yego_miauto/services/gastos/miautoGastoPagoService.js');

  assert.match(paymentService, /pending_receipt/);
  assert.match(paymentService, /fleet_in_progress/);
  assert.match(paymentService, /fleet_receipt_pending/);
});
