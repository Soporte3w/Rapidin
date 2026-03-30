/**
 * Recalcula montos de cuotas Mi Auto desde el cronograma (incluye pct_comision, 83,33 % PF, amount_due).
 * Para cuotas en USD, normaliza `partner_fees_raw` legado (PEN/COP) vía `partnerFeesRawDbNormalizeUsdFromYangoLocal`.
 * Uso: node scripts/recalc-miauto-cuotas-semanales-montos.js [solicitud_uuid]
 * Sin argumento: todas las solicitudes con cuotas.
 */
import { recalcMontosCuotasSemanalesDesdeCronograma } from '../services/miautoCuotaSemanalService.js';

const sid = process.argv[2]?.trim() || null;

try {
  const r = await recalcMontosCuotasSemanalesDesdeCronograma(sid ? { solicitudId: sid } : {});
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
