/**
 * Recalcula mora (`late_fee` + estado) en todas las cuotas Mi Auto en alcance,
 * igual que el job diario **1:00 America/Lima** (`runDailyMora`).
 *
 * Uso:
 *   cd backend && node scripts/miauto-ejecutar-mora-diaria.js
 */
import 'dotenv/config';
import { recalcularMoraGlobal } from '../yego_miauto/services/miautoCuotaSemanalService.js';

console.log('=== Mi Auto mora diaria (global) ===');
const r = await recalcularMoraGlobal();
console.log(JSON.stringify(r, null, 2));
process.exit(0);
