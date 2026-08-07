import XLSX from 'xlsx-js-style';
import { query } from '../../../config/database.js';
import { addDaysYmd, mondayOfWeekContainingYmd } from '../../../utils/miautoLimaWeekRange.js';
import { analizarRachaBonoTiempo } from '../bonos/miautoBonoTiempoService.js';
import { cuotaCubiertaSql, listAlquilerVenta } from '../solicitud/miautoSolicitudService.js';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REPORT_WEEKS = 261;

const COLORS = {
  header: '4F81BD',
  headerBorder: '385D8A',
  band: 'DCE6F1',
  white: 'FFFFFF',
  text: '1F2937',
  border: 'B8CCE4',
};

function trimOrUndefined(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function isValidYmd(value) {
  if (!YMD_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function ymdFromDbDate(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return match ? match[1] : null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function uuidFilter(value, label) {
  const normalized = trimOrUndefined(value);
  if (!normalized) return undefined;
  if (!UUID_RE.test(normalized)) {
    const error = new Error(`${label} inválido`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function toExcelDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000) + 25569;
}

function formatYmdDmy(value) {
  const [year, month, day] = String(value || '').split('-');
  return year && month && day ? `${day}/${month}/${year}` : '';
}

function thinBorder(color = COLORS.border) {
  const edge = { style: 'thin', color: { rgb: color } };
  return { top: edge, bottom: edge, left: edge, right: edge };
}

function applyStyle(ws, rowIndex, colCount, style) {
  for (let columnIndex = 0; columnIndex < colCount; columnIndex += 1) {
    const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
    if (!ws[address]) ws[address] = { t: 's', v: '' };
    ws[address].s = style;
  }
}

function reportDriverName(row) {
  if (row.yango_work_status === 'fired' && row.working_driver_name) return row.working_driver_name;
  return row.driver_name || row.phone || row.email || '—';
}

export function normalizeControlReportRange(rawFrom, rawTo) {
  const fromInput = String(rawFrom || '').trim().slice(0, 10);
  const toInput = String(rawTo || '').trim().slice(0, 10);
  if (!isValidYmd(fromInput) || !isValidYmd(toInput)) {
    const error = new Error('Selecciona fechas válidas para las semanas desde y hasta');
    error.statusCode = 400;
    throw error;
  }
  const weekFrom = mondayOfWeekContainingYmd(fromInput);
  const weekTo = mondayOfWeekContainingYmd(toInput);
  if (weekTo < weekFrom) {
    const error = new Error('La semana hasta no puede ser anterior a la semana desde');
    error.statusCode = 400;
    throw error;
  }
  const weeks = [];
  for (let current = weekFrom; current <= weekTo; current = addDaysYmd(current, 7)) {
    weeks.push(current);
    if (weeks.length > MAX_REPORT_WEEKS) {
      const error = new Error(`El reporte admite como máximo ${MAX_REPORT_WEEKS} semanas`);
      error.statusCode = 400;
      throw error;
    }
  }
  return {
    weekFrom,
    weekTo,
    rangeEnd: addDaysYmd(weekTo, 6),
    weeks,
  };
}

async function listAllContracts(filters) {
  const contracts = [];
  let page = 1;
  let total = 0;
  do {
    const result = await listAlquilerVenta({ ...filters, page, limit: 100 });
    const rows = Array.isArray(result.data) ? result.data : [];
    contracts.push(...rows);
    total = Number(result.total) || contracts.length;
    if (rows.length === 0) break;
    page += 1;
  } while (contracts.length < total);
  return contracts;
}

function groupRowsBySolicitud(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = String(row.solicitud_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

export async function getMiautoControlReportData(filters = {}) {
  const range = normalizeControlReportRange(filters.week_from, filters.week_to);
  const contracts = await listAllContracts({
    country: trimOrUndefined(filters.country),
    cronograma_id: uuidFilter(filters.cronograma_id, 'Cronograma'),
    conductor_id: uuidFilter(filters.conductor_id, 'Conductor'),
    solicitud_id: uuidFilter(filters.solicitud_id, 'Contrato'),
  });
  const solicitudIds = contracts.map((row) => row.id);
  if (solicitudIds.length === 0) {
    return { ...range, rows: [], note: 'No se encontraron contratos para los filtros seleccionados.' };
  }

  const bonusContractIds = contracts
    .filter((row) => row.bono_tiempo_activo === true)
    .map((row) => row.id);
  const [summaryResult, selectedWeeksResult, streakRowsResult, appliedBonusesResult] = await Promise.all([
    query(
      `SELECT c.solicitud_id,
              COUNT(*) FILTER (
                WHERE COALESCE(c.due_date, c.week_start_date)::date <= $2::date
              )::int AS cuotas_transcurridas,
              COUNT(*) FILTER (
                WHERE COALESCE(c.due_date, c.week_start_date)::date <= $2::date
                  AND (LOWER(COALESCE(c.status, '')) IN ('paid', 'bonificada') OR ${cuotaCubiertaSql('c')})
              )::int AS cuotas_pagadas
       FROM module_miauto_cuota_semanal c
       WHERE c.solicitud_id = ANY($1::uuid[])
         AND c.deleted_at IS NULL
       GROUP BY c.solicitud_id`,
      [solicitudIds, range.rangeEnd]
    ),
    query(
      `SELECT solicitud_id, week_start_date, num_viajes
       FROM module_miauto_cuota_semanal
       WHERE solicitud_id = ANY($1::uuid[])
         AND deleted_at IS NULL
         AND week_start_date::date BETWEEN $2::date AND $3::date
       ORDER BY solicitud_id, week_start_date`,
      [solicitudIds, range.weekFrom, range.weekTo]
    ),
    bonusContractIds.length > 0
      ? query(
          `SELECT id, solicitud_id, week_start_date, due_date, status, pago_puntual, num_viajes
           FROM module_miauto_cuota_semanal
           WHERE solicitud_id = ANY($1::uuid[])
             AND deleted_at IS NULL
             AND COALESCE(due_date, week_start_date)::date <= $2::date
           ORDER BY solicitud_id, week_start_date, due_date, id`,
          [bonusContractIds, range.rangeEnd]
        )
      : Promise.resolve({ rows: [] }),
    bonusContractIds.length > 0
      ? query(
          `SELECT solicitud_id, source_cuota_ids
           FROM module_miauto_bono_tiempo
           WHERE solicitud_id = ANY($1::uuid[])
             AND status = 'aplicado'`,
          [bonusContractIds]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const summaryBySolicitud = new Map(
    (summaryResult.rows || []).map((row) => [String(row.solicitud_id), row])
  );
  const selectedWeeksBySolicitud = groupRowsBySolicitud(selectedWeeksResult.rows);
  const streakRowsBySolicitud = groupRowsBySolicitud(streakRowsResult.rows);
  const excludedBySolicitud = new Map();
  for (const bonus of appliedBonusesResult.rows || []) {
    const key = String(bonus.solicitud_id);
    if (!excludedBySolicitud.has(key)) excludedBySolicitud.set(key, new Set());
    const sourceIds = Array.isArray(bonus.source_cuota_ids) ? bonus.source_cuota_ids : [];
    for (const id of sourceIds) excludedBySolicitud.get(key).add(String(id));
  }

  const rows = contracts.map((contract) => {
    const key = String(contract.id);
    const summary = summaryBySolicitud.get(key) || {};
    const transcurridas = Number(summary.cuotas_transcurridas) || 0;
    const pagadas = Number(summary.cuotas_pagadas) || 0;
    const pendientes = Math.max(0, transcurridas - pagadas);
    const tripsByWeek = new Map(
      (selectedWeeksBySolicitud.get(key) || []).map((row) => [
        ymdFromDbDate(row.week_start_date),
        Number(row.num_viajes) || 0,
      ])
    );
    const fechaInicio = ymdFromDbDate(contract.fecha_inicio_cobro_semanal) || '';
    const depositWeek = isValidYmd(fechaInicio) ? mondayOfWeekContainingYmd(fechaInicio) : null;
    const streak = contract.bono_tiempo_activo === true
      ? analizarRachaBonoTiempo(streakRowsBySolicitud.get(key) || [], depositWeek, {
          cutoffYmd: range.rangeEnd,
          excludedCuotaIds: excludedBySolicitud.get(key) || [],
        }).progress
      : 0;
    const plan = Number(contract.cuotas_semanales_plan) || Number(contract.total_cuotas) || 0;
    return {
      solicitud_id: contract.id,
      conductor: reportDriverName(contract),
      dni: String(contract.dni || ''),
      licencia: String(contract.license_number || ''),
      vehiculo: String(contract.vehiculo_name || ''),
      placa: String(contract.placa_asignada || ''),
      fecha_inicio_pago: fechaInicio || null,
      total_cuotas_contrato: plan,
      cuotas_transcurridas: transcurridas,
      cuotas_pagadas: pagadas,
      estado_cuotas: pendientes > 0 ? 'PENDIENTE' : 'AL DÍA',
      cuotas_pendientes: pendientes,
      viajes_por_semana: range.weeks.map((week) => tripsByWeek.get(week) || 0),
      bono_tiempo: streak,
      cronograma: contract.cronograma_name || '',
    };
  });

  const conductorScope = trimOrUndefined(filters.conductor_id) || trimOrUndefined(filters.solicitud_id)
    ? [...new Set(rows.map((row) => row.conductor))].join(', ') || 'Seleccionado'
    : 'Todos';
  const cronogramaScope = trimOrUndefined(filters.cronograma_id)
    ? [...new Set(rows.map((row) => row.cronograma).filter(Boolean))].join(', ') || 'Seleccionado'
    : 'Todos';
  return {
    ...range,
    rows,
    note: `Reporte generado automáticamente según el rango seleccionado. Conductor: ${conductorScope}. Cronograma: ${cronogramaScope}.`,
  };
}

export function buildMiautoControlReportWorkbook(report) {
  const weeks = Array.isArray(report.weeks) ? report.weeks : [];
  const dataRows = Array.isArray(report.rows) ? report.rows : [];
  const headers = [
    'Conductor',
    'DNI',
    'Licencia',
    'Vehículo',
    'Placa',
    'Fecha inicio de pago',
    'Total cuotas contrato',
    'Cuotas transcurridas',
    'Cuotas pagadas',
    'Estado de cuotas',
    'Cuotas pendientes',
    ...weeks.map((_, index) => `Semana ${index + 1} - Viajes`),
    'Bono Tiempo',
  ];
  const colCount = headers.length;
  const matrix = [
    ['REPORTE DE CONTROL - YEGO AUTO PROPIO'],
    ['Rango de fechas:', toExcelDate(report.weekFrom), 'hasta', toExcelDate(report.rangeEnd)],
    ['Semanas incluidas:', weeks.map(formatYmdDmy).join(' | ')],
    ['Nota:', report.note || 'Reporte generado automáticamente según los filtros seleccionados.'],
    headers,
    ...dataRows.map((row) => [
      row.conductor,
      row.dni,
      row.licencia,
      row.vehiculo,
      row.placa,
      row.fecha_inicio_pago ? toExcelDate(row.fecha_inicio_pago) : '',
      Number(row.total_cuotas_contrato) || 0,
      Number(row.cuotas_transcurridas) || 0,
      Number(row.cuotas_pagadas) || 0,
      row.estado_cuotas,
      Number(row.cuotas_pendientes) || 0,
      ...(Array.isArray(row.viajes_por_semana) ? row.viajes_por_semana : weeks.map(() => 0)),
      Number(row.bono_tiempo) || 0,
    ]),
  ];
  const padded = matrix.map((row) => {
    const copy = [...row];
    while (copy.length < colCount) copy.push('');
    return copy.slice(0, colCount);
  });
  const ws = XLSX.utils.aoa_to_sheet(padded, { cellDates: true });
  const lastColumn = XLSX.utils.encode_col(colCount - 1);
  const lastDataRow = Math.max(5, 5 + dataRows.length);

  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: colCount - 1 } },
    { s: { r: 2, c: 1 }, e: { r: 2, c: colCount - 1 } },
    { s: { r: 3, c: 1 }, e: { r: 3, c: colCount - 1 } },
  ];
  ws['!autofilter'] = { ref: `A5:${lastColumn}${lastDataRow}` };
  ws['!views'] = [{
    ySplit: 5,
    xSplit: 0,
    topLeftCell: 'A6',
    activeCell: 'A6',
    showGridLines: true,
  }];
  ws['!cols'] = headers.map((_, index) => {
    if (index === 0) return { wch: 24 };
    if (index === 1) return { wch: 14 };
    if (index === 2) return { wch: 17 };
    if (index === 3) return { wch: 22 };
    if (index === 4) return { wch: 13 };
    if (index === 5) return { wch: 19 };
    if (index >= 6 && index <= 10) return { wch: 18 };
    if (index === colCount - 1) return { wch: 13 };
    return { wch: 17 };
  });
  ws['!rows'] = [{ hpt: 24 }, { hpt: 20 }, { hpt: 34 }, { hpt: 34 }, { hpt: 30 }];

  for (let rowIndex = 0; rowIndex <= 3; rowIndex += 1) {
    applyStyle(ws, rowIndex, colCount, {
      fill: { fgColor: { rgb: COLORS.white } },
      font: { sz: 11, color: { rgb: '111827' } },
      alignment: { vertical: 'center', wrapText: true },
    });
  }
  applyStyle(ws, 0, colCount, {
    fill: { fgColor: { rgb: COLORS.white } },
    font: { bold: true, sz: 14, color: { rgb: '111827' } },
    alignment: { horizontal: 'left', vertical: 'center' },
  });
  for (const rowIndex of [1, 2, 3]) {
    const labelAddress = XLSX.utils.encode_cell({ r: rowIndex, c: 0 });
    ws[labelAddress].s = {
      fill: { fgColor: { rgb: COLORS.white } },
      font: { bold: true, sz: 11, color: { rgb: '111827' } },
      alignment: { vertical: 'center', wrapText: true },
    };
  }
  for (const address of ['B2', 'D2']) {
    ws[address].z = 'dd/mm/yyyy';
    ws[address].s = {
      fill: { fgColor: { rgb: COLORS.white } },
      font: { sz: 11, color: { rgb: COLORS.text } },
      alignment: { vertical: 'center' },
      numFmt: 'dd/mm/yyyy',
    };
  }
  for (const address of ['B3', 'B4']) {
    ws[address].s = {
      fill: { fgColor: { rgb: COLORS.white } },
      font: { sz: 11, color: { rgb: COLORS.text } },
      alignment: { vertical: 'center', wrapText: true },
    };
  }
  applyStyle(ws, 4, colCount, {
    fill: { fgColor: { rgb: COLORS.header } },
    font: { bold: true, sz: 10, color: { rgb: COLORS.white } },
    alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
    border: thinBorder(COLORS.headerBorder),
  });
  for (let rowIndex = 5; rowIndex < 5 + dataRows.length; rowIndex += 1) {
    const alternate = (rowIndex - 5) % 2 === 1;
    applyStyle(ws, rowIndex, colCount, {
      fill: { fgColor: { rgb: alternate ? COLORS.band : COLORS.white } },
      font: { sz: 10, color: { rgb: COLORS.text } },
      alignment: { vertical: 'center', wrapText: false },
      border: thinBorder(),
    });
    const dateAddress = XLSX.utils.encode_cell({ r: rowIndex, c: 5 });
    if (ws[dateAddress]?.v) {
      ws[dateAddress].z = 'dd/mm/yyyy';
      ws[dateAddress].s = {
        ...ws[dateAddress].s,
        numFmt: 'dd/mm/yyyy',
      };
    }
    for (const columnIndex of [1, 2, 4]) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      ws[address].t = 's';
      ws[address].z = '@';
      ws[address].s = {
        ...ws[address].s,
        alignment: { horizontal: 'left', vertical: 'center' },
        numFmt: '@',
      };
    }
    for (let columnIndex = 6; columnIndex < colCount; columnIndex += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      ws[address].s = {
        ...ws[address].s,
        alignment: { horizontal: 'right', vertical: 'center' },
        numFmt: '#,##0',
      };
    }
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, ws, 'Reporte general');
  return workbook;
}

export function buildMiautoControlReportBuffer(report) {
  const workbook = buildMiautoControlReportWorkbook(report);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

export async function createMiautoControlReportExport(filters = {}) {
  const report = await getMiautoControlReportData(filters);
  const buffer = buildMiautoControlReportBuffer(report);
  const fileName = `reporte_control_yego_auto_${report.weekFrom}_${report.rangeEnd}.xlsx`;
  return { buffer, fileName, report };
}
