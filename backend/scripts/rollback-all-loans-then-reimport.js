/**
 * 1) Obtiene todos los request_id que tienen préstamo (PE por defecto).
 * 2) Los escribe en rollback-request-ids.txt y ejecuta el rollback (borra esos préstamos y cuotas).
 * 3) Ejecuta el import con --fix-missing-loans y --google-sheet-id para volver a insertar desde el Cronograma.
 *
 * Uso (desde backend/):
 *   node scripts/rollback-all-loans-then-reimport.js
 *   node scripts/rollback-all-loans-then-reimport.js --country=CO
 *   node scripts/rollback-all-loans-then-reimport.js --dry-run   # solo lista, no borra ni importa
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

const { query } = await import('../config/database.js');

const ROLLBACK_FILE = path.join(__dirname, 'rollback-request-ids.txt');
const GOOGLE_SHEET_ID = process.env.EXCEL_GOOGLE_SHEET_ID || '1mXdVRuSsOK9IlbpY1CQaNe_AHEVeePiU';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const countryArg = process.argv.find((a) => a.startsWith('--country='));
  const country = countryArg ? (String(countryArg.split('=')[1]).toUpperCase() === 'CO' ? 'CO' : 'PE') : 'PE';

  const res = await query(
    `SELECT l.request_id FROM module_rapidin_loans l WHERE l.country = $1 AND l.request_id IS NOT NULL`,
    [country]
  );
  const requestIds = (res.rows || []).map((r) => r.request_id).filter(Boolean);
  if (requestIds.length === 0) {
    console.log(`No hay préstamos con request_id para ${country}. Nada que hacer rollback.`);
    process.exit(0);
    return;
  }

  console.log(`Préstamos a hacer rollback (${country}):`, requestIds.length);

  const content = requestIds.join('\n');
  fs.writeFileSync(ROLLBACK_FILE, content, 'utf8');
  console.log('Escrito', requestIds.length, 'request_id en', ROLLBACK_FILE);

  if (dryRun) {
    console.log('--dry-run: no se ejecuta rollback ni import.');
    process.exit(0);
    return;
  }

  console.log('\n--- Ejecutando rollback ---');
  await runScript('node', ['scripts/rollback-fix-missing-loans.js', '--file=scripts/rollback-request-ids.txt']);

  console.log('\n--- Ejecutando import --fix-missing-loans ---');
  await runScript('node', [
    'excel/importExcelRptasPE.js',
    '--fix-missing-loans',
    '--country=' + country,
    '--google-sheet-id=' + GOOGLE_SHEET_ID,
  ]);
}

function runScript(cmd, args) {
  return new Promise((resolve, reject) => {
    const cwd = path.join(__dirname, '..');
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: false });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} salió con código ${code}`));
      else resolve();
    });
    child.on('error', reject);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
