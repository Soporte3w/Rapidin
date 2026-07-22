import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { importMimotoExcel } from '../yego_mimoto/services/mimotoExcelImportService.js';

function argument(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const filePath = argument('file');
if (!filePath) {
  throw new Error('Uso: node scripts/mimoto-import-weekly-payments-excel.js --file <archivo.xlsx> [--apply] [--actor <uuid>]');
}

const apply = process.argv.includes('--apply');
const actorId = argument('actor');
const reportPath = argument('report') || path.join('/tmp', `mimoto-import-${apply ? 'apply' : 'dry-run'}-${Date.now()}.json`);
const report = await importMimotoExcel({ filePath: path.resolve(filePath), apply, actorId });
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify({
  mode: report.mode,
  file: report.file,
  importId: report.importId || null,
  summary: report.summary,
  report: reportPath,
}, null, 2));

if (report.errors.length > 0) {
  console.error(`Dry-run con ${report.errors.length} errores. Revise ${reportPath}`);
  process.exitCode = 2;
}
