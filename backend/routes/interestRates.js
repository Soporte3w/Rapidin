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

// GET /api/interest-rates - Obtener todas las tasas de interés
router.get('/', async (req, res) => {
  try {
    const { country, rate_type } = req.query;
    let sql = 'SELECT * FROM module_rapidin_interest_rates WHERE 1=1';
    const params = [];
    let paramCount = 0;

    if (country && req.allowedCountries?.includes(country)) {
      paramCount++;
      sql += ` AND country = $${paramCount}`;
      params.push(country);
    } else if (req.allowedCountries && req.allowedCountries.length > 0) {
      paramCount++;
      sql += ` AND country = ANY($${paramCount})`;
      params.push(req.allowedCountries);
    }

    if (rate_type) {
      paramCount++;
      sql += ` AND rate_type = $${paramCount}`;
      params.push(rate_type);
    }

    sql += ' ORDER BY country, rate_type, effective_date DESC';

    const result = await query(sql, params);
    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo tasas de interés:', error);
    return errorResponse(res, 'Error obteniendo tasas de interés', 500);
  }
});

// POST /api/interest-rates - Crear una nueva tasa de interés
router.post('/', async (req, res) => {
  try {
    const {
      country,
      rate_type,
      rate_value,
      effective_date
    } = req.body;

    // Validaciones
    if (!country || !req.allowedCountries?.includes(country)) {
      return errorResponse(res, 'País inválido o sin permisos', 400);
    }

    if (!rate_type || !['TEA', 'TES', 'TED'].includes(rate_type)) {
      return errorResponse(res, 'Tipo de tasa inválido. Debe ser TEA, TES o TED', 400);
    }

    if (!rate_value || isNaN(parseFloat(rate_value)) || parseFloat(rate_value) < 0) {
      return errorResponse(res, 'Valor de tasa inválido', 400);
    }

    if (!effective_date) {
      return errorResponse(res, 'Fecha efectiva es requerida', 400);
    }

    // Desactivar tasas anteriores del mismo tipo y país
    await query(
      `UPDATE module_rapidin_interest_rates 
       SET active = false 
       WHERE country = $1 AND rate_type = $2 AND active = true`,
      [country, rate_type]
    );

    // Crear nueva tasa
    const result = await query(
      `INSERT INTO module_rapidin_interest_rates 
       (country, rate_type, rate_value, effective_date, active, created_by)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING *`,
      [
        country,
        rate_type,
        parseFloat(rate_value),
        effective_date,
        req.user.id
      ]
    );

    return successResponse(res, result.rows[0], 'Tasa de interés creada exitosamente', 201);
  } catch (error) {
    logger.error('Error creando tasa de interés:', error);
    return errorResponse(res, 'Error creando tasa de interés', 500);
  }
});

// GET /api/interest-rates/active - Obtener tasas activas
router.get('/active', async (req, res) => {
  try {
    const { country } = req.query;
    let sql = 'SELECT * FROM module_rapidin_interest_rates WHERE active = true';
    const params = [];

    if (country && req.allowedCountries?.includes(country)) {
      sql += ' AND country = $1';
      params.push(country);
    } else if (req.allowedCountries && req.allowedCountries.length > 0) {
      sql += ` AND country = ANY($1)`;
      params.push(req.allowedCountries);
    }

    sql += ' ORDER BY country, rate_type';

    const result = await query(sql, params);
    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo tasas activas:', error);
    return errorResponse(res, 'Error obteniendo tasas activas', 500);
  }
});

// GET /api/interest-rates/:id - Obtener una tasa por ID
router.get('/:id', validateUUID, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      'SELECT * FROM module_rapidin_interest_rates WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Tasa de interés no encontrada', 404);
    }

    // Verificar permisos de país
    const rate = result.rows[0];
    if (!req.allowedCountries?.includes(rate.country)) {
      return errorResponse(res, 'Sin permisos para acceder a esta tasa', 403);
    }

    return successResponse(res, rate);
  } catch (error) {
    logger.error('Error obteniendo tasa de interés:', error);
    return errorResponse(res, 'Error obteniendo tasa de interés', 500);
  }
});

// PUT /api/interest-rates/:id - Actualizar una tasa de interés
router.put('/:id', validateUUID, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      rate_value,
      effective_date,
      active
    } = req.body;

    // Verificar que la tasa existe y tiene permisos
    const existingRate = await query(
      'SELECT * FROM module_rapidin_interest_rates WHERE id = $1',
      [id]
    );

    if (existingRate.rows.length === 0) {
      return errorResponse(res, 'Tasa de interés no encontrada', 404);
    }

    const rate = existingRate.rows[0];
    if (!req.allowedCountries?.includes(rate.country)) {
      return errorResponse(res, 'Sin permisos para actualizar esta tasa', 403);
    }

    // Construir query de actualización dinámicamente
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (rate_value !== undefined) {
      if (isNaN(parseFloat(rate_value)) || parseFloat(rate_value) < 0) {
        return errorResponse(res, 'Valor de tasa inválido', 400);
      }
      updates.push(`rate_value = $${paramCount++}`);
      values.push(parseFloat(rate_value));
    }

    if (effective_date !== undefined) {
      updates.push(`effective_date = $${paramCount++}`);
      values.push(effective_date);
    }

    if (active !== undefined) {
      updates.push(`active = $${paramCount++}`);
      values.push(active);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No hay campos para actualizar', 400);
    }

    // Si se activa una tasa, desactivar las demás del mismo tipo y país
    if (active === true) {
      await query(
        `UPDATE module_rapidin_interest_rates 
         SET active = false 
         WHERE country = $1 AND rate_type = $2 AND id != $3`,
        [rate.country, rate.rate_type, id]
      );
    }

    values.push(id);
    const result = await query(
      `UPDATE module_rapidin_interest_rates 
       SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $${paramCount} 
       RETURNING *`,
      values
    );

    return successResponse(res, result.rows[0], 'Tasa de interés actualizada exitosamente');
  } catch (error) {
    logger.error('Error actualizando tasa de interés:', error);
    return errorResponse(res, 'Error actualizando tasa de interés', 500);
  }
});

// DELETE /api/interest-rates/:id - Eliminar una tasa de interés
router.delete('/:id', validateUUID, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que la tasa existe y tiene permisos
    const existingRate = await query(
      'SELECT * FROM module_rapidin_interest_rates WHERE id = $1',
      [id]
    );

    if (existingRate.rows.length === 0) {
      return errorResponse(res, 'Tasa de interés no encontrada', 404);
    }

    const rate = existingRate.rows[0];
    if (!req.allowedCountries?.includes(rate.country)) {
      return errorResponse(res, 'Sin permisos para eliminar esta tasa', 403);
    }

    // Eliminar la tasa
    await query(
      'DELETE FROM module_rapidin_interest_rates WHERE id = $1',
      [id]
    );

    return successResponse(res, null, 'Tasa de interés eliminada exitosamente');
  } catch (error) {
    logger.error('Error eliminando tasa de interés:', error);
    return errorResponse(res, 'Error eliminando tasa de interés', 500);
  }
});

export default router;
