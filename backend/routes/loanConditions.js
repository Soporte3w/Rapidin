import express from 'express';
import { query } from '../config/database.js';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);
router.use(verifyRole('admin'));

router.get('/', async (req, res) => {
  try {
    const { country } = req.query;
    let sql = 'SELECT * FROM module_rapidin_loan_conditions WHERE 1=1';
    const params = [];

    if (country && req.allowedCountries?.includes(country)) {
      sql += ' AND country = $1';
      params.push(country);
    } else if (req.allowedCountries && req.allowedCountries.length > 0) {
      sql += ` AND country = ANY($1)`;
      params.push(req.allowedCountries);
    }

    sql += ' ORDER BY country, version DESC';

    const result = await query(sql, params);
    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo condiciones:', error);
    return errorResponse(res, 'Error obteniendo condiciones', 500);
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      country,
      late_fee_type,
      late_fee_rate,
      late_fee_cap,
      initial_wait_days,
      payment_day_of_week,
      min_weeks,
      max_weeks
    } = req.body;

    if (!country || !req.allowedCountries?.includes(country)) {
      return errorResponse(res, 'País inválido o sin permisos', 400);
    }

    const maxVersion = await query(
      'SELECT MAX(version) as max_version FROM module_rapidin_loan_conditions WHERE country = $1',
      [country]
    );

    const newVersion = (parseInt(maxVersion.rows[0].max_version) || 0) + 1;

    await query(
      'UPDATE module_rapidin_loan_conditions SET active = false WHERE country = $1',
      [country]
    );

    const result = await query(
      `INSERT INTO module_rapidin_loan_conditions 
       (country, version, active, late_fee_type, late_fee_rate, late_fee_cap, initial_wait_days, payment_day_of_week, min_weeks, max_weeks, created_by)
       VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        country,
        newVersion,
        late_fee_type,
        late_fee_rate,
        late_fee_cap,
        initial_wait_days,
        payment_day_of_week,
        min_weeks,
        max_weeks,
        req.user.id
      ]
    );

    return successResponse(res, result.rows[0], 'Condiciones creadas exitosamente', 201);
  } catch (error) {
    logger.error('Error creando condiciones:', error);
    return errorResponse(res, 'Error creando condiciones', 500);
  }
});

router.put('/:id', validateUUID, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      late_fee_type,
      late_fee_rate,
      late_fee_cap,
      initial_wait_days,
      payment_day_of_week,
      min_weeks,
      max_weeks,
      active
    } = req.body;

    const existing = await query(
      'SELECT * FROM module_rapidin_loan_conditions WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      return errorResponse(res, 'Condición no encontrada', 404);
    }
    const row = existing.rows[0];
    if (!req.allowedCountries?.includes(row.country)) {
      return errorResponse(res, 'Sin permisos para este país', 403);
    }

    if (active === true) {
      await query(
        'UPDATE module_rapidin_loan_conditions SET active = false WHERE country = $1 AND id != $2',
        [row.country, id]
      );
    }

    const result = await query(
      `UPDATE module_rapidin_loan_conditions SET
         late_fee_type = COALESCE($1, late_fee_type),
         late_fee_rate = COALESCE($2, late_fee_rate),
         late_fee_cap = $3,
         initial_wait_days = COALESCE($4, initial_wait_days),
         payment_day_of_week = COALESCE($5, payment_day_of_week),
         min_weeks = COALESCE($6, min_weeks),
         max_weeks = COALESCE($7, max_weeks),
         active = COALESCE($8, active)
       WHERE id = $9
       RETURNING *`,
      [
        late_fee_type ?? row.late_fee_type,
        late_fee_rate != null ? late_fee_rate : row.late_fee_rate,
        late_fee_cap !== undefined ? late_fee_cap : row.late_fee_cap,
        initial_wait_days != null ? initial_wait_days : row.initial_wait_days,
        payment_day_of_week != null ? payment_day_of_week : row.payment_day_of_week,
        min_weeks != null ? min_weeks : row.min_weeks,
        max_weeks != null ? max_weeks : row.max_weeks,
        active !== undefined ? active : row.active,
        id
      ]
    );
    return successResponse(res, result.rows[0], 'Condición actualizada');
  } catch (error) {
    logger.error('Error actualizando condiciones:', error);
    return errorResponse(res, 'Error actualizando condiciones', 500);
  }
});

router.delete('/:id', validateUUID, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query(
      'SELECT * FROM module_rapidin_loan_conditions WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      return errorResponse(res, 'Condición no encontrada', 404);
    }
    const row = existing.rows[0];
    if (!req.allowedCountries?.includes(row.country)) {
      return errorResponse(res, 'Sin permisos para este país', 403);
    }
    if (row.active) {
      return errorResponse(
        res,
        'No se puede eliminar la condición activa. Cree una nueva versión y desactívela desde allí si desea reemplazarla.',
        400
      );
    }

    await query('DELETE FROM module_rapidin_loan_conditions WHERE id = $1', [id]);
    return successResponse(res, null, 'Condición eliminada');
  } catch (error) {
    logger.error('Error eliminando condición:', error);
    return errorResponse(res, 'Error eliminando condición', 500);
  }
});

router.get('/history/:id', validateUUID, async (req, res) => {
  try {
    const result = await query(
      `SELECT h.*, u.first_name, u.last_name
       FROM module_rapidin_loan_conditions_history h
       LEFT JOIN module_rapidin_users u ON u.id = h.modified_by
       WHERE h.condition_id = $1
       ORDER BY h.modified_at DESC`,
      [req.params.id]
    );

    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo historial:', error);
    return errorResponse(res, 'Error obteniendo historial', 500);
  }
});

export default router;







