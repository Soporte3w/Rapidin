import express from 'express';
import { getPortfolioAtRisk } from '../services/analysisService.js';
import { query } from '../config/database.js';
import { verifyToken } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.get('/risk', async (req, res) => {
  try {
    const { country } = req.query;

    if (!country) {
      return errorResponse(res, 'País es requerido', 400);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(country)) {
      return errorResponse(res, 'No tienes permisos para este país', 403);
    }

    const par1 = await getPortfolioAtRisk(country, 1);
    const par7 = await getPortfolioAtRisk(country, 7);
    const par30 = await getPortfolioAtRisk(country, 30);

    return successResponse(res, {
      par_1: par1,
      par_7: par7,
      par_30: par30
    });
  } catch (error) {
    logger.error('Error obteniendo análisis de cartera:', error);
    return errorResponse(res, 'Error obteniendo análisis de cartera', 500);
  }
});

export default router;







