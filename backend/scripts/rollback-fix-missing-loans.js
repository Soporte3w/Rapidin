/**
 * Borra los préstamos (y sus cuotas) que se crearon para las solicitudes del archivo.
 * Por si algo falló después de ejecutar --fix-missing-loans o list-disbursed-requests-without-loan.js --insert.
 *
 * El archivo .txt debe tener un UUID por línea: request_id de la solicitud cuyo préstamo quieres borrar.
 * Líneas vacías o que no parezcan UUID se ignoran.
 *
 * Uso (desde backend/):
 *   node scripts/rollback-fix-missing-loans.js --file=rollback-request-ids.txt
 *   node scripts/rollback-fix-missing-loans.js --file=rollback-request-ids.txt --dry-run   # solo lista, no borra
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

const { query } = await import('../config/database.js');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseIdsFromFile(filePath) {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines.filter((id) => UUID_REGEX.test(id));
}

async function main() {
  const fileArg = process.argv.find((a) => a.startsWith('--file='));
  const filePath = fileArg ? fileArg.split('=')[1].trim().replace(/^["']|["']$/g, '') : null;
  const dryRun = process.argv.includes('--dry-run');

  if (!filePath) {
    console.error('Uso: node scripts/rollback-fix-missing-loans.js --file=rollback-request-ids.txt');
    console.error('El archivo debe tener un request_id por línea (UUID de la solicitud).');
    process.exit(1);
  }

  if (!fs.existsSync(path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath))) {
    console.error('No existe el archivo:', filePath);
    process.exit(1);
  }

  const requestIds = parseIdsFromFile(filePath);
  if (requestIds.length === 0) {
    console.log('No hay UUIDs válidos en el archivo.');
    process.exit(0);
  }

  const loansRes = await query(
    'SELECT id, request_id, disbursed_amount, created_at FROM module_rapidin_loans WHERE request_id = ANY($1::uuid[])',
    [requestIds]
  );
  const loans = loansRes.rows || [];

  if (loans.length === 0) {
    console.log('No se encontraron préstamos para esos request_id.');
    process.exit(0);
  }

  console.log('Préstamos a borrar:', loans.length);
  loans.forEach((l) => console.log('  loan_id:', l.id, 'request_id:', l.request_id, 'monto:', l.disbursed_amount));

  if (dryRun) {
    console.log('\n--dry-run: no se borró nada.');
    process.exit(0);
  }

  const loanIds = loans.map((l) => l.id);
  const delInst = await query('DELETE FROM module_rapidin_installments WHERE loan_id = ANY($1::uuid[])', [loanIds]);
  const deletedInstallments = delInst.rowCount || 0;
  await query('UPDATE module_rapidin_notifications SET loan_id = NULL WHERE loan_id = ANY($1::uuid[])', [loanIds]).catch(() => {});
  await query('DELETE FROM module_rapidin_loans WHERE id = ANY($1::uuid[])', [loanIds]);
  console.log('\nBorrados: %d cuotas, %d préstamos.', deletedInstallments, loanIds.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
