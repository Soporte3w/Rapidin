/**
 * Ejecuta el cobro Fleet de Yego Mi Auto (mismo job del lunes 7:10 Lima: una pasada sobre toda la cola).
 * Cobra todas las cuotas pendientes/vencidas/parciales con saldo según `getCuotasToCharge`.
 *
 * Uso:
 *   cd backend && node scripts/miauto-ejecutar-cobro-fleet-lunes.js
 */
import 'dotenv/config';
import { runWeeklyFleetChargeMonday } from '../jobs/miautoWeeklyCharge.js';

console.log('=== Cobro Fleet Yego Mi Auto (job lunes 7:10, ejecución manual) ===');

const r = await runWeeklyFleetChargeMonday({ auditJob: 'manual_script' });

console.log(
  `\nCuotas en cola: ${r.cuotas_en_cola ?? 0} | ok: ${r.success ?? 0} | parcial: ${r.partial ?? 0} | fallidos: ${r.failed ?? 0}`
);

if (!r.ok) {
  console.error('Error:', r.error || '(sin mensaje)');
  process.exit(1);
}

process.exit((r.failed ?? 0) > 0 ? 1 : 0);
