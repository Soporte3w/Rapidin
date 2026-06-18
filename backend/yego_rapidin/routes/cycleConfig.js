import express from 'express';
import { query } from '../../config/database.js';
import { verifyToken, verifyRole } from '../../middleware/auth.js';
import { filterByCountry } from '../../middleware/permissions.js';
import { successResponse, errorResponse } from '../../utils/responses.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);
router.use(verifyRole('admin'));

router.get('/', async (req, res) => {
  try {
    const { country } = req.query;
    let sql = 'SELECT * FROM module_rapidin_cycle_config WHERE 1=1';
    const params = [];

    if (country && req.allowedCountries?.includes(country)) {
      sql += ' AND country = $1';
      params.push(country);
    } else if (req.allowedCountries && req.allowedCountries.length > 0) {
      sql += ' AND country = ANY($1)';
      params.push(req.allowedCountries);
    }

    sql += ' ORDER BY country, cycle';

    const result = await query(sql, params);
    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo configuración de ciclos:', error);
    return errorResponse(res, 'Error obteniendo configuración de ciclos', 500);
  }
});

router.post('/', async (req, res) => {
  try {
    const { country, cycle, max_credit_line, interest_rate, requires_guarantor, min_guarantor_amount } = req.body;

    if (!country || !req.allowedCountries?.includes(country)) {
      return errorResponse(res, 'País inválido o sin permisos', 400);
    }

    const result = await query(
      `INSERT INTO module_rapidin_cycle_config 
       (country, cycle, max_credit_line, interest_rate, requires_guarantor, min_guarantor_amount, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (country, cycle) 
       DO UPDATE SET 
         max_credit_line = EXCLUDED.max_credit_line,
         interest_rate = EXCLUDED.interest_rate,
         requires_guarantor = EXCLUDED.requires_guarantor,
         min_guarantor_amount = EXCLUDED.min_guarantor_amount,
         active = true,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [country, cycle, max_credit_line, interest_rate, requires_guarantor ?? false, min_guarantor_amount || null]
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
    const { max_credit_line, interest_rate, requires_guarantor, min_guarantor_amount, active } = req.body;

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

// --- Mi Auto Cycle Config CRUD ---

router.get('/miauto', async (req, res) => {
  try {
    const { country } = req.query;
    let sql = 'SELECT * FROM module_rapidin_miauto_cycle_config WHERE 1=1';
    const params = [];

    if (country && req.allowedCountries?.includes(country)) {
      sql += ' AND country = $1';
      params.push(country);
    } else if (req.allowedCountries && req.allowedCountries.length > 0) {
      sql += ' AND country = ANY($1)';
      params.push(req.allowedCountries);
    }

    sql += ' ORDER BY country, cycle';
    const result = await query(sql, params);
    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo configuración Mi Auto:', error);
    return errorResponse(res, 'Error obteniendo configuración Mi Auto', 500);
  }
});

router.post('/miauto', async (req, res) => {
  try {
    const { country, cycle, max_credit_line, interest_rate, requires_guarantor, min_guarantor_amount } = req.body;

    if (!country || !req.allowedCountries?.includes(country)) {
      return errorResponse(res, 'País inválido o sin permisos', 400);
    }

    const result = await query(
      `INSERT INTO module_rapidin_miauto_cycle_config 
       (country, cycle, max_credit_line, interest_rate, requires_guarantor, min_guarantor_amount, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (country, cycle) 
       DO UPDATE SET 
         max_credit_line = EXCLUDED.max_credit_line,
         interest_rate = EXCLUDED.interest_rate,
         requires_guarantor = EXCLUDED.requires_guarantor,
         min_guarantor_amount = EXCLUDED.min_guarantor_amount,
         active = true,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [country, cycle, max_credit_line, interest_rate, requires_guarantor ?? false, min_guarantor_amount || null]
    );

    return successResponse(res, result.rows[0], 'Configuración Mi Auto creada/actualizada', 201);
  } catch (error) {
    logger.error('Error creando configuración Mi Auto:', error);
    return errorResponse(res, 'Error creando configuración Mi Auto', 500);
  }
});

router.put('/miauto/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { max_credit_line, interest_rate, requires_guarantor, min_guarantor_amount, active } = req.body;

    const existing = await query('SELECT * FROM module_rapidin_miauto_cycle_config WHERE id = $1', [id]);
    if (existing.rows.length === 0) return errorResponse(res, 'Configuración no encontrada', 404);
    if (!req.allowedCountries?.includes(existing.rows[0].country)) return errorResponse(res, 'Sin permisos', 403);

    const updates = [];
    const values = [];
    let p = 1;

    if (max_credit_line !== undefined) { updates.push(`max_credit_line = $${p++}`); values.push(max_credit_line); }
    if (interest_rate !== undefined) { updates.push(`interest_rate = $${p++}`); values.push(interest_rate); }
    if (requires_guarantor !== undefined) { updates.push(`requires_guarantor = $${p++}`); values.push(requires_guarantor); }
    if (min_guarantor_amount !== undefined) { updates.push(`min_guarantor_amount = $${p++}`); values.push(min_guarantor_amount); }
    if (active !== undefined) { updates.push(`active = $${p++}`); values.push(active); }

    if (updates.length === 0) return errorResponse(res, 'No hay campos para actualizar', 400);

    values.push(id);
    const result = await query(
      `UPDATE module_rapidin_miauto_cycle_config SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${p} RETURNING *`,
      values
    );
    return successResponse(res, result.rows[0], 'Configuración Mi Auto actualizada');
  } catch (error) {
    logger.error('Error actualizando configuración Mi Auto:', error);
    return errorResponse(res, 'Error actualizando configuración Mi Auto', 500);
  }
});

router.delete('/miauto/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query('SELECT * FROM module_rapidin_miauto_cycle_config WHERE id = $1', [id]);
    if (existing.rows.length === 0) return errorResponse(res, 'Configuración no encontrada', 404);
    if (!req.allowedCountries?.includes(existing.rows[0].country)) return errorResponse(res, 'Sin permisos', 403);

    await query('DELETE FROM module_rapidin_miauto_cycle_config WHERE id = $1', [id]);
    return successResponse(res, null, 'Configuración Mi Auto eliminada');
  } catch (error) {
    logger.error('Error eliminando configuración Mi Auto:', error);
    return errorResponse(res, 'Error eliminando configuración Mi Auto', 500);
  }
});

export default router;







