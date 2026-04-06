/**
 * Elimina la fila module_miauto_cuota_semanal de un lunes de cuota para una solicitud Mi Auto,
 * o para **todas** las solicitudes que tengan cuota ese lunes (`--all`).
 * No usa backend/backups/.
 *
 * Uso:
 *   node scripts/miauto-eliminar-cuota-semana-solicitud.js <solicitud_uuid> <YYYY-MM-DD> [--apply] [--force-deposito]
 *   node scripts/miauto-eliminar-cuota-semana-solicitud.js --all <YYYY-MM-DD> [--apply] [--force-deposito]
 */
import { query } from '../config/database.js';
import { mondayOfWeekContainingYmd } from '../utils/miautoLimaWeekRange.js';
import {
  isSemanaDepositoMiAuto,
  parsePartnerFeesCascadaDestinoDb,
  updateMoraDiaria,
  persistPaidAmountCapsForSolicitud,
} from '../services/miautoCuotaSemanalService.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const forceDeposito = argv.includes('--force-deposito');
const allMode = argv.includes('--all');
const positional = argv.filter((a) => !a.startsWith('--'));

function usage() {
  console.error(
    'Uso:\n' +
      '  node scripts/miauto-eliminar-cuota-semana-solicitud.js <solicitud_uuid> <YYYY-MM-DD> [--apply] [--force-deposito]\n' +
      '  node scripts/miauto-eliminar-cuota-semana-solicitud.js --all <YYYY-MM-DD> [--apply] [--force-deposito]'
  );
  process.exit(1);
}

function stripCascadaTarget(jsonDb, targetId) {
  const list = parsePartnerFeesCascadaDestinoDb(jsonDb);
  const t = String(targetId);
  const next = list.filter((a) => a && String(a.cuota_semanal_id) !== t);
  if (next.length === list.length) return { changed: false, value: null };
  return {
    changed: true,
    value: next.length === 0 ? null : JSON.stringify(next),
  };
}

async function deleteCuotaForSolicitud(solicitudId, cuotaId) {
  const compRes = await query(
    `SELECT id::text FROM module_miauto_comprobante_cuota_semanal WHERE cuota_semanal_id = $1::uuid`,
    [cuotaId]
  );
  const compIds = (compRes.rows || []).map((r) => r.id);

  const hermanasRes = await query(
    `SELECT id::text, partner_fees_cascada_destino
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1::uuid AND id <> $2::uuid`,
    [solicitudId, cuotaId]
  );

  for (const cid of compIds) {
    await query(`DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1::uuid`, [cid]);
  }
  for (const h of hermanasRes.rows || []) {
    const { changed, value } = stripCascadaTarget(h.partner_fees_cascada_destino, cuotaId);
    if (changed) {
      await query(
        `UPDATE module_miauto_cuota_semanal SET partner_fees_cascada_destino = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid`,
        [value, h.id]
      );
    }
  }
  await query(`DELETE FROM module_miauto_cuota_semanal WHERE id = $1::uuid`, [cuotaId]);
  return { comprobantes_borrados: compIds.length };
}

async function runAll(monday) {
  const listRes = await query(
    `SELECT c.id::text AS cuota_id, c.solicitud_id::text AS solicitud_id, c.status, c.paid_amount::numeric, c.late_fee::numeric,
            s.fecha_inicio_cobro_semanal
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     WHERE c.week_start_date::date = $1::date
     ORDER BY c.solicitud_id`,
    [monday]
  );
  const rows = listRes.rows || [];
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    monday,
    total_encontradas: rows.length,
    omitidas_semana_deposito: [],
    eliminadas: [],
    errores: [],
  };

  const affectedSolicitudes = new Set();

  for (const row of rows) {
    const sid = row.solicitud_id;
    const cuotaId = row.cuota_id;
    if (!forceDeposito && isSemanaDepositoMiAuto(monday, row.fecha_inicio_cobro_semanal)) {
      summary.omitidas_semana_deposito.push({ solicitud_id: sid, cuota_id: cuotaId });
      continue;
    }
    if (!apply) {
      summary.eliminadas.push({
        solicitud_id: sid,
        cuota_id: cuotaId,
        status: row.status,
        paid_amount: String(row.paid_amount),
        late_fee: String(row.late_fee),
      });
      continue;
    }
    try {
      const r = await deleteCuotaForSolicitud(sid, cuotaId);
      affectedSolicitudes.add(sid);
      summary.eliminadas.push({ solicitud_id: sid, cuota_id: cuotaId, ...r });
    } catch (e) {
      summary.errores.push({ solicitud_id: sid, cuota_id: cuotaId, error: String(e?.message || e) });
    }
  }

  if (apply && affectedSolicitudes.size > 0) {
    for (const sid of affectedSolicitudes) {
      await updateMoraDiaria(sid, { includePartial: true });
      await persistPaidAmountCapsForSolicitud(sid);
    }
    summary.solicitudes_mora_y_caps = [...affectedSolicitudes];
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!apply && rows.length > 0) {
    console.log('Dry-run: añade --apply para ejecutar.');
  }
}

async function runOne(solicitudId, rawWeek) {
  const monday = mondayOfWeekContainingYmd(rawWeek);
  const solRes = await query(
    `SELECT id, fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1::uuid`,
    [solicitudId]
  );
  const sol = solRes.rows?.[0];
  if (!sol) {
    console.error('Solicitud no encontrada');
    process.exit(1);
  }
  if (isSemanaDepositoMiAuto(monday, sol.fecha_inicio_cobro_semanal) && !forceDeposito) {
    console.error('Semana depósito: use --force-deposito si es intencional.');
    process.exit(1);
  }

  const cuotaRes = await query(
    `SELECT id::text, week_start_date, due_date, paid_amount::numeric, late_fee::numeric, status
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1::uuid AND week_start_date::date = $2::date`,
    [solicitudId, monday]
  );
  const cuota = cuotaRes.rows?.[0];
  if (!cuota) {
    console.error(`Sin cuota week_start_date::date = ${monday}`);
    process.exit(1);
  }

  const cuotaId = cuota.id;
  const compRes = await query(
    `SELECT id::text FROM module_miauto_comprobante_cuota_semanal WHERE cuota_semanal_id = $1::uuid`,
    [cuotaId]
  );
  const compIds = (compRes.rows || []).map((r) => r.id);

  const hermanasRes = await query(
    `SELECT id::text, partner_fees_cascada_destino
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1::uuid AND id <> $2::uuid`,
    [solicitudId, cuotaId]
  );

  let cascadaCount = 0;
  for (const h of hermanasRes.rows || []) {
    const { changed } = stripCascadaTarget(h.partner_fees_cascada_destino, cuotaId);
    if (changed) cascadaCount++;
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        solicitud_id: solicitudId,
        monday,
        cuota_id: cuotaId,
        cuota,
        comprobantes_a_borrar: compIds.length,
        filas_cascada_a_actualizar: cascadaCount,
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log('Dry-run: añade --apply para ejecutar.');
    process.exit(0);
  }

  const del = await deleteCuotaForSolicitud(solicitudId, cuotaId);
  const nMora = await updateMoraDiaria(solicitudId, { includePartial: true });
  await persistPaidAmountCapsForSolicitud(solicitudId);
  console.log(
    JSON.stringify(
      {
        ok: true,
        deleted_cuota_id: cuotaId,
        comprobantes_borrados: del.comprobantes_borrados,
        updateMoraDiaria_filas: nMora,
      },
      null,
      2
    )
  );
}

async function main() {
  if (allMode) {
    if (positional.length < 1) usage();
    const rawWeek = String(positional[0]).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawWeek)) usage();
    const monday = mondayOfWeekContainingYmd(rawWeek);
    await runAll(monday);
    return;
  }

  if (positional.length < 2) usage();
  const solicitudId = String(positional[0]).trim();
  const rawWeek = String(positional[1]).trim().slice(0, 10);
  if (!/^[0-9a-f-]{36}$/i.test(solicitudId)) usage();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawWeek)) usage();
  await runOne(solicitudId, rawWeek);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
