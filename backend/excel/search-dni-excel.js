/**
 * Busca un DNI en el Excel de Préstamos Yego.
 * Por defecto usa Prestamos Yego (6).xlsx en la raíz del proyecto.
 *
 * Uso (desde backend/):
 *   node excel/search-dni-excel.js <DNI>
 *   node excel/search-dni-excel.js <DNI> "ruta/al/archivo.xlsx"
 *
 * Ejemplo: node excel/search-dni-excel.js 7062465
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..', '..');

const dni = process.argv[2];
const excelArg = process.argv[3];

if (!dni) {
  console.log('Uso: node excel/search-dni-excel.js <DNI> [ruta-excel]');
  console.log('Ejemplo: node excel/search-dni-excel.js 7062465');
  process.exit(1);
}

const possibleNames = [
  excelArg,
  path.join(projectRoot, 'Prestamos Yego (6).xlsx'),
  path.join(projectRoot, 'Prestamos Yego.xlsx'),
  path.join(__dirname, 'Prestamos Yego (6).xlsx'),
  path.join(__dirname, 'Prestamos Yego.xlsx'),
].filter(Boolean);

let EXCEL_PATH = null;
for (const p of possibleNames) {
  if (p && fs.existsSync(p)) {
    EXCEL_PATH = p;
    break;
  }
}

if (!EXCEL_PATH) {
  console.error('No se encontró el Excel de Préstamos Yego. Rutas probadas:');
  possibleNames.forEach((p) => console.error('  -', p));
  process.exit(1);
}

console.log('Excel:', EXCEL_PATH);
console.log('Buscando DNI:', dni, '\n');

const workbook = XLSX.readFile(EXCEL_PATH);
const sheetNames = workbook.SheetNames;

function findDniInSheet(sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return;
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
  const headers = Object.keys(rows[0] || {});
  const dniCols = headers.filter((k) => /dni|cedula|documento|carné|extranjería|cédula/i.test(String(k)));

  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (const key of Object.keys(row || {})) {
      const val = String(row[key] ?? '').trim();
      if (val === dni) {
        count++;
        console.log('--- Hoja:', sheetName, '| Fila Excel:', i + 2, '---');
        console.log(JSON.stringify(row, null, 2));
        console.log('');
        break;
      }
    }
  }
  if (count === 0) {
    console.log(sheetName + ':', rows.length, 'filas. Sin coincidencia para DNI', dni);
  } else {
    console.log(sheetName + ':', count, 'coincidencia(s).');
  }
  console.log('');
}

for (const name of sheetNames) {
  findDniInSheet(name);
}

console.log('Listo.');
