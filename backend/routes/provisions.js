import express from 'express';
import { calculateProvisions, getPortfolioAtRisk } from '../services/analysisService.js';
import { query } from '../config/database.js';
import { verifyToken } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.post('/calculate', async (req, res) => {
  try {
    const { country } = req.body;

    if (!country) {
      return errorResponse(res, 'País es requerido', 400);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(country)) {
      return errorResponse(res, 'No tienes permisos para este país', 403);
    }

    const provisions = await calculateProvisions(country);
    return successResponse(res, provisions, 'Provisiones calculadas');
  } catch (error) {
    logger.error('Error calculando provisiones:', error);
    return errorResponse(res, 'Error calculando provisiones', 500);
  }
});

router.get('/history', async (req, res) => {
  try {
    const { country } = req.query;

    if (!country) {
      return errorResponse(res, 'País es requerido', 400);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(country)) {
      return errorResponse(res, 'No tienes permisos para este país', 403);
    }

    const result = await query(
      'SELECT * FROM module_rapidin_provisions WHERE country = $1 ORDER BY calculation_date DESC',
      [country]
    );

    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo historial de provisiones:', error);
    return errorResponse(res, 'Error obteniendo historial de provisiones', 500);
  }
});

router.get('/par', async (req, res) => {
  try {
    const { country, days = 30 } = req.query;

    if (!country) {
      return errorResponse(res, 'País es requerido', 400);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(country)) {
      return errorResponse(res, 'No tienes permisos para este país', 403);
    }

    const par = await getPortfolioAtRisk(country, parseInt(days));
    return successResponse(res, par);
  } catch (error) {
    logger.error('Error obteniendo PAR:', error);
    return errorResponse(res, 'Error obteniendo PAR', 500);
  }
});

export default router;







