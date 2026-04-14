/**
 * Tras restaurar backup o si pending/UI no cuadra: recalcula mora persistida y recorta `paid_amount`
 * al tope de obligación (`persistPaidAmountCapsForSolicitud`), misma lógica que el job tras generar cuotas.
 *
 * Uso: cd backend && node scripts/miauto-repair-mora-caps-solicitud.js <solicitud_uuid>
 */
import 'dotenv/config';
import { persistPaidAmountCapsForSolicitud, updateMoraDiaria } from '../services/miautoCuotaSemanalService.js';

const sid = process.argv[2]?.trim();
if (!sid) {
  console.error('Uso: node scripts/miauto-repair-mora-caps-solicitud.js <solicitud_uuid>');
  process.exit(1);
}

try {
  await updateMoraDiaria(sid, { includePartial: true });
  const n = await persistPaidAmountCapsForSolicitud(sid);
  console.log(JSON.stringify({ ok: true, solicitud_id: sid, ajustes_cap_paid: n }, null, 2));
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
