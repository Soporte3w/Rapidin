/**
 * Borra solicitudes duplicadas: mismo driver_id, country, requested_amount y status.
 * Se conserva la más antigua (created_at menor); el resto se elimina (y sus préstamos/cuotas si tienen).
 *
 * Uso (desde backend/):
 *   node scripts/delete-duplicate-requests.js --dry-run   # solo lista duplicados, no borra
 *   node scripts/delete-duplicate-requests.js            # borra las duplicadas
 *   node scripts/delete-duplicate-requests.js --country=PE   # solo PE
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

const { query } = await import('../config/database.js');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const countryArg = process.argv.find((a) => a.startsWith('--country='));
  const country = countryArg ? (String(countryArg.split('=')[1]).toUpperCase() === 'CO' ? 'CO' : 'PE') : null;

  const countryFilter = country ? 'AND r.country = $1' : '';
  const params = country ? [country] : [];

  // Grupos (driver_id, country, requested_amount, status) con más de una solicitud. De cada grupo, marcar las que NO son la más antigua.
  const dupRes = await query(
    `WITH ranked AS (
       SELECT r.id, r.driver_id, r.country, r.requested_amount, r.status, r.created_at,
              ROW_NUMBER() OVER (PARTITION BY r.driver_id, r.country, r.requested_amount::text, r.status ORDER BY r.created_at ASC, r.id ASC) AS rn
       FROM module_rapidin_loan_requests r
       WHERE 1=1 ${countryFilter}
     )
     SELECT id, driver_id, country, requested_amount, status, created_at
     FROM ranked
     WHERE rn > 1`,
    params
  );

  const toDelete = dupRes.rows || [];
  if (toDelete.length === 0) {
    console.log('No se encontraron solicitudes duplicadas.');
    process.exit(0);
    return;
  }

  console.log('Solicitudes duplicadas a borrar (se conserva la más antigua de cada grupo):', toDelete.length);
  toDelete.forEach((r) => {
    console.log('  ', r.id, '| driver:', r.driver_id, '|', r.country, '|', r.requested_amount, '|', r.status, '|', r.created_at);
  });

  if (dryRun) {
    console.log('\n--dry-run: no se borró nada.');
    process.exit(0);
    return;
  }

  const ids = toDelete.map((r) => r.id);

  // Primero préstamos que apunten a estas solicitudes (y sus cuotas)
  const loansRes = await query('SELECT id FROM module_rapidin_loans WHERE request_id = ANY($1::uuid[])', [ids]);
  const loanIds = (loansRes.rows || []).map((r) => r.id);
  if (loanIds.length > 0) {
    await query('DELETE FROM module_rapidin_installments WHERE loan_id = ANY($1::uuid[])', [loanIds]);
    await query('UPDATE module_rapidin_notifications SET loan_id = NULL WHERE loan_id = ANY($1::uuid[])', [loanIds]).catch(() => {});
    await query('DELETE FROM module_rapidin_loans WHERE id = ANY($1::uuid[])', [loanIds]);
    console.log('Borrados', loanIds.length, 'préstamos y sus cuotas.');
  }

  await query('DELETE FROM module_rapidin_loan_requests WHERE id = ANY($1::uuid[])', [ids]);
  console.log('Borradas', ids.length, 'solicitudes duplicadas.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
