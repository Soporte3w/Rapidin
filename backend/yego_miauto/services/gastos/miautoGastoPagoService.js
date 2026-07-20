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
