import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../config/database.js';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(verifyRole('admin'));

router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, email, first_name, last_name, role, country, active, last_access, created_at FROM module_rapidin_users ORDER BY created_at DESC'
    );
    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo usuarios:', error);
    return errorResponse(res, 'Error obteniendo usuarios', 500);
  }
});

router.post('/', async (req, res) => {
  try {
    const { email, password, first_name, last_name, role, country } = req.body;

    if (!email || !password || !first_name || !last_name || !role || !country) {
      return errorResponse(res, 'Todos los campos son requeridos', 400);
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await query(
      `INSERT INTO module_rapidin_users (email, password_hash, first_name, last_name, role, country)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, first_name, last_name, role, country, active`,
      [email, passwordHash, first_name, last_name, role, country]
    );

    return successResponse(res, result.rows[0], 'Usuario creado exitosamente', 201);
  } catch (error) {
    logger.error('Error creando usuario:', error);
    if (error.code === '23505') {
      return errorResponse(res, 'El email ya está en uso', 409);
    }
    return errorResponse(res, 'Error creando usuario', 500);
  }
});

router.put('/:id', validateUUID, async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, role, country, active } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (first_name) {
      updates.push(`first_name = $${paramCount++}`);
      values.push(first_name);
    }
    if (last_name) {
      updates.push(`last_name = $${paramCount++}`);
      values.push(last_name);
    }
    if (role) {
      updates.push(`role = $${paramCount++}`);
      values.push(role);
    }
    if (country) {
      updates.push(`country = $${paramCount++}`);
      values.push(country);
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
      `UPDATE module_rapidin_users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING id, email, first_name, last_name, role, country, active`,
      values
    );

    return successResponse(res, result.rows[0], 'Usuario actualizado exitosamente');
  } catch (error) {
    logger.error('Error actualizando usuario:', error);
    return errorResponse(res, 'Error actualizando usuario', 500);
  }
});

router.delete('/:id', validateUUID, async (req, res) => {
  try {
    await query('UPDATE module_rapidin_users SET active = false WHERE id = $1', [req.params.id]);
    return successResponse(res, null, 'Usuario desactivado exitosamente');
  } catch (error) {
    logger.error('Error desactivando usuario:', error);
    return errorResponse(res, 'Error desactivando usuario', 500);
  }
});

export default router;







