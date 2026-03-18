import express from 'express';
import fs from 'fs';
import path from 'path';
import pool from '../database/connection.js';
import { getLoanRequests, getLoanRequestById, rejectLoanRequest, getLoanByRequestId, getInstallmentSchedule } from '../services/loanService.js';
import { getDocumentsByRequestId, getDocumentByIdAndRequestId } from '../services/documentService.js';
import { sendWhatsAppMessage } from '../services/authService.js';
import { getPartnerNameById } from '../services/partnersService.js';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse, paginatedResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.get('/', async (req, res) => {
  try {
    const { status, country, driver, date_from, date_to, date_field, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const filters = {};
    if (status) filters.status = status;
    if (country && req.allowedCountries?.includes(country)) {
      filters.country = country;
    } else if (req.allowedCountries) {
      filters.country = req.allowedCountries[0];
    }
    if (driver && typeof driver === 'string') filters.driver = driver;
    if (date_from && typeof date_from === 'string') filters.date_from = date_from;
    if (date_to && typeof date_to === 'string') filters.date_to = date_to;
    if (date_field === 'approved_at') filters.date_field = 'approved_at';
    const tz = filters.country === 'PE' ? 'America/Lima' : filters.country === 'CO' ? 'America/Bogota' : 'UTC';
    filters.date_tz = tz;
    filters.offset = (pageNum - 1) * limitNum;
    filters.limit = limitNum;

    const result = await getLoanRequests(filters);
    const data = result.data ?? result;
    const total = result.total ?? (Array.isArray(result) ? result.length : 0);
    return paginatedResponse(res, data, pageNum, limitNum, total);
  } catch (error) {
    logger.error('Error obteniendo solicitudes:', error);
    return errorResponse(res, 'Error obteniendo solicitudes', 500);
  }
});

router.get('/:id/documents/:docId/file', validateUUID, async (req, res) => {
  try {
    const { id: requestId, docId } = req.params;
    const request = await getLoanRequestById(requestId);
    if (!request) {
      return errorResponse(res, 'Solicitud no encontrada', 404);
    }
    if (req.allowedCountries && !req.allowedCountries.includes(request.country)) {
      return errorResponse(res, 'No tienes permisos para ver esta solicitud', 403);
    }

    const doc = await getDocumentByIdAndRequestId(docId, requestId);
    if (!doc || !doc.file_path) {
      return errorResponse(res, 'Documento no encontrado', 404);
    }

    // Si file_path es una URL (subida al bucket/media), redirigir
    if (doc.file_path.startsWith('http')) {
      return res.redirect(doc.file_path);
    }

    const filePath = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(process.cwd(), doc.file_path);
    if (!fs.existsSync(filePath)) {
      return errorResponse(res, 'Archivo no encontrado', 404);
    }

    const ext = path.extname(doc.file_name).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' }[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.sendFile(path.resolve(filePath));
  } catch (error) {
    logger.error('Error sirviendo documento:', error);
    return errorResponse(res, 'Error al obtener el documento', 500);
  }
});

router.get('/:id', validateUUID, async (req, res) => {
  try {
    const request = await getLoanRequestById(req.params.id);

    if (!request) {
      return errorResponse(res, 'Solicitud no encontrada', 404);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(request.country)) {
      return errorResponse(res, 'No tienes permisos para ver esta solicitud', 403);
    }

    let driver_licencia = null;
    let driver_partner_name = null;

    const isValidLicense = (val) => {
      if (val == null || typeof val !== 'string') return false;
      const s = val.trim();
      return s.length > 0 && s.length <= 30 && !/^DRIVERDRAFT/i.test(s);
    };
    const setLicencia = (raw) => {
      const s = (raw != null ? String(raw).trim() : '') || null;
      if (s && isValidLicense(s)) driver_licencia = s;
    };

    // Flota y licencia: conductor de la solicitud (module_rapidin_drivers) y, si hace falta, su fila en drivers (por external_driver_id)
    if (request.driver_id) {
      try {
        const rapidinDriver = await pool.query(
          'SELECT park_id, license, external_driver_id FROM module_rapidin_drivers WHERE id = $1 LIMIT 1',
          [request.driver_id]
        );
        const rd = rapidinDriver?.rows?.[0];
        if (rd?.park_id) driver_partner_name = await getPartnerNameById(rd.park_id);
        setLicencia(rd?.license);
        // Si no hay licencia en Rapidín, usar la del mismo conductor en Yego (drivers.driver_id = external_driver_id), no por teléfono
        if (driver_licencia == null && rd?.external_driver_id) {
          const yegoDriver = await pool.query(
            `SELECT license_number FROM drivers WHERE driver_id::text = $1 LIMIT 1`,
            [String(rd.external_driver_id).trim()]
          );
          const yRow = yegoDriver?.rows?.[0];
          setLicencia(yRow?.license_number);
        }
      } catch (e) {
        logger.error('Error resolviendo flota/licencia por driver_id:', e);
      }
    }

    // Último recurso: licencia por teléfono en drivers (puede haber varios con el mismo teléfono; solo si no tenemos ya por conductor)
    if (request.phone && driver_licencia == null) {
      try {
        const driverRow = await pool.query(
          `SELECT license_number FROM drivers
           WHERE phone = $1 AND work_status = 'working' LIMIT 1`,
          [request.phone]
        );
        setLicencia(driverRow?.rows?.[0]?.license_number);
      } catch (e) {
        if (e.code !== '42703') logger.error('Error resolviendo licencia por teléfono:', e);
      }
    }

    const documents = await getDocumentsByRequestId(req.params.id);
    const driverCycle = (request.cycle ?? request.driver_cycle) != null ? parseInt(request.cycle ?? request.driver_cycle, 10) : 1;
    let requires_guarantor = false;
    if (request.country && driverCycle) {
      const cycleConfig = await pool.query(
        `SELECT requires_guarantor FROM module_rapidin_cycle_config 
         WHERE country = $1 AND cycle = $2 AND active = true LIMIT 1`,
        [request.country, driverCycle]
      );
      requires_guarantor = cycleConfig.rows[0]?.requires_guarantor === true;
    }
    const payload = { ...request, documents, driver_licencia, driver_partner_name, requires_guarantor };
    if (request.status === 'disbursed') {
      const loan = await getLoanByRequestId(req.params.id);
      if (loan) {
        payload.loan = loan;
        payload.installments = await getInstallmentSchedule(loan.id);
      }
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return successResponse(res, payload);
  } catch (error) {
    logger.error('Error obteniendo solicitud:', error);
    return errorResponse(res, 'Error obteniendo solicitud', 500);
  }
});

router.post('/:id/reject', validateUUID, verifyRole('analyst', 'approver', 'admin'), async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason) {
      return errorResponse(res, 'Motivo de rechazo requerido', 400);
    }

    const request = await rejectLoanRequest(req.params.id, reason, req.user.id);
    return successResponse(res, request, 'Solicitud rechazada');
  } catch (error) {
    logger.error('Error rechazando solicitud:', error);
    return errorResponse(res, error.message, 400);
  }
});

/** Enviar mensaje al conductor por WhatsApp (solicitud desembolsada: ej. cuenta bancaria equivocada) */
router.post('/:id/send-message', validateUUID, verifyRole('analyst', 'approver', 'admin'), async (req, res) => {
  try {
    const request = await getLoanRequestById(req.params.id);
    if (!request) {
      return errorResponse(res, 'Solicitud no encontrada', 404);
    }
    if (req.allowedCountries && !req.allowedCountries.includes(request.country)) {
      return errorResponse(res, 'No tienes permisos para esta solicitud', 403);
    }
    if (!['approved', 'disbursed'].includes(request.status)) {
      return errorResponse(res, 'Solo se puede enviar mensaje para solicitudes aprobadas o desembolsadas', 400);
    }
    const rawPhone = request.phone;
    if (!rawPhone || !String(rawPhone).trim()) {
      return errorResponse(res, 'La solicitud no tiene teléfono del conductor', 400);
    }
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      return errorResponse(res, 'El mensaje no puede estar vacío', 400);
    }
    const digits = String(rawPhone).replace(/\D/g, '');
    const country = request.country || 'PE';
    let phone = digits;
    if (digits.length >= 10 && (digits.startsWith('51') || digits.startsWith('57'))) {
      phone = digits;
    } else if (country === 'PE' && digits.length === 9) {
      phone = '51' + digits;
    } else if (country === 'CO' && digits.length === 10) {
      phone = '57' + digits;
    }
    const result = await sendWhatsAppMessage(phone, message);
    if (!result.success) {
      return errorResponse(res, result.error || 'Error al enviar WhatsApp', 400);
    }
    return successResponse(res, { sent: true }, 'Mensaje enviado por Rapidín');
  } catch (error) {
    logger.error('Error enviando mensaje solicitud:', error);
    return errorResponse(res, error.message || 'Error al enviar', 500);
  }
});

export default router;







