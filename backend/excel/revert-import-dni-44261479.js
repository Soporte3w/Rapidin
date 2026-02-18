/**
 * Revierte la importación de prueba para DNI 44261479 (PE):
 * Elimina todo lo asociado a ese DNI en module_rapidin (lo que se insertó para probar).
 *
 * Uso (desde backend/):
 *   node excel/revert-import-dni-44261479.js
 *   node excel/revert-import-dni-44261479.js --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { query } = await import('../config/database.js');

const DNI = '44261479';
const COUNTRY = 'PE';
const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  console.log(`Reversión import de prueba DNI ${DNI} (${COUNTRY}): eliminar cuotas, préstamos, solicitudes y conductores.`);
  if (DRY_RUN) console.log('Modo --dry-run: no se modificará la base de datos.');

  const drivers = await query(
    `SELECT id, park_id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2`,
    [DNI, COUNTRY]
  );
  const driverIds = (drivers.rows || []).map((r) => r.id);
  if (driverIds.length === 0) {
    console.log('No se encontraron conductores para este DNI. Nada que hacer.');
    process.exit(0);
    return;
  }

  console.log(`Conductores a eliminar: ${driverIds.length}`, drivers.rows.map((r) => ({ id: r.id, park_id: r.park_id })));

  const loans = await query(
    `SELECT id FROM module_rapidin_loans WHERE driver_id = ANY($1::uuid[])`,
    [driverIds]
  );
  const loanIds = (loans.rows || []).map((r) => r.id);
  console.log(`Préstamos a eliminar: ${loanIds.length}`);

  if (!DRY_RUN) {
    if (loanIds.length > 0) {
      await query(`DELETE FROM module_rapidin_installments WHERE loan_id = ANY($1::uuid[])`, [loanIds]);
      console.log('Cuotas eliminadas.');
      await query(`DELETE FROM module_rapidin_loans WHERE id = ANY($1::uuid[])`, [loanIds]);
      console.log('Préstamos eliminados.');
    }
    await query(`DELETE FROM module_rapidin_loan_requests WHERE driver_id = ANY($1::uuid[])`, [driverIds]);
    console.log('Solicitudes eliminadas.');
    await query(`DELETE FROM module_rapidin_drivers WHERE id = ANY($1::uuid[])`, [driverIds]);
    console.log(`Conductores eliminados: ${driverIds.length}.`);
  } else {
    console.log('[DRY-RUN] Se eliminarían cuotas de', loanIds.length, 'préstamos, luego préstamos, solicitudes y', driverIds.length, 'conductores.');
  }

  console.log('Listo.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
