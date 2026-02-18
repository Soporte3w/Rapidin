/**
 * Borra duplicados en module_rapidin_drivers: mismo DNI (solo dígitos) + mismo country + mismo park_id.
 * Por cada grupo conserva una fila (prioridad: con phone, con external_driver_id, más reciente) y
 * reasigna loan_requests, loans, notifications, payment_vouchers al id conservado; luego borra el resto.
 *
 * Uso (desde backend/):
 *   node scripts/delete-duplicate-drivers-by-dni-park.js
 *   node scripts/delete-duplicate-drivers-by-dni-park.js --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

const { query } = await import('../config/database.js');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const r = await query(`
    WITH norm AS (
      SELECT id, dni, country, park_id, external_driver_id, phone, created_at,
             REGEXP_REPLACE(dni, '[^0-9]', '', 'g') AS dni_digits
      FROM module_rapidin_drivers
    ),
    grp AS (
      SELECT dni_digits, country, COALESCE(park_id,'') AS park_id
      FROM norm GROUP BY 1,2,3 HAVING COUNT(*) > 1
    ),
    ranked AS (
      SELECT n.id, n.dni, n.dni_digits, n.country, n.park_id,
             ROW_NUMBER() OVER (PARTITION BY n.dni_digits, n.country, COALESCE(n.park_id,'')
               ORDER BY (CASE WHEN n.phone IS NOT NULL AND TRIM(COALESCE(n.phone,'')) <> '' THEN 0 ELSE 1 END),
                        (CASE WHEN n.external_driver_id IS NOT NULL AND TRIM(COALESCE(n.external_driver_id,'')) <> '' THEN 0 ELSE 1 END),
                        n.created_at DESC) AS rn
      FROM norm n
      JOIN grp ON grp.dni_digits = n.dni_digits AND grp.country = n.country AND grp.park_id = COALESCE(n.park_id,'')
    )
    SELECT id, dni, dni_digits, country, park_id, rn FROM ranked ORDER BY dni_digits, park_id, rn
  `);
  const rows = r.rows || [];
  const toDelete = rows.filter((r) => Number(r.rn) !== 1);
  const toKeepIds = new Set(rows.filter((r) => Number(r.rn) === 1).map((r) => r.id));

  console.log('Grupos duplicados (mismo DNI dígitos + country + park_id):', toKeepIds.size);
  console.log('Filas duplicadas a borrar:', toDelete.length);
  if (toDelete.length === 0) {
    console.log('Nada que borrar.');
    process.exit(0);
  }

  for (const row of toDelete) {
    const dupId = row.id;
    const keptId = rows.find(
      (r) =>
        r.dni_digits === row.dni_digits &&
        r.country === row.country &&
        (r.park_id || '') === (row.park_id || '') &&
        Number(r.rn) === 1
    )?.id;
    if (!keptId) {
      console.warn('No keptId para', dupId, row.dni);
      continue;
    }
    console.log('Duplicado', row.dni, row.park_id, '-> reasignar a', keptId, 'y borrar', dupId);
    if (!dryRun) {
      await query('UPDATE module_rapidin_loan_requests SET driver_id = $1 WHERE driver_id = $2', [keptId, dupId]);
      await query('UPDATE module_rapidin_loans SET driver_id = $1 WHERE driver_id = $2', [keptId, dupId]);
      await query('UPDATE module_rapidin_notifications SET driver_id = $1 WHERE driver_id = $2', [keptId, dupId]);
      await query('UPDATE module_rapidin_payment_vouchers SET driver_id = $1 WHERE driver_id = $2', [keptId, dupId]);
      await query('DELETE FROM module_rapidin_drivers WHERE id = $1', [dupId]);
    }
  }
  console.log(dryRun ? 'Dry-run: no se borró nada.' : 'Listo.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
