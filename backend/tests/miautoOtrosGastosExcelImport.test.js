import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx';
import {
  buildInitialPartialDrivers,
  buildRecords,
  calculateReconciliation,
  parseDateHeader,
  resolveSolicitud,
  statusFromCell,
} from '../scripts/miauto-import-otros-gastos-excel.js';

const IMPORT_OPTIONS = { fallbackYear: 2026, gpsMonthlyAmount: 47.2 };

test('interpreta fechas mensuales y semanales del Excel', () => {
  assert.equal(parseDateHeader('July 2026', 2026, true), '2026-07-31');
  assert.equal(parseDateHeader('06 - July', 2026), '2026-07-06');
  assert.equal(parseDateHeader('15/07/26', 2026), '2026-07-15');
});

test('reconoce todas las marcas de pago usadas por el Excel', () => {
  const dueDate = '2026-06-01';
  for (const marker of ['Pagado', 'PAGADA', 'SI', 'Sí', 'OK', 'X', '✔', '✓', true, 200, '200.00']) {
    assert.equal(statusFromCell(marker, dueDate, '2026-07-20'), 'paid');
  }
  assert.equal(statusFromCell('Pendiente', dueDate, '2026-07-20'), 'overdue');
  assert.equal(statusFromCell('Programado', dueDate, '2026-07-20'), 'pending');
  assert.equal(statusFromCell('', '2026-08-01', '2026-07-20'), 'pending');
});

test('GPS no crea cuotas donde el Excel usa guion antes del inicio', () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['CONDUCTOR', 'PLACA', 'F. ENTREGA', 'July 2025', 'August 2025', 'September 2025'],
    ['Conductor Nuevo', 'ABC123', '2025-08-10', '-', 'Pagado', 'Programado'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'GPS');

  const records = buildRecords(workbook, '2026-07-20', IMPORT_OPTIONS);
  assert.deepEqual(records.map(({ number, total, dueDate, status }) => ({ number, total, dueDate, status })), [
    { number: 1, total: 2, dueDate: '2025-08-31', status: 'paid' },
    { number: 2, total: 2, dueDate: '2025-09-30', status: 'pending' },
  ]);
});

test('una marca Excel pagada completa solo lo que no cubrieron pagos operativos', () => {
  const result = calculateReconciliation({
    existing: { paid_amount: 50 },
    payments: { imported: 0, operational: 50 },
    record: { amount: 200, status: 'paid', dueDate: '2026-06-01' },
    todayYmd: '2026-07-20',
  });
  assert.deepEqual(result, {
    protectedPaid: 50,
    desiredImport: 150,
    paidAmount: 200,
    status: 'paid',
  });
});

test('una fila Excel pendiente nunca borra un pago Fleet o comprobante', () => {
  const result = calculateReconciliation({
    existing: { paid_amount: 80 },
    payments: { imported: 30, operational: 50 },
    record: { amount: 200, status: 'overdue', dueDate: '2026-06-01' },
    todayYmd: '2026-07-20',
  });
  assert.deepEqual(result, {
    protectedPaid: 50,
    desiredImport: 0,
    paidAmount: 50,
    status: 'overdue',
  });
});

test('lee monto y check separados en SOAT sin perder cuotas pagadas', () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['CONDUCTOR', 'PLACA', '#CEL.', 'F. VENCIMIENTO', 'MONTO', '02 - February', 'ESTADO', '02 - March', 'ESTADO'],
    ['Conductora Uno', 'ABC123', '999999999', '2026-06-01', 800, 200, '✓', 200, 'Pendiente'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'SOAT');

  const records = buildRecords(workbook, '2026-07-20', IMPORT_OPTIONS);
  assert.deepEqual(records.map(({ amount, status, dueDate }) => ({ amount, status, dueDate })), [
    { amount: 200, status: 'paid', dueDate: '2026-02-02' },
    { amount: 200, status: 'overdue', dueDate: '2026-03-02' },
  ]);
});

test('mantiene el concepto historico para STR + GPS y evita duplicados semanticos', () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['CONDUCTOR', 'LICENCIA', '# CELULAR', 'MONTO', 'AUTO', 'F. Entrega', '06 - July'],
    ['Conductor Dos', 'Q12345678', '988888888', 'Kia soluto - $23.38', 'AUTO', '2026-06-01', 'Pagado'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'STR + GPS');

  const [record] = buildRecords(workbook, '2026-07-20', IMPORT_OPTIONS);
  assert.equal(record.concept, 'todo_riesgo_mas_gps_agrupado');
  assert.equal(record.status, 'paid');
  assert.equal(record.amount, 23.38);
});

test('resuelve licencia con prefijo por DNI antes de usar el telefono', () => {
  const solicitudIndex = {
    plate: new Map(),
    license: new Map(),
    dni: new Map([['43309390', ['solicitud-1']]]),
    phone: new Map(),
  };
  assert.deepEqual(resolveSolicitud({
    idType: 'license',
    identifier: 'Q43309390',
    phone: null,
  }, solicitudIndex), {
    id: 'solicitud-1',
    matches: 1,
    matchedBy: 'dni',
  });
});

test('Inicial Parcial conserva al conductor listado aunque sus semanas esten vacias', () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['CONDUCTOR', 'LICENCIA', '# CELULAR', 'MONTO', 'AUTO', 'F. Entrega', '06 - July'],
    ['Conductor Sin Cuotas', 'Q12345678', '999999999', '$19.23', 'AUTO', '2026-07-01', null],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Inicial Parcial');

  assert.equal(buildRecords(workbook, '2026-07-20', IMPORT_OPTIONS).length, 0);
  assert.deepEqual(buildInitialPartialDrivers(workbook), [{
    idType: 'license',
    identifier: 'Q12345678',
    phone: '999999999',
    driverName: 'Conductor Sin Cuotas',
  }]);
});
