/**
 * Importación de préstamos de Colombia desde el Excel "Rptas CO" / "Cronogramas CO" (Prestamos Yego).
 * Ejecuta la misma lógica que importExcelRptasPE.js con --country=CO.
 *
 * Uso (desde backend/):
 *   node excel/importExcelRptasCO.js           # importar Colombia
 *   node excel/importExcelRptasCO.js --dry-run # solo simular
 *   node excel/importExcelRptasCO.js --limit=20
 *   node excel/importExcelRptasCO.js --debug
 *
 * Requiere: Prestamos Yego (6).xlsx en la raíz del proyecto, con hojas "Rptas CO" y "Cronogramas CO" (o "Cronograma CO").
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'importExcelRptasPE.js');
const args = ['--country=CO', ...process.argv.slice(2)];

const child = spawn(process.execPath, [scriptPath, ...args], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..')
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
