/**
 * Actualiza a 'cancelled' todos los préstamos (PE y CO) que tienen todas sus cuotas pagadas.
 * Incluye préstamos en 'active' y en 'defaulted' (vencidos) que ya pagaron todo.
 * También actualiza la solicitud (loan_request) asociada a 'cancelled'.
 *
 * Uso (desde backend/):
 *   node excel/update-loans-fully-paid-to-cancelled.js
 *   node excel/update-loans-fully-paid-to-cancelled.js --dry-run   # solo muestra cuántos se actualizarían
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { query } = await import('../config/database.js');
const { logger } = await import('../utils/logger.js');

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  logger.info('Actualizando préstamos (active o defaulted/vencidos) → cancelled cuando todas las cuotas están pagadas (PE y CO)...');

  // Préstamos que están active o defaulted y tienen todas las cuotas pagadas (cualquier country)
  const sel = await query(`
    SELECT l.id, l.country, l.status AS current_status
    FROM module_rapidin_loans l
    WHERE l.status IN ('active', 'defaulted')
      AND (SELECT COUNT(*) FROM module_rapidin_installments i WHERE i.loan_id = l.id) > 0
      AND (SELECT COUNT(*) FROM module_rapidin_installments i WHERE i.loan_id = l.id)
          = (SELECT COUNT(*) FROM module_rapidin_installments i WHERE i.loan_id = l.id AND (i.status = 'paid' OR (i.installment_amount > 0 AND i.paid_amount >= i.installment_amount)))
  `);

  const toUpdate = sel.rows || [];
  const byCountry = {};
  for (const r of toUpdate) {
    byCountry[r.country] = (byCountry[r.country] || 0) + 1;
  }

  const defaultedCount = (toUpdate.filter(r => r.current_status === 'defaulted')).length;
  logger.info(`Préstamos a actualizar a cancelled: ${toUpdate.length} (PE: ${byCountry.PE || 0}, CO: ${byCountry.CO || 0})${defaultedCount ? `, de los cuales ${defaultedCount} estaban en defaulted/vencidos` : ''}`);

  if (DRY_RUN) {
    logger.info('Modo --dry-run: no se modificó la base de datos.');
    process.exit(0);
    return;
  }

  if (toUpdate.length === 0) {
    logger.info('Nada que actualizar.');
    process.exit(0);
    return;
  }

  const updated = await query(`
    UPDATE module_rapidin_loans l
    SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
    WHERE l.status IN ('active', 'defaulted')
      AND (SELECT COUNT(*) FROM module_rapidin_installments i WHERE i.loan_id = l.id) > 0
      AND (SELECT COUNT(*) FROM module_rapidin_installments i WHERE i.loan_id = l.id)
          = (SELECT COUNT(*) FROM module_rapidin_installments i WHERE i.loan_id = l.id AND (i.status = 'paid' OR (i.installment_amount > 0 AND i.paid_amount >= i.installment_amount)))
  `);
  const loansCount = updated.rowCount ?? 0;
  logger.info(`Préstamos actualizados a cancelled: ${loansCount}`);

  const reqUpdated = await query(`
    UPDATE module_rapidin_loan_requests r
    SET status = 'cancelled'
    WHERE r.status != 'cancelled'
      AND EXISTS (SELECT 1 FROM module_rapidin_loans l WHERE l.request_id = r.id AND l.status = 'cancelled')
  `);
  const requestsCount = reqUpdated.rowCount ?? 0;
  logger.info(`Solicitudes actualizadas a cancelled: ${requestsCount}`);

  logger.info('Listo.');
  process.exit(0);
}

run().catch(err => {
  logger.error(err);
  process.exit(1);
});
