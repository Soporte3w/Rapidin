/**
 * Aplica la regla de «pago cubre cuota neta programada» en **toda** la base (misma lógica que el job / `updateMoraDiaria`).
 * Útil tras desplegar el fix para alinear cuotas rent-sale/Fleet que quedaron `overdue` con `paid_amount` = cuota neta.
 *
 * Pasos con `--apply`:
 *  1. `recalcularMoraGlobal()` → `updateMoraDiaria(null, { includePartial: true })` sobre todas las filas en scope.
 *  2. `persistPaidAmountCapsForSolicitud` por cada `solicitud_id` distinto que tenga cuotas (alinea topes de pagado).
 *
 * Uso:
 *   cd backend && node scripts/miauto-apply-pago-neta-todas-solicitudes.js
 *   cd backend && node scripts/miauto-apply-pago-neta-todas-solicitudes.js --apply
 *   cd backend && node scripts/miauto-apply-pago-neta-todas-solicitudes.js --apply --solo-caps   (solo persist caps; si ya corriste el recalc de mora)
 */
import 'dotenv/config';
import { query } from '../config/database.js';
import { recalcularMoraGlobal, persistPaidAmountCapsForSolicitud } from '../services/miautoCuotaSemanalService.js';

const apply = process.argv.includes('--apply');
const soloCaps = process.argv.includes('--solo-caps');

try {
  const countRes = await query(
    `SELECT
       COUNT(DISTINCT solicitud_id)::int AS solicitudes,
       COUNT(*)::int AS cuotas
     FROM module_miauto_cuota_semanal`
  );
  const c = countRes.rows[0] || {};

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          mensaje:
            'Sin --apply: solo estadísticas. Con --apply se ejecuta mora global + caps por solicitud (puede tardar varios minutos).',
          module_miauto_cuota_semanal: {
            solicitudes_distintas: c.solicitudes,
            filas_cuota: c.cuotas,
          },
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  const t0 = Date.now();
  let updated = 0;
  if (!soloCaps) {
    const r = await recalcularMoraGlobal();
    updated = r.updated;
  }
  const t1 = Date.now();

  const sidRes = await query(
    `SELECT DISTINCT solicitud_id::text AS sid FROM module_miauto_cuota_semanal ORDER BY sid`
  );
  const sids = (sidRes.rows || []).map((r) => r.sid).filter(Boolean);

  let capsTotal = 0;
  let idx = 0;
  for (const sid of sids) {
    const n = await persistPaidAmountCapsForSolicitud(sid);
    capsTotal += n;
    idx += 1;
    if (idx % 100 === 0) {
      console.error(`… caps ${idx}/${sids.length} solicitudes`);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        solo_caps: soloCaps,
        updateMoraDiaria_filas_actualizadas: updated,
        persistPaidAmountCaps_ajustes_suma: capsTotal,
        solicitudes_procesadas_caps: sids.length,
        ms_recalc_mora: t1 - t0,
        ms_total: Date.now() - t0,
      },
      null,
      2
    )
  );
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
