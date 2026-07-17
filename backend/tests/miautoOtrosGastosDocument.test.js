import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOtherExpenseDocumentName,
  expenseDocumentLabel,
} from '../yego_miauto/services/utils/miautoOtrosGastosDocument.js';

test('nombre de comprobante incluye conductor, concepto, cuota y fecha', () => {
  const result = buildOtherExpenseDocumentName({
    driverName: 'José Pérez López',
    expenseType: 'impuesto_vehicular',
    installmentNumber: 2,
    dueDate: '2027-05-10',
    originalName: 'voucher final.pdf',
    mimeType: 'application/pdf',
    origin: 'admin',
    uploadedAt: new Date('2027-05-02T14:30:45.000Z'),
  });

  assert.equal(result.displayName, 'JOSE_PEREZ_LOPEZ_IMPUESTO_VEHICULAR_CUOTA_2_2027-05-10.pdf');
  assert.equal(
    result.objectName,
    'comprobantes/admin/impuesto_vehicular/2027/20270502143045_JOSE_PEREZ_LOPEZ_IMPUESTO_VEHICULAR_CUOTA_2_2027-05-10.pdf',
  );
});

test('nombre usa DNI y extensión segura cuando no hay conductor', () => {
  const result = buildOtherExpenseDocumentName({
    dni: '00123456',
    expenseType: 'soat',
    installmentNumber: 1,
    dueDate: '2026-08-01',
    originalName: 'captura',
    mimeType: 'image/png',
    origin: 'conductor',
    uploadedAt: new Date('2026-07-17T10:00:00.000Z'),
  });

  assert.equal(result.displayName, '00123456_SOAT_CUOTA_1_2026-08-01.png');
  assert.match(result.objectName, /^comprobantes\/conductor\/soat\/2026\//);
  assert.equal(expenseDocumentLabel('desconocido'), 'OTRO_GASTO');
});
