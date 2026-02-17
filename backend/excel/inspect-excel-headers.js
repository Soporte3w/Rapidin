/**
 * Lista TODAS las columnas exactas del Excel (Rptas PE/CO y Cronogramas PE/CO).
 * Uso (desde backend/): node excel/inspect-excel-headers.js
 * Opcional: node excel/inspect-excel-headers.js CO   → solo hojas de Colombia
 */
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXCEL_PATH = path.join(__dirname, '..', '..', 'Prestamos Yego (6).xlsx');
const onlyCountry = (process.argv[2] || '').toUpperCase();

const workbook = XLSX.readFile(EXCEL_PATH);
console.log('Hojas en el libro:', workbook.SheetNames.join(', '));

function showHeaders(sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    console.log(`\n--- ${sheetName}: NO EXISTE ---`);
    return;
  }
  const data = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false, header: 1 });
  const headers = data[0] || [];
  console.log(`\n--- ${sheetName} (${headers.length} columnas) ---`);
  headers.forEach((h, i) => {
    const name = String(h ?? '').trim();
    if (name) console.log(`  [${i}] "${name}"`);
  });
  const row1 = data[1] || [];
  const dateLike = headers
    .map((h, i) => ({ i, name: String(h ?? '').trim() }))
    .filter(({ name }) => /marca|fecha|temporal|solicitud|created|date/i.test(name));
  if (dateLike.length) {
    console.log(`  Ejemplo fila 2 (columnas fecha/marca):`);
    dateLike.forEach(({ i, name }) => console.log(`    "${name}" = ${JSON.stringify(row1[i])}`));
  }
}

const sheetsPE = ['Rptas PE', 'Cronogramas PE'];
const sheetsCO = ['Rptas CO', 'Cronogramas CO', 'Cronograma CO'];
if (onlyCountry === 'CO') {
  sheetsCO.forEach(showHeaders);
} else if (onlyCountry === 'PE') {
  sheetsPE.forEach(showHeaders);
} else {
  [...sheetsPE, ...sheetsCO].forEach(showHeaders);
}

process.exit(0);
