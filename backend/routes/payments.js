import express from 'express';
import { registerPayment, getPayments, getAutoPaymentLog } from '../services/paymentService.js';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { validatePayment, validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse, paginatedResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);
router.use(verifyRole('payer', 'admin'));

router.post('/', validatePayment, async (req, res) => {
  try {
    const payment = await registerPayment(req.body, req.user.id);
    return successResponse(res, payment, 'Pago registrado exitosamente', 201);
  } catch (error) {
    logger.error('Error registrando pago:', error);
    return errorResponse(res, error.message, 400);
  }
});

router.get('/', async (req, res) => {
  try {
    const { loan_id, payment_id, date_from, date_to, page, limit, country } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const filters = {};
    if (country === 'PE' || country === 'CO') {
      if (req.allowedCountries && !req.allowedCountries.includes(country)) {
        return errorResponse(res, 'No tienes permisos para este país', 403);
      }
      filters.country = country;
    }
    if (loan_id && typeof loan_id === 'string') filters.loan_id = loan_id;
    if (payment_id && typeof payment_id === 'string') filters.payment_id = payment_id;
    if (date_from) filters.date_from = date_from;
    if (date_to) filters.date_to = date_to;
    filters.limit = limitNum;
    filters.offset = (pageNum - 1) * limitNum;

    const result = await getPayments(filters);
    if (Array.isArray(result)) {
      return successResponse(res, result);
    }
    return paginatedResponse(res, result.data, pageNum, limitNum, result.total);
  } catch (error) {
    logger.error('Error obteniendo pagos:', error);
    return errorResponse(res, 'Error obteniendo pagos', 500);
  }
});

router.get('/automatic-log', async (req, res) => {
  try {
    const { date_from, date_to, status, driver, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const result = await getAutoPaymentLog({
      date_from: date_from || undefined,
      date_to: date_to || undefined,
      status: status || undefined,
      driver: driver || undefined,
      limit: limitNum,
      offset: (pageNum - 1) * limitNum
    });
    return paginatedResponse(res, result.data, pageNum, limitNum, result.total);
  } catch (error) {
    logger.error('Error obteniendo log de pagos automáticos:', error);
    return errorResponse(res, 'Error obteniendo log', 500);
  }
});

router.get('/:id', validateUUID, async (req, res) => {
  try {
    const payments = await getPayments({ loan_id: req.params.id });
    return successResponse(res, payments);
  } catch (error) {
    logger.error('Error obteniendo pago:', error);
    return errorResponse(res, 'Error obteniendo pago', 500);
  }
});

export default router;







