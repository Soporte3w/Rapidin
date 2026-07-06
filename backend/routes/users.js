import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../config/database.js';
import { LEGACY_USERS_TABLE, SYSTEM_ROLES_TABLE, SYSTEM_USERS_TABLE } from '../config/systemUsers.js';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();
const DEFAULT_ALLOWED_MODULES = [
  'rapidin',
  'rapidin.dashboard',
  'rapidin.solicitudes',
  'rapidin.nueva_solicitud',
  'rapidin.prestamos',
  'rapidin.pagos',
  'rapidin.cobros_masivos',
  'rapidin.analisis',
  'rapidin.provisiones',
  'rapidin.configuracion',
  'rapidin.usuarios',
];
const SYSTEM_ROLES = new Set(['admin', 'analyst', 'approver', 'payer']);

router.use(verifyToken);
router.use(verifyRole('admin'));

function normalizeAllowedModules(allowedModules) {
  if (!Array.isArray(allowedModules)) return DEFAULT_ALLOWED_MODULES;
  const modules = [...new Set(allowedModules.map((value) => String(value || '').trim()).filter(Boolean))];
  return modules.length > 0 ? modules : DEFAULT_ALLOWED_MODULES;
}

function normalizeRoleCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_.-]/g, '');
}

async function getActiveRole(role) {
  const code = normalizeRoleCode(role);
  if (!code) return null;
  const result = await query(
    `SELECT id, code, name, description, base_role, allowed_modules, active, system_default, created_at, updated_at
     FROM ${SYSTEM_ROLES_TABLE}
     WHERE code = $1 AND active = true`,
    [code]
  );
  return result.rows[0] || null;
}

function isValidBaseRole(role) {
  return SYSTEM_ROLES.has(String(role || '').trim());
}

function inferBaseRoleFromPermissions(permissions) {
  const modules = normalizeAllowedModules(permissions);
  if (modules.some((permission) => permission.endsWith('.usuarios') || permission.endsWith('.configuracion'))) return 'admin';
  if (modules.some((permission) => permission.includes('.pagos') || permission.includes('.cobros'))) return 'payer';
  if (modules.some((permission) => permission.includes('.solicitudes') || permission.includes('.prestamos') || permission.includes('.alquiler_venta'))) return 'approver';
  return 'analyst';
}

async function syncLegacyUser(user) {
  await query(
    `INSERT INTO ${LEGACY_USERS_TABLE}
       (id, email, password_hash, first_name, last_name, role, country, active, allowed_modules, last_access, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::boolean, true), COALESCE($9::text[], '{rapidin}'::text[]), $10, COALESCE($11::timestamp, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       password_hash = EXCLUDED.password_hash,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       role = EXCLUDED.role,
       country = EXCLUDED.country,
       active = EXCLUDED.active,
       allowed_modules = EXCLUDED.allowed_modules,
       last_access = EXCLUDED.last_access,
       updated_at = CURRENT_TIMESTAMP`,
    [
      user.id,
      user.email,
      user.password_hash,
      user.first_name,
      user.last_name,
      user.role,
      user.country,
      user.active,
      user.allowed_modules,
      user.last_access || null,
      user.created_at || null,
    ]
  );
}

router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, email, first_name, last_name, role, country, active, allowed_modules, last_access, created_at FROM ${SYSTEM_USERS_TABLE} ORDER BY created_at DESC`
    );
    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo usuarios:', error);
    return errorResponse(res, 'Error obteniendo usuarios', 500);
  }
});

router.get('/roles', async (req, res) => {
  try {
    const result = await query(
      `SELECT
         r.id,
         r.code,
         r.name,
         r.description,
         r.base_role,
         r.allowed_modules,
         r.active,
         r.system_default,
         r.created_at,
         r.updated_at,
         COUNT(u.id)::int AS assigned_users
       FROM ${SYSTEM_ROLES_TABLE} r
       LEFT JOIN ${SYSTEM_USERS_TABLE} u ON u.role = r.code
       GROUP BY r.id
       ORDER BY r.system_default DESC, r.name ASC`
    );
    return successResponse(res, result.rows);
  } catch (error) {
    logger.error('Error obteniendo roles:', error);
    return errorResponse(res, 'Error obteniendo roles', 500);
  }
});

router.post('/roles', async (req, res) => {
  try {
    const { code, name, description, base_role, allowed_modules, active = true } = req.body;
    const roleCode = normalizeRoleCode(code || name);
    const modules = normalizeAllowedModules(allowed_modules);
    const resolvedBaseRole = base_role || inferBaseRoleFromPermissions(modules);

    if (!roleCode || !name) {
      return errorResponse(res, 'Nombre del rol es requerido', 400);
    }
    if (!/^[a-z0-9][a-z0-9_.-]{1,48}$/.test(roleCode)) {
      return errorResponse(res, 'Código de rol inválido', 400);
    }
    if (!isValidBaseRole(resolvedBaseRole)) {
      return errorResponse(res, 'Rol base inválido', 400);
    }

    const result = await query(
      `INSERT INTO ${SYSTEM_ROLES_TABLE}
        (code, name, description, base_role, allowed_modules, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, code, name, description, base_role, allowed_modules, active, system_default, created_at, updated_at`,
      [roleCode, name, description || null, resolvedBaseRole, modules, active !== false]
    );

    return successResponse(res, result.rows[0], 'Rol creado correctamente', 201);
  } catch (error) {
    logger.error('Error creando rol:', error);
    if (error.code === '23505') {
      return errorResponse(res, 'Ya existe un rol con ese código', 409);
    }
    return errorResponse(res, 'Error creando rol', 500);
  }
});

router.put('/roles/:id', validateUUID, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, base_role, allowed_modules, active } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name != null && String(name).trim()) {
      updates.push(`name = $${paramCount++}`);
      values.push(String(name).trim());
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description || null);
    }
    if (base_role) {
      if (!isValidBaseRole(base_role)) {
        return errorResponse(res, 'Rol base inválido', 400);
      }
      updates.push(`base_role = $${paramCount++}`);
      values.push(base_role);
    }
    if (allowed_modules !== undefined) {
      updates.push(`allowed_modules = $${paramCount++}`);
      values.push(normalizeAllowedModules(allowed_modules));
    }
    if (active !== undefined) {
      const role = await query(`SELECT system_default FROM ${SYSTEM_ROLES_TABLE} WHERE id = $1`, [id]);
      if (role.rows[0]?.system_default && active === false) {
        return errorResponse(res, 'No se puede desactivar un rol base del sistema', 400);
      }
      updates.push(`active = $${paramCount++}`);
      values.push(active);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No hay campos para actualizar', 400);
    }

    values.push(id);
    const result = await query(
      `UPDATE ${SYSTEM_ROLES_TABLE}
       SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING id, code, name, description, base_role, allowed_modules, active, system_default, created_at, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Rol no encontrado', 404);
    }

    return successResponse(res, result.rows[0], 'Rol actualizado correctamente');
  } catch (error) {
    logger.error('Error actualizando rol:', error);
    return errorResponse(res, 'Error actualizando rol', 500);
  }
});

router.delete('/roles/:id', validateUUID, async (req, res) => {
  try {
    const { id } = req.params;
    const role = await query(
      `SELECT id, code, system_default FROM ${SYSTEM_ROLES_TABLE} WHERE id = $1`,
      [id]
    );

    if (role.rows.length === 0) {
      return errorResponse(res, 'Rol no encontrado', 404);
    }

    const assigned = await query(
      `SELECT COUNT(*)::int AS total FROM ${SYSTEM_USERS_TABLE} WHERE role = $1`,
      [role.rows[0].code]
    );
    if ((assigned.rows[0]?.total || 0) > 0) {
      return errorResponse(res, 'No se puede eliminar un rol asignado a usuarios', 409);
    }

    await query(`DELETE FROM ${SYSTEM_ROLES_TABLE} WHERE id = $1`, [id]);
    return successResponse(res, null, 'Rol eliminado correctamente');
  } catch (error) {
    logger.error('Error eliminando rol:', error);
    return errorResponse(res, 'Error eliminando rol', 500);
  }
});

router.post('/', async (req, res) => {
  try {
    const { email, password, first_name, last_name, role, country, allowed_modules } = req.body;

    if (!email || !password || !first_name || !last_name || !role || !country) {
      return errorResponse(res, 'Todos los campos son requeridos', 400);
    }
    const roleRecord = await getActiveRole(role);
    if (!roleRecord) {
      return errorResponse(res, 'Rol de usuario inválido', 400);
    }
    const modules = Array.isArray(allowed_modules) && allowed_modules.length > 0
      ? normalizeAllowedModules(allowed_modules)
      : normalizeAllowedModules(roleRecord.allowed_modules);

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await query(
      `INSERT INTO ${SYSTEM_USERS_TABLE} (email, password_hash, first_name, last_name, role, country, allowed_modules)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, password_hash, first_name, last_name, role, country, active, allowed_modules, last_access, created_at`,
      [email, passwordHash, first_name, last_name, roleRecord.code, country, modules]
    );

    await syncLegacyUser(result.rows[0]);
    const { password_hash, ...publicUser } = result.rows[0];
    return successResponse(res, publicUser, 'Usuario creado exitosamente', 201);
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
    const { first_name, last_name, role, country, active, password, allowed_modules } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (first_name != null && first_name !== '') {
      updates.push(`first_name = $${paramCount++}`);
      values.push(first_name);
    }
    if (last_name != null && last_name !== '') {
      updates.push(`last_name = $${paramCount++}`);
      values.push(last_name);
    }
    if (role) {
      const roleRecord = await getActiveRole(role);
      if (!roleRecord) {
        return errorResponse(res, 'Rol de usuario inválido', 400);
      }
      updates.push(`role = $${paramCount++}`);
      values.push(roleRecord.code);
    }
    if (country) {
      updates.push(`country = $${paramCount++}`);
      values.push(country);
    }
    if (active !== undefined) {
      updates.push(`active = $${paramCount++}`);
      values.push(active);
    }
    if (password && String(password).trim()) {
      const passwordHash = await bcrypt.hash(String(password).trim(), 10);
      updates.push(`password_hash = $${paramCount++}`);
      values.push(passwordHash);
    }

    if (allowed_modules !== undefined) {
      updates.push(`allowed_modules = $${paramCount++}`);
      values.push(normalizeAllowedModules(allowed_modules));
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No hay campos para actualizar', 400);
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    const result = await query(
      `UPDATE ${SYSTEM_USERS_TABLE} SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING id, email, password_hash, first_name, last_name, role, country, active, allowed_modules, last_access, created_at`,
      values
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Usuario no encontrado', 404);
    }

    await syncLegacyUser(result.rows[0]);
    const { password_hash, ...publicUser } = result.rows[0];
    return successResponse(res, publicUser, 'Usuario actualizado exitosamente');
  } catch (error) {
    logger.error('Error actualizando usuario:', error);
    return errorResponse(res, 'Error actualizando usuario', 500);
  }
});

router.delete('/:id', validateUUID, async (req, res) => {
  try {
    const result = await query(
      `UPDATE ${SYSTEM_USERS_TABLE} SET active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1
       RETURNING id, email, password_hash, first_name, last_name, role, country, active, allowed_modules, last_access, created_at`,
      [req.params.id]
    );
    if (result.rows[0]) await syncLegacyUser(result.rows[0]);
    return successResponse(res, null, 'Usuario desactivado exitosamente');
  } catch (error) {
    logger.error('Error desactivando usuario:', error);
    return errorResponse(res, 'Error desactivando usuario', 500);
  }
});

export default router;
