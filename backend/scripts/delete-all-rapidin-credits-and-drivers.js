/**
 * Elimina todos los créditos (préstamos + solicitudes) y todos los conductores de Rapidín.
 * Orden respetando FKs: préstamos y dependientes → documentos por request_id → solicitudes → notificaciones → conductores.
 *
 * Uso (desde backend/):
 *   node scripts/delete-all-rapidin-credits-and-drivers.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

async function main() {
  const { query } = await import('../config/database.js');

  console.log('=== Limpieza total Rapidín: créditos y conductores ===\n');

  // ----- 1. PRÉSTAMOS (loans) y todo lo que depende de ellos -----
  const loansResult = await query(
    `SELECT id, disbursed_amount, number_of_installments, status FROM module_rapidin_loans ORDER BY created_at DESC`
  );
  const loanIds = loansResult.rows.map((r) => r.id);

  if (loanIds.length > 0) {
    console.log('1. Eliminando préstamos:', loanIds.length);
    for (const loanId of loanIds) {
      const inst = await query('SELECT id FROM module_rapidin_installments WHERE loan_id = $1', [loanId]);
      const installmentIds = inst.rows.map((r) => r.id);
      if (installmentIds.length > 0) {
        await query('DELETE FROM module_rapidin_payment_installments WHERE installment_id = ANY($1)', [installmentIds]);
        await query('DELETE FROM module_rapidin_voucher_installments WHERE installment_id = ANY($1)', [installmentIds]);
      }
      await query('DELETE FROM module_rapidin_documents WHERE loan_id = $1', [loanId]);
      await query('DELETE FROM module_rapidin_payment_vouchers WHERE loan_id = $1', [loanId]);
      await query('DELETE FROM module_rapidin_payments WHERE loan_id = $1', [loanId]);
      await query('DELETE FROM module_rapidin_auto_payment_log WHERE loan_id = $1', [loanId]);
      await query('DELETE FROM module_rapidin_loans WHERE id = $1', [loanId]);
    }
    console.log('   Préstamos eliminados.\n');
  } else {
    console.log('1. No hay préstamos.\n');
  }

  // ----- 2. Documentos asociados a solicitudes (request_id) -----
  const docReq = await query('DELETE FROM module_rapidin_documents WHERE request_id IS NOT NULL RETURNING id');
  if (docReq.rowCount > 0) {
    console.log('2. Documentos por solicitud eliminados:', docReq.rowCount);
  }

  // ----- 3. SOLICITUDES (loan_requests) -----
  const reqResult = await query('SELECT id FROM module_rapidin_loan_requests');
  const requestIds = reqResult.rows.map((r) => r.id);
  if (requestIds.length > 0) {
    await query('DELETE FROM module_rapidin_loan_requests WHERE id = ANY($1)', [requestIds]);
    console.log('3. Solicitudes eliminadas:', requestIds.length, '\n');
  } else {
    console.log('3. No hay solicitudes.\n');
  }

  // ----- 4. Notificaciones (referencian driver_id y loan_id) -----
  const notif = await query('DELETE FROM module_rapidin_notifications RETURNING id');
  if (notif.rowCount > 0) {
    console.log('4. Notificaciones eliminadas:', notif.rowCount);
  }

  // ----- 5. CONDUCTORES (drivers) -----
  const driversResult = await query('SELECT id, first_name, last_name, dni, country FROM module_rapidin_drivers');
  const driverIds = driversResult.rows.map((r) => r.id);
  if (driverIds.length > 0) {
    console.log('5. Eliminando conductores:', driverIds.length);
    driversResult.rows.forEach((r) => {
      console.log('   -', r.dni, r.country, (r.first_name || '').trim(), (r.last_name || '').trim());
    });
    await query('DELETE FROM module_rapidin_drivers WHERE id = ANY($1)', [driverIds]);
    console.log('   Conductores eliminados.\n');
  } else {
    console.log('5. No hay conductores.\n');
  }

  console.log('=== Listo. Créditos y conductores de Rapidín eliminados. ===');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
