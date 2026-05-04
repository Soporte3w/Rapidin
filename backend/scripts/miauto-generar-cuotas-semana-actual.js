/**
 * Ejecuta la generación de cuotas semanales para TODAS las solicitudes activas
 * (misma lógica que el job del lunes 1:10 Lima).
 *
 * IMPORTANTE — No usa Excel:
 *   Viajes y partner fees salen de **Yango `driver/income`**; bono / % / cobro saldo del **cronograma**
 *   en código (`ensureCuotaSemanalForWeek`). Aquí no se pegan columnas tipo hoja de operaciones.
 *
 * Si necesitas ver o compartir desglose (viajes, PF, bono, cascada, Fleet simulado):
 *   node scripts/miauto-preview-semana-excel.js [YYYY-MM-DD]
 *   → genera `scripts/output/preview-semana-YYYY-MM-DD.xlsx` (solo lectura, no BD).
 *
 * Si operación carga semanas desde Excel (fecha, viajes, monto, validado…):
 *   `miauto-cargar-cuotas-excel-sin-mora.js`, `miauto-cargar-cuotas-excel-entrega-inmediata.js`.
 *
 * Uso:
 *   node scripts/miauto-generar-cuotas-semana-actual.js
 */
import 'dotenv/config';
import { runWeeklyCuotaGenerationMonday } from '../jobs/miautoWeeklyCharge.js';

console.log('=== Generando cuotas semana actual para todas las solicitudes activas ===');
const result = await runWeeklyCuotaGenerationMonday({ incomeMaxAttempts: 3, reportDetails: true });
console.log(JSON.stringify(result, null, 2));
if (!result) {
  console.error('Falló la generación (revisa conexión a BD / logs).');
  process.exit(1);
}
process.exit(result.ensure_failed > 0 ? 1 : 0);
