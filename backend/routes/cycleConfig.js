import express from 'express';
import { query } from '../config/database.js';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);
router.use(verifyRole('admin'));

router.get('/', async (req, res) => {
  try {
    const { country } = req.query;
    let sql = `SELECT 
      c.*,
      r.rate_type as reference_rate_type,
      r.rate_value as reference_rate_value
      FROM module_rapidin_cycle_config c
      LEFT JOIN module_rapidin_interest_rates r ON r.id = c.reference_rate_id
      WHERE 1=1`;
    const params = [];

    if (country && req.allowedCountries?.includes(country)) {
      sql += ' AND c.country = $1';
      params.push(country);
    } else if (req.allowedCountries && req.allowedCountries.length > 0) {
      sql += ` AND c.country = ANY($1)`;
      params.push(req.allowedCountries);
    }

    sql += ' ORDER BY c.country, c.cycle';

    const result = await query(sql, params);
    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo configuración de ciclos:', error);
    return errorResponse(res, 'Error obteniendo configuración de ciclos', 500);
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      country,
      cycle,
      max_credit_line,
      interest_rate,
      interest_rate_type,
      reference_rate_id,
      requires_guarantor,
      min_guarantor_amount
    } = req.body;

    if (!country || !req.allowedCountries?.includes(country)) {
      return errorResponse(res, 'País inválido o sin permisos', 400);
    }

    // Validar que si se proporciona reference_rate_id, sea válido
    if (reference_rate_id) {
      const rateCheck = await query(
        'SELECT id, country, rate_type FROM module_rapidin_interest_rates WHERE id = $1 AND active = true',
        [reference_rate_id]
      );
      if (rateCheck.rows.length === 0) {
        return errorResponse(res, 'La tasa de interés de referencia no existe o no está activa', 400);
      }
      if (rateCheck.rows[0].country !== country) {
        return errorResponse(res, 'La tasa de interés de referencia no corresponde al país seleccionado', 400);
      }
      // Si se proporciona reference_rate_id, usar el tipo de esa tasa
      if (!interest_rate_type) {
        const rateType = rateCheck.rows[0].rate_type;
        const result = await query(
          `INSERT INTO module_rapidin_cycle_config 
           (country, cycle, max_credit_line, interest_rate, interest_rate_type, reference_rate_id, requires_guarantor, min_guarantor_amount, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
           ON CONFLICT (country, cycle) 
           DO UPDATE SET 
             max_credit_line = EXCLUDED.max_credit_line,
             interest_rate = EXCLUDED.interest_rate,
             interest_rate_type = EXCLUDED.interest_rate_type,
             reference_rate_id = EXCLUDED.reference_rate_id,
             requires_guarantor = EXCLUDED.requires_guarantor,
             min_guarantor_amount = EXCLUDED.min_guarantor_amount,
             active = true,
             updated_at = CURRENT_TIMESTAMP
           RETURNING *`,
          [country, cycle, max_credit_line, interest_rate, rateType, reference_rate_id, requires_guarantor, min_guarantor_amount]
        );
        return successResponse(res, result.rows[0], 'Configuración de ciclo creada/actualizada exitosamente', 201);
      }
    }

    const result = await query(
      `INSERT INTO module_rapidin_cycle_config 
       (country, cycle, max_credit_line, interest_rate, interest_rate_type, reference_rate_id, requires_guarantor, min_guarantor_amount, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       ON CONFLICT (country, cycle) 
       DO UPDATE SET 
         max_credit_line = EXCLUDED.max_credit_line,
         interest_rate = EXCLUDED.interest_rate,
         interest_rate_type = EXCLUDED.interest_rate_type,
         reference_rate_id = EXCLUDED.reference_rate_id,
         requires_guarantor = EXCLUDED.requires_guarantor,
         min_guarantor_amount = EXCLUDED.min_guarantor_amount,
         active = true,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [country, cycle, max_credit_line, interest_rate, interest_rate_type || null, reference_rate_id || null, requires_guarantor, min_guarantor_amount]
    );

    return successResponse(res, result.rows[0], 'Configuración de ciclo creada/actualizada exitosamente', 201);
  } catch (error) {
    logger.error('Error creando configuración de ciclo:', error);
    return errorResponse(res, 'Error creando configuración de ciclo', 500);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { max_credit_line, interest_rate, interest_rate_type, reference_rate_id, requires_guarantor, min_guarantor_amount, active } = req.body;

    // Verificar que la configuración existe y tiene permisos
    const existingConfig = await query(
      'SELECT * FROM module_rapidin_cycle_config WHERE id = $1',
      [id]
    );

    if (existingConfig.rows.length === 0) {
      return errorResponse(res, 'Configuración de ciclo no encontrada', 404);
    }

    const config = existingConfig.rows[0];
    if (!req.allowedCountries?.includes(config.country)) {
      return errorResponse(res, 'Sin permisos para actualizar esta configuración', 403);
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (max_credit_line !== undefined) {
      updates.push(`max_credit_line = $${paramCount++}`);
      values.push(max_credit_line);
    }
    if (interest_rate !== undefined) {
      updates.push(`interest_rate = $${paramCount++}`);
      values.push(interest_rate);
    }
    if (interest_rate_type !== undefined) {
      updates.push(`interest_rate_type = $${paramCount++}`);
      values.push(interest_rate_type);
    }
    if (reference_rate_id !== undefined) {
      // Validar que la tasa de referencia sea válida
      if (reference_rate_id) {
        const rateCheck = await query(
          'SELECT id, country, rate_type FROM module_rapidin_interest_rates WHERE id = $1 AND active = true',
          [reference_rate_id]
        );
        if (rateCheck.rows.length === 0) {
          return errorResponse(res, 'La tasa de interés de referencia no existe o no está activa', 400);
        }
        if (rateCheck.rows[0].country !== config.country) {
          return errorResponse(res, 'La tasa de interés de referencia no corresponde al país de la configuración', 400);
        }
      }
      updates.push(`reference_rate_id = $${paramCount++}`);
      values.push(reference_rate_id);
    }
    if (requires_guarantor !== undefined) {
      updates.push(`requires_guarantor = $${paramCount++}`);
      values.push(requires_guarantor);
    }
    if (min_guarantor_amount !== undefined) {
      updates.push(`min_guarantor_amount = $${paramCount++}`);
      values.push(min_guarantor_amount);
    }
    if (active !== undefined) {
      updates.push(`active = $${paramCount++}`);
      values.push(active);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No hay campos para actualizar', 400);
    }

    values.push(id);
    const result = await query(
      `UPDATE module_rapidin_cycle_config SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramCount} RETURNING *`,
      values
    );

    return successResponse(res, result.rows[0], 'Configuración actualizada exitosamente');
  } catch (error) {
    logger.error('Error actualizando configuración:', error);
    return errorResponse(res, 'Error actualizando configuración', 500);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que la configuración existe y tiene permisos
    const existingConfig = await query(
      'SELECT * FROM module_rapidin_cycle_config WHERE id = $1',
      [id]
    );

    if (existingConfig.rows.length === 0) {
      return errorResponse(res, 'Configuración de ciclo no encontrada', 404);
    }

    const config = existingConfig.rows[0];
    if (!req.allowedCountries?.includes(config.country)) {
      return errorResponse(res, 'Sin permisos para eliminar esta configuración', 403);
    }

    // Eliminar la configuración
    await query(
      'DELETE FROM module_rapidin_cycle_config WHERE id = $1',
      [id]
    );

    return successResponse(res, null, 'Configuración de ciclo eliminada exitosamente');
  } catch (error) {
    logger.error('Error eliminando configuración:', error);
    return errorResponse(res, 'Error eliminando configuración', 500);
  }
});

export default router;







