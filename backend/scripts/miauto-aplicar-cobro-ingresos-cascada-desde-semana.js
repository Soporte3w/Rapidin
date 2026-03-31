/**
 * Aplica el **mismo reparto** que el ensure Yango: pool en moneda de cuota → `paid_amount` en cuotas con saldo,
 * orden **due_date ASC** (más antigua primero), **excluyendo** la fila de la semana origen (como `ensureCuotaSemanalForWeek`).
 * Persiste en la fila origen `partner_fees_cascada_destino` (merge con lo que ya hubiera) para que la UI muestre
 * «Imputación del cobro», y aplica `snapshotOrigenFilaTrasCascadaPool` (mismo criterio que `ensureCuotaSemanalForWeek`):
 * PF remanente, `partner_fees_yango_raw` alineado con la columna «Cobro por ingresos», y `amount_due` persistido coherente.
 *
 * Uso (desde `backend/`):
 *   node scripts/miauto-aplicar-cobro-ingresos-cascada-desde-semana.js <solicitud_uuid> <ordinal_semana_ui> <monto> [dni] [--pool-total]
 *
 * - **Sin `--pool-total`**: `<monto>` = tributo columna «cobro por ingresos» (**83,33% PF**); el pool repartido es
 *   ese monto + % comisión de la fila de esa semana (igual que `partnerFeesPlusComisionPool` en el servicio).
 * - **Con `--pool-total`**: `<monto>` es el **pool total** (misma moneda que la cuota) a repartir.
 * - Moneda de fila: **USD**, **PEN** o **COP** (el pool va en esa moneda).
 *
 * Ejemplos:
 *   node scripts/... baf37a6e-... 32 56.76 07687147 --pool-total
 *   node scripts/... <uuid> 32 56.76 07687147
 */
import { query } from '../config/database.js';
import { round2 } from '../services/miautoMoneyUtils.js';
import {
  applyPartnerFeesWaterfallToSolicitud,
  cascadaDestinoExcluirCuotaOrigen,
  mergeCascadaAllocacionesPorCuota,
  parsePartnerFeesCascadaDestinoDb,
  persistPaidAmountCapsForSolicitud,
  snapshotOrigenFilaTrasCascadaPool,
  updateMoraDiaria,
} from '../services/miautoCuotaSemanalService.js';

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function partnerFeesPlusComisionPool(pf83, pctComision) {
  const pf = round2(Number(pf83) || 0);
  const pct = round2(Number(pctComision) || 0);
  const com = round2(pf * (pct / 100));
  return round2(pf + com);
}

function parseArgs(argv) {
  const poolTotal = argv.includes('--pool-total');
  const rest = argv.filter((a) => a !== '--pool-total');
  const sid = rest[0]?.trim();
  const ordinal = Math.max(1, parseInt(String(rest[1] || ''), 10) || 0);
  const monto = parseFloat(String(rest[2] || '').replace(',', '.'));
  let dniCheck = null;
  if (rest[3] && digitsOnly(rest[3]).length >= 7) dniCheck = rest[3].trim();
  return { sid, ordinal, monto, dniCheck, poolTotal };
}

async function main() {
  const { sid, ordinal, monto, dniCheck, poolTotal } = parseArgs(process.argv.slice(2));

  if (!sid || !ordinal || Number.isNaN(monto) || monto <= 0) {
    console.error(
      'Uso: node scripts/miauto-aplicar-cobro-ingresos-cascada-desde-semana.js <solicitud_uuid> <ordinal_semana> <monto> [dni] [--pool-total]'
    );
    process.exit(1);
  }

  if (dniCheck) {
    const sol = await query(
      `SELECT REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g') AS dni_sol,
              REGEXP_REPLACE(COALESCE(TRIM(rd.dni), ''), '[^0-9]', '', 'g') AS dni_rd
       FROM module_miauto_solicitud s
       LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
       WHERE s.id = $1::uuid`,
      [sid]
    );
    const row = sol.rows[0];
    if (!row) {
      console.error('Solicitud no encontrada');
      process.exit(1);
    }
    const dniBd = String(row.dni_rd || row.dni_sol || '');
    if (dniBd !== digitsOnly(dniCheck)) {
      console.error(`DNI no coincide: BD=${dniBd || '(vacío)'} esperado=${digitsOnly(dniCheck)}`);
      process.exit(1);
    }
  }

  const cu = await query(
    `SELECT id, week_start_date, due_date, moneda, pct_comision, cobro_saldo, cuota_semanal,
            partner_fees_cascada_destino
     FROM (
       SELECT c.*, ROW_NUMBER() OVER (ORDER BY c.week_start_date ASC NULLS LAST) AS n
       FROM module_miauto_cuota_semanal c
       WHERE c.solicitud_id = $1::uuid
     ) x
     WHERE n = $2`,
    [sid, ordinal]
  );
  const filaOrigen = cu.rows[0];
  if (!filaOrigen) {
    console.error(`No hay cuota con ordinal UI ${ordinal} para la solicitud`);
    process.exit(1);
  }

  const moneda = String(filaOrigen.moneda || 'PEN').toUpperCase();
  if (moneda !== 'USD' && moneda !== 'PEN' && moneda !== 'COP') {
    console.error(`Moneda de cuota no soportada para este script: ${moneda} (use USD, PEN o COP)`);
    process.exit(1);
  }

  const pct = round2(parseFloat(filaOrigen.pct_comision) || 0);
  const poolMonto = poolTotal ? round2(monto) : partnerFeesPlusComisionPool(round2(monto), pct);

  const w1 = await applyPartnerFeesWaterfallToSolicitud(sid, poolMonto, {
    excludeCuotaSemanalId: String(filaOrigen.id),
  });
  const rem = round2(w1.remainingPool);

  const mergedNuevo = cascadaDestinoExcluirCuotaOrigen(
    mergeCascadaAllocacionesPorCuota([w1.allocations || []]),
    String(filaOrigen.id)
  );
  const prevList = parsePartnerFeesCascadaDestinoDb(filaOrigen.partner_fees_cascada_destino);
  const mergedFinal = cascadaDestinoExcluirCuotaOrigen(
    mergeCascadaAllocacionesPorCuota([prevList, mergedNuevo]),
    String(filaOrigen.id)
  );
  const jsonDest =
    mergedFinal.length > 0 ? JSON.stringify(mergedFinal) : null;

  const snap = snapshotOrigenFilaTrasCascadaPool({
    remainingPoolUsd: rem,
    pctComision: pct,
    cuotaSemanal: round2(parseFloat(filaOrigen.cuota_semanal) || 0),
    cobroSaldo: round2(parseFloat(filaOrigen.cobro_saldo) || 0),
  });

  await query(
    `UPDATE module_miauto_cuota_semanal
     SET partner_fees_cascada_destino = $1::jsonb,
         partner_fees_raw = $3,
         partner_fees_83 = $4,
         partner_fees_yango_raw = $5,
         amount_due = $6,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2::uuid`,
    [
      jsonDest,
      filaOrigen.id,
      snap.partnerFeesRaw,
      snap.partnerFees83,
      snap.partnerFeesYangoRaw,
      snap.amountDue,
    ]
  );

  await updateMoraDiaria(sid, { includePartial: true });
  await persistPaidAmountCapsForSolicitud(sid);

  console.log(
    JSON.stringify(
      {
        ok: true,
        solicitud_id: sid,
        semana_ordinal_ui: ordinal,
        cuota_origen_id: filaOrigen.id,
        week_start_date: filaOrigen.week_start_date,
        moneda_cuota: moneda,
        pool_aplicado: poolMonto,
        pool_total_flag: poolTotal,
        monto_ingresado: round2(monto),
        pct_comision_fila: pct,
        aplicado_a_paid: round2(w1.applied),
        pool_remanente: rem,
        snapshot_origen: snap,
        partner_fees_cascada_destino: mergedFinal,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
