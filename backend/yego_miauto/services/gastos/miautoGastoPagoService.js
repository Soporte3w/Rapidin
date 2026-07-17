import { getClient } from '../../../config/database.js';
import { round2 } from '../utils/miautoMoneyUtils.js';
import { expenseStatus } from './miautoGastoRules.js';

function limaTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function ymd(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  return match?.[1] || null;
}

async function updateCycleStatus(client, cycleId) {
  if (!cycleId) return;
  await client.query(
    `UPDATE module_miauto_gasto_ciclo c
     SET estado = CASE
       WHEN NOT EXISTS (
         SELECT 1 FROM module_miauto_otros_gastos og
         WHERE og.ciclo_id = c.id AND og.deleted_at IS NULL
           AND COALESCE(og.paid_amount, 0) < COALESCE(og.amount_due, 0) - 0.005
       ) THEN 'completado'
       ELSE 'activo'
     END,
     updated_at = CURRENT_TIMESTAMP
     WHERE c.id = $1::uuid AND c.estado <> 'cancelado'`,
    [cycleId]
  );
}

export async function applyPaymentToExpense({
  client: externalClient = null,
  solicitudId,
  expenseId,
  receiptId = null,
  source,
  sourceKey,
  originalAmount,
  originalCurrency,
  appliedAmount,
  appliedCurrency,
  exchangeRate = null,
  userId = null,
  metadata = {},
  rejectExcess = true,
}) {
  const client = externalClient || await getClient();
  const ownsTransaction = !externalClient;
  try {
    if (ownsTransaction) await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, monto_aplicado FROM module_miauto_gasto_pago_aplicacion
       WHERE source_key = $1 AND reversed_at IS NULL`,
      [sourceKey]
    );
    if (existing.rows[0]) {
      if (ownsTransaction) await client.query('COMMIT');
      return { idempotent: true, applied: Number(existing.rows[0].monto_aplicado) || 0 };
    }

    const expenseResult = await client.query(
      `SELECT id, solicitud_id, ciclo_id, due_date, amount_due, paid_amount, status, moneda
       FROM module_miauto_otros_gastos
       WHERE id = $1::uuid AND solicitud_id = $2::uuid AND deleted_at IS NULL
       FOR UPDATE`,
      [expenseId, solicitudId]
    );
    const expense = expenseResult.rows[0];
    if (!expense) throw new Error('Cuota de otros gastos no encontrada');

    const amountDue = round2(Number(expense.amount_due) || 0);
    const paidBefore = round2(Number(expense.paid_amount) || 0);
    const pendingBefore = round2(Math.max(0, amountDue - paidBefore));
    const requested = round2(Number(appliedAmount) || 0);
    if (requested <= 0.005) throw new Error('El monto aplicado debe ser mayor a cero');
    if (rejectExcess && requested > pendingBefore + 0.005) {
      throw new Error(`El monto supera el saldo pendiente (${pendingBefore.toFixed(2)} ${expense.moneda})`);
    }
    const applied = round2(Math.min(requested, pendingBefore));
    if (applied <= 0.005) throw new Error('Esta cuota ya no tiene saldo pendiente');

    const paidAfter = round2(paidBefore + applied);
    const statusAfter = expenseStatus({
      amountDue,
      paidAmount: paidAfter,
      dueDate: ymd(expense.due_date),
      todayYmd: limaTodayYmd(),
    });

    const application = await client.query(
      `INSERT INTO module_miauto_gasto_pago_aplicacion
         (solicitud_id, otros_gastos_id, comprobante_id, origen, source_key,
          monto_original, moneda_original, tipo_cambio, monto_aplicado,
          moneda_aplicada, applied_by, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       RETURNING id`,
      [solicitudId, expenseId, receiptId, source, sourceKey, originalAmount,
        originalCurrency, exchangeRate, applied, appliedCurrency, userId, JSON.stringify(metadata)]
    );

    await client.query(
      `UPDATE module_miauto_otros_gastos
       SET paid_amount = $1, status = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4::uuid`,
      [paidAfter, statusAfter, userId, expenseId]
    );
    await updateCycleStatus(client, expense.ciclo_id);

    if (ownsTransaction) await client.query('COMMIT');
    return {
      idempotent: false,
      applicationId: application.rows[0]?.id,
      expenseId,
      pendingBefore,
      applied,
      pendingAfter: round2(Math.max(0, amountDue - paidAfter)),
      paidAfter,
      statusAfter,
    };
  } catch (error) {
    if (ownsTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

/**
 * Aplica un remanente de cascada solo a gastos vencidos o con vencimiento de hoy.
 * Las cuotas semanales deben procesarse antes de llamar esta funcion.
 */
export async function applyPoolToAdditionalExpenses({
  solicitudId,
  poolAmount,
  sourceKey,
  currency = 'PEN',
  userId = null,
}) {
  let remaining = round2(Number(poolAmount) || 0);
  if (remaining <= 0.005) return { applied: 0, remainingPool: 0, allocations: [] };

  const client = await getClient();
  const allocations = [];
  try {
    await client.query('BEGIN');
    const rows = await client.query(
      `SELECT id, due_date, amount_due, paid_amount, moneda
       FROM module_miauto_otros_gastos
       WHERE solicitud_id = $1::uuid AND deleted_at IS NULL
         AND due_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date
         AND COALESCE(paid_amount, 0) < COALESCE(amount_due, 0) - 0.005
         AND moneda = $2
         AND NOT EXISTS (
           SELECT 1 FROM module_miauto_comprobante_otros_gastos cp
           WHERE cp.otros_gastos_id = module_miauto_otros_gastos.id
             AND cp.estado = 'pendiente'
         )
       ORDER BY due_date, COALESCE(numero_cuota, week_index), id
       FOR UPDATE`,
      [solicitudId, currency]
    );

    for (const expense of rows.rows) {
      if (remaining <= 0.005) break;
      const pending = round2(Math.max(0, Number(expense.amount_due) - Number(expense.paid_amount)));
      const amount = round2(Math.min(remaining, pending));
      const result = await applyPaymentToExpense({
        client,
        solicitudId,
        expenseId: expense.id,
        source: 'cascada',
        sourceKey: `${sourceKey}:${expense.id}`,
        originalAmount: amount,
        originalCurrency: currency,
        appliedAmount: amount,
        appliedCurrency: currency,
        exchangeRate: 1,
        userId,
        metadata: { cascade_source_key: sourceKey },
        rejectExcess: false,
      });
      const applied = round2(Number(result.applied) || 0);
      remaining = round2(Math.max(0, remaining - applied));
      allocations.push({
        otros_gastos_id: expense.id,
        due_date: expense.due_date,
        monto: applied,
        pending_antes: result.pendingBefore,
        pending_despues: result.pendingAfter,
      });
    }

    await client.query('COMMIT');
    return {
      applied: round2(Number(poolAmount) - remaining),
      remainingPool: remaining,
      allocations,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
