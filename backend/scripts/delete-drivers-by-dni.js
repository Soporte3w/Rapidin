/**
 * Borra conductores de module_rapidin_drivers por DNI.
 * Primero elimina dependencias: cuotas, préstamos, solicitudes; luego los conductores.
 *
 * Uso (desde backend/):
 *   node scripts/delete-drivers-by-dni.js 41717021 10302323
 *   node scripts/delete-drivers-by-dni.js --dry-run 41717021 10302323
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

const { query } = await import('../config/database.js');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dnis = process.argv.filter((a) => !a.startsWith('--') && /^\d+$/.test(a));
  if (dnis.length === 0) {
    console.error('Uso: node scripts/delete-drivers-by-dni.js [--dry-run] DNI1 DNI2 ...');
    process.exit(1);
  }

  const res = await query(
    'SELECT id, dni, first_name, last_name, country FROM module_rapidin_drivers WHERE dni = ANY($1::text[])',
    [dnis]
  );
  const drivers = res.rows || [];
  if (drivers.length === 0) {
    console.log('No se encontraron conductores con esos DNI.');
    process.exit(0);
  }
  const ids = drivers.map((d) => d.id);
  console.log('Conductores a borrar:', drivers.length);
  drivers.forEach((d) => console.log('  ', d.dni, d.first_name, d.last_name, d.country));

  if (dryRun) {
    console.log('\n--dry-run: no se borró nada.');
    process.exit(0);
  }

  const loanRes = await query('SELECT id FROM module_rapidin_loans WHERE driver_id = ANY($1::uuid[])', [ids]);
  const loanIds = (loanRes.rows || []).map((r) => r.id);
  if (loanIds.length > 0) {
    await query('DELETE FROM module_rapidin_installments WHERE loan_id = ANY($1::uuid[])', [loanIds]);
    await query('UPDATE module_rapidin_notifications SET loan_id = NULL WHERE loan_id = ANY($1::uuid[])', [loanIds]).catch(() => {});
    await query('DELETE FROM module_rapidin_loans WHERE id = ANY($1::uuid[])', [loanIds]);
    console.log('Borrados', loanIds.length, 'préstamos y cuotas.');
  }
  await query('DELETE FROM module_rapidin_loan_requests WHERE driver_id = ANY($1::uuid[])', [ids]);
  await query('UPDATE module_rapidin_notifications SET driver_id = NULL WHERE driver_id = ANY($1::uuid[])', [ids]).catch(() => {});
  await query('DELETE FROM module_rapidin_drivers WHERE id = ANY($1::uuid[])', [ids]);
  console.log('Borrados', ids.length, 'conductores.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
