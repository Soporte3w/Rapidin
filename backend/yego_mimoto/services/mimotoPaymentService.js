import { getClient, query } from '../../config/database.js';
import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';
import {
  assertMimotoIsolationSql,
  convertMimotoAmount,
  deriveQuotaStatus,
  distributePayment,
  normalizeMimotoCurrency,
  quotaBalances,
  roundMoney,
  simulatePaymentCascade,
} from './mimotoFinancialEngine.js';
import { bogotaToday, positiveNumber } from './mimotoServiceUtils.js';

const q = (sql, params = []) => query(assertMimotoIsolationSql(sql), params);

async function exchangeRate(execute) {
  const result = await execute(
    assertMimotoIsolationSql(
      `SELECT valor_usd_a_local FROM module_mimoto_tipo_cambio WHERE country='CO'`
    )
  );
  const rate = Number(result.rows[0]?.valor_usd_a_local) || 0;
  if (rate <= 0) throw new Error('El tipo de cambio USD/COP no está configurado');
  return rate;
}

export async function applyPaymentToQuota({
  solicitudId,
  quotaId,
  amount,
  currency,
  source,
  sourceKey = null,
  actorId,
  voucher,
}) {
  if (!MIMOTO_CONFIG.enabled) {
    throw new Error('Yego Mi Moto está desactivado; no se pueden aplicar pagos');
  }
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const quotaResult = await client.query(
      assertMimotoIsolationSql(
        `SELECT q.* FROM module_mimoto_cuota_semanal q
         WHERE q.id=$1 AND q.solicitud_id=$2 AND q.deleted_at IS NULL FOR UPDATE`
      ),
      [quotaId, solicitudId]
    );
    const quota = quotaResult.rows[0];
    if (!quota) throw new Error('Cuota Mi Moto no encontrada');
    const priorChunks = Array.isArray(quota.payment_chunks) ? quota.payment_chunks : [];
    if (sourceKey && priorChunks.some((item) => item?.source_key === sourceKey)) {
      const balances = quotaBalances(quota);
      await client.query('COMMIT');
      return {
        cuota_id: quotaId,
        status: quota.status,
        saldo_total: roundMoney(balances.capital + balances.lateFee + balances.extraLateFee),
        idempotent: true,
      };
    }
    const inputCurrency = normalizeMimotoCurrency(currency);
    const rate = inputCurrency === quota.moneda ? 1 : await exchangeRate(client.query.bind(client));
    const converted = convertMimotoAmount(
      positiveNumber(amount, 'monto'),
      inputCurrency,
      quota.moneda,
      rate
    );
    const distribution = distributePayment(quota, converted);
    if (distribution.applied <= 0.005) throw new Error('La cuota no tiene saldo pendiente');
    const balances = quotaBalances(quota);
    const newLateFee = roundMoney(balances.lateFee - distribution.lateFee);
    const newExtra = roundMoney(balances.extraLateFee - distribution.extraLateFee);
    const newCapitalPaid = roundMoney(Number(quota.capital_paid || 0) + distribution.capital);
    const newPaid = roundMoney(Number(quota.paid_amount || 0) + distribution.applied);
    const totalBalance = roundMoney(
      Math.max(0, Number(quota.amount_due) - newCapitalPaid) + newLateFee + newExtra
    );
    const paymentDate = bogotaToday();
    const status = deriveQuotaStatus({
      dueDate: quota.due_date,
      balance: totalBalance,
      paidAmount: newPaid,
      today: paymentDate,
    });
    const chunk = {
      source,
      source_key: sourceKey || undefined,
      amount_original: roundMoney(amount),
      currency_original: inputCurrency,
      amount_applied: distribution.applied,
      currency_applied: quota.moneda,
      late_fee: distribution.lateFee,
      extra_late_fee: distribution.extraLateFee,
      capital: distribution.capital,
      unapplied: distribution.unapplied,
      applied_at: new Date().toISOString(),
    };
    await client.query(
      assertMimotoIsolationSql(
        `UPDATE module_mimoto_cuota_semanal SET
          capital_paid=$1, late_fee=$2, late_fee_paid=late_fee_paid+$3,
          mora_extra=$4, mora_extra_paid=mora_extra_paid+$5, paid_amount=$6,
          fecha_ultimo_abono=$7, status=$8,
          mora_extra_desde=CASE
            WHEN $11 THEN COALESCE(mora_extra_desde,GREATEST(due_date,$7::date))
            ELSE mora_extra_desde
          END,
          mora_extra_calculated_through=CASE
            WHEN $11 THEN COALESCE(mora_extra_calculated_through,GREATEST(due_date,$7::date))
            ELSE mora_extra_calculated_through
          END,
          payment_chunks=payment_chunks || $9::jsonb, updated_at=CURRENT_TIMESTAMP, updated_by=$10
         WHERE id=$12`
      ),
      [newCapitalPaid, newLateFee, distribution.lateFee, newExtra, distribution.extraLateFee,
        newPaid, paymentDate, status, JSON.stringify([chunk]), actorId || null,
        totalBalance > 0.005, quotaId]
    );
    let comprobanteId = null;
    if (voucher || source !== 'fleet') {
      const comprobante = await client.query(
        assertMimotoIsolationSql(
          `INSERT INTO module_mimoto_comprobante_cuota_semanal
            (solicitud_id,cuota_semanal_id,monto,moneda,file_name,file_path,estado,origen,
             aplicacion_chunks,acredito_en_cronograma,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,TRUE,$10) RETURNING id`
        ),
        [solicitudId, quotaId, roundMoney(amount), inputCurrency, voucher?.fileName || null,
          voucher?.filePath || null, source === 'manual' ? 'validado' : 'pendiente',
          source === 'manual' ? 'pago_manual' : source, JSON.stringify([chunk]), actorId || null]
      );
      comprobanteId = comprobante.rows[0].id;
    }
    await client.query(
      assertMimotoIsolationSql(
        `INSERT INTO module_mimoto_billing_audit_trail
          (cuota_semanal_id,solicitud_id,week_start_date,semana_ordinal,event_type,billing_context,generated_by,actor_id)
         VALUES ($1,$2,$3,$4,'payment.applied',$5::jsonb,$6,$7)`
      ),
      [quotaId, solicitudId, quota.week_start_date, quota.week_number, JSON.stringify(chunk), source, actorId || null]
    );
    await client.query('COMMIT');
    return { cuota_id: quotaId, comprobante_id: comprobanteId, status, saldo_total: totalBalance, distribution };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listValidationVouchers({ estado = 'pendiente', limit = 200 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const result = await q(
    `SELECT * FROM (
       SELECT cp.id, 'cuota_semanal'::text AS comprobante_tipo, cp.solicitud_id,
              cp.cuota_semanal_id AS referencia_id, cp.monto, cp.moneda, cp.file_name,
              cp.file_path, cp.estado, cp.origen, cp.created_at, cp.rechazo_razon,
              s.first_name, s.last_name, s.document_type, s.document_number, s.phone,
              s.placa_asignada, f.name AS fleet_name,
              ('Semana ' || q.week_number)::text AS referencia
       FROM module_mimoto_comprobante_cuota_semanal cp
       JOIN module_mimoto_solicitud s ON s.id=cp.solicitud_id
       JOIN module_mimoto_fleet f ON f.id=s.fleet_id
       JOIN module_mimoto_cuota_semanal q ON q.id=cp.cuota_semanal_id
       WHERE cp.deleted_at IS NULL
       UNION ALL
       SELECT cp.id, 'otro_gasto'::text, cp.solicitud_id, cp.otros_gastos_id,
              cp.monto, cp.moneda, cp.file_name, cp.file_path, cp.estado, cp.origen,
              cp.created_at, cp.rechazo_razon, s.first_name, s.last_name,
              s.document_type, s.document_number, s.phone, s.placa_asignada,
              f.name, (g.tipo || ' · cuota ' || g.numero_cuota)::text
       FROM module_mimoto_comprobante_otros_gastos cp
       JOIN module_mimoto_solicitud s ON s.id=cp.solicitud_id
       JOIN module_mimoto_fleet f ON f.id=s.fleet_id
       JOIN module_mimoto_otros_gastos g ON g.id=cp.otros_gastos_id
     ) vouchers
     WHERE ($1='todos' OR estado=$1)
     ORDER BY created_at DESC LIMIT $2`,
    [estado, safeLimit]
  );
  return result.rows;
}

export async function updateVoucherBankStatus(id, type, status, reason, actorId) {
  if (!['validado', 'rechazado'].includes(status)) throw new Error('Estado de comprobante inválido');
  const table = type === 'otro_gasto'
    ? 'module_mimoto_comprobante_otros_gastos'
    : type === 'cuota_semanal'
      ? 'module_mimoto_comprobante_cuota_semanal'
      : null;
  if (!table) throw new Error('Tipo de comprobante inválido');
  const result = await q(
    `UPDATE ${table} SET
       estado=$1,
       validated_at=CASE WHEN $1='validado' THEN CURRENT_TIMESTAMP ELSE validated_at END,
       validated_by=CASE WHEN $1='validado' THEN $2 ELSE validated_by END,
       rechazado_at=CASE WHEN $1='rechazado' THEN CURRENT_TIMESTAMP ELSE NULL END,
       rechazado_by=CASE WHEN $1='rechazado' THEN $2 ELSE NULL END,
       rechazo_razon=CASE WHEN $1='rechazado' THEN $3 ELSE NULL END,
       updated_by=$2
     WHERE id=$4 AND deleted_at IS NULL RETURNING *`,
    [status, actorId || null, String(reason || '').trim() || null, id]
  );
  if (!result.rows[0]) throw new Error('Comprobante no encontrado');
  return result.rows[0];
}

export async function applyPaymentToExpense({ solicitudId, expenseId, amount, currency, source, actorId, voucher }) {
  if (!MIMOTO_CONFIG.enabled) throw new Error('Yego Mi Moto está desactivado; no se pueden aplicar pagos');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const expenseResult = await client.query(
      assertMimotoIsolationSql(
        `SELECT * FROM module_mimoto_otros_gastos
         WHERE id=$1 AND solicitud_id=$2 AND deleted_at IS NULL FOR UPDATE`
      ),
      [expenseId, solicitudId]
    );
    const expense = expenseResult.rows[0];
    if (!expense) throw new Error('Gasto Mi Moto no encontrado');
    const inputCurrency = normalizeMimotoCurrency(currency);
    const rate = inputCurrency === expense.moneda ? 1 : await exchangeRate(client.query.bind(client));
    const converted = convertMimotoAmount(
      positiveNumber(amount, 'monto'),
      inputCurrency,
      expense.moneda,
      rate
    );
    const balance = roundMoney(Math.max(0, Number(expense.amount_due) - Number(expense.paid_amount)));
    const applied = Math.min(balance, converted);
    if (applied <= 0.005) throw new Error('El gasto no tiene saldo pendiente');
    const newPaid = roundMoney(Number(expense.paid_amount) + applied);
    const remaining = roundMoney(Math.max(0, Number(expense.amount_due) - newPaid));
    const status = deriveQuotaStatus({
      dueDate: expense.due_date,
      balance: remaining,
      paidAmount: newPaid,
      today: bogotaToday(),
    });
    await client.query(
      assertMimotoIsolationSql(
        `UPDATE module_mimoto_otros_gastos SET paid_amount=$1, status=$2,
           updated_at=CURRENT_TIMESTAMP, updated_by=$3 WHERE id=$4`
      ),
      [newPaid, status, actorId || null, expenseId]
    );
    let comprobanteId = null;
    if (voucher) {
      const comprobante = await client.query(
        assertMimotoIsolationSql(
          `INSERT INTO module_mimoto_comprobante_otros_gastos
            (solicitud_id,otros_gastos_id,monto,moneda,monto_original,moneda_original,
             tipo_cambio,monto_aplicado,moneda_aplicada,file_name,file_path,estado,origen,created_by)
           VALUES ($1,$2,$3,$4,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`
        ),
        [solicitudId, expenseId, roundMoney(amount), inputCurrency, rate, applied, expense.moneda,
          voucher?.fileName || null, voucher?.filePath || null,
          source === 'manual' ? 'validado' : 'pendiente', source === 'fleet' ? 'fleet' : source,
          actorId || null]
      );
      comprobanteId = comprobante.rows[0].id;
    }
    await client.query(
      assertMimotoIsolationSql(
        `INSERT INTO module_mimoto_gasto_pago_aplicacion
          (solicitud_id,otros_gastos_id,comprobante_id,fuente,monto,moneda,metadata,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`
      ),
      [solicitudId, expenseId, comprobanteId,
        source === 'fleet' ? 'fleet' : source === 'manual' ? 'manual' : 'comprobante',
        applied, expense.moneda,
        JSON.stringify({ amount_original: roundMoney(amount), currency_original: inputCurrency, rate }),
        actorId || null]
    );
    await client.query('COMMIT');
    return {
      gasto_id: expenseId,
      comprobante_id: comprobanteId,
      status,
      saldo_total: remaining,
      applied,
      unapplied: roundMoney(converted - applied),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function simulateFleetCascade(solicitudId, availableAmount, currency) {
  const amount = positiveNumber(availableAmount, 'saldo_disponible');
  const inputCurrency = normalizeMimotoCurrency(currency || 'COP');
  const asOf = bogotaToday();
  const cuotas = await q(
    `SELECT * FROM module_mimoto_cuota_semanal
     WHERE solicitud_id=$1 AND deleted_at IS NULL AND status IN ('overdue','partial','pending')
       AND due_date<=$2::date
     ORDER BY due_date, week_start_date, id`,
    [solicitudId, asOf]
  );
  if (cuotas.rows.length === 0) {
    return { requested: amount, applied: 0, remaining: amount, applications: [] };
  }
  const targetCurrency = cuotas.rows[0].moneda;
  let converted = amount;
  let rate = 1;
  if (inputCurrency !== targetCurrency) {
    rate = await exchangeRate(q);
    converted = convertMimotoAmount(amount, inputCurrency, targetCurrency, rate);
  }
  return {
    dry_run: true,
    input: { amount, currency: inputCurrency },
    as_of: asOf,
    target_currency: targetCurrency,
    exchange_rate: rate,
    ...simulatePaymentCascade(cuotas.rows, converted, { asOf }),
  };
}
