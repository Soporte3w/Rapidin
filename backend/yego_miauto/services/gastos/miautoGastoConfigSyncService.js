import { getClient } from '../../../config/database.js';
import { logger } from '../../../utils/logger.js';
import { amountChanged, configuredExpenseAmount } from './miautoGastoConfigSync.js';

const EMPTY_SYNC_SUMMARY = Object.freeze({ scanned: 0, updated: 0, cycles: 0 });

function uniqueIds(values) {
  return [...new Set((values || []).filter(Boolean).map(String))];
}

function changesFromRows(rows) {
  return rows.flatMap((row) => {
    const amount = configuredExpenseAmount(row.requisitos_gastos, row);
    return amountChanged(row.amount_due, amount) ? [{ id: row.id, amount }] : [];
  });
}

async function findEditableExpenses(client, vehicleIds) {
  const result = await client.query(
    `SELECT og.id, og.ciclo_id, og.tipo, og.numero_cuota, og.total_cuotas,
            og.amount_due, cv.requisitos_gastos
     FROM module_miauto_otros_gastos og
     INNER JOIN module_miauto_solicitud s
       ON s.id = og.solicitud_id AND s.deleted_at IS NULL
     INNER JOIN module_miauto_cronograma_vehiculo cv
       ON cv.id = s.cronograma_vehiculo_id
     WHERE s.cronograma_vehiculo_id = ANY($1::uuid[])
       AND og.deleted_at IS NULL
       AND og.origen = 'sistema'
       AND LOWER(COALESCE(og.status, 'pending')) <> 'paid'
       AND COALESCE(og.paid_amount, 0) <= 0.005
       AND NOT EXISTS (
         SELECT 1 FROM module_miauto_gasto_pago_aplicacion pa
         WHERE pa.otros_gastos_id = og.id AND pa.reversed_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM module_miauto_comprobante_otros_gastos cp
         WHERE cp.otros_gastos_id = og.id AND cp.estado <> 'rechazado'
       )
       AND NOT EXISTS (
         SELECT 1 FROM module_miauto_gasto_cobro_fleet_intento fi
         WHERE fi.otros_gastos_id = og.id AND fi.estado IN ('processing', 'reconcile')
       )
     FOR UPDATE OF og`,
    [vehicleIds]
  );
  return result.rows;
}

async function updateExpenseAmounts(client, changes, userId) {
  if (changes.length === 0) return [];
  const result = await client.query(
    `UPDATE module_miauto_otros_gastos og
     SET amount_due = change.amount,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP
     FROM jsonb_to_recordset($1::jsonb) AS change(id uuid, amount numeric)
     WHERE og.id = change.id
     RETURNING og.ciclo_id`,
    [JSON.stringify(changes), userId]
  );
  return uniqueIds(result.rows.map((row) => row.ciclo_id));
}

async function refreshCycleTotals(client, cycleIds, userId) {
  if (cycleIds.length === 0) return;
  await client.query(
    `UPDATE module_miauto_gasto_ciclo c
     SET monto_total = totals.monto_total,
         estado = CASE WHEN totals.pending_count = 0 THEN 'completado' ELSE 'activo' END,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP
     FROM (
       SELECT ciclo_id, SUM(amount_due) AS monto_total,
              COUNT(*) FILTER (
                WHERE COALESCE(paid_amount, 0) < COALESCE(amount_due, 0) - 0.005
              ) AS pending_count
       FROM module_miauto_otros_gastos
       WHERE ciclo_id = ANY($1::uuid[]) AND deleted_at IS NULL
       GROUP BY ciclo_id
     ) totals
     WHERE c.id = totals.ciclo_id`,
    [cycleIds, userId]
  );
}

/** Actualiza solo cuotas del sistema sin pagos, comprobantes ni cobros Fleet en curso. */
export async function syncUnpaidExpenseAmountsForCronogramaVehicles(vehicleIds, userId = null) {
  const ids = uniqueIds(vehicleIds);
  if (ids.length === 0) return { ...EMPTY_SYNC_SUMMARY };

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const rows = await findEditableExpenses(client, ids);
    const changes = changesFromRows(rows);
    const cycleIds = await updateExpenseAmounts(client, changes, userId);
    await refreshCycleTotals(client, cycleIds, userId);
    await client.query('COMMIT');

    const summary = { scanned: rows.length, updated: changes.length, cycles: cycleIds.length };
    logger.info('miauto.gastos.cronograma_amounts_synced', { vehicleIds: ids, ...summary });
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
