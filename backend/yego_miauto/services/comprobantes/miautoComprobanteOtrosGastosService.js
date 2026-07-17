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
  ) AS fleet_in_progress`;

function assertExpensePaymentAvailable(conflict) {
  if (conflict?.pending_receipt) {
    throw new Error('Esta cuota ya tiene un comprobante pendiente');
  }
  if (conflict?.fleet_in_progress) {
    throw new Error('Esta cuota tiene un cobro Fleet en proceso; vuelve a intentarlo luego');
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
            COALESCE(origen, 'conductor') AS origen, created_at
     FROM module_miauto_comprobante_otros_gastos
     WHERE solicitud_id = $1::uuid
     ORDER BY created_at, id`,
    [solicitudId]
  );
  return result.rows;
}

export async function listForAdminValidation({ estado = 'pendiente', country, limit = 300 } = {}) {
  const params = [];
  const where = ['s.deleted_at IS NULL'];
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

/** Registra el comprobante pendiente de validacion bancaria y acredita el gasto de inmediato. */
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
  const fileName = displayName;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const lockedExpense = await client.query(
      `SELECT id, status
       FROM module_miauto_otros_gastos
       WHERE id = $1::uuid AND solicitud_id = $2::uuid AND deleted_at IS NULL
       FOR UPDATE`,
      [expenseId, solicitudId]
    );
    if (!lockedExpense.rows[0]) throw new Error('Cuota de otros gastos no encontrada');
    if (lockedExpense.rows[0].status === 'paid') throw new Error('Esta cuota ya esta pagada');

    const conflict = await client.query(PAYMENT_CONFLICT_SQL, [expenseId]);
    assertExpensePaymentAvailable(conflict.rows[0]);

    const inserted = await client.query(
      `INSERT INTO module_miauto_comprobante_otros_gastos
       (solicitud_id, otros_gastos_id, monto, moneda, monto_original,
          moneda_original, file_name, file_path, created_by, origen)
       VALUES ($1::uuid, $2::uuid, $3, $4, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [solicitudId, expenseId, payment.originalAmount, payment.originalCurrency,
        fileName, path, userId, normalizedOrigin]
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
       SET tipo_cambio = $1, monto_aplicado = $2, moneda_aplicada = $3
       WHERE id = $4::uuid`,
      [payment.exchangeRate, application.applied, payment.appliedCurrency, receiptId]
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

export async function rejectComprobanteOtrosGastos(solicitudId, receiptId, userId, { motivo } = {}) {
  const result = await query(
    `UPDATE module_miauto_comprobante_otros_gastos
     SET estado = 'rechazado', rechazado_at = CURRENT_TIMESTAMP,
         rechazo_razon = $1, rechazado_by = $2
     WHERE solicitud_id = $3::uuid AND id = $4::uuid AND estado = 'pendiente'
     RETURNING id`,
    [motivo ? String(motivo).trim() : null, userId, solicitudId, receiptId]
  );
  if (!result.rows[0]) throw new Error('El comprobante no existe o ya fue procesado');
  return listBySolicitud(solicitudId);
}

export async function validateComprobanteOtrosGastos(solicitudId, receiptId, userId) {
  const receiptResult = await query(
    `SELECT id, otros_gastos_id, monto, moneda, monto_original, moneda_original, estado
     FROM module_miauto_comprobante_otros_gastos
     WHERE solicitud_id = $1::uuid AND id = $2::uuid`,
    [solicitudId, receiptId]
  );
  const receipt = receiptResult.rows[0];
  if (!receipt) throw new Error('Comprobante no encontrado');
  if (receipt.estado === 'validado') throw new Error('El comprobante ya esta validado');
  if (receipt.estado === 'rechazado') throw new Error('No se puede validar un comprobante rechazado');

  const expenseResult = await query(
    `SELECT id, moneda FROM module_miauto_otros_gastos
     WHERE id = $1::uuid AND solicitud_id = $2::uuid AND deleted_at IS NULL`,
    [receipt.otros_gastos_id, solicitudId]
  );
  const expense = expenseResult.rows[0];
  if (!expense) throw new Error('Cuota de otros gastos no encontrada');

  const payment = await resolveExpensePayment({
    solicitudId,
    amount: receipt.monto_original ?? receipt.monto,
    currency: receipt.moneda_original || receipt.moneda,
    expenseCurrency: expense.moneda,
  });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const lockedReceipt = await client.query(
      `SELECT estado
       FROM module_miauto_comprobante_otros_gastos
       WHERE solicitud_id = $1::uuid AND id = $2::uuid
       FOR UPDATE`,
      [solicitudId, receiptId]
    );
    if (!lockedReceipt.rows[0]) throw new Error('Comprobante no encontrado');
    if (lockedReceipt.rows[0].estado !== 'pendiente') {
      throw new Error('El comprobante ya fue procesado');
    }
    const application = await applyPaymentToExpense({
      client,
      solicitudId,
      expenseId: receipt.otros_gastos_id,
      receiptId,
      source: 'comprobante',
      sourceKey: `comprobante-otros:${receiptId}`,
      ...payment,
      userId,
      metadata: { validation: 'bank_confirmation' },
    });
    const updatedReceipt = await client.query(
      `UPDATE module_miauto_comprobante_otros_gastos
       SET estado = 'validado', validated_at = CURRENT_TIMESTAMP, validated_by = $1,
           monto_original = $2, moneda_original = $3, tipo_cambio = $4,
           monto_aplicado = $5, moneda_aplicada = $6
       WHERE id = $7::uuid AND estado = 'pendiente'
       RETURNING id`,
      [userId, payment.originalAmount, payment.originalCurrency, payment.exchangeRate,
        application.applied, payment.appliedCurrency, receiptId]
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
