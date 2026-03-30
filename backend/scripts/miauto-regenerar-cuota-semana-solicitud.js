/**
 * Regenera la fila de cuota de la semana “actual” del job Mi Auto (mismo lunes que el cron lunes 1:10 Lima).
 * Consulta Yango, hace ensureCuotaSemanalForWeek (INSERT o UPDATE). Por defecto no cobra (dryRun).
 *
 * Uso:
 *   node scripts/miauto-regenerar-cuota-semana-solicitud.js <solicitud_uuid>
 *   MIAUTO_REGEN_COBRO=1 node scripts/miauto-regenerar-cuota-semana-solicitud.js <uuid>   # también ejecuta cobro Fleet
 */
import { runWeeklyChargeForSolicitud } from '../jobs/miautoWeeklyCharge.js';

const sid = process.argv[2]?.trim();
if (!sid) {
  console.error('Uso: node scripts/miauto-regenerar-cuota-semana-solicitud.js <solicitud_uuid>');
  process.exit(1);
}

const cobrar = process.env.MIAUTO_REGEN_COBRO === '1' || process.env.MIAUTO_REGEN_COBRO === 'true';
const incomeMaxAttempts = Math.max(1, Math.min(12, Number(process.env.MIAUTO_REGEN_INCOME_ATTEMPTS) || 4));

try {
  const r = await runWeeklyChargeForSolicitud(sid, {
    dryRun: !cobrar,
    incomeMaxAttempts,
  });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
