/**
 * Pasa a 'defaulted' (Vencido) los préstamos que están 'active' y tienen al menos
 * una cuota en estado 'overdue' (vencida).
 *
 * Uso (desde backend/):
 *   node excel/update-loans-with-overdue-to-defaulted.js
 *   node excel/update-loans-with-overdue-to-defaulted.js --dry-run   # solo muestra cuántos se actualizarían
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
  logger.info('Buscando préstamos active con al menos una cuota overdue para marcar como defaulted (Vencido)...');

  const sel = await query(`
    SELECT l.id, l.country
    FROM module_rapidin_loans l
    WHERE l.status = 'active'
      AND EXISTS (
        SELECT 1 FROM module_rapidin_installments i
        WHERE i.loan_id = l.id AND i.status = 'overdue'
      )
  `);

  const toUpdate = sel.rows || [];
  const byCountry = {};
  for (const r of toUpdate) {
    byCountry[r.country] = (byCountry[r.country] || 0) + 1;
  }

  logger.info(`Préstamos a actualizar a defaulted (Vencido): ${toUpdate.length} (PE: ${byCountry.PE || 0}, CO: ${byCountry.CO || 0})`);

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

  const ids = toUpdate.map((r) => r.id);
  const updated = await query(
    `UPDATE module_rapidin_loans SET status = 'defaulted', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  logger.info('Préstamos actualizados a defaulted (Vencido): ' + (updated.rowCount ?? 0));
  logger.info('Listo.');
  process.exit(0);
}

run().catch((err) => {
  logger.error(err);
  process.exit(1);
});
