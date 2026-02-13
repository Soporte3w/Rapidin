import express from 'express';
import { getPaymentBehavior } from '../services/analysisService.js';
import { verifyToken } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.get('/', async (req, res) => {
  try {
    const { country, start_date, end_date } = req.query;

    if (!country || !start_date || !end_date) {
      return errorResponse(res, 'País, fecha inicio y fecha fin son requeridos', 400);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(country)) {
      return errorResponse(res, 'No tienes permisos para este país', 403);
    }

    const behavior = await getPaymentBehavior(country, start_date, end_date);
    return successResponse(res, behavior);
  } catch (error) {
    logger.error('Error obteniendo comportamiento de pago:', error);
    return errorResponse(res, 'Error obteniendo comportamiento de pago', 500);
  }
});

export default router;







