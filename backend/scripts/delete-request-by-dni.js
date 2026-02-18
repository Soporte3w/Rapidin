/**
 * Elimina la(s) solicitud(es) de préstamo del conductor con el DNI indicado.
 * Borra en cascada: vouchers, pagos, documentos, cuotas, préstamos y finalmente las solicitudes.
 *
 * Uso (desde backend/):
 *   node scripts/delete-request-by-dni.js 34234234
 *   node scripts/delete-request-by-dni.js 34234234 --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

const { query } = await import('../config/database.js');

const DNI = (process.argv[2] || '').replace(/\D/g, '');
if (!DNI) {
  console.error('Uso: node scripts/delete-request-by-dni.js <DNI> [--dry-run]');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const drivers = await query(
    `SELECT id, dni, country, first_name, last_name FROM module_rapidin_drivers WHERE REPLACE(COALESCE(dni,''), ' ', '') = $1`,
    [DNI]
  );
  if (!drivers.rows?.length) {
    console.log('No se encontró ningún conductor con DNI', DNI);
    process.exit(0);
    return;
  }

  const driverIds = drivers.rows.map((d) => d.id);
  console.log('Conductor(es) con DNI', DNI + ':', drivers.rows.map((d) => `${d.first_name} ${d.last_name} (${d.country})`).join(', '));

  const requests = await query(
    `SELECT id, driver_id, country, requested_amount, status, created_at FROM module_rapidin_loan_requests WHERE driver_id = ANY($1::uuid[]) ORDER BY created_at`,
    [driverIds]
  );
  if (!requests.rows?.length) {
    console.log('No hay solicitudes de préstamo para este DNI.');
    process.exit(0);
    return;
  }

  const requestIds = requests.rows.map((r) => r.id);
  console.log('Solicitudes a eliminar:', requests.rows.length);
  requests.rows.forEach((r) => console.log('  ', r.id, '|', r.requested_amount, '|', r.status, '|', r.created_at));

  if (dryRun) {
    console.log('\n--dry-run: no se borró nada.');
    process.exit(0);
    return;
  }

  const loansRes = await query('SELECT id, request_id FROM module_rapidin_loans WHERE request_id = ANY($1::uuid[])', [requestIds]);
  const loanIds = (loansRes.rows || []).map((r) => r.id);

  if (loanIds.length > 0) {
    await query(
      `DELETE FROM module_rapidin_voucher_installments WHERE voucher_id IN (SELECT id FROM module_rapidin_payment_vouchers WHERE loan_id = ANY($1::uuid[]))`,
      [loanIds]
    );
    await query('DELETE FROM module_rapidin_payment_vouchers WHERE loan_id = ANY($1::uuid[])', [loanIds]);
    await query(
      `DELETE FROM module_rapidin_payment_installments WHERE payment_id IN (SELECT id FROM module_rapidin_payments WHERE loan_id = ANY($1::uuid[]))`,
      [loanIds]
    );
    await query('DELETE FROM module_rapidin_payments WHERE loan_id = ANY($1::uuid[])', [loanIds]);
    await query('DELETE FROM module_rapidin_documents WHERE loan_id = ANY($1::uuid[])', [loanIds]);
    await query('DELETE FROM module_rapidin_auto_payment_log WHERE loan_id = ANY($1::uuid[])', [loanIds]);
    await query('DELETE FROM module_rapidin_installments WHERE loan_id = ANY($1::uuid[])', [loanIds]);
    await query('DELETE FROM module_rapidin_loans WHERE id = ANY($1::uuid[])', [loanIds]);
    console.log('Borrados', loanIds.length, 'préstamo(s) y datos relacionados.');
  }

  await query('DELETE FROM module_rapidin_documents WHERE request_id = ANY($1::uuid[])', [requestIds]);
  await query('DELETE FROM module_rapidin_loan_requests WHERE id = ANY($1::uuid[])', [requestIds]);
  console.log('Borradas', requestIds.length, 'solicitud(es) para DNI', DNI);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
