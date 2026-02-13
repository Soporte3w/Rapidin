import express from 'express';
import { getExecutiveKPIs } from '../services/analysisService.js';
import { verifyToken } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.get('/', async (req, res) => {
  try {
    const { country } = req.query;

    if (!country) {
      return errorResponse(res, 'País es requerido', 400);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(country)) {
      return errorResponse(res, 'No tienes permisos para este país', 403);
    }

    const kpis = await getExecutiveKPIs(country);
    return successResponse(res, kpis);
  } catch (error) {
    logger.error('Error obteniendo KPIs ejecutivos:', error);
    return errorResponse(res, 'Error obteniendo KPIs ejecutivos', 500);
  }
});

export default router;







