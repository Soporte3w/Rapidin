/**
 * Fija `fecha_ultimo_abono` (Lima) en una fila de cuota semanal Mi Auto (p. ej. backfill del día real del abono).
 *
 * Uso:
 *   cd backend && node scripts/miauto-set-fecha-ultimo-abono.js <solicitud_uuid> <week_start_YYYY-MM-DD> <fecha_abono_YYYY-MM-DD>
 *
 * Ejemplo:
 *   node scripts/miauto-set-fecha-ultimo-abono.js b552af8b-9514-4518-89cd-4f21730c05c0 2026-03-16 2026-04-08
 */
import { query } from '../config/database.js';

const sid = process.argv[2]?.trim();
const weekYmd = process.argv[3]?.trim();
const fechaAbono = process.argv[4]?.trim();

if (!sid || !weekYmd || !fechaAbono) {
  console.error(
    'Uso: node scripts/miauto-set-fecha-ultimo-abono.js <solicitud_uuid> <week_start_YYYY-MM-DD> <fecha_abono_YYYY-MM-DD>'
  );
  process.exit(1);
}

const week = weekYmd.slice(0, 10);
const fa = fechaAbono.slice(0, 10);

try {
  const res = await query(
    `UPDATE module_miauto_cuota_semanal
     SET fecha_ultimo_abono = $3::date, updated_at = CURRENT_TIMESTAMP
     WHERE solicitud_id = $1::uuid AND week_start_date::date = $2::date`,
    [sid, week, fa]
  );
  console.log(JSON.stringify({ ok: true, rowCount: res.rowCount, solicitud_id: sid, week_start: week, fecha_ultimo_abono: fa }, null, 2));
  process.exit(0);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
