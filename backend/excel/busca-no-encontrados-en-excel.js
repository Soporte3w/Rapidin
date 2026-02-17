/**
 * Para cada conductor del CSV no-encontrados-sync-external-id.csv, busca si aparece
 * en el Excel "Prestamos Yego (6).xlsx" (hojas Rptas CO, Rptas PE, Cronogramas CO, Cronogramas PE).
 * Así sabes de dónde salieron los datos (si están en el Excel) aunque no estén en la tabla drivers.
 *
 * Uso (desde backend/):
 *   node excel/busca-no-encontrados-en-excel.js
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(__dirname, 'no-encontrados-sync-external-id.csv');
const EXCEL_PATH = path.join(__dirname, '..', '..', 'Prestamos Yego (6).xlsx');
const REPORT_PATH = path.join(__dirname, 'no-encontrados-en-excel-reporte.txt');

function digitsOnly(str) {
  return (str || '').toString().replace(/\D/g, '');
}

function normalizeDniForCompare(dni) {
  const s = (dni || '').toString().trim();
  if (!s) return { raw: '', digits: '' };
  return { raw: s, digits: digitsOnly(s) };
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';');
    const dni = (parts[0] || '').trim();
    const nombre = (parts[1] || '').trim();
    const phone = (parts[2] || '').trim();
    if (!dni || dni.toLowerCase() === 'dni') continue;
    rows.push({ dni, nombre, phone });
  }
  return rows;
}

/** Devuelve el valor de la celda que puede ser DNI (texto o número en Excel). */
function getDniFromRow(row, dniHeaders) {
  for (const h of dniHeaders) {
    const val = row[h];
    if (val == null) continue;
    if (typeof val === 'number' && !isNaN(val)) {
      const asInt = Math.floor(val);
      if (val === asInt) return String(asInt);
      return String(val).replace(/\.0+$/, '');
    }
    const s = String(val).trim();
    if (s) return s;
  }
  return null;
}

/** Recorre todas las hojas del Excel y construye un Map: dniNormalizado -> { sheetName, excelRow (1-based) } */
function buildDniToExcelMap(workbook) {
  const map = new Map(); // key: digitsOnly(dni) for reliable match; value: { sheetName, excelRow, rawDni }
  const sheetNames = workbook.SheetNames || [];
  const sheetsToSearch = sheetNames.filter(
    (n) => /Rptas CO|Rptas PE|Cronogramas CO|Cronogramas PE|Cronograma CO|Cronograma PE/i.test(n)
  );

  const dniHeaderPatterns = [
    'CÉDULA DE CIUDADANIA - CARNÉ EXTRANJERÍA',
    'CÉDULA DE CIUDADANIA - CARNÉ EXTRANJERÍA ',
    'DNI - CARNÉ EXTRANJERÍA',
    'DNI - CARNÉ EXTRANJERÍA ',
    'DNI',
  ];

  for (const sheetName of sheetsToSearch) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
    const headers = rows[0] ? Object.keys(rows[0]) : [];
    const dniCols = headers.filter((h) =>
      dniHeaderPatterns.some((p) => h && (h === p || h.trim() === p.trim()))
    );
    if (dniCols.length === 0) {
      const byPattern = headers.filter((k) => /dni|cedula|cédula|carné|extranjería|documento/i.test(String(k)));
      dniCols.push(...byPattern);
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const dniVal = getDniFromRow(row, dniCols.length ? dniCols : Object.keys(row || {}));
      if (!dniVal) continue;
      const digits = digitsOnly(dniVal);
      if (digits.length < 4) continue;
      const excelRow = i + 2;
      if (!map.has(digits)) {
        map.set(digits, { sheetName, excelRow, rawDni: dniVal });
      }
    }
  }

  return map;
}

function run() {
  console.log('Leyendo CSV no encontrados:', CSV_PATH);
  if (!fs.existsSync(CSV_PATH)) {
    console.error('No existe el CSV:', CSV_PATH);
    process.exit(1);
  }
  const csvContent = fs.readFileSync(CSV_PATH, 'utf8');
  const noEncontrados = parseCsv(csvContent);
  console.log('No encontrados en sync:', noEncontrados.length);

  console.log('Leyendo Excel:', EXCEL_PATH);
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error('No existe el Excel:', EXCEL_PATH);
    process.exit(1);
  }
  const workbook = XLSX.readFile(EXCEL_PATH, { cellNF: false, raw: true });
  const dniToExcel = buildDniToExcelMap(workbook);
  console.log('DNIs únicos encontrados en Excel (por hojas Rptas/Cronogramas CO/PE):', dniToExcel.size);
  console.log('');

  const report = [];
  report.push('=== No encontrados en tabla drivers: ¿están en el Excel Prestamos Yego (6).xlsx? ===');
  report.push('');

  let inExcel = 0;
  let notInExcel = 0;

  for (const row of noEncontrados) {
    const { dni, nombre, phone } = row;
    const { digits } = normalizeDniForCompare(dni);
    const found = digits ? dniToExcel.get(digits) : null;

    if (found) {
      inExcel++;
      report.push(`SÍ EN EXCEL  | ${nombre} | dni=${dni} | phone=${phone || '(vacío)'}`);
      report.push(`             → Hoja: "${found.sheetName}", Fila Excel: ${found.excelRow} (DNI en Excel: ${found.rawDni})`);
    } else {
      notInExcel++;
      report.push(`NO EN EXCEL  | ${nombre} | dni=${dni} | phone=${phone || '(vacío)'}`);
    }
    report.push('');
  }

  report.push('--- Resumen ---');
  report.push(`Sí están en el Excel: ${inExcel}`);
  report.push(`No están en el Excel: ${notInExcel}`);
  report.push('');
  report.push('(Si no están en el Excel, los datos pueden venir de otro import, registro manual o integración.)');

  const reportText = report.join('\n');
  fs.writeFileSync(REPORT_PATH, reportText, 'utf8');
  console.log(reportText);
  console.log('');
  console.log('Reporte guardado en:', REPORT_PATH);
  process.exit(0);
}

run();
