import express from 'express';
import { query } from '../config/database.js';
import { verifyToken } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.get('/', async (req, res) => {
  try {
    const { loan_id, status } = req.query;
    
    let sql = `
      SELECT i.*, l.country, l.driver_id
      FROM module_rapidin_installments i
      JOIN module_rapidin_loans l ON l.id = i.loan_id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (loan_id) {
      sql += ` AND i.loan_id = $${paramCount++}`;
      params.push(loan_id);
    }

    if (status) {
      sql += ` AND i.status = $${paramCount++}`;
      params.push(status);
    }

    if (req.allowedCountries && req.allowedCountries.length > 0) {
      sql += ` AND l.country = ANY($${paramCount++})`;
      params.push(req.allowedCountries);
    }

    sql += ` ORDER BY i.due_date ASC`;

    const result = await query(sql, params);
    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo cuotas:', error);
    return errorResponse(res, 'Error obteniendo cuotas', 500);
  }
});

router.get('/:id', validateUUID, async (req, res) => {
  try {
    const result = await query(
      `SELECT i.*, l.country
       FROM module_rapidin_installments i
       JOIN module_rapidin_loans l ON l.id = i.loan_id
       WHERE i.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Cuota no encontrada', 404);
    }

    const installment = result.rows[0];

    if (req.allowedCountries && !req.allowedCountries.includes(installment.country)) {
      return errorResponse(res, 'No tienes permisos para ver esta cuota', 403);
    }

    return successResponse(res, installment);
  } catch (error) {
    logger.error('Error obteniendo cuota:', error);
    return errorResponse(res, 'Error obteniendo cuota', 500);
  }
});

export default router;







