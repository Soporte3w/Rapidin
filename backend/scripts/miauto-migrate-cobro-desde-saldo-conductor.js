/**
 * Acumulado en moneda de la cuota de lo retirado del saldo Yango Fleet hacia esa fila (job cobro).
 * cd backend && node scripts/miauto-migrate-cobro-desde-saldo-conductor.js
 */
import 'dotenv/config';
import { query } from '../config/database.js';

await query(
  `ALTER TABLE module_miauto_cuota_semanal
   ADD COLUMN IF NOT EXISTS cobro_desde_saldo_conductor NUMERIC(14,2) NOT NULL DEFAULT 0`
);
console.log(JSON.stringify({ ok: true, column: 'cobro_desde_saldo_conductor' }, null, 2));
process.exit(0);
