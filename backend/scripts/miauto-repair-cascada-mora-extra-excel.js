/**
 * Repara cuotas Excel cerradas por cascada que conservaron mora_extra pendiente.
 *
 * Por defecto solo muestra candidatos. Para aplicar:
 *   node scripts/miauto-repair-cascada-mora-extra-excel.js --apply
 */
import 'dotenv/config';
import crypto from 'crypto';
import pool from '../config/database.js';

const applyChanges = process.argv.includes('--apply');

const CANDIDATES_SQL = `
  WITH cascade_allocations AS (
    SELECT
      a.id AS audit_id,
      a.solicitud_id,
      a.created_at AS cascade_created_at,
      allocation.value AS allocation,
      allocation.value->>'cuota_id' AS cuota_id,
      COALESCE((allocation.value->>'pending_despues')::numeric, 0) AS pending_despues
    FROM module_miauto_billing_audit_trail a
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(a.billing_context->'imputaciones') = 'array'
          THEN a.billing_context->'imputaciones'
        ELSE '[]'::jsonb
      END
    ) allocation(value)
    WHERE a.event_type = 'cascaded'
  ),
  latest_allocation AS (
    SELECT DISTINCT ON (cuota_id)
      cuota_id,
      audit_id,
      solicitud_id,
      cascade_created_at,
      allocation,
      pending_despues
    FROM cascade_allocations
    WHERE cuota_id IS NOT NULL AND cuota_id <> ''
    ORDER BY cuota_id, cascade_created_at DESC, audit_id DESC
  )
  SELECT
    c.id,
    c.solicitud_id,
    c.week_start_date,
    c.due_date,
    c.status,
    c.montos_fuente,
    c.amount_due,
    c.paid_amount,
    c.late_fee,
    c.mora_extra,
    c.mora_extra_total,
    c.mora_extra_desde,
    l.audit_id AS cascade_audit_id,
    l.cascade_created_at,
    l.pending_despues,
    l.allocation
  FROM latest_allocation l
  JOIN module_miauto_cuota_semanal c ON c.id::text = l.cuota_id
  WHERE c.deleted_at IS NULL
    AND LOWER(TRIM(COALESCE(c.montos_fuente, ''))) = 'excel'
    AND LOWER(TRIM(COALESCE(c.status, ''))) = 'paid'
    AND COALESCE(c.mora_extra, 0)::numeric > 0.005
    AND l.pending_despues <= 0.005
  ORDER BY c.solicitud_id, c.due_date, c.id
`;

function num(value) {
  return Number.parseFloat(value) || 0;
}

function preview(rows) {
  return rows.map((row) => ({
    cuota_id: row.id,
    solicitud_id: row.solicitud_id,
    week_start_date: row.week_start_date,
    paid_amount: num(row.paid_amount),
    mora_extra_antes: num(row.mora_extra),
    mora_extra_total_antes: num(row.mora_extra_total),
    cascade_audit_id: row.cascade_audit_id,
    cascade_pending_despues: num(row.pending_despues),
  }));
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const candidates = await client.query(CANDIDATES_SQL);
    const rows = candidates.rows || [];
    const moraExtraTotal = rows.reduce((sum, row) => sum + num(row.mora_extra), 0);

    if (!applyChanges) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({
        mode: 'dry-run',
        candidates: rows.length,
        mora_extra_total: Math.round(moraExtraTotal * 100) / 100,
        rows: preview(rows),
      }, null, 2));
      return;
    }

    const repaired = [];
    for (const row of rows) {
      const before = {
        status: row.status,
        paid_amount: num(row.paid_amount),
        mora_extra: num(row.mora_extra),
        mora_extra_total: num(row.mora_extra_total),
        mora_extra_desde: row.mora_extra_desde,
      };
      const historicalTotal = Math.max(before.mora_extra_total, before.mora_extra);
      const updated = await client.query(
        `UPDATE module_miauto_cuota_semanal
         SET mora_extra = 0,
             mora_extra_total = $2,
             mora_extra_desde = NULL,
             status = 'paid',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND deleted_at IS NULL
           AND LOWER(TRIM(COALESCE(montos_fuente, ''))) = 'excel'
           AND LOWER(TRIM(COALESCE(status, ''))) = 'paid'
           AND COALESCE(mora_extra, 0)::numeric > 0.005
         RETURNING id, solicitud_id, week_start_date, paid_amount, status,
                   mora_extra, mora_extra_total, mora_extra_desde`,
        [row.id, historicalTotal]
      );
      if (updated.rows.length !== 1) {
        throw new Error(`La cuota ${row.id} cambió durante la reparación; se revierte toda la transacción`);
      }

      const afterRow = updated.rows[0];
      const after = {
        status: afterRow.status,
        paid_amount: num(afterRow.paid_amount),
        mora_extra: num(afterRow.mora_extra),
        mora_extra_total: num(afterRow.mora_extra_total),
        mora_extra_desde: afterRow.mora_extra_desde,
      };
      const billingContext = {
        version: '1.0',
        event_type: 'mora_extra_reconciled',
        reason: 'cascada_excel_cerro_saldo_pero_mora_extra_quedo_pendiente',
        before,
        after,
        evidence: {
          cascade_audit_id: row.cascade_audit_id,
          cascade_created_at: row.cascade_created_at,
          pending_despues: num(row.pending_despues),
          allocation: row.allocation,
        },
      };
      const executionHash = crypto
        .createHash('sha256')
        .update(`mora-extra-reconciled|${row.id}|${row.cascade_audit_id}|${before.mora_extra}`)
        .digest('hex');

      await client.query(
        `INSERT INTO module_miauto_billing_audit_trail
           (cuota_semanal_id, solicitud_id, week_start_date, semana_ordinal,
            event_type, billing_context, generated_by, actor_id, correlation_id, execution_hash)
         VALUES ($1, $2, $3, NULL, 'mora_extra_reconciled', $4::jsonb,
                 'repair_script', NULL, NULL, $5)`,
        [row.id, row.solicitud_id, row.week_start_date, JSON.stringify(billingContext), executionHash]
      );

      repaired.push({
        cuota_id: row.id,
        solicitud_id: row.solicitud_id,
        paid_amount: after.paid_amount,
        mora_extra_antes: before.mora_extra,
        mora_extra_despues: after.mora_extra,
        mora_extra_total: after.mora_extra_total,
      });
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({
      mode: 'apply',
      repaired: repaired.length,
      mora_extra_reconciled: Math.round(moraExtraTotal * 100) / 100,
      rows: repaired,
    }, null, 2));
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
