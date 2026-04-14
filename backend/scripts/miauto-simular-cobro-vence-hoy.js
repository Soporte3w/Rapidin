/**
 * Simula el cobro Fleet (mismo orden y lógica que el cron lunes 7:10 Lima).
 *
 * Opcional `--vence-hoy`: pone `due_date = hoy Lima` en la primera cuota de la solicitud
 * que tenga saldo pendiente (orden cola: due_date ASC, luego week_start), recalcula mora
 * y luego muestra qué haría cada retiro (dry-run; no descuenta saldo real salvo que uses el script de cobro real).
 *
 *   # Solo simular con el estado actual de BD (sin tocar fechas)
 *   node scripts/miauto-simular-cobro-vence-hoy.js <solicitud_uuid> --sin-saldo-api
 *
 *   # Marcar “vence hoy” la primera cuota con deuda + simular cobro (consulta saldo Yango si quitas --sin-saldo-api)
 *   node scripts/miauto-simular-cobro-vence-hoy.js <solicitud_uuid> --vence-hoy --sin-saldo-api
 */
import 'dotenv/config';
import { query } from '../config/database.js';
import { getLimaYmd } from '../utils/miautoLimaWeekRange.js';
import {
  getCuotasToChargeForSolicitud,
  persistPaidAmountCapsForSolicitud,
  processCobroCuota,
  updateMoraDiaria,
} from '../services/miautoCuotaSemanalService.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const id = args.find((a) => !a.startsWith('-'));
  return {
    id,
    venceHoy: args.includes('--vence-hoy'),
    sinSaldoApi: args.includes('--sin-saldo-api'),
  };
}

async function aplicarVencimientoHoyLima(solicitudId) {
  const hoy = getLimaYmd(new Date());
  const pick = await query(
    `SELECT c.id, c.due_date::text AS due_antes, c.week_start_date::text AS ws
     FROM module_miauto_cuota_semanal c
     WHERE c.solicitud_id = $1::uuid
       AND c.status IN ('pending', 'overdue', 'partial')
       AND (COALESCE(c.amount_due, 0) + COALESCE(c.late_fee, 0) - COALESCE(c.paid_amount, 0)) > 0.005
     ORDER BY c.due_date ASC NULLS LAST, c.week_start_date ASC NULLS LAST, c.id
     LIMIT 1`,
    [solicitudId]
  );
  const row = pick.rows[0];
  if (!row) {
    return { ok: false, error: 'No hay cuota con saldo pendiente para esta solicitud' };
  }
  await query(
    `UPDATE module_miauto_cuota_semanal
     SET due_date = $1::date, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2::uuid`,
    [hoy, row.id]
  );
  return { ok: true, cuota_id: row.id, due_antes: row.due_antes, due_nuevo: hoy, week_start: row.ws };
}

async function main() {
  const { id, venceHoy, sinSaldoApi } = parseArgs(process.argv);
  if (!id) {
    console.error(
      'Uso: node scripts/miauto-simular-cobro-vence-hoy.js <solicitud_uuid> [--vence-hoy] [--sin-saldo-api]'
    );
    process.exit(1);
  }

  if (venceHoy) {
    const r = await aplicarVencimientoHoyLima(id);
    console.log('\n--- Ajuste vencimiento hoy (Lima) ---\n', JSON.stringify(r, null, 2));
    if (!r.ok) {
      process.exit(1);
    }
  }

  await updateMoraDiaria(id, { includePartial: true });
  await persistPaidAmountCapsForSolicitud(id);

  const { cuotas: cola, pendingMap: solicitudPendingMap } = await getCuotasToChargeForSolicitud(id);
  console.log('\n--- Cola cobro (due_date ASC, misma query que job 7:10) ---');
  console.log(JSON.stringify({ solicitud_id: id, cuotas_en_cola: cola.length }, null, 2));

  if (cola.length === 0) {
    console.log(
      '\nNo hay cuotas en cola: revisa status, saldo pendiente, external_driver_id/park_id Mi Auto, o MIAUTO_PARK_ID.'
    );
    process.exit(0);
  }

  const opts = { dryRun: true, skipBalanceCheck: sinSaldoApi, solicitudPendingMap };
  let i = 0;
  for (const row of cola) {
    i += 1;
    const out = await processCobroCuota(row, null, null, opts);
    console.log(`\n#${i} cuota_id=${row.id} due=${row.due_date} week_start=${row.week_start_date} external_driver_id=${row.external_driver_id}`);
    console.log(JSON.stringify(out, null, 2));
  }

  console.log(
    '\nNota: simulación en dry-run (no se retiró saldo). Cobro real: node scripts/miauto-cobro-fleet-solicitud.js <uuid>'
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
