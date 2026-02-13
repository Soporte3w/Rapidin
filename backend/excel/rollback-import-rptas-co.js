/**
 * Elimina solo los datos de Colombia (CO) insertados por la importación del Excel.
 * Respeta PE: no toca conductores, solicitudes ni préstamos de Perú.
 * Orden: log cobros, distribución pagos, pagos, voucher_installments, vouchers, installments, documents, loans, loan_requests, drivers (solo country='CO').
 * Uso (desde backend/): node excel/rollback-import-rptas-co.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { getClient } = await import('../config/database.js');
const { logger } = await import('../utils/logger.js');

const COUNTRY = 'CO';

async function run() {
  logger.info(`Eliminando solo datos de importación de ${COUNTRY} (Colombia)...`);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const loanIdsCo = `SELECT id FROM module_rapidin_loans WHERE country = $1`;
    const driverIdsCo = `SELECT id FROM module_rapidin_drivers WHERE country = $1`;
    const requestIdsCo = `SELECT id FROM module_rapidin_loan_requests WHERE country = $1`;

    // 1) Log de cobros: por loan o por driver de CO
    const r1 = await client.query(
      `DELETE FROM module_rapidin_auto_payment_log
       WHERE loan_id IN (${loanIdsCo}) OR driver_id IN (${driverIdsCo})`,
      [COUNTRY]
    );
    logger.info(`  module_rapidin_auto_payment_log: ${r1.rowCount} filas`);

    // 2) Distribución de pagos: pagos de préstamos CO (payment_id → payment → loan_id)
    const r2 = await client.query(
      `DELETE FROM module_rapidin_payment_installments
       WHERE payment_id IN (SELECT id FROM module_rapidin_payments WHERE loan_id IN (${loanIdsCo}))`,
      [COUNTRY]
    );
    logger.info(`  module_rapidin_payment_installments: ${r2.rowCount} filas`);

    // 3) Pagos de préstamos CO
    const r3 = await client.query(
      `DELETE FROM module_rapidin_payments WHERE loan_id IN (${loanIdsCo})`,
      [COUNTRY]
    );
    logger.info(`  module_rapidin_payments: ${r3.rowCount} filas`);

    // 4) Voucher installments: vouchers de préstamos CO
    const r4 = await client.query(
      `DELETE FROM module_rapidin_voucher_installments
       WHERE voucher_id IN (SELECT id FROM module_rapidin_payment_vouchers WHERE loan_id IN (${loanIdsCo}))`,
      [COUNTRY]
    );
    logger.info(`  module_rapidin_voucher_installments: ${r4.rowCount} filas`);

    // 5) Vouchers de préstamos CO
    const r5 = await client.query(
      `DELETE FROM module_rapidin_payment_vouchers WHERE loan_id IN (${loanIdsCo})`,
      [COUNTRY]
    );
    logger.info(`  module_rapidin_payment_vouchers: ${r5.rowCount} filas`);

    // 6) Cuotas de préstamos CO
    const r6 = await client.query(
      `DELETE FROM module_rapidin_installments WHERE loan_id IN (${loanIdsCo})`,
      [COUNTRY]
    );
    logger.info(`  module_rapidin_installments: ${r6.rowCount} filas`);

    // 7) Documentos ligados a préstamos o solicitudes de CO
    const r7 = await client.query(
      `DELETE FROM module_rapidin_documents
       WHERE loan_id IN (${loanIdsCo}) OR request_id IN (${requestIdsCo})`,
      [COUNTRY]
    );
    logger.info(`  module_rapidin_documents: ${r7.rowCount} filas`);

    // 8) Préstamos CO
    const r8 = await client.query(
      `DELETE FROM module_rapidin_loans WHERE country = $1`,
      [COUNTRY]
    );
    logger.info(`  module_rapidin_loans: ${r8.rowCount} filas`);

    // 9) Solicitudes CO
    const r9 = await client.query(
      `DELETE FROM module_rapidin_loan_requests WHERE country = $1`,
      [COUNTRY]
    );
    logger.info(`  module_rapidin_loan_requests: ${r9.rowCount} filas`);

    // 10) Conductores CO
    const r10 = await client.query(
      `DELETE FROM module_rapidin_drivers WHERE country = $1`,
      [COUNTRY]
    );
    logger.info(`  module_rapidin_drivers: ${r10.rowCount} filas`);

    await client.query('COMMIT');
    logger.info('Rollback CO completado. Puedes volver a ejecutar: node excel/importExcelRptasPE.js --country=CO');
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
