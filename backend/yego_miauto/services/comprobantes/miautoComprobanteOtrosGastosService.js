import { getClient, query } from '../../../config/database.js';
import { uploadFileToMedia } from '../../../services/voucherService.js';
import { montoEnPEN, montoEnUSD, normalizePenUsd, round2 } from '../utils/miautoMoneyUtils.js';
import { applyPaymentToExpense } from '../gastos/miautoGastoPagoService.js';
import { MIAUTO_PARK_ID } from '../utils/miautoDriverLookup.js';
import { buildOtherExpenseDocumentName } from '../utils/miautoOtrosGastosDocument.js';

const MIAUTO_OTROS_GASTOS_BUCKET = process.env.MIAUTO_OTROS_GASTOS_BUCKET || 'yego-rapidin-otros-gastos';
const PAYMENT_CONFLICT_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM module_miauto_comprobante_otros_gastos
    WHERE otros_gastos_id = $1::uuid AND estado = 'pendiente'
  ) AS pending_receipt,
  EXISTS (
    SELECT 1 FROM module_miauto_gasto_cobro_fleet_intento
    WHERE otros_gastos_id = $1::uuid AND estado IN ('processing', 'reconcile')
  ) AS fleet_in_progress,
  EXISTS (
    SELECT 1 FROM module_miauto_gasto_pago_aplicacion
    WHERE otros_gastos_id = $1::uuid AND origen = 'fleet'
      AND comprobante_id IS NULL AND reversed_at IS NULL
  ) AS fleet_receipt_pending`;

function assertExpensePaymentAvailable(conflict) {
  if (conflict?.pending_receipt) {
    throw new Error('Esta cuota ya tiene un comprobante pendiente');
  }
  if (conflict?.fleet_in_progress) {
    throw new Error('Esta cuota tiene un cobro Fleet en proceso; vuelve a intentarlo luego');
  }
  if (conflict?.fleet_receipt_pending) {
    throw new Error('Primero sube el comprobante del cobro Fleet anterior');
  }
}

function assertPaymentWithinExpenseBalance(payment, expense) {
  const pending = round2(Math.max(
    0,
    Number(expense.amount_due) - Number(expense.paid_amount),
  ));
  if (payment.appliedAmount > pending + 0.005) {
    throw new Error(`El monto supera el saldo pendiente (${pending.toFixed(2)} ${expense.moneda})`);
  }
}

async function resolveExpensePayment({ solicitudId, amount, currency, expenseCurrency }) {
  const originalAmount = Number(amount);
  if (!Number.isFinite(originalAmount) || originalAmount <= 0) {
    throw new Error('Indica un monto valido para el comprobante');
  }

  const originalCurrency = normalizePenUsd(currency);
  const appliedCurrency = normalizePenUsd(expenseCurrency);
  const convertedAmount = appliedCurrency === 'USD'
    ? await montoEnUSD(solicitudId, originalAmount, originalCurrency)
    : await montoEnPEN(solicitudId, originalAmount, originalCurrency);
  if (convertedAmount == null || convertedAmount <= 0) {
    throw new Error('No se pudo convertir el monto del comprobante');
  }

  const appliedAmount = round2(convertedAmount);
  return {
    originalAmount: round2(originalAmount),
    originalCurrency,
    appliedAmount,
    appliedCurrency,
    exchangeRate: originalCurrency === appliedCurrency
      ? 1
      : round2(appliedAmount / originalAmount),
  };
}

export async function listBySolicitud(solicitudId) {
  const result = await query(
    `SELECT id, solicitud_id, otros_gastos_id, monto, moneda,
            COALESCE(monto_original, monto) AS monto_original,
            COALESCE(moneda_original, moneda) AS moneda_original,
            tipo_cambio, monto_aplicado, moneda_aplicada,
            file_name, file_path, estado, validated_at, validated_by,
            rechazado_at, rechazo_razon, rechazado_by, created_by,
            COALESCE(origen, 'conductor') AS origen, created_at,
            EXISTS (
              SELECT 1 FROM module_miauto_gasto_pago_aplicacion pa
              WHERE pa.comprobante_id = cp.id AND pa.reversed_at IS NULL
            ) OR COALESCE(monto_aplicado, 0) > 0.005 AS pago_aplicado
     FROM module_miauto_comprobante_otros_gastos cp
     WHERE solicitud_id = $1::uuid
     ORDER BY created_at, id`,
    [solicitudId]
  );
  return result.rows;
}

export async function listForAdminValidation({ estado = 'pendiente', country, limit = 300 } = {}) {
  const params = [];
  const where = [
    's.deleted_at IS NULL',
    `(EXISTS (
       SELECT 1 FROM module_miauto_gasto_pago_aplicacion pa
       WHERE pa.comprobante_id = cp.id AND pa.reversed_at IS NULL
     ) OR COALESCE(cp.monto_aplicado, 0) > 0.005)`,
  ];
  const normalizedStatus = String(estado || 'pendiente').trim().toLowerCase();
  if (normalizedStatus && normalizedStatus !== 'todos') {
    params.push(normalizedStatus);
    where.push(`LOWER(COALESCE(NULLIF(TRIM(cp.estado::text), ''), 'pendiente')) = $${params.length}`);
  }
  const normalizedCountry = String(country || '').trim().toUpperCase();
  if (normalizedCountry) {
    params.push(normalizedCountry);
    where.push(`UPPER(COALESCE(s.country, '')) = $${params.length}`);
  }
  params.push(MIAUTO_PARK_ID);
  const parkIdParam = params.length;
  params.push(Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 300)));

  const result = await query(
    `SELECT cp.id, cp.solicitud_id, NULL::uuid AS cuota_semanal_id,
            cp.otros_gastos_id, 'otros_gastos'::text AS tipo_comprobante,
            cp.monto, cp.moneda, cp.file_name, cp.file_path,
            COALESCE(NULLIF(TRIM(cp.estado::text), ''), 'pendiente') AS estado,
            cp.validated_at, cp.validated_by, cp.rechazado_at,
            cp.rechazo_razon, cp.rechazado_by, cp.created_at,
            COALESCE(cp.origen, 'conductor') AS origen,
            s.dni, s.phone, s.email, s.country, s.license_number, s.placa_asignada,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', rd.first_name, rd.last_name)), ''),
              NULLIF(TRIM(CONCAT_WS(' ', d_fleet.first_name, d_fleet.last_name)), ''),
              NULLIF(TRIM(CONCAT_WS(' ', d_placa.first_name, d_placa.last_name)), '')
            ) AS driver_name,
            rd.first_name AS driver_first_name, rd.last_name AS driver_last_name,
            cr.name AS cronograma_name, cv.name AS vehiculo_name,
            og.due_date, og.amount_due, og.paid_amount, 0::numeric AS late_fee,
            og.status AS cuota_status, og.moneda AS cuota_moneda,
            og.tipo AS gasto_tipo, og.numero_cuota, og.total_cuotas, og.periodo_anio
     FROM module_miauto_comprobante_otros_gastos cp
     INNER JOIN module_miauto_solicitud s ON s.id = cp.solicitud_id
     INNER JOIN module_miauto_otros_gastos og ON og.id = cp.otros_gastos_id AND og.deleted_at IS NULL
     LEFT JOIN module_rapidin_drivers rd ON rd.id::text = s.driver_id_fleet
     LEFT JOIN LATERAL (
       SELECT first_name, last_name
       FROM drivers d
       WHERE d.driver_id = s.driver_id_fleet
       LIMIT 1
     ) d_fleet ON true
     LEFT JOIN LATERAL (
       SELECT first_name, last_name
       FROM drivers d
       WHERE TRIM(COALESCE(d.park_id::text, '')) = $${parkIdParam}
         AND d.work_status = 'working'
         AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(d.car_number, '')), '\\s', '', 'g')) =
             UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '\\s', '', 'g'))
         AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '\\s', '', 'g')) <> ''
       LIMIT 1
     ) d_placa ON true
     LEFT JOIN module_miauto_cronograma cr ON cr.id = s.cronograma_id
     LEFT JOIN module_miauto_cronograma_vehiculo cv ON cv.id = s.cronograma_vehiculo_id
     WHERE ${where.join(' AND ')}
     ORDER BY cp.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

/** Registra el comprobante y aplica el pago al gasto en una sola transaccion. */
export async function createComprobanteOtrosGastos(
  solicitudId,
  expenseId,
  file,
  amount,
  currency,
  { userId = null, origin = 'conductor' } = {},
) {
  const expense = await query(
    `SELECT og.id, og.status, og.tipo, og.numero_cuota, og.week_index, og.due_date, og.moneda,
            og.amount_due, og.paid_amount,
            s.dni,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', rd.first_name, rd.last_name)), ''),
              NULLIF(TRIM(CONCAT_WS(' ', d.first_name, d.last_name)), '')
            ) AS driver_name
     FROM module_miauto_otros_gastos og
     INNER JOIN module_miauto_solicitud s ON s.id = og.solicitud_id
     LEFT JOIN module_rapidin_drivers rd ON rd.id::text = s.driver_id_fleet
     LEFT JOIN LATERAL (
       SELECT first_name, last_name
       FROM drivers fleet_driver
       WHERE fleet_driver.driver_id = s.driver_id_fleet
       LIMIT 1
     ) d ON true
     WHERE og.id = $1::uuid AND og.solicitud_id = $2::uuid AND og.deleted_at IS NULL`,
    [expenseId, solicitudId]
  );
  const expenseRow = expense.rows[0];
  if (!expenseRow) throw new Error('Cuota de otros gastos no encontrada');
  if (expenseRow.status === 'paid') throw new Error('Esta cuota ya esta pagada');
  const payment = await resolveExpensePayment({
    solicitudId,
    amount,
    currency,
    expenseCurrency: expenseRow.moneda,
  });
  assertPaymentWithinExpenseBalance(payment, expenseRow);

  const existingConflict = await query(PAYMENT_CONFLICT_SQL, [expenseId]);
  assertExpensePaymentAvailable(existingConflict.rows[0]);

  const normalizedOrigin = origin === 'admin' ? 'admin' : 'conductor';
  const { displayName, objectName } = buildOtherExpenseDocumentName({
    driverName: expenseRow.driver_name,
    dni: expenseRow.dni,
    expenseType: expenseRow.tipo,
    installmentNumber: expenseRow.numero_cuota || expenseRow.week_index,
    dueDate: expenseRow.due_date,
    originalName: file.originalname,
    mimeType: file.mimetype,
    origin: normalizedOrigin,
  });
  const path = await uploadFileToMedia(
    { ...file, originalname: objectName },
    { bucket: MIAUTO_OTROS_GASTOS_BUCKET },
  );
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const lockedExpense = await client.query(
      `SELECT id, status, amount_due, paid_amount
       FROM module_miauto_otros_gastos
       WHERE id = $1::uuid AND solicitud_id = $2::uuid AND deleted_at IS NULL
       FOR UPDATE`,
      [expenseId, solicitudId]
    );
    if (!lockedExpense.rows[0]) throw new Error('Cuota de otros gastos no encontrada');
    if (lockedExpense.rows[0].status === 'paid') throw new Error('Esta cuota ya esta pagada');
    assertPaymentWithinExpenseBalance(payment, {
      ...lockedExpense.rows[0],
      moneda: expenseRow.moneda,
    });

    const conflict = await client.query(PAYMENT_CONFLICT_SQL, [expenseId]);
    assertExpensePaymentAvailable(conflict.rows[0]);

    const inserted = await client.query(
      `INSERT INTO module_miauto_comprobante_otros_gastos
       (solicitud_id, otros_gastos_id, monto, moneda, monto_original,
          moneda_original, tipo_cambio, moneda_aplicada,
          file_name, file_path, created_by, origen)
       VALUES ($1::uuid, $2::uuid, $3, $4, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [solicitudId, expenseId, payment.originalAmount, payment.originalCurrency,
        payment.exchangeRate, payment.appliedCurrency,
        displayName, path, userId, normalizedOrigin]
    );
    const receiptId = inserted.rows[0]?.id;
    if (!receiptId) throw new Error('No se pudo registrar el comprobante');

    const application = await applyPaymentToExpense({
      client,
      solicitudId,
      expenseId,
      receiptId,
      source: 'comprobante',
      sourceKey: `comprobante-otros:${receiptId}`,
      ...payment,
      userId,
      metadata: { validation: 'pending_bank_confirmation', origin: normalizedOrigin },
    });
    await client.query(
      `UPDATE module_miauto_comprobante_otros_gastos
       SET monto_aplicado = $1
       WHERE id = $2::uuid`,
      [application.applied, receiptId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return listBySolicitud(solicitudId);
}

/** Vincula evidencia a un cobro Fleet ya aplicado, sin volver a afectar el saldo del gasto. */
export async function attachComprobanteToFleetExpensePayment(
  solicitudId,
  expenseId,
  fleetApplicationId,
  file,
  { userId = null } = {},
) {
  const paymentResult = await query(
    `SELECT pa.id, pa.comprobante_id,
            og.tipo, og.numero_cuota, og.week_index, og.due_date,
            s.dni,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', rd.first_name, rd.last_name)), ''),
              NULLIF(TRIM(CONCAT_WS(' ', d.first_name, d.last_name)), '')
            ) AS driver_name
     FROM module_miauto_gasto_pago_aplicacion pa
     INNER JOIN module_miauto_otros_gastos og
       ON og.id = pa.otros_gastos_id AND og.deleted_at IS NULL
     INNER JOIN module_miauto_solicitud s ON s.id = pa.solicitud_id
     LEFT JOIN module_rapidin_drivers rd ON rd.id::text = s.driver_id_fleet
     LEFT JOIN LATERAL (
       SELECT first_name, last_name
       FROM drivers fleet_driver
       WHERE fleet_driver.driver_id = s.driver_id_fleet
       LIMIT 1
     ) d ON true
     WHERE pa.id = $1::uuid
       AND pa.solicitud_id = $2::uuid
       AND pa.otros_gastos_id = $3::uuid
       AND pa.origen = 'fleet'
       AND pa.reversed_at IS NULL`,
    [fleetApplicationId, solicitudId, expenseId]
  );
  const payment = paymentResult.rows[0];
  if (!payment) throw new Error('Cobro Fleet no encontrado');
  if (payment.comprobante_id) throw new Error('Este cobro Fleet ya tiene comprobante');

  const { displayName, objectName } = buildOtherExpenseDocumentName({
    driverName: payment.driver_name,
    dni: payment.dni,
    expenseType: payment.tipo,
    installmentNumber: payment.numero_cuota || payment.week_index,
    dueDate: payment.due_date,
    originalName: file.originalname,
    mimeType: file.mimetype,
    origin: 'admin',
  });
  const path = await uploadFileToMedia(
    { ...file, originalname: objectName },
    { bucket: MIAUTO_OTROS_GASTOS_BUCKET },
  );

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const lockedPayment = await client.query(
      `SELECT id, monto_original, moneda_original, tipo_cambio,
              monto_aplicado, moneda_aplicada, comprobante_id
       FROM module_miauto_gasto_pago_aplicacion
       WHERE id = $1::uuid AND solicitud_id = $2::uuid
         AND otros_gastos_id = $3::uuid AND origen = 'fleet'
         AND reversed_at IS NULL
       FOR UPDATE`,
      [fleetApplicationId, solicitudId, expenseId]
    );
    const locked = lockedPayment.rows[0];
    if (!locked) throw new Error('Cobro Fleet no encontrado');
    if (locked.comprobante_id) throw new Error('Este cobro Fleet ya tiene comprobante');

    const inserted = await client.query(
      `INSERT INTO module_miauto_comprobante_otros_gastos
         (solicitud_id, otros_gastos_id, monto, moneda, monto_original,
          moneda_original, tipo_cambio, monto_aplicado, moneda_aplicada,
          file_name, file_path, created_by, origen)
       VALUES ($1::uuid, $2::uuid, $3, $4, $3, $4, $5, $6, $7, $8, $9, $10, 'admin')
       RETURNING id`,
      [solicitudId, expenseId, locked.monto_original, locked.moneda_original,
        locked.tipo_cambio, locked.monto_aplicado, locked.moneda_aplicada,
        displayName, path, userId]
    );
    const receiptId = inserted.rows[0]?.id;
    if (!receiptId) throw new Error('No se pudo registrar el comprobante');

    const linked = await client.query(
      `UPDATE module_miauto_gasto_pago_aplicacion
       SET comprobante_id = $1::uuid,
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('receipt_attached_at', CURRENT_TIMESTAMP)
       WHERE id = $2::uuid AND comprobante_id IS NULL
       RETURNING id`,
      [receiptId, fleetApplicationId]
    );
    if (!linked.rows[0]) throw new Error('El cobro Fleet ya fue vinculado por otro proceso');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return listBySolicitud(solicitudId);
}

async function applyReceiptWithinTransaction({
  client,
  solicitudId,
  receiptId,
}) {
  const receiptResult = await client.query(
    `SELECT cp.id, cp.otros_gastos_id, cp.tipo_cambio,
            cp.monto_aplicado, cp.moneda_aplicada, cp.estado,
            og.moneda AS expense_currency
     FROM module_miauto_comprobante_otros_gastos cp
     INNER JOIN module_miauto_otros_gastos og
       ON og.id = cp.otros_gastos_id AND og.deleted_at IS NULL
     WHERE cp.solicitud_id = $1::uuid AND cp.id = $2::uuid
     FOR UPDATE OF cp, og`,
    [solicitudId, receiptId]
  );
  const receipt = receiptResult.rows[0];
  if (!receipt) throw new Error('Comprobante no encontrado');
  if (receipt.estado !== 'pendiente') throw new Error('El comprobante ya fue procesado');

  const sourceKey = `comprobante-otros:${receipt.id}`;
  const existingApplication = await client.query(
    `SELECT id, monto_aplicado, tipo_cambio, moneda_aplicada
     FROM module_miauto_gasto_pago_aplicacion
     WHERE (comprobante_id = $1::uuid OR source_key = $2) AND reversed_at IS NULL
     ORDER BY applied_at DESC
     LIMIT 1`,
    [receipt.id, sourceKey]
  );
  const legacyAppliedAmount = round2(Number(receipt.monto_aplicado) || 0);
  if (!existingApplication.rows[0] && legacyAppliedAmount <= 0.005) {
    throw new Error('Primero confirma el cobro asociado a este comprobante');
  }

  const existing = existingApplication.rows[0];
  const applied = round2(Number(existing?.monto_aplicado) || legacyAppliedAmount);
  const exchangeRate = existing?.tipo_cambio ?? receipt.tipo_cambio ?? null;
  const appliedCurrency = existing?.moneda_aplicada
    || receipt.moneda_aplicada
    || receipt.expense_currency;
  await client.query(
    `UPDATE module_miauto_comprobante_otros_gastos
     SET tipo_cambio = COALESCE(tipo_cambio, $1),
         monto_aplicado = COALESCE(monto_aplicado, $2),
         moneda_aplicada = COALESCE(moneda_aplicada, $3)
     WHERE id = $4::uuid`,
    [exchangeRate, applied, appliedCurrency, receipt.id]
  );
  const expenseResult = await client.query(
    `SELECT amount_due, paid_amount, status
     FROM module_miauto_otros_gastos
     WHERE id = $1::uuid`,
    [receipt.otros_gastos_id]
  );
  const expense = expenseResult.rows[0];
  return {
    receiptId: receipt.id,
    expenseId: receipt.otros_gastos_id,
    applied,
    pendingAfter: round2(Math.max(0, Number(expense?.amount_due) - Number(expense?.paid_amount))),
    statusAfter: expense?.status,
  };
}

export async function rejectComprobanteOtrosGastos(solicitudId, receiptId, userId, { motivo } = {}) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE module_miauto_comprobante_otros_gastos
       SET estado = 'rechazado', rechazado_at = CURRENT_TIMESTAMP,
           rechazo_razon = $1, rechazado_by = $2
       WHERE solicitud_id = $3::uuid AND id = $4::uuid AND estado = 'pendiente'
       RETURNING id`,
      [motivo ? String(motivo).trim() : null, userId, solicitudId, receiptId]
    );
    if (!result.rows[0]) throw new Error('El comprobante no existe o ya fue procesado');
    await client.query(
      `UPDATE module_miauto_gasto_pago_aplicacion
       SET comprobante_id = NULL,
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('receipt_rejected_at', CURRENT_TIMESTAMP)
       WHERE comprobante_id = $1::uuid AND origen = 'fleet' AND reversed_at IS NULL`,
      [receiptId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return listBySolicitud(solicitudId);
}

export async function validateComprobanteOtrosGastos(solicitudId, receiptId, userId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const application = await applyReceiptWithinTransaction({
      client,
      solicitudId,
      receiptId,
    });
    const updatedReceipt = await client.query(
      `UPDATE module_miauto_comprobante_otros_gastos
       SET estado = 'validado', validated_at = CURRENT_TIMESTAMP, validated_by = $1,
           monto_aplicado = COALESCE(monto_aplicado, $2)
       WHERE id = $3::uuid AND estado = 'pendiente'
       RETURNING id`,
      [userId, application.applied, receiptId]
    );
    if (!updatedReceipt.rows[0]) throw new Error('El comprobante ya fue procesado');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return listBySolicitud(solicitudId);
}
