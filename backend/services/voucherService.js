import pool from '../database/connection.js';
import { logger } from '../utils/logger.js';
import { normalizePhoneForDb } from '../utils/helpers.js';
import { updateLoanBalance, checkLoanCompleted } from './paymentService.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const query = (text, params) => pool.query(text, params);

// Obtener cuotas pendientes de un préstamo
export const getPendingInstallments = async (loanId, driverId) => {
  try {
    const installmentsQuery = `
      SELECT 
        i.id,
        i.installment_number,
        i.installment_amount,
        i.due_date,
        i.status,
        i.paid_amount,
        COALESCE(i.late_fee, 0) as late_fee,
        (i.installment_amount - COALESCE(i.paid_amount, 0)) as installment_pending,
        (i.installment_amount - COALESCE(i.paid_amount, 0) + COALESCE(i.late_fee, 0)) as pending_amount
      FROM module_rapidin_installments i
      JOIN module_rapidin_loans l ON l.id = i.loan_id
      WHERE l.id = $1 
        AND l.driver_id = $2
        AND i.status IN ('pending', 'overdue')
        AND ((i.installment_amount - COALESCE(i.paid_amount, 0)) > 0 OR COALESCE(i.late_fee, 0) > 0)
      ORDER BY i.due_date ASC
    `;

    const result = await query(installmentsQuery, [loanId, driverId]);
    return result.rows.map(row => ({
      id: row.id,
      installmentNumber: row.installment_number,
      amount: parseFloat(row.installment_amount),
      dueDate: row.due_date,
      status: row.status,
      paidAmount: parseFloat(row.paid_amount || 0),
      installmentPending: parseFloat(row.installment_pending || 0),
      pendingAmount: parseFloat(row.pending_amount),
      lateFee: parseFloat(row.late_fee || 0)
    }));
  } catch (error) {
    logger.error('Error obteniendo cuotas pendientes:', error);
    throw error;
  }
};

const MEDIA_UPLOAD_URL = process.env.MEDIA_UPLOAD_URL || 'http://178.156.204.129:3000/media';
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || 'rapidin-media';

// Subir archivo al endpoint de media (bucket) y obtener URL. file = { buffer, mimetype?, originalname? }
export async function uploadFileToMedia(file) {
  const form = new FormData();
  form.append('bucket', MEDIA_BUCKET);
  const blob = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });
  form.append('file', blob, file.originalname || 'voucher');

  const response = await fetch(MEDIA_UPLOAD_URL, {
    method: 'POST',
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Error al subir archivo a media: ${response.status} ${text}`);
  }

  const data = await response.json();
  if (!data.url) {
    throw new Error('La respuesta del servicio de media no incluyó la URL');
  }
  return data.url;
}

// Subir voucher de pago
export const uploadVoucher = async (loanId, driverId, amount, paymentDate, file, observations, installmentIds) => {
  try {
    // Validar que el préstamo pertenece al conductor
    const loanCheck = await query(
      'SELECT id, driver_id FROM module_rapidin_loans WHERE id = $1 AND driver_id = $2',
      [loanId, driverId]
    );

    if (loanCheck.rows.length === 0) {
      throw new Error('Préstamo no encontrado o no pertenece al conductor');
    }

    // Validar que las cuotas pertenecen al préstamo y que son en orden (solo las que vencen primero, consecutivas)
    if (installmentIds && installmentIds.length > 0) {
      const installmentsCheck = await query(
        `SELECT id, due_date FROM module_rapidin_installments 
         WHERE id = ANY($1::uuid[]) AND loan_id = $2
         AND status IN ('pending', 'overdue')
         AND ((installment_amount - COALESCE(paid_amount, 0)) > 0 OR COALESCE(late_fee, 0) > 0)`,
        [installmentIds, loanId]
      );

      if (installmentsCheck.rows.length !== installmentIds.length) {
        throw new Error('Una o más cuotas no pertenecen al préstamo o ya están pagadas');
      }

      const pendingOrdered = await query(
        `SELECT id FROM module_rapidin_installments 
         WHERE loan_id = $1 AND status IN ('pending', 'overdue')
         AND ((installment_amount - COALESCE(paid_amount, 0)) > 0 OR COALESCE(late_fee, 0) > 0)
         ORDER BY due_date ASC`,
        [loanId]
      );
      const allowedIdsOrdered = pendingOrdered.rows.map((r) => r.id);
      const firstN = allowedIdsOrdered.slice(0, installmentIds.length);
      const requestedSet = new Set(installmentIds);
      const isPrefix = firstN.length === installmentIds.length &&
        firstN.every((id) => requestedSet.has(id)) &&
        installmentIds.every((id) => firstN.includes(id));
      if (!isPrefix) {
        throw new Error('Solo puedes pagar cuotas en orden (la que vence primero, luego la siguiente).');
      }
    }

    // Subir archivo al endpoint de media y obtener URL
    const fileUrl = await uploadFileToMedia(file);
    const fileName = file.originalname || `voucher_${loanId}_${Date.now()}.png`;

    // Guardar voucher con la URL en file_path (compatibilidad: "Ver" redirige si empieza por http)
    const voucherResult = await query(
      `INSERT INTO module_rapidin_payment_vouchers 
       (loan_id, driver_id, amount, payment_date, file_name, file_path, observations, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING *`,
      [loanId, driverId, amount, paymentDate, fileName, fileUrl, observations || null]
    );

    const voucher = voucherResult.rows[0];

    // Asociar cuotas con el voucher
    if (installmentIds && installmentIds.length > 0) {
      // Distribuir el monto entre las cuotas seleccionadas
      const totalPending = await query(
        `SELECT SUM((installment_amount - COALESCE(paid_amount, 0)) + COALESCE(late_fee, 0)) as total
         FROM module_rapidin_installments
         WHERE id = ANY($1::uuid[])`,
        [installmentIds]
      );

      const totalPendingAmount = parseFloat(totalPending.rows[0].total);
      const voucherAmount = parseFloat(amount);

      for (const installmentId of installmentIds) {
        const installmentInfo = await query(
          'SELECT installment_amount, paid_amount, late_fee FROM module_rapidin_installments WHERE id = $1',
          [installmentId]
        );

        const installmentAmount = parseFloat(installmentInfo.rows[0].installment_amount);
        const paidAmount = parseFloat(installmentInfo.rows[0].paid_amount || 0);
        const lateFee = parseFloat(installmentInfo.rows[0].late_fee || 0);
        const pendingAmount = (installmentAmount - paidAmount) + lateFee;

        // Calcular monto proporcional
        const proportionalAmount = Math.min(
          (pendingAmount / totalPendingAmount) * voucherAmount,
          pendingAmount
        );

        await query(
          `INSERT INTO module_rapidin_voucher_installments (voucher_id, installment_id, applied_amount)
           VALUES ($1, $2, $3)`,
          [voucher.id, installmentId, proportionalAmount]
        );
      }
    }

    return voucher;
  } catch (error) {
    logger.error('Error subiendo voucher:', error);
    throw error;
  }
};

// Obtener vouchers de un conductor. Si loanId viene, solo de ese préstamo (por flota); si no, de todos.
export const getDriverVouchers = async (phone, country, loanId = null) => {
  try {
    const phoneForDb = normalizePhoneForDb(phone, country);
    const digitsOnly = (phone || '').toString().replace(/\D/g, '');

    const rapidinDriverQuery = `
      SELECT id FROM module_rapidin_drivers 
      WHERE country = $1
        AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4)
    `;
    const rapidinDriverResult = await query(rapidinDriverQuery, [country, phoneForDb, phone, digitsOnly]);

    if (rapidinDriverResult.rows.length === 0) {
      return [];
    }

    const driverIds = rapidinDriverResult.rows.map((r) => r.id);

    const vouchersQuery = loanId
      ? `
      SELECT 
        v.id,
        v.loan_id,
        v.amount,
        v.payment_date,
        v.file_name,
        v.file_path,
        v.observations,
        v.status,
        v.reviewed_at,
        v.rejection_reason,
        v.created_at,
        l.disbursed_amount as loan_amount,
        COUNT(vi.id) as installments_count,
        ARRAY_AGG(vi.installment_id) as installment_ids
      FROM module_rapidin_payment_vouchers v
      JOIN module_rapidin_loans l ON l.id = v.loan_id
      LEFT JOIN module_rapidin_voucher_installments vi ON vi.voucher_id = v.id
      WHERE v.driver_id = ANY($1) AND v.loan_id = $2
      GROUP BY v.id, v.loan_id, v.amount, v.payment_date, v.file_name, v.file_path, 
               v.observations, v.status, v.reviewed_at, v.rejection_reason, 
               v.created_at, l.disbursed_amount
      ORDER BY v.created_at DESC
    `
      : `
      SELECT 
        v.id,
        v.loan_id,
        v.amount,
        v.payment_date,
        v.file_name,
        v.file_path,
        v.observations,
        v.status,
        v.reviewed_at,
        v.rejection_reason,
        v.created_at,
        l.disbursed_amount as loan_amount,
        COUNT(vi.id) as installments_count,
        ARRAY_AGG(vi.installment_id) as installment_ids
      FROM module_rapidin_payment_vouchers v
      JOIN module_rapidin_loans l ON l.id = v.loan_id
      LEFT JOIN module_rapidin_voucher_installments vi ON vi.voucher_id = v.id
      WHERE v.driver_id = ANY($1)
      GROUP BY v.id, v.loan_id, v.amount, v.payment_date, v.file_name, v.file_path, 
               v.observations, v.status, v.reviewed_at, v.rejection_reason, 
               v.created_at, l.disbursed_amount
      ORDER BY v.created_at DESC
    `;

    const vouchersParams = loanId ? [driverIds, loanId] : [driverIds];
    const result = await query(vouchersQuery, vouchersParams);

    return result.rows.map(row => ({
      id: row.id,
      loanId: row.loan_id,
      amount: parseFloat(row.amount),
      paymentDate: row.payment_date,
      fileName: row.file_name,
      filePath: row.file_path,
      observations: row.observations,
      status: row.status,
      reviewedAt: row.reviewed_at,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at,
      loanAmount: parseFloat(row.loan_amount),
      installmentsCount: parseInt(row.installments_count) || 0,
      installmentIds: row.installment_ids || []
    }));
  } catch (error) {
    logger.error('Error obteniendo vouchers del conductor:', error);
    throw error;
  }
};

// Obtener todos los vouchers (admin) con datos de conductor y préstamo
export const getAllVouchers = async (filters = {}) => {
  try {
    const { status: statusFilter } = filters;
    let whereClause = '';
    const params = [];
    if (statusFilter) {
      params.push(statusFilter);
      whereClause = `WHERE v.status = $${params.length}`;
    }

    const vouchersQuery = `
      SELECT 
        v.id,
        v.loan_id,
        v.driver_id,
        v.amount,
        v.payment_date,
        v.file_name,
        v.file_path,
        v.observations,
        v.status,
        v.reviewed_at,
        v.rejection_reason,
        v.created_at,
        d.first_name as driver_first_name,
        d.last_name as driver_last_name,
        d.phone as driver_phone,
        l.disbursed_amount as loan_amount,
        COUNT(vi.id) as installments_count,
        (SELECT ARRAY_AGG(i.installment_number ORDER BY i.installment_number)
         FROM module_rapidin_voucher_installments vi2
         JOIN module_rapidin_installments i ON i.id = vi2.installment_id
         WHERE vi2.voucher_id = v.id) as installment_numbers
      FROM module_rapidin_payment_vouchers v
      JOIN module_rapidin_drivers d ON d.id = v.driver_id
      JOIN module_rapidin_loans l ON l.id = v.loan_id
      LEFT JOIN module_rapidin_voucher_installments vi ON vi.voucher_id = v.id
      ${whereClause}
      GROUP BY v.id, v.loan_id, v.driver_id, v.amount, v.payment_date, v.file_name, v.file_path,
               v.observations, v.status, v.reviewed_at, v.rejection_reason,
               v.created_at, d.first_name, d.last_name, d.phone, l.disbursed_amount
      ORDER BY v.created_at DESC
    `;

    const result = await query(vouchersQuery, params);

    return result.rows.map(row => ({
      id: row.id,
      loanId: row.loan_id,
      driverId: row.driver_id,
      amount: parseFloat(row.amount),
      paymentDate: row.payment_date,
      fileName: row.file_name,
      filePath: row.file_path,
      observations: row.observations,
      status: row.status,
      reviewedAt: row.reviewed_at,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at,
      driverFirstName: row.driver_first_name,
      driverLastName: row.driver_last_name,
      driverPhone: row.driver_phone,
      loanAmount: parseFloat(row.loan_amount),
      installmentsCount: parseInt(row.installments_count) || 0,
      installmentNumbers: Array.isArray(row.installment_numbers) ? row.installment_numbers.filter(Boolean) : (row.installment_numbers ? [row.installment_numbers] : [])
    }));
  } catch (error) {
    logger.error('Error obteniendo vouchers (admin):', error);
    throw error;
  }
};

// Validar o rechazar voucher (admin)
export const reviewVoucher = async (voucherId, status, reviewedBy, rejectionReason) => {
  try {
    if (!['approved', 'rejected'].includes(status)) {
      throw new Error('Status inválido. Debe ser "approved" o "rejected"');
    }

    const updateQuery = `
      UPDATE module_rapidin_payment_vouchers
      SET status = $1,
          reviewed_by = $2,
          reviewed_at = CURRENT_TIMESTAMP,
          rejection_reason = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `;

    const result = await query(updateQuery, [status, reviewedBy, rejectionReason || null, voucherId]);

    if (result.rows.length === 0) {
      throw new Error('Voucher no encontrado');
    }

    // Si se aprueba, crear el pago y aplicarlo a las cuotas (evitar duplicidad: si ya existe pago para este voucher, no crear otro)
    if (status === 'approved') {
      const voucher = result.rows[0];

      const existingPayment = await query(
        'SELECT id FROM module_rapidin_payments WHERE voucher_id = $1 LIMIT 1',
        [voucherId]
      );
      if (existingPayment.rows.length > 0) {
        return result.rows[0];
      }

      // Obtener las cuotas asociadas
      const voucherInstallments = await query(
        `SELECT vi.installment_id, vi.applied_amount, i.installment_number
         FROM module_rapidin_voucher_installments vi
         JOIN module_rapidin_installments i ON i.id = vi.installment_id
         WHERE vi.voucher_id = $1`,
        [voucherId]
      );

      // Crear registro de pago vinculado al comprobante
      const paymentResult = await query(
        `INSERT INTO module_rapidin_payments 
         (loan_id, amount, payment_date, payment_method, voucher_id, observations, registered_by)
         VALUES ($1, $2, $3, 'voucher', $4, $5, $6)
         RETURNING id`,
        [voucher.loan_id, voucher.amount, voucher.payment_date, voucherId, voucher.observations, reviewedBy]
      );

      const paymentId = paymentResult.rows[0].id;

      // Aplicar pago a las cuotas (primero mora, luego cuota)
      for (const vi of voucherInstallments.rows) {
        const installmentInfo = await query(
          'SELECT installment_amount, paid_amount, late_fee FROM module_rapidin_installments WHERE id = $1',
          [vi.installment_id]
        );
        
        const installmentAmount = parseFloat(installmentInfo.rows[0].installment_amount);
        const paidAmount = parseFloat(installmentInfo.rows[0].paid_amount || 0);
        const lateFee = parseFloat(installmentInfo.rows[0].late_fee || 0);
        const pendingInstallmentAmount = installmentAmount - paidAmount;
        const appliedAmount = parseFloat(vi.applied_amount);
        
        // Primero pagar la mora, luego la cuota
        let lateFeePaid = Math.min(appliedAmount, lateFee);
        let installmentPaid = Math.max(0, Math.min(appliedAmount - lateFeePaid, pendingInstallmentAmount));
        
        // Actualizar cuota (mora pagada se acumula en paid_late_fee)
        await query(
          `UPDATE module_rapidin_installments
           SET paid_amount = paid_amount + $1,
               late_fee = GREATEST(0, COALESCE(late_fee, 0) - $2),
               paid_late_fee = COALESCE(paid_late_fee, 0) + $2,
               status = CASE 
                 WHEN (paid_amount + $1) >= installment_amount 
                   AND (COALESCE(late_fee, 0) - $2) <= 0
                 THEN 'paid'
                 WHEN (paid_amount + $1) >= installment_amount THEN 'pending'
                 WHEN due_date < CURRENT_DATE THEN 'overdue'
                 ELSE 'pending'
               END,
               paid_date = CASE 
                 WHEN (paid_amount + $1) >= installment_amount 
                   AND (COALESCE(late_fee, 0) - $2) <= 0
                 THEN CURRENT_DATE
                 ELSE paid_date
               END
           WHERE id = $3`,
          [installmentPaid, lateFeePaid, vi.installment_id]
        );

        // Recalcular mora sobre el saldo pendiente (monto sobrante)
        const feeRes = await query('SELECT calculate_late_fee($1, CURRENT_DATE) as late_fee', [vi.installment_id]);
        const newLateFee = Math.max(0, parseFloat(feeRes.rows[0]?.late_fee) || 0);
        await query(
          `UPDATE module_rapidin_installments 
           SET late_fee = $1, days_overdue = GREATEST(0, CURRENT_DATE - due_date)
           WHERE id = $2`,
          [newLateFee, vi.installment_id]
        );

        // Crear relación pago-cuota
        await query(
          `INSERT INTO module_rapidin_payment_installments (payment_id, installment_id, applied_amount)
           VALUES ($1, $2, $3)`,
          [paymentId, vi.installment_id, appliedAmount]
        );
      }

      // Recalcular balance y marcar préstamo como completado si ya no hay cuotas pendientes
      await updateLoanBalance(voucher.loan_id);
      await checkLoanCompleted(voucher.loan_id);
    }

    return result.rows[0];
  } catch (error) {
    logger.error('Error revisando voucher:', error);
    throw error;
  }
};




