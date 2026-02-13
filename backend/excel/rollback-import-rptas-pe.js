/**
 * Elimina todos los datos insertados por la importación del Excel Rptas PE.
 * Orden: log cobros, distribución pagos, pagos, voucher_installments, vouchers, installments, loans, loan_requests, drivers.
 * Uso (desde backend/): node excel/rollback-import-rptas-pe.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { getClient } = await import('../config/database.js');
const { logger } = await import('../utils/logger.js');

async function run() {
  logger.info('Eliminando datos de la importación Rptas PE...');

  const client = await getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      TRUNCATE TABLE
        module_rapidin_auto_payment_log,
        module_rapidin_payment_installments,
        module_rapidin_payments,
        module_rapidin_voucher_installments,
        module_rapidin_payment_vouchers,
        module_rapidin_installments,
        module_rapidin_documents,
        module_rapidin_loans,
        module_rapidin_loan_requests,
        module_rapidin_drivers
      RESTART IDENTITY CASCADE
    `);
    logger.info('  Tablas truncadas');

    await client.query('COMMIT');
    logger.info('Rollback completado.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  process.exit(0);
}

run().catch(err => {
  logger.error(err);
  process.exit(1);
});
