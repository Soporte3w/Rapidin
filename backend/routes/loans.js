import express from 'express';
import { getLoans, getLoanById, getInstallmentSchedule, getLoansExportBundle } from '../services/loanService.js';
import { sendWhatsAppMessage } from '../services/authService.js';
import { verifyToken } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse, paginatedResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.get('/', async (req, res) => {
  try {
    const { status, country, driver, loan_id, date_from, date_to, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const filters = {};
    if (status) filters.status = status;
    if (country && req.allowedCountries?.includes(country)) {
      filters.country = country;
    }
    if (driver && typeof driver === 'string') filters.driver = driver;
    if (loan_id && typeof loan_id === 'string') filters.loan_id = loan_id;
    if (date_from && typeof date_from === 'string') filters.date_from = date_from;
    if (date_to && typeof date_to === 'string') filters.date_to = date_to;
    filters.limit = limitNum;
    filters.offset = (pageNum - 1) * limitNum;

    const result = await getLoans(filters);
    if (Array.isArray(result)) {
      return successResponse(res, result);
    }
    return paginatedResponse(res, result.data, pageNum, limitNum, result.total);
  } catch (error) {
    logger.error('Error obteniendo préstamos:', error);
    return errorResponse(res, 'Error obteniendo préstamos', 500);
  }
});

router.get('/export', async (req, res) => {
  try {
    const { status, country, driver, loan_id, date_from, date_to } = req.query;
    const filters = {};
    if (status) filters.status = status;
    if (country && req.allowedCountries?.includes(country)) {
      filters.country = country;
    }
    if (driver && typeof driver === 'string') filters.driver = driver;
    if (loan_id && typeof loan_id === 'string') filters.loan_id = loan_id;
    if (date_from && typeof date_from === 'string') filters.date_from = date_from;
    if (date_to && typeof date_to === 'string') filters.date_to = date_to;

    const bundle = await getLoansExportBundle(filters);
    return successResponse(res, bundle, 'Export listo');
  } catch (error) {
    if (error.code === 'EXPORT_LIMIT_EXCEEDED') {
      return errorResponse(res, error.message, 400);
    }
    logger.error('Error exportando préstamos:', error);
    return errorResponse(res, 'Error al exportar préstamos', 500);
  }
});

router.get('/:id', validateUUID, async (req, res) => {
  try {
    const loan = await getLoanById(req.params.id);
    
    if (!loan) {
      return errorResponse(res, 'Préstamo no encontrado', 404);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(loan.country)) {
      return errorResponse(res, 'No tienes permisos para ver este préstamo', 403);
    }

    return successResponse(res, loan);
  } catch (error) {
    logger.error('Error obteniendo préstamo:', error);
    return errorResponse(res, 'Error obteniendo préstamo', 500);
  }
});

router.get('/:id/schedule', validateUUID, async (req, res) => {
  try {
    const loan = await getLoanById(req.params.id);
    
    if (!loan) {
      return errorResponse(res, 'Préstamo no encontrado', 404);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(loan.country)) {
      return errorResponse(res, 'No tienes permisos para ver este préstamo', 403);
    }

    const schedule = await getInstallmentSchedule(req.params.id);
    return successResponse(res, schedule);
  } catch (error) {
    logger.error('Error obteniendo cronograma:', error);
    return errorResponse(res, 'Error obteniendo cronograma', 500);
  }
});

router.post('/:id/send-whatsapp', validateUUID, async (req, res) => {
  try {
    const loan = await getLoanById(req.params.id);
    if (!loan) {
      return errorResponse(res, 'Préstamo no encontrado', 404);
    }
    if (req.allowedCountries && !req.allowedCountries.includes(loan.country)) {
      return errorResponse(res, 'No tienes permisos para este préstamo', 403);
    }
    const rawPhone = loan.whatsapp_phone ?? loan.phone;
    if (!rawPhone || !String(rawPhone).trim()) {
      return errorResponse(res, 'El préstamo no tiene número de WhatsApp asociado', 400);
    }
    const digits = String(rawPhone).replace(/\D/g, '');
    const country = loan.country || 'PE';
    let phone = digits;
    if (digits.length >= 10 && (digits.startsWith('51') || digits.startsWith('57'))) {
      phone = digits;
    } else if (country === 'PE' && digits.length === 9) {
      phone = '51' + digits;
    } else if (country === 'CO' && digits.length === 10) {
      phone = '57' + digits;
    }
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      return errorResponse(res, 'El mensaje no puede estar vacío', 400);
    }
    const result = await sendWhatsAppMessage(phone, message);
    if (!result.success) {
      return errorResponse(res, result.error || 'Error al enviar WhatsApp', 400);
    }
    return successResponse(res, { sent: true }, 'Mensaje enviado por WhatsApp');
  } catch (error) {
    logger.error('Error enviando WhatsApp:', error);
    return errorResponse(res, error.message || 'Error al enviar', 500);
  }
});

export default router;







