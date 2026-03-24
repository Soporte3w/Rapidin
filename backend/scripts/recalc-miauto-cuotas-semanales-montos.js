/**
 * Persiste en BD pct_comision, cobro_saldo, amount_due y demás campos de regla
 * recalculados desde el cronograma (misma lógica que ensureCuotaSemanalForWeek).
 *
 * Uso:
 *   node scripts/recalc-miauto-cuotas-semanales-montos.js
 *   node scripts/recalc-miauto-cuotas-semanales-montos.js --solicitud-id <uuid>
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { logger } from '../utils/logger.js';
import { recalcMontosCuotasSemanalesDesdeCronograma } from '../services/miautoCuotaSemanalService.js';

function parseArgs(argv) {
  let solicitudId = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--solicitud-id' && argv[i + 1]) solicitudId = String(argv[++i]).trim();
  }
  return { solicitudId };
}

async function main() {
  const { solicitudId } = parseArgs(process.argv);
  const r = await recalcMontosCuotasSemanalesDesdeCronograma({ solicitudId });
  logger.info(`Listo: ${r.updated} cuotas actualizadas, ${r.solicitudes} solicitudes tocadas.`);
  process.exit(0);
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
