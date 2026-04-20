/**
 * Ejecuta la generación de cuotas semanales para TODAS las solicitudes activas
 * (misma lógica que el job del lunes 1:10 Lima).
 *
 * Uso:
 *   node scripts/miauto-generar-cuotas-semana-actual.js
 */
import 'dotenv/config';
import { runWeeklyCuotaGenerationMonday } from '../jobs/miautoWeeklyCharge.js';

console.log('=== Generando cuotas semana actual para todas las solicitudes activas ===');
const result = await runWeeklyCuotaGenerationMonday({ incomeMaxAttempts: 3, reportDetails: true });
console.log(JSON.stringify(result, null, 2));
process.exit(result.ensure_failed > 0 ? 1 : 0);
