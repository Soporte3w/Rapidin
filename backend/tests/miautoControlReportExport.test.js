import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx-js-style';
import {
  buildMiautoControlReportBuffer,
  normalizeControlReportRange,
} from '../yego_miauto/services/reportes/miautoControlReportService.js';

test('normaliza fechas a semanas completas de lunes a domingo', () => {
  const range = normalizeControlReportRange('2026-07-22', '2026-08-09');
  assert.deepEqual(range, {
    weekFrom: '2026-07-20',
    weekTo: '2026-08-03',
    rangeEnd: '2026-08-09',
    weeks: ['2026-07-20', '2026-07-27', '2026-08-03'],
  });
});

test('rechaza un rango invertido', () => {
  assert.throws(
    () => normalizeControlReportRange('2026-08-10', '2026-08-03'),
    /semana hasta no puede ser anterior/i
  );
});

test('genera el Excel con columnas de semanas dinámicas y una fila por contrato', () => {
  const buffer = buildMiautoControlReportBuffer({
    weekFrom: '2026-07-20',
    weekTo: '2026-08-03',
    rangeEnd: '2026-08-09',
    weeks: ['2026-07-20', '2026-07-27', '2026-08-03'],
    note: 'Reporte de prueba.',
    rows: [
      {
        conductor: 'Hendrik Hassan',
        dni: '003800663',
        licencia: 'Q003800663',
        vehiculo: 'Kia Soluto 2026',
        placa: 'CWP640',
        fecha_inicio_pago: '2026-03-02',
        total_cuotas_contrato: 261,
        cuotas_transcurridas: 23,
        cuotas_pagadas: 23,
        estado_cuotas: 'AL DÍA',
        cuotas_pendientes: 0,
        viajes_por_semana: [125, 124, 125],
        bono_tiempo: 4,
      },
    ],
  });

  assert.ok(buffer.length > 1000);
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellStyles: true });
  assert.deepEqual(workbook.SheetNames, ['Reporte general']);
  const sheet = workbook.Sheets['Reporte general'];
  assert.equal(sheet.A1.v, 'REPORTE DE CONTROL - YEGO AUTO PROPIO');
  assert.equal(sheet.A5.v, 'Conductor');
  assert.equal(sheet.L5.v, 'Semana 1 - Viajes');
  assert.equal(sheet.N5.v, 'Semana 3 - Viajes');
  assert.equal(sheet.O5.v, 'Bono Tiempo');
  assert.equal(sheet.A6.v, 'Hendrik Hassan');
  assert.equal(sheet.B6.v, '003800663');
  assert.equal(sheet.L6.v, 125);
  assert.equal(sheet.O6.v, 4);
  assert.equal(sheet['!autofilter'].ref, 'A5:O6');
  assert.ok(sheet.A5.s, 'la cabecera debe conservar un estilo propio');
});
