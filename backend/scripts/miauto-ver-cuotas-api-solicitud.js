/**
 * Rent sale / Mi Auto: imprime el mismo JSON que devuelve GET /cuotas-semanales (staff) para una solicitud.
 * Opcional: una sola semana por lunes (YYYY-MM-DD).
 *
 * Uso:
 *   cd backend && node scripts/miauto-ver-cuotas-api-solicitud.js b552af8b-9514-4518-89cd-4f21730c05c0
 *   cd backend && node scripts/miauto-ver-cuotas-api-solicitud.js b552af8b-9514-4518-89cd-4f21730c05c0 2026-03-16
 *
 * Requiere .env con DATABASE_URL (o la misma config que el API).
 */
import { getCuotasSemanalesConRacha } from '../services/miautoCuotaSemanalService.js';

/** YYYY-MM-DD desde `Date`, ISO string o valor de BD. */
function weekStartYmd(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s.slice(0, 10);
}

const sid = process.argv[2]?.trim();
const weekYmd = process.argv[3]?.trim();

if (!sid) {
  console.error('Uso: node scripts/miauto-ver-cuotas-api-solicitud.js <solicitud_uuid> [week_start_YYYY-MM-DD]');
  process.exit(1);
}

try {
  const { data: cuotas } = await getCuotasSemanalesConRacha(sid, { incluirAbonoComprobantePendiente: true });
  const list = Array.isArray(cuotas) ? cuotas : [];
  let out = list;
  if (weekYmd) {
    const prefix = weekYmd.slice(0, 10);
    out = list.filter((c) => weekStartYmd(c.week_start_date) === prefix);
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
