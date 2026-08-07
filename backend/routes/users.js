import express from 'express';
import { query, withTransaction } from '../config/database.js';
import {
  LEGACY_USERS_TABLE,
  RRHH_USERS_TABLE,
  SYSTEM_ROLES_TABLE,
  SYSTEM_USERS_TABLE,
} from '../config/systemUsers.js';
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

function normalizeCustomAllowedModules(allowedModules) {
  if (allowedModules == null) return null;
  if (!Array.isArray(allowedModules)) return null;
  return [...new Set(allowedModules.map((value) => String(value || '').trim()).filter(Boolean))];
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
      `SELECT
           h.id AS id,
           h.id AS directory_user_id,
           u.id AS system_user_id,
           'rrhh'::text AS source,
           h.email,
           h.first_name,
           h.last_name,
           h.role AS rrhh_role,
           h.is_active AS employment_active,
           u.role,
           COALESCE(u.country, 'PE') AS country,
           (u.id IS NOT NULL AND u.active AND h.is_active) AS active,
           COALESCE(u.custom_allowed_modules, r.allowed_modules, u.allowed_modules, ARRAY[]::text[]) AS allowed_modules,
           u.custom_allowed_modules,
           (u.custom_allowed_modules IS NULL) AS inherits_role_permissions,
           u.last_access,
           h.created_at
       FROM ${RRHH_USERS_TABLE} h
       LEFT JOIN ${SYSTEM_USERS_TABLE} u ON u.rrhh_user_id = h.id
       LEFT JOIN ${SYSTEM_ROLES_TABLE} r ON r.code = u.role
       ORDER BY h.is_active DESC, active DESC, h.last_name ASC, h.first_name ASC, h.email ASC`
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
         COUNT(u.id) FILTER (WHERE u.rrhh_user_id IS NOT NULL)::int AS assigned_users
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

router.put('/directory/:id/access', async (req, res) => {
  try {
    const directoryUserId = String(req.params.id || '').trim();
    const { role, country, active, custom_allowed_modules } = req.body;

    if (!directoryUserId) {
      return errorResponse(res, 'Usuario de RR. HH. inválido', 400);
    }
    if (country != null && !['PE', 'CO'].includes(country)) {
      return errorResponse(res, 'País inválido', 400);
    }
    if (active != null && typeof active !== 'boolean') {
      return errorResponse(res, 'Estado de acceso inválido', 400);
    }
    if (custom_allowed_modules !== undefined && custom_allowed_modules !== null && !Array.isArray(custom_allowed_modules)) {
      return errorResponse(res, 'Permisos personalizados inválidos', 400);
    }

    const updatedUser = await withTransaction(async () => {
      const directoryResult = await query(
        `SELECT id, email, password_hash, first_name, last_name, role, is_active
         FROM ${RRHH_USERS_TABLE}
         WHERE id = $1
         FOR UPDATE`,
        [directoryUserId]
      );
      const directoryUser = directoryResult.rows[0];
      if (!directoryUser) {
        const error = new Error('Usuario de RR. HH. no encontrado');
        error.statusCode = 404;
        throw error;
      }

      const existingResult = await query(
        `SELECT id, rrhh_user_id, role, country, active, custom_allowed_modules
         FROM ${SYSTEM_USERS_TABLE}
         WHERE rrhh_user_id = $1 OR LOWER(email) = LOWER($2)
         ORDER BY (rrhh_user_id = $1) DESC
         LIMIT 1
         FOR UPDATE`,
        [directoryUser.id, directoryUser.email]
      );
      const existing = existingResult.rows[0] || null;
      const resolvedActive = active ?? existing?.active ?? false;

      if (existing?.rrhh_user_id && existing.rrhh_user_id !== directoryUser.id) {
        const error = new Error('El email ya está vinculado a otro usuario de RR. HH.');
        error.statusCode = 409;
        throw error;
      }

      if (resolvedActive && !directoryUser.is_active) {
        const error = new Error('No se puede habilitar a un usuario inactivo en RR. HH.');
        error.statusCode = 409;
        throw error;
      }
      if (existing?.id === req.user.id && active === false) {
        const error = new Error('No puedes desactivar tu propio acceso');
        error.statusCode = 409;
        throw error;
      }
      if (existing?.id === req.user.id && role && role !== existing.role) {
        const error = new Error('No puedes cambiar tu propio rol');
        error.statusCode = 409;
        throw error;
      }
      if (!existing && !resolvedActive) return null;

      const resolvedRoleCode = role || existing?.role;
      const roleRecord = await getActiveRole(resolvedRoleCode);
      if (!roleRecord) {
        const error = new Error('Selecciona un rol activo para habilitar el acceso');
        error.statusCode = 400;
        throw error;
      }

      const hasCustomPermissions = Object.prototype.hasOwnProperty.call(req.body, 'custom_allowed_modules');
      const customModules = hasCustomPermissions
        ? normalizeCustomAllowedModules(custom_allowed_modules)
        : existing?.custom_allowed_modules ?? null;
      const effectiveModules = customModules ?? normalizeAllowedModules(roleRecord.allowed_modules);
      const resolvedCountry = country || existing?.country || 'PE';

      let result;
      if (existing) {
        result = await query(
          `UPDATE ${SYSTEM_USERS_TABLE}
           SET rrhh_user_id = $1,
               email = $2,
               password_hash = $3,
               first_name = $4,
               last_name = $5,
               role = $6,
               country = $7,
               active = $8,
               allowed_modules = $9,
               custom_allowed_modules = $10,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $11
           RETURNING id, email, password_hash, first_name, last_name, role, country, active,
                     allowed_modules, custom_allowed_modules, rrhh_user_id, last_access, created_at`,
          [
            directoryUser.id,
            directoryUser.email,
            directoryUser.password_hash,
            directoryUser.first_name,
            directoryUser.last_name,
            roleRecord.code,
            resolvedCountry,
            resolvedActive,
            effectiveModules,
            customModules,
            existing.id,
          ]
        );
      } else {
        result = await query(
          `INSERT INTO ${SYSTEM_USERS_TABLE}
             (rrhh_user_id, email, password_hash, first_name, last_name, role, country, active,
              allowed_modules, custom_allowed_modules)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, email, password_hash, first_name, last_name, role, country, active,
                     allowed_modules, custom_allowed_modules, rrhh_user_id, last_access, created_at`,
          [
            directoryUser.id,
            directoryUser.email,
            directoryUser.password_hash,
            directoryUser.first_name,
            directoryUser.last_name,
            roleRecord.code,
            resolvedCountry,
            resolvedActive,
            effectiveModules,
            customModules,
          ]
        );
      }

      await syncLegacyUser(result.rows[0]);
      return result.rows[0];
    });

    if (!updatedUser) {
      return successResponse(res, null, 'El usuario ya estaba sin acceso');
    }
    const { password_hash, ...publicUser } = updatedUser;
    return successResponse(
      res,
      publicUser,
      publicUser.active ? 'Acceso actualizado correctamente' : 'Acceso desactivado correctamente'
    );
  } catch (error) {
    logger.error('Error actualizando acceso desde RR. HH.:', error);
    if (error.code === '23505') {
      return errorResponse(res, 'El email ya está vinculado a otra cuenta del sistema', 409);
    }
    return errorResponse(res, error.message || 'Error actualizando el acceso', error.statusCode || 500);
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
      `SELECT COUNT(*)::int AS total
       FROM ${SYSTEM_USERS_TABLE}
       WHERE role = $1 AND rrhh_user_id IS NOT NULL`,
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

export default router;
