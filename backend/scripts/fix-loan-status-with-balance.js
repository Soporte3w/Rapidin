/**
 * Corrige préstamos que están como 'cancelled' pero tienen saldo pendiente (cuotas sin pagar).
 * Deben mostrarse como 'active' hasta que todas las cuotas estén pagadas.
 * Uso: desde backend/ → node scripts/fix-loan-status-with-balance.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

async function main() {
  const { query } = await import('../config/database.js');
  const r = await query(
    `UPDATE module_rapidin_loans
     SET status = 'active', updated_at = CURRENT_TIMESTAMP
     WHERE status = 'cancelled' AND pending_balance > 0
     RETURNING id, pending_balance`
  );
  if (r.rows.length === 0) {
    console.log('No había préstamos que corregir.');
  } else {
    console.log('Corregidos', r.rows.length, 'préstamo(s) a estado active:', r.rows.map((row) => row.id));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
