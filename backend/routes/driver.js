import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { getDriverDashboard, getDriverLoans } from '../services/driverService.js';
import { getPendingInstallments, uploadVoucher, getDriverVouchers, uploadFileToMedia } from '../services/voucherService.js';
import { uploadVoucher as uploadMiddleware } from '../middleware/upload.js';
import { getCreditLine, getPaymentPunctuality, simulateLoanOptions } from '../services/calculationsService.js';
import { createLoanRequest, getInstallmentSchedule } from '../services/loanService.js';
import { checkMinimumTripsForLoanOffer } from '../services/tripsValidationService.js';
import { getDniInfo } from '../services/factilizaService.js';
import { getPartnerNameById } from '../services/partnersService.js';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../database/connection.js';
import { logger } from '../utils/logger.js';
import { phoneDigitsForRapidinMatch } from '../utils/helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadsDir = path.join(__dirname, '../../uploads/loan-documents');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `loan-doc-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const uploadLoanDocFields = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf|webp/;
    const ext = path.extname(file.originalname).toLowerCase();
    const mimetypeOk = allowedTypes.test(file.mimetype) || file.mimetype === 'image/webp';
    const extOk = ext ? allowedTypes.test(ext) : true; // sin extensión (ej. blob/image) se acepta si mimetype vale
    if (mimetypeOk && extOk) {
      return cb(null, true);
    }
    cb(new Error('Solo se permiten archivos JPEG, PNG, WebP o PDF'));
  }
}).fields([
  { name: 'id_document', maxCount: 1 },
  { name: 'contact_front_photo', maxCount: 1 },
  { name: 'contract_signature', maxCount: 1 }
]);

const router = express.Router();

/** Normaliza teléfono para consultas (mismo criterio que en loan-request). */
function normalizePhoneForDb(phone, country) {
  const digits = (phone || '').toString().replace(/\D/g, '');
  if (country === 'CO') {
    return digits.length === 12 && digits.startsWith('57') ? `+${digits}` : `+57${digits}`;
  }
  return digits.length === 11 && digits.startsWith('51') ? `+${digits}` : digits.length >= 9 ? `+51${digits.slice(-9)}` : `+${digits}`;
}

/** Código país para tabla drivers (license_country): 'PE' -> 'per', 'CO' -> 'col'. */
function getCountryCodeForDrivers(country) {
  return country === 'PE' ? 'per' : country === 'CO' ? 'col' : (country || '').toLowerCase();
}

/** Trunca a 20 caracteres para columnas VARCHAR(20) (dni, phone en module_rapidin_drivers). */
function truncateVarchar20(val) {
  if (val == null) return '';
  const s = String(val).trim();
  return s.length > 20 ? s.slice(0, 20) : s;
}

/** Parsea park_id desde query o body. */
function parseParkId(req, fromQuery = true) {
  const value = fromQuery ? req.query?.park_id : req.body?.park_id;
  return (value != null && value !== '') ? String(value).trim() : null;
}

/** Parsea driver_id (UUID de module_rapidin_drivers) desde query. Con solo este id se buscan solicitudes y préstamos. */
function parseDriverId(req, fromQuery = true) {
  const value = fromQuery ? req.query?.driver_id : req.body?.driver_id;
  return (value != null && value !== '') ? String(value).trim() : null;
}

/** Valida que el usuario sea conductor (phone + country). Retorna errorResponse o null. */
function requireDriverAuth(req, res) {
  const { phone, country } = req.user || {};
  if (!phone) return errorResponse(res, 'Usuario no es un conductor', 403);
  if (!country) return errorResponse(res, 'País no especificado en el token', 400);
  return null;
}

/**
 * Si el conductor (phone + country) tiene préstamo activo o en mora en otra flota (park_id distinto a currentParkId),
 * devuelve { hasActiveInOtherFlota: true, flotas: [{ flota_name }] }. Si no, { hasActiveInOtherFlota: false }.
 */
async function getActiveLoanInOtherFlota(phone, country, currentParkId) {
  const phoneForDb = normalizePhoneForDb(phone, country);
  const digitsOnly = (phone || '').toString().replace(/\D/g, '');
  const last9 = phoneDigitsForRapidinMatch(phone, country);
  const currentNorm = (currentParkId != null && currentParkId !== '') ? String(currentParkId).trim() : '';

  const result = await pool.query(
    `SELECT DISTINCT d.park_id
     FROM module_rapidin_drivers d
     JOIN module_rapidin_loans l ON l.driver_id = d.id AND l.status IN ('active', 'defaulted')
     WHERE d.country = $1
       AND (d.phone = $2 OR d.phone = $3 OR REGEXP_REPLACE(COALESCE(d.phone,''), '[^0-9]', '', 'g') = $4 OR REGEXP_REPLACE(COALESCE(d.phone,''), '[^0-9]', '', 'g') = $5)
       AND (COALESCE(TRIM(d.park_id), '') <> $6 OR $6 = '')`,
    [country, phoneForDb, phone, digitsOnly, last9, currentNorm]
  );

  const flotas = [];
  for (const row of result.rows) {
    const parkId = (row.park_id != null && row.park_id !== '') ? String(row.park_id).trim() : '';
    if (parkId && parkId !== currentNorm) {
      const flotaName = await getPartnerNameById(row.park_id) || row.park_id || 'Otra flota';
      flotas.push({ flota_name: flotaName });
    }
  }
  if (flotas.length > 0) return { hasActiveInOtherFlota: true, flotas };
  return { hasActiveInOtherFlota: false };
}

/**
 * Si el conductor (phone + country) tiene una solicitud que bloquea en alguna flota (pendiente, aprobada, firmada o desembolsada con préstamo no cancelado),
 * devuelve { hasPendingRequest: true, flotas: [{ flota_name, status }] }. Si no, { hasPendingRequest: false }.
 */
async function getPendingRequestInAnyFlota(phone, country) {
  const phoneForDb = normalizePhoneForDb(phone, country);
  const digitsOnly = (phone || '').toString().replace(/\D/g, '');
  const last9 = phoneDigitsForRapidinMatch(phone, country);
  const result = await pool.query(
    `SELECT r.status, d.park_id
     FROM module_rapidin_loan_requests r
     JOIN module_rapidin_drivers d ON d.id = r.driver_id
     WHERE d.country = $1
       AND (d.phone = $2 OR d.phone = $3 OR REGEXP_REPLACE(COALESCE(d.phone,''), '[^0-9]', '', 'g') = $4 OR REGEXP_REPLACE(COALESCE(d.phone,''), '[^0-9]', '', 'g') = $5)
       AND r.status NOT IN ('rejected', 'cancelled')
       AND (
         r.status IN ('pending', 'approved', 'signed')
         OR (r.status = 'disbursed' AND EXISTS (
           SELECT 1 FROM module_rapidin_loans l 
           WHERE l.request_id = r.id AND (l.status IS NULL OR l.status != 'cancelled')
         ))
       )
     ORDER BY r.created_at DESC`,
    [country, phoneForDb, phone, digitsOnly, last9]
  );
  if (result.rows.length === 0) return { hasPendingRequest: false };
  const flotas = [];
  const seen = new Set();
  for (const row of result.rows) {
    const key = `${row.park_id || ''}-${row.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const flotaName = await getPartnerNameById(row.park_id) || row.park_id || 'Otra flota';
    flotas.push({ flota_name: flotaName, status: row.status });
  }
  return { hasPendingRequest: true, flotas, status: result.rows[0].status };
}

// Nombre de la flota por park_id (API de partners) — para mostrar en header y guardar en sesión
router.get('/flota-name', authenticate, async (req, res) => {
  try {
    const parkId = parseParkId(req, true);
    if (!parkId) {
      return successResponse(res, { name: null }, 'Sin flota');
    }
    const name = await getPartnerNameById(parkId) || null;
    return successResponse(res, { name }, 'Nombre de flota');
  } catch (error) {
    logger.error('Error obteniendo nombre de flota:', error);
    return errorResponse(res, error.message || 'Error al obtener nombre de flota', 500);
  }
});

// Obtener dashboard del conductor. Si ya existe conductor (login), usar driver_id; si no viene, resolver por teléfono.
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const parkId = parseParkId(req, true);
    let driverId = parseDriverId(req, true);
    if (!driverId) driverId = await getRapidinDriverId(phone, country, parkId);

    const dashboard = await getDriverDashboard(phone, country, parkId, driverId);
    if (dashboard && typeof dashboard === 'object') {
      dashboard.rapidin_driver_id = driverId || dashboard.rapidin_driver_id || null;
      dashboard.park_id = parkId || dashboard.park_id || null;
    }
    return successResponse(res, dashboard, 'Dashboard obtenido exitosamente');
  } catch (error) {
    logger.error('Error en /driver/dashboard:', error);
    return errorResponse(res, error.message || 'Error al obtener el dashboard', 500);
  }
});

// Actualizar perfil del conductor (email, etc.)
router.patch('/profile', authenticate, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const { email } = req.body;
    const emailValue = typeof email === 'string' ? email.trim() || null : null;
    const driverId = await getRapidinDriverId(phone, country);
    if (!driverId) {
      return errorResponse(res, 'Conductor no encontrado', 404);
    }
    await pool.query(
      'UPDATE module_rapidin_drivers SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [emailValue, driverId]
    );
    return successResponse(res, { email: emailValue }, 'Perfil actualizado');
  } catch (error) {
    logger.error('Error en PATCH /driver/profile:', error);
    return errorResponse(res, error.message || 'Error al actualizar perfil', 500);
  }
});

// Obtener préstamos y solicitudes. Si el conductor ya existe (login guarda driver_id), usar ese id; si no viene, resolver por teléfono.
router.get('/loans', authenticate, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const parkId = parseParkId(req, true);
    const driverId = parseDriverId(req, true);
    const resolvedDriverId = driverId || await getRapidinDriverId(phone, country, parkId);

    const result = await getDriverLoans(phone, country, parkId, resolvedDriverId);
    // Devolver contexto usado para que el frontend pueda persistirlo en localStorage (park_id / rapidin_driver_id)
    if (result && typeof result === 'object') {
      result.rapidin_driver_id = resolvedDriverId || result.rapidin_driver_id || null;
      result.park_id = parkId || result.park_id || null;
    }
    return successResponse(res, result, 'Préstamos obtenidos exitosamente');
  } catch (error) {
    logger.error('Error en /driver/loans:', error);
    return errorResponse(res, error.message || 'Error al obtener los préstamos', 500);
  }
});

// Helper: resolver driver_id por (phone, country, park_id opcional). En BD el phone puede estar como "970180035" (9 dígitos); comparar también por últimos 9.
async function getRapidinDriverId(phone, country, parkId = null) {
  const phoneForDb = normalizePhoneForDb(phone, country);
  const digitsOnly = (phone || '').toString().replace(/\D/g, '');
  const last9 = phoneDigitsForRapidinMatch(phone, country);
  const parkNorm = (parkId != null && String(parkId).trim() !== '') ? String(parkId).trim() : null;
  if (parkNorm) {
    let r = await pool.query(
      `SELECT id FROM module_rapidin_drivers 
       WHERE country = $2 AND COALESCE(park_id, '') = $3 
       AND (phone = $1 OR phone = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $6) 
       LIMIT 1`,
      [phoneForDb, country, parkNorm, phone, digitsOnly, last9]
    );
    if (r.rows.length === 0) {
      r = await pool.query(
        `SELECT id FROM module_rapidin_drivers 
         WHERE country = $1 AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5) 
         LIMIT 1`,
        [country, phoneForDb, phone, digitsOnly, last9]
      );
    }
    return r.rows[0]?.id ?? null;
  }
  const r = await pool.query(
    `SELECT id FROM module_rapidin_drivers 
     WHERE country = $1 AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5) 
     LIMIT 1`,
    [country, phoneForDb, phone, digitsOnly, last9]
  );
  return r.rows[0]?.id ?? null;
}

// Todos los driver_id del conductor (phone + country), para historial de pagos en todas las flotas.
async function getRapidinDriverIds(phone, country) {
  const phoneForDb = normalizePhoneForDb(phone, country);
  const digitsOnly = (phone || '').toString().replace(/\D/g, '');
  const last9 = phoneDigitsForRapidinMatch(phone, country);
  const r = await pool.query(
    `SELECT id FROM module_rapidin_drivers 
     WHERE country = $1 AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5)`,
    [country, phoneForDb, phone, digitsOnly, last9]
  );
  return r.rows.map((row) => row.id);
}

// Verifica que el préstamo pertenezca a un conductor con el mismo (phone, country). Así un conductor con varios préstamos en distintas flotas puede ver las cuotas de cualquiera.
async function loanBelongsToDriverByPhoneCountry(loanId, phone, country) {
  const phoneForDb = normalizePhoneForDb(phone, country);
  const digitsOnly = (phone || '').toString().replace(/\D/g, '');
  const last9 = phoneDigitsForRapidinMatch(phone, country);
  const r = await pool.query(
    `SELECT l.id, l.driver_id, l.status as loan_status, r.status as request_status
     FROM module_rapidin_loans l
     INNER JOIN module_rapidin_drivers d ON d.id = l.driver_id
     LEFT JOIN module_rapidin_loan_requests r ON r.id = l.request_id
     WHERE l.id = $1 AND d.country = $2
       AND (d.phone = $3 OR d.phone = $4 OR REGEXP_REPLACE(COALESCE(d.phone,''), '[^0-9]', '', 'g') = $5 OR REGEXP_REPLACE(COALESCE(d.phone,''), '[^0-9]', '', 'g') = $6)`,
    [loanId, country, phoneForDb, phone, digitsOnly, last9]
  );
  return r.rows[0] || null;
}

const DISBURSED_LOAN_STATUSES = ['active', 'completed', 'cancelled', 'late', 'defaulted'];
function canShowSchedule(loanRow) {
  if (loanRow.request_status === 'disbursed' || loanRow.request_status === 'cancelled') return true;
  if (loanRow.loan_status && DISBURSED_LOAN_STATUSES.includes(loanRow.loan_status)) return true;
  return false;
}

// Obtener cuotas pendientes de un préstamo (solo si la solicitud está desembolsada; sin desembolso no hay cronograma)
// Permite ver cuotas de cualquier préstamo del conductor aunque sea de otra flota (mismo phone+country).
router.get('/loans/:loanId/installments', authenticate, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const { loanId } = req.params;

    const loanRow = await loanBelongsToDriverByPhoneCountry(loanId, phone, country);
    if (!loanRow) {
      return errorResponse(res, 'Préstamo no encontrado o no corresponde a tu usuario', 404);
    }
    if (!canShowSchedule(loanRow)) {
      return errorResponse(res, 'El cronograma de cuotas solo está disponible después del desembolso.', 403);
    }

    const installments = await getPendingInstallments(loanId, loanRow.driver_id);
    return successResponse(res, installments, 'Cuotas pendientes obtenidas exitosamente');
  } catch (error) {
    logger.error('Error obteniendo cuotas pendientes:', error);
    return errorResponse(res, error.message || 'Error al obtener las cuotas', 500);
  }
});

// Cronograma completo de un préstamo (solo si la solicitud está desembolsada; sin desembolso no se genera cronograma)
// Permite ver cronograma de cualquier préstamo del conductor aunque sea de otra flota (mismo phone+country).
router.get('/loans/:loanId/schedule', authenticate, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const { loanId } = req.params;

    const loanRow = await loanBelongsToDriverByPhoneCountry(loanId, phone, country);
    if (!loanRow) {
      return errorResponse(res, 'Préstamo no encontrado o no corresponde a tu usuario', 404);
    }
    if (!canShowSchedule(loanRow)) {
      return errorResponse(res, 'El cronograma solo está disponible después del desembolso.', 403);
    }

    const schedule = await getInstallmentSchedule(loanId);
    const balanceRow = await pool.query(
      'SELECT pending_balance FROM module_rapidin_loans WHERE id = $1',
      [loanId]
    );
    const pendingBalance = balanceRow.rows[0] ? parseFloat(balanceRow.rows[0].pending_balance) : null;
    return successResponse(res, { schedule, pendingBalance }, 'Cronograma obtenido');
  } catch (error) {
    logger.error('Error obteniendo cronograma:', error);
    return errorResponse(res, error.message || 'Error al obtener el cronograma', 500);
  }
});

// Subir voucher de pago
router.post('/vouchers', authenticate, uploadMiddleware.single('voucher'), async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const { loanId, amount, paymentDate, observations, installmentIds } = req.body;

    if (!req.file) {
      return errorResponse(res, 'Debes subir un archivo de voucher', 400);
    }

    if (!loanId || !amount || !paymentDate) {
      return errorResponse(res, 'Faltan datos requeridos (loanId, amount, paymentDate)', 400);
    }

    // Que el préstamo pertenezca al conductor (por phone+country), así funciona con varios préstamos en distintas flotas
    const loanRow = await loanBelongsToDriverByPhoneCountry(loanId, phone, country);
    if (!loanRow) {
      return errorResponse(res, 'Préstamo no encontrado o no pertenece al conductor', 404);
    }
    const parsedInstallmentIds = installmentIds ? JSON.parse(installmentIds) : [];

    const voucher = await uploadVoucher(
      loanId,
      loanRow.driver_id,
      parseFloat(amount),
      paymentDate,
      req.file,
      observations,
      parsedInstallmentIds
    );

    return successResponse(res, voucher, 'Voucher subido exitosamente');
  } catch (error) {
    logger.error('Error subiendo voucher:', error);
    return errorResponse(res, error.message || 'Error al subir el voucher', 500);
  }
});

// Obtener vouchers del conductor
router.get('/vouchers', authenticate, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const loanId = (req.query?.loan_id && String(req.query.loan_id).trim()) || null;

    const vouchers = await getDriverVouchers(phone, country, loanId);
    return successResponse(res, vouchers, 'Vouchers obtenidos exitosamente');
  } catch (error) {
    logger.error('Error obteniendo vouchers:', error);
    return errorResponse(res, error.message || 'Error al obtener los vouchers', 500);
  }
});

// Listar pagos del conductor. Si viene loan_id (préstamo/flota), solo de ese préstamo; si no, de todos.
router.get('/payments', authenticate, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const loanIdFilter = (req.query?.loan_id && String(req.query.loan_id).trim()) || null;

    const driverIds = await getRapidinDriverIds(phone, country);
    if (driverIds.length === 0) {
      return successResponse(res, { payments: [], pending_vouchers: [] }, 'Listado de pagos');
    }

    if (loanIdFilter) {
      const loanRow = await loanBelongsToDriverByPhoneCountry(loanIdFilter, phone, country);
      if (!loanRow) {
        return successResponse(res, { payments: [], pending_vouchers: [] }, 'Listado de pagos');
      }
    }

    const paymentsQuery = loanIdFilter
      ? `
      SELECT 
        p.id,
        p.loan_id,
        p.amount,
        p.payment_date,
        COALESCE(p.payment_method, 'manual') AS payment_method,
        p.created_at,
        (SELECT v.id FROM module_rapidin_payment_vouchers v
         WHERE v.loan_id = p.loan_id AND v.amount = p.amount AND v.payment_date = p.payment_date
         AND v.status = 'approved' AND v.driver_id = ANY($1)
         ORDER BY v.reviewed_at DESC NULLS LAST LIMIT 1) AS voucher_id,
        (SELECT array_agg(i.installment_number ORDER BY i.installment_number)
         FROM module_rapidin_payment_installments pi
         JOIN module_rapidin_installments i ON i.id = pi.installment_id
         WHERE pi.payment_id = p.id) AS installment_numbers
      FROM module_rapidin_payments p
      INNER JOIN module_rapidin_loans l ON l.id = p.loan_id
      WHERE l.driver_id = ANY($1) AND p.loan_id = $2
      ORDER BY p.payment_date DESC, p.created_at DESC
    `
      : `
      SELECT 
        p.id,
        p.loan_id,
        p.amount,
        p.payment_date,
        COALESCE(p.payment_method, 'manual') AS payment_method,
        p.created_at,
        (SELECT v.id FROM module_rapidin_payment_vouchers v
         WHERE v.loan_id = p.loan_id AND v.amount = p.amount AND v.payment_date = p.payment_date
         AND v.status = 'approved' AND v.driver_id = ANY($1)
         ORDER BY v.reviewed_at DESC NULLS LAST LIMIT 1) AS voucher_id,
        (SELECT array_agg(i.installment_number ORDER BY i.installment_number)
         FROM module_rapidin_payment_installments pi
         JOIN module_rapidin_installments i ON i.id = pi.installment_id
         WHERE pi.payment_id = p.id) AS installment_numbers
      FROM module_rapidin_payments p
      INNER JOIN module_rapidin_loans l ON l.id = p.loan_id
      WHERE l.driver_id = ANY($1)
      ORDER BY p.payment_date DESC, p.created_at DESC
    `;

    const paymentsParams = loanIdFilter ? [driverIds, loanIdFilter] : [driverIds];
    const result = await pool.query(paymentsQuery, paymentsParams);
    const payments = result.rows.map((row) => ({
      id: row.id,
      loan_id: row.loan_id,
      amount: parseFloat(row.amount),
      payment_date: row.payment_date,
      payment_method: row.payment_method || 'manual',
      created_at: row.created_at,
      voucher_id: row.voucher_id || null,
      installment_numbers: Array.isArray(row.installment_numbers) ? row.installment_numbers : (row.installment_numbers ? [row.installment_numbers] : []),
      is_pending: false
    }));

    const pendingVouchersQuery = loanIdFilter
      ? `
      SELECT 
        v.id,
        v.loan_id,
        v.amount,
        v.payment_date,
        v.created_at,
        (SELECT array_agg(i.installment_number ORDER BY i.installment_number)
         FROM module_rapidin_voucher_installments vi
         JOIN module_rapidin_installments i ON i.id = vi.installment_id
         WHERE vi.voucher_id = v.id) AS installment_numbers
      FROM module_rapidin_payment_vouchers v
      WHERE v.driver_id = ANY($1) AND v.status = 'pending' AND v.loan_id = $2
      ORDER BY v.payment_date DESC, v.created_at DESC
    `
      : `
      SELECT 
        v.id,
        v.loan_id,
        v.amount,
        v.payment_date,
        v.created_at,
        (SELECT array_agg(i.installment_number ORDER BY i.installment_number)
         FROM module_rapidin_voucher_installments vi
         JOIN module_rapidin_installments i ON i.id = vi.installment_id
         WHERE vi.voucher_id = v.id) AS installment_numbers
      FROM module_rapidin_payment_vouchers v
      WHERE v.driver_id = ANY($1) AND v.status = 'pending'
      ORDER BY v.payment_date DESC, v.created_at DESC
    `;
    const pendingParams = loanIdFilter ? [driverIds, loanIdFilter] : [driverIds];
    const pendingResult = await pool.query(pendingVouchersQuery, pendingParams);
    const pending_vouchers = pendingResult.rows.map((row) => ({
      id: row.id,
      loan_id: row.loan_id,
      amount: parseFloat(row.amount),
      payment_date: row.payment_date,
      payment_method: 'voucher',
      created_at: row.created_at,
      voucher_id: row.id,
      installment_numbers: Array.isArray(row.installment_numbers) ? row.installment_numbers : (row.installment_numbers ? [row.installment_numbers] : []),
      is_pending: true
    }));

    return successResponse(res, { payments, pending_vouchers }, 'Listado de pagos');
  } catch (error) {
    logger.error('Error obteniendo pagos del conductor:', error);
    return errorResponse(res, error.message || 'Error al obtener los pagos', 500);
  }
});

// Servir archivo de voucher
router.get('/vouchers/:voucherId/file', authenticate, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const { voucherId } = req.params;

    const driverIds = await getRapidinDriverIds(phone, country);
    if (driverIds.length === 0) {
      return errorResponse(res, 'Conductor no encontrado', 404);
    }
    const voucherQuery = await pool.query(
      'SELECT file_path, file_name FROM module_rapidin_payment_vouchers WHERE id = $1 AND driver_id = ANY($2)',
      [voucherId, driverIds]
    );

    if (voucherQuery.rows.length === 0) {
      return errorResponse(res, 'Voucher no encontrado', 404);
    }

    const voucher = voucherQuery.rows[0];

    // Si file_path es una URL (subida a media/S3), redirigir
    if (voucher.file_path && voucher.file_path.startsWith('http')) {
      return res.redirect(voucher.file_path);
    }

    if (!fs.existsSync(voucher.file_path)) {
      return errorResponse(res, 'Archivo no encontrado', 404);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${voucher.file_name}"`);
    res.sendFile(path.resolve(voucher.file_path));
  } catch (error) {
    logger.error('Error sirviendo archivo de voucher:', error);
    return errorResponse(res, error.message || 'Error al obtener el archivo', 500);
  }
});

// Verificar oferta disponible para el conductor (al entrar en "Solicitar préstamo Rapidín" se guardan external_driver_id y park_id en rapidin_drivers).
// La validación de viajes (mín. 400 en 2 meses) aplica SOLO a este flujo conductor; la vista admin (GET /admin/loan-offer y POST /admin/loan-request) no valida viajes.
router.get('/loan-offer', authenticate, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const parkIdFromQuery = parseParkId(req, true);
    const externalDriverIdFromQuery = (req.query.external_driver_id != null && req.query.external_driver_id !== '')
      ? String(req.query.external_driver_id).trim()
      : (req.query.driver_id != null && req.query.driver_id !== '') ? String(req.query.driver_id).trim() : null;

    // No permitir nueva solicitud si ya tiene préstamo activo o en mora en otra flota
    const otherFlota = await getActiveLoanInOtherFlota(phone, country, parkIdFromQuery);
    if (otherFlota.hasActiveInOtherFlota) {
      const firstNames = otherFlota.flotas.map(f => f.flota_name).join(', ');
      const msg = otherFlota.flotas.length === 1
        ? `No puedes solicitar un préstamo en esta flota. Tienes un crédito pendiente en "${firstNames}". Debes pagarlo primero para solicitar en otra flota.`
        : `No puedes solicitar un préstamo en esta flota. Tienes créditos pendientes en otras flotas. Debes pagarlos primero para solicitar aquí.`;
      return errorResponse(res, msg, 400, { flotas: otherFlota.flotas });
    }

    // No permitir si ya tiene una solicitud en proceso en cualquier flota
    const pendingInAny = await getPendingRequestInAnyFlota(phone, country);
    if (pendingInAny.hasPendingRequest) {
      const firstNames = pendingInAny.flotas.map(f => f.flota_name).join(', ');
      const statusMessages = {
        pending: `Ya tienes una solicitud de préstamo pendiente en otra flota. Espera a que sea procesada antes de solicitar otro.`,
        approved: `Ya tienes una solicitud aprobada en otra flota. Completa el proceso (firma/desembolso) antes de solicitar otro.`,
        signed: `Ya tienes una solicitud firmada en otra flota. Completa el desembolso antes de solicitar otro.`,
        disbursed: `Ya tienes un préstamo desembolsado en otra flota. Debes pagarlo antes de solicitar aquí.`
      };
      const msg = statusMessages[pendingInAny.status] || `Ya tienes una solicitud en proceso en otra flota. Espera a que sea procesada.`;
      return errorResponse(res, msg, 400, { flotas: pendingInAny.flotas });
    }

    // Buscar el driver en la tabla drivers (búsqueda flexible por formato de teléfono)
    const phoneForOffer = normalizePhoneForDb(phone, country);
    const digitsOnlyOffer = (phone || '').toString().replace(/\D/g, '');
    const driverResult = await pool.query(
      `SELECT id, driver_id, license_number, first_name, last_name, document_number 
       FROM drivers 
       WHERE license_country = $1 AND work_status = 'working'
         AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4)
       LIMIT 1`,
      [getCountryCodeForDrivers(country), phoneForOffer, phone, digitsOnlyOffer]
    );

    if (driverResult.rows.length === 0) {
      return errorResponse(res, 'Conductor no encontrado o inactivo', 404);
    }

    const driverData = driverResult.rows[0];
    const identifier = driverData.license_number || driverData.document_number || phone;

    // En trips.conductor_id se guarda el external_driver_id (selectedExternalDriverId del localStorage).
    // Usar external_driver_id del query si viene; si no, fallback a driver_id de la tabla drivers.
    const conductorId = externalDriverIdFromQuery || driverData.driver_id;
    if (!conductorId) {
      return res.status(400).json({
        success: false,
        message: 'No se puede validar viajes: indica la flota o el conductor (external_driver_id).',
      });
    }
    const tripsCheck = await checkMinimumTripsForLoanOffer(conductorId);
    if (!tripsCheck.allowed) {
      return errorResponse(
        res,
        tripsCheck.message || 'No cumples el mínimo de viajes en los dos meses anteriores para solicitar un préstamo.',
        400,
        { reason: 'insufficient_trips' }
      );
    }

    // Buscar el driver en module_rapidin_drivers: por (phone, country) y si hay park_id por (phone, country, park_id). En BD phone puede ser "970180035" (9 dígitos).
    const parkForQuery = parkIdFromQuery || '';
    const last9Offer = phoneDigitsForRapidinMatch(phone, country);
    const rapidinDriverQuery = parkIdFromQuery
      ? `SELECT id, cycle FROM module_rapidin_drivers 
         WHERE country = $1 AND COALESCE(park_id, '') = $2 
         AND (phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5)
         LIMIT 1`
      : `SELECT id, cycle FROM module_rapidin_drivers 
         WHERE country = $1 AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5)
         LIMIT 1`;
    const rapidinDriverParams = parkIdFromQuery
      ? [country, parkForQuery, phoneForOffer, phone, digitsOnlyOffer, last9Offer]
      : [country, phoneForOffer, phone, digitsOnlyOffer, last9Offer];
    const rapidinDriverResult = await pool.query(rapidinDriverQuery, rapidinDriverParams);
    let cycle = 1;
    let cycleFromColumn = 1;
    let driverId = null;

    if (rapidinDriverResult.rows.length > 0) {
      driverId = rapidinDriverResult.rows[0].id;
      cycleFromColumn = Number(rapidinDriverResult.rows[0].cycle) || 1;
      cycle = cycleFromColumn;
      // Guardar en rapidin_drivers la flota elegida (external_driver_id y park_id) al entrar en nueva solicitud
      if (externalDriverIdFromQuery || parkIdFromQuery) {
        await pool.query(
          `UPDATE module_rapidin_drivers 
           SET external_driver_id = COALESCE(NULLIF(TRIM($1), ''), external_driver_id),
               park_id = COALESCE(NULLIF(TRIM($2), ''), park_id),
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $3`,
          [externalDriverIdFromQuery || null, parkIdFromQuery || null, driverId]
        );
      }
      // Si puntualidad de pago < 40%, el conductor regresa al ciclo 1
      const punctuality = await getPaymentPunctuality(driverId);
      if (punctuality < 0.4) {
        cycleFromColumn = 1;
        cycle = 1;
        await pool.query(
          'UPDATE module_rapidin_drivers SET cycle = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [driverId]
        );
      }
    } else {
      // Si no existe, crear registro para esta flota (phone y dni VARCHAR(20))
      const phoneStr = String(phone ?? '').trim().slice(0, 20);
      const dniStr = (String(identifier ?? '').trim() || phoneStr).slice(0, 20);
      const createDriverQuery = `
        INSERT INTO module_rapidin_drivers (phone, country, dni, cycle, credit_line, first_name, last_name, external_driver_id, park_id)
        VALUES ($1, $2, $3, 1, 0, $4, $5, $6, $7)
        RETURNING id, cycle
      `;
      const newDriverResult = await pool.query(createDriverQuery, [
        phoneStr || null,
        country,
        dniStr,
        driverData.first_name || '',
        driverData.last_name || '',
        externalDriverIdFromQuery || null,
        parkIdFromQuery || null
      ]);
      driverId = newDriverResult.rows[0].id;
      cycle = 1;
    }

    // Validar si el conductor tiene una solicitud que bloquea (disbursed con préstamo no cancelado no bloquea si el préstamo está cancelado)
    const existingRequest = await pool.query(
      `SELECT r.id, r.status 
       FROM module_rapidin_loan_requests r
       LEFT JOIN module_rapidin_loans l ON l.request_id = r.id
       WHERE r.driver_id = $1 
         AND r.status NOT IN ('rejected', 'cancelled')
         AND (
           r.status IN ('pending', 'approved', 'signed')
           OR (r.status = 'disbursed' AND (l.id IS NULL OR l.status != 'cancelled'))
         )
       LIMIT 1`,
      [driverId]
    );

    if (existingRequest.rows.length > 0) {
      const status = existingRequest.rows[0].status;
      const statusMessages = {
        'pending': 'Ya tienes una solicitud de préstamo pendiente. Espera a que sea procesada.',
        'approved': 'Ya tienes una solicitud de préstamo aprobada. Completa el proceso actual antes de solicitar uno nuevo.',
        'signed': 'Ya tienes una solicitud de préstamo firmada. Completa el proceso actual antes de solicitar uno nuevo.',
        'disbursed': 'Ya tienes una solicitud de préstamo desembolsada. Completa el proceso actual antes de solicitar uno nuevo.'
      };
      return errorResponse(res, statusMessages[status] || 'Ya tienes una solicitud de préstamo en proceso.', 400);
    }

    // Si tiene préstamo cancelado pero la última fecha del cronograma aún no ha llegado (pagó adelantado), debe esperar
    const cancelledFutureDate = await pool.query(
      `SELECT MAX(i.due_date) as last_schedule_due_date
       FROM module_rapidin_loans l
       JOIN module_rapidin_installments i ON i.loan_id = l.id
       WHERE l.driver_id = $1 AND l.status = 'cancelled'
       GROUP BY l.id
       HAVING MAX(i.due_date) > CURRENT_DATE
       LIMIT 1`,
      [driverId]
    );
    if (cancelledFutureDate.rows.length > 0 && cancelledFutureDate.rows[0].last_schedule_due_date) {
      const lastDate = new Date(cancelledFutureDate.rows[0].last_schedule_due_date);
      const fechaStr = lastDate.toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' });
      return errorResponse(res, `No puedes solicitar un nuevo préstamo hasta cumplir la última fecha de tu cronograma. Podrás solicitar a partir del ${fechaStr}.`, 400);
    }

    // Obtener monto máximo según el ciclo (usa cycle de la BD)
    const maxAmount = await getCreditLine(driverId, country);
    // Garante: ciclo >= 7 siempre requiere garante; si no, según configuración del ciclo
    const cycleConfigRow = await pool.query(
      `SELECT requires_guarantor FROM module_rapidin_cycle_config 
       WHERE country = $1 AND cycle = $2 AND active = true LIMIT 1`,
      [country, cycleFromColumn]
    );
    const requiresGuarantor = cycleFromColumn >= 7 || cycleConfigRow.rows[0]?.requires_guarantor === true;

    // Devolver el ciclo real del conductor (columna cycle en BD), no el calculado por préstamos pagados
    return successResponse(res, {
      cycle: cycleFromColumn,
      maxAmount,
      hasOffer: maxAmount > 0,
      requiresGuarantor
    }, 'Oferta obtenida exitosamente');
  } catch (error) {
    logger.error('Error verificando oferta:', error);
    return errorResponse(res, error.message || 'Error al verificar la oferta', 500);
  }
});

// Validar DNI (persona de contacto) vía Factiliza - solo Perú
router.get('/validate-dni/:dni', authenticate, async (req, res) => {
  try {
    const { country } = req.user;
    if (country !== 'PE') {
      return errorResponse(res, 'La validación de DNI solo está disponible para Perú', 400);
    }
    const { dni } = req.params;
    const info = await getDniInfo(dni);
    return successResponse(res, { fullName: info.fullName }, 'DNI validado');
  } catch (error) {
    return errorResponse(res, error.message || 'Error al validar DNI', 400);
  }
});

// Simular opciones de préstamo
router.post('/loan-simulate', authenticate, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;
    const { requestedAmount } = req.body;

    if (!requestedAmount) {
      return errorResponse(res, 'Monto solicitado requerido', 400);
    }

    const driverId = await getRapidinDriverId(phone, country);
    if (!driverId) {
      return errorResponse(res, 'Conductor no encontrado', 404);
    }

    const driverRow = await pool.query('SELECT cycle FROM module_rapidin_drivers WHERE id = $1', [driverId]);
    const cycle = driverRow.rows[0]?.cycle != null ? parseInt(driverRow.rows[0].cycle, 10) : 1;

    // Obtener condiciones de préstamo
    const conditionsResult = await pool.query(
      'SELECT * FROM module_rapidin_loan_conditions WHERE country = $1 AND active = true ORDER BY version DESC LIMIT 1',
      [country]
    );

    if (conditionsResult.rows.length === 0) {
      return errorResponse(res, 'No hay condiciones de préstamo configuradas', 400);
    }

    const options = await simulateLoanOptions(
      parseFloat(requestedAmount),
      country,
      cycle,
      conditionsResult.rows[0]
    );

    return successResponse(res, options, 'Opciones de préstamo generadas exitosamente');
  } catch (error) {
    logger.error('Error simulando préstamo:', error);
    return errorResponse(res, error.message || 'Error al simular el préstamo', 500);
  }
});

router.post('/loan-request', authenticate, uploadLoanDocFields, async (req, res) => {
  try {
    const authErr = requireDriverAuth(req, res);
    if (authErr) return authErr;
    const { phone, country } = req.user;

    const {
      dni,
      requested_amount,
      purpose,
      deposit_type,
      bank,
      account_type,
      account_number,
      contact_name,
      contact_dni,
      contact_phone,
      contact_relationship,
      contact_signature,
      selected_option,
      contract_signature,
      driver_id: driverIdFromBody,
      external_driver_id: externalDriverIdFromBody,
      park_id: parkIdFromBody
    } = req.body;

    // external_driver_id y park_id: desde body (flota elegida en app); aceptar driver_id o external_driver_id
    let externalDriverId = (driverIdFromBody != null && driverIdFromBody !== '')
      ? String(driverIdFromBody).trim()
      : (externalDriverIdFromBody != null && externalDriverIdFromBody !== '')
        ? String(externalDriverIdFromBody).trim()
        : null;
    let selectedParkId = (parkIdFromBody != null && parkIdFromBody !== '')
      ? String(parkIdFromBody).trim()
      : null;

    // No permitir solicitud en esta flota si ya tiene préstamo activo en otra
    const otherFlota = await getActiveLoanInOtherFlota(phone, country, selectedParkId);
    if (otherFlota.hasActiveInOtherFlota) {
      const names = otherFlota.flotas.map(f => f.flota_name).join(', ');
      const msg = otherFlota.flotas.length === 1
        ? `No puedes solicitar un préstamo en esta flota. Debes pagar primero el préstamo en ${names}.`
        : 'No puedes solicitar un préstamo en esta flota. Debes pagar primero los préstamos en las otras flotas.';
      return errorResponse(res, msg, 400, { flotas: otherFlota.flotas });
    }

    // Validaciones básicas
    if (!requested_amount || !purpose) {
      return errorResponse(res, 'Monto solicitado y propósito son requeridos', 400);
    }

    // Buscar el driver en la tabla drivers (incluir driver_id y park_id por si no vienen en el body)
    const driverResult = await pool.query(
      `SELECT driver_id, park_id, license_number, first_name, last_name, document_number 
       FROM drivers 
       WHERE phone = $1 AND license_country = $2 AND work_status = 'working'
       ORDER BY park_id NULLS LAST
       LIMIT 1`,
      [phone, getCountryCodeForDrivers(country)]
    );

    if (driverResult.rows.length === 0) {
      return errorResponse(res, 'Conductor no encontrado o inactivo', 404);
    }

    const driverData = driverResult.rows[0];
    // Fallback: si no llegaron desde el frontend (local), usar los de la primera fila drivers
    if (!externalDriverId && driverData.driver_id != null) {
      externalDriverId = String(driverData.driver_id).trim();
    }
    if (!selectedParkId && driverData.park_id != null) {
      selectedParkId = String(driverData.park_id).trim();
    }
    const driverDni = (driverData.document_number || '').toString().trim();
    if (contact_dni && driverDni && (contact_dni || '').toString().trim() === driverDni) {
      return errorResponse(res, 'El DNI del contacto no puede ser el mismo que el del conductor', 400);
    }
    if (contact_phone) {
      const driverPhoneDigits = (phone || '').toString().replace(/\D/g, '');
      const contactPhoneDigits = (contact_phone || '').toString().replace(/\D/g, '');
      const driverLast9 = driverPhoneDigits.length >= 9 ? driverPhoneDigits.slice(-9) : driverPhoneDigits;
      if (contactPhoneDigits && driverLast9 && contactPhoneDigits === driverLast9) {
        return errorResponse(res, 'El teléfono del contacto no puede ser el mismo que el del conductor', 400);
      }
    }
    // Usar número de licencia o document_number como identificador; truncar a 20 (dni VARCHAR(20))
    const identifier = truncateVarchar20(driverData.license_number || driverData.document_number || phone);

    const phoneForDb = truncateVarchar20(normalizePhoneForDb(phone, country));

    // Buscar o crear driver en module_rapidin_drivers por (phone, country, park_id). En BD phone puede ser "970180035" (9 dígitos).
    const parkForQuery = selectedParkId || '';
    const digitsOnly = (phone || '').toString().replace(/\D/g, '');
    const last9Admin = phoneDigitsForRapidinMatch(phone, country);
    let rapidinDriverResult = await pool.query(
      `SELECT id FROM module_rapidin_drivers 
       WHERE country = $2 AND COALESCE(park_id, '') = $3 
       AND (phone = $1 OR phone = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $6)
       LIMIT 1`,
      [phoneForDb, country, parkForQuery, phone, digitsOnly, last9Admin]
    );

    let driverId;
    if (rapidinDriverResult.rows.length === 0) {
      try {
        const createResult = await pool.query(
          `INSERT INTO module_rapidin_drivers (phone, country, dni, cycle, credit_line, first_name, last_name, external_driver_id, park_id)
           VALUES ($1, $2, $3, 1, 0, $4, $5, $6, $7)
           RETURNING id`,
          [phoneForDb, country, identifier, driverData.first_name || '', driverData.last_name || '', externalDriverId || null, selectedParkId || null]
        );
        driverId = createResult.rows[0].id;
      } catch (insertErr) {
        if (insertErr.code === '23505') {
          // Duplicado (race o phone en otro formato): usar la fila existente
          rapidinDriverResult = await pool.query(
            `SELECT id FROM module_rapidin_drivers 
             WHERE country = $2 AND COALESCE(park_id, '') = $3 
             AND (phone = $1 OR phone = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $6)
             LIMIT 1`,
            [phoneForDb, country, parkForQuery, phone, digitsOnly, last9Admin]
          );
          if (rapidinDriverResult.rows.length === 0) throw insertErr;
          driverId = rapidinDriverResult.rows[0].id;
          await pool.query(
            `UPDATE module_rapidin_drivers 
             SET dni = COALESCE(NULLIF($1, ''), dni), first_name = COALESCE(NULLIF($2, ''), first_name), last_name = COALESCE(NULLIF($3, ''), last_name),
             external_driver_id = COALESCE(NULLIF(TRIM(COALESCE(external_driver_id, '')), ''), $5),
             park_id = COALESCE(NULLIF(TRIM(COALESCE($6, '')), ''), park_id), updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
            [identifier, driverData.first_name || '', driverData.last_name || '', driverId, externalDriverId || null, selectedParkId || null]
          );
        } else throw insertErr;
      }
    } else {
      driverId = rapidinDriverResult.rows[0].id;
      await pool.query(
        `UPDATE module_rapidin_drivers 
         SET dni = COALESCE(NULLIF($1, ''), dni), 
             first_name = COALESCE(NULLIF($2, ''), first_name),
             last_name = COALESCE(NULLIF($3, ''), last_name),
             external_driver_id = COALESCE(NULLIF(TRIM(COALESCE(external_driver_id, '')), ''), $5),
             park_id = COALESCE(NULLIF(TRIM(COALESCE($6, '')), ''), park_id),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [identifier, driverData.first_name || '', driverData.last_name || '', driverId, externalDriverId || null, selectedParkId || null]
      );
    }

    // Ciclo del conductor y si este ciclo requiere garante (desde configuración de ciclos)
    const driverCycleResult = await pool.query(
      'SELECT cycle FROM module_rapidin_drivers WHERE id = $1',
      [driverId]
    );
    const driverCycle = driverCycleResult.rows[0]?.cycle != null ? parseInt(driverCycleResult.rows[0].cycle, 10) : 1;
    const cycleConfigResult = await pool.query(
      `SELECT requires_guarantor FROM module_rapidin_cycle_config 
       WHERE country = $1 AND cycle = $2 AND active = true LIMIT 1`,
      [country, driverCycle]
    );
    const requiresGuarantor = cycleConfigResult.rows[0]?.requires_guarantor === true;

    if (requiresGuarantor) {
      if (!contact_name?.trim() || !contact_dni?.trim() || !contact_phone?.trim()) {
        return errorResponse(res, 'Para tu ciclo se requiere garante. Completa nombre, DNI y teléfono del garante.', 400);
      }
      if (!contact_signature) {
        return errorResponse(res, 'Se requiere la firma del garante.', 400);
      }
      if (!req.files?.contact_front_photo?.[0]) {
        return errorResponse(res, 'Se requiere la foto del DNI frontal del garante.', 400);
      }
    }

    // Crear solicitud de préstamo (createLoanRequest ya valida préstamos activos y solicitudes pendientes)
    const loanRequest = await createLoanRequest({
      driver_id: driverId,
      country,
      requested_amount: parseFloat(requested_amount),
      observations: JSON.stringify({
        purpose,
        deposit_type,
        bank,
        account_type,
        account_number,
        contact_name,
        contact_dni,
        contact_phone,
        contact_relationship,
        selected_option: selected_option ? parseInt(selected_option) : null
      })
    });

    // Prefijos con nombre para los archivos en el bucket: documento_nombre_persona
    const slug = (name) => (name || '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_áéíóúÁÉÍÓÚñÑ\-]/g, '')
      .slice(0, 80) || 'sin_nombre';
    const driverNameSlug = slug([driverData.first_name, driverData.last_name].filter(Boolean).join(' '));
    const contactNameSlug = slug(contact_name || '');

    // Subir documentos a la API de bucket (media) y guardar URLs en la BD.
    // Aceptamos archivo (multipart) o base64: enviar como archivo es mejor (sin límite de tamaño en body); base64 también sirve para firmas desde canvas.
    const requestId = loanRequest.id;
    const uploadAndInsertDoc = async (type, fileName, buffer, mimetype = 'image/png', signed = false) => {
      const url = await uploadFileToMedia({ buffer, mimetype, originalname: fileName });
      await pool.query(
        `INSERT INTO module_rapidin_documents (loan_id, request_id, type, file_name, file_path, signed, signed_at)
         VALUES (NULL, $1, $2, $3, $4, $5, $6)`,
        [requestId, type, fileName, url, signed, signed ? new Date() : null]
      );
    };

    const toBuffer = (source, kind) => {
      if (!source) return null;
      if (kind === 'file' && source.path) {
        return { buffer: fs.readFileSync(source.path), mimetype: source.mimetype || 'image/png' };
      }
      const base64Data = (source || '').replace(/^data:image\/\w+;base64,/, '');
      if (!base64Data) return null;
      return { buffer: Buffer.from(base64Data, 'base64'), mimetype: 'image/png' };
    };

    // Documentos: conductor (siempre); garante solo si la configuración del ciclo requiere fiado.
    const firmaConductorName = `firma_conductor_${driverNameSlug}_${requestId}.png`;
    const firmaGaranteName = `firma_garante_${contactNameSlug}_${requestId}.png`;
    const conductorSigSource = req.files?.contract_signature?.[0] || contract_signature;

    const docs = [
      [req.files?.id_document?.[0], 'id_document', `id_document_${driverNameSlug}_${requestId}.png`, 'file', false],
      [conductorSigSource, 'contract_signature', firmaConductorName, conductorSigSource?.path ? 'file' : 'base64', true]
    ];
    if (requiresGuarantor) {
      docs.push(
        [req.files?.contact_front_photo?.[0], 'contact_front_photo', `dni_garante_${contactNameSlug}_${requestId}.png`, 'file', false],
        [contact_signature, 'contact_signature', firmaGaranteName, 'base64', true]
      );
    }

    for (const [source, type, fileName, kind, signed] of docs) {
      const parsed = toBuffer(source, kind);
      if (!parsed) continue;
      await uploadAndInsertDoc(type, fileName, parsed.buffer, parsed.mimetype, signed);
    }

    return successResponse(res, { requestId: loanRequest.id }, 'Solicitud de préstamo creada exitosamente', 201);
  } catch (error) {
    logger.error('Error creando solicitud de préstamo:', error);
    return errorResponse(res, error.message || 'Error al crear la solicitud', 500);
  }
});

export default router;




