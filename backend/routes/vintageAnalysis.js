import express from 'express';
import { getVintageAnalysis } from '../services/analysisService.js';
import { verifyToken } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.get('/', async (req, res) => {
  try {
    const { country, cohort_month } = req.query;

    if (!country || !cohort_month) {
      return errorResponse(res, 'País y mes de cohorte son requeridos', 400);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(country)) {
      return errorResponse(res, 'No tienes permisos para este país', 403);
    }

    const analysis = await getVintageAnalysis(country, cohort_month);
    return successResponse(res, analysis);
  } catch (error) {
    logger.error('Error obteniendo análisis vintage:', error);
    return errorResponse(res, 'Error obteniendo análisis vintage', 500);
  }
});

export default router;







