/**
 * Revierte la ejecución de update-by-dni-from-excel.js para DNI 42864766 (PE):
 * - Reasigna los préstamos que quedaron en los conductores "Yego" y "Yego Mi Auto"
 *   al conductor principal del mismo DNI (park_id vacío o el de menor id).
 * - Elimina los 2 conductores insertados (dni=42864766, park_id in ('Yego','Yego Mi Auto')).
 *
 * Uso (desde backend/):
 *   node excel/revert-update-by-dni-42864766.js
 *   node excel/revert-update-by-dni-42864766.js --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const { query } = await import('../config/database.js');

const DNI = '42864766';
const COUNTRY = 'PE';
const PARK_IDS_INSERTADOS = ['Yego', 'Yego Mi Auto'];
const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  console.log(`Reversión para DNI ${DNI} (${COUNTRY}): conductores con park_id en [${PARK_IDS_INSERTADOS.join(', ')}].`);
  if (DRY_RUN) console.log('Modo --dry-run: no se modificará la base de datos.');

  const inserted = await query(
    `SELECT id, park_id, first_name, last_name FROM module_rapidin_drivers
     WHERE dni = $1 AND country = $2 AND TRIM(COALESCE(park_id, '')) = ANY($3::text[])`,
    [DNI, COUNTRY, PARK_IDS_INSERTADOS]
  );
  const toDelete = inserted.rows || [];
  if (toDelete.length === 0) {
    console.log('No se encontraron conductores a revertir. Nada que hacer.');
    process.exit(0);
    return;
  }

  const idsToDelete = toDelete.map((r) => r.id);
  console.log(`Conductores a eliminar: ${toDelete.length}`, toDelete.map((r) => ({ id: r.id, park_id: r.park_id })));

  const mainDriver = await query(
    `SELECT id FROM module_rapidin_drivers
     WHERE dni = $1 AND country = $2 AND id != ALL($3::uuid[])
     ORDER BY (CASE WHEN COALESCE(TRIM(park_id), '') = '' THEN 0 ELSE 1 END), id
     LIMIT 1`,
    [DNI, COUNTRY, idsToDelete]
  );
  const mainId = mainDriver.rows?.[0]?.id;
  if (!mainId && toDelete.length > 0) {
    console.log('No hay otro conductor para este DNI; los préstamos quedarán reasignados al primero de los que iban a borrarse (no se borra nadie).');
    const fallback = toDelete[0].id;
    if (!DRY_RUN) {
      await query(
        `UPDATE module_rapidin_loans SET driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE driver_id = ANY($2::uuid[])`,
        [fallback, idsToDelete]
      );
      await query(
        `UPDATE module_rapidin_loan_requests SET driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE driver_id = ANY($2::uuid[])`,
        [fallback, idsToDelete]
      );
    }
    console.log('Listo (reasignados a conductor fallback).');
    process.exit(0);
    return;
  }

  if (mainId) {
    const loanUpd = await query(
      `UPDATE module_rapidin_loans SET driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE driver_id = ANY($2::uuid[]) RETURNING id`,
      [mainId, idsToDelete]
    );
    const reqUpd = await query(
      `UPDATE module_rapidin_loan_requests SET driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE driver_id = ANY($2::uuid[]) RETURNING id`,
      [mainId, idsToDelete]
    );
    if (!DRY_RUN) {
      console.log(`Préstamos reasignados a conductor principal: ${(loanUpd.rows || []).length} loans, ${(reqUpd.rows || []).length} requests.`);
    } else {
      console.log(`[DRY-RUN] Se reasignarían loans/requests a conductor ${mainId}.`);
    }
  }

  if (!DRY_RUN && idsToDelete.length > 0) {
    await query(`DELETE FROM module_rapidin_drivers WHERE id = ANY($1::uuid[])`, [idsToDelete]);
    console.log(`Eliminados ${idsToDelete.length} conductor(es).`);
  } else if (DRY_RUN) {
    console.log(`[DRY-RUN] Se eliminarían ${idsToDelete.length} conductor(es).`);
  }

  console.log('Listo.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
