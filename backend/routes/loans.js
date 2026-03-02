import express from 'express';
import pool from '../database/connection.js';
import { getLoans, getLoanById, getInstallmentSchedule } from '../services/loanService.js';
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

export default router;







