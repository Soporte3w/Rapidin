/**
 * Una sola vez: agrega columna montos_fuente a module_miauto_cuota_semanal.
 * cd backend && node scripts/miauto-migrate-add-montos-fuente-cuota.js
 */
import 'dotenv/config';
import { query } from '../config/database.js';

await query(
  `ALTER TABLE module_miauto_cuota_semanal
   ADD COLUMN IF NOT EXISTS montos_fuente VARCHAR(32) NOT NULL DEFAULT 'sistema'`
);
console.log(JSON.stringify({ ok: true, note: 'montos_fuente: excel | sistema' }, null, 2));
process.exit(0);
