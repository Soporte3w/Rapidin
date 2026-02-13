/**
 * Inspecciona la hoja Cronogramas PE del Excel para ver columnas y formato de fechas.
 * Uso (desde backend/): node excel/inspect-excel-cronograma.js
 */
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXCEL_PATH = path.join(__dirname, '..', '..', 'Prestamos Yego (6).xlsx');

const workbook = XLSX.readFile(EXCEL_PATH);
console.log('Hojas:', workbook.SheetNames);

const sheetName = 'Cronogramas PE';
if (!workbook.Sheets[sheetName]) {
  console.log('No existe hoja Cronogramas PE. Probando Cronograma PE...');
}
const sheet = workbook.Sheets[sheetName] || workbook.Sheets['Cronograma PE'];
if (!sheet) {
  console.log('Hojas disponibles:', workbook.SheetNames);
  process.exit(1);
}

// sheet_to_json con header 1 para ver fila 0 como nombres
const data = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false, header: 1 });
console.log('\n--- Primera fila (encabezados) ---');
const headers = data[0] || [];
headers.forEach((h, i) => console.log(`  [${i}] "${h}" (tipo: ${typeof h})`));

// Buscar columnas que contengan "fecha" o "program"
const fechaCols = headers
  .map((h, i) => ({ i, name: String(h || '').trim() }))
  .filter(({ name }) => /fecha|program|venc/i.test(name));
console.log('\n--- Columnas que contienen fecha/program/venc ---');
fechaCols.forEach(({ i, name }) => console.log(`  Col ${i}: "${name}"`));

// Primera fila de datos (índice 1)
console.log('\n--- Segunda fila (primer dato) - valores de columnas de fecha ---');
const row1 = data[1] || [];
fechaCols.forEach(({ i, name }) => {
  const val = row1[i];
  console.log(`  "${name}" = ${JSON.stringify(val)} (tipo: ${typeof val})`);
});

// Varias filas más para ver patrón de Fecha_Programada
console.log('\n--- Filas 1 a 5: todas las columnas (solo primeras 12) ---');
for (let r = 1; r <= Math.min(5, data.length - 1); r++) {
  const row = data[r];
  console.log(`Fila ${r + 1}:`, (row || []).slice(0, 12).map((v, i) => `${headers[i]}=${JSON.stringify(v)}`).join(' | '));
}

// Raw: leer con raw: true para ver números de Excel (fechas como serial)
const rawData = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true, header: 1 });
console.log('\n--- Valores RAW (números Excel) fila 2, columnas de fecha ---');
const rawRow1 = rawData[1] || [];
fechaCols.forEach(({ i, name }) => {
  const val = rawRow1[i];
  console.log(`  "${name}" raw = ${JSON.stringify(val)} (tipo: ${typeof val})`);
});

// Con sheet_to_json(sheet, { raw: true }) con header por defecto (objeto)
const asObj = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
console.log('\n--- Primera fila como objeto (raw: true) - Fecha_Programada ---');
console.log('  Fecha_Programada =', asObj[0]?.Fecha_Programada, 'tipo:', typeof asObj[0]?.Fecha_Programada);
// Simular excelDateToJS con epoch 31-dic-1899
function excelDateToJS(serial) {
  if (serial == null || serial === '' || isNaN(Number(serial))) return null;
  const n = Number(serial);
  const epoch = new Date(1899, 11, 31);
  const d = new Date(epoch.getTime() + n * 86400000);
  return isNaN(d.getTime()) ? null : d;
}
const d = excelDateToJS(asObj[0]?.Fecha_Programada);
console.log('  excelDateToJS(...) =', d ? d.toISOString().slice(0, 10) : null);

process.exit(0);
