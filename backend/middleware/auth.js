import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';
import { RRHH_USERS_TABLE, SYSTEM_ROLES_TABLE, SYSTEM_USERS_TABLE } from '../config/systemUsers.js';
import { asyncLocalStorage, logger } from '../utils/logger.js';

function updateRequestUserContext(user) {
  const context = asyncLocalStorage.getStore();
  if (!context || !user) return;
  context.userId = user.id || null;
  context.userRole = user.role || null;
  context.actorType = 'user';
}

const ADMIN_USER_SELECT = `
  u.id,
  COALESCE(h.email, u.email) AS email,
  COALESCE(h.first_name, u.first_name) AS first_name,
  COALESCE(h.last_name, u.last_name) AS last_name,
  u.role,
  u.country,
  (u.active AND COALESCE(h.is_active, true)) AS active,
  COALESCE(u.custom_allowed_modules, r.allowed_modules, u.allowed_modules, '{rapidin}'::text[]) AS allowed_modules,
  COALESCE(r.base_role, u.role) AS base_role,
  r.name AS role_name,
  u.rrhh_user_id,
  COALESCE(h.is_active, true) AS employment_active,
  CASE
    WHEN u.role = 'admin' OR COALESCE(r.base_role, u.role) = 'admin'
      THEN ARRAY['PE', 'CO']::text[]
    ELSE COALESCE(
      NULLIF(ARRAY(
        SELECT up.country::text
        FROM module_rapidin_user_country_permissions up
        WHERE up.user_id = u.id
        ORDER BY up.country
      ), ARRAY[]::text[]),
      NULLIF(ARRAY(
        SELECT rp.country::text
        FROM module_rapidin_role_country_permissions rp
        WHERE rp.role = u.role
        ORDER BY rp.country
      ), ARRAY[]::text[]),
      ARRAY[u.country::text]
    )
  END AS allowed_countries
`;

export const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        error: 'Token no proporcionado'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await query(
      `SELECT ${ADMIN_USER_SELECT}
       FROM ${SYSTEM_USERS_TABLE} u
       LEFT JOIN ${SYSTEM_ROLES_TABLE} r ON r.code = u.role
       LEFT JOIN ${RRHH_USERS_TABLE} h ON h.id = u.rrhh_user_id
       WHERE u.id = $1`,
      [decoded.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].active) {
      return res.status(401).json({
        error: 'Usuario no válido o inactivo'
      });
    }

    req.user = result.rows[0];
    req.user.allowed_modules = req.user.allowed_modules || decoded.allowedModules || ['rapidin'];
    updateRequestUserContext(req.user);
    next();
  } catch (error) {
    logger.error('Error verificando token:', error);

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Token inválido'
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expirado'
      });
    }

    return res.status(500).json({
      error: 'Error en autenticación'
    });
  }
};

// Middleware para autenticar conductores y admins.
// Seguridad ante manipulación de URL: el cliente puede cambiar la URL o IDs en la petición;
// el backend SIEMPRE valida el token y que el recurso pertenezca al usuario (ej. loanBelongsToDriverByPhoneCountry en rutas driver).
// Sin token válido → 401. Recurso ajeno → 403/404.
export const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        error: 'Token no proporcionado'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // El token puede contener userId (admin) o phone (conductor)
    if (decoded.phone && decoded.role === 'driver') {
      // Es un conductor - usar directamente los datos del token (guardados al hacer login)
      if (!decoded.country) {
        logger.warn('Token de conductor sin país, usando default PE');
      }
      req.user = {
        phone: decoded.phone,
        country: decoded.country || 'PE',
        role: 'driver'
      };
      logger.debug('Usuario conductor autenticado:', { phone: req.user.phone, country: req.user.country });
    } else if (decoded.userId) {
      // Es un admin - buscar en la tabla nueva de usuarios del sistema
      const result = await query(
        `SELECT ${ADMIN_USER_SELECT}
         FROM ${SYSTEM_USERS_TABLE} u
         LEFT JOIN ${SYSTEM_ROLES_TABLE} r ON r.code = u.role
         LEFT JOIN ${RRHH_USERS_TABLE} h ON h.id = u.rrhh_user_id
         WHERE u.id = $1`,
        [decoded.userId]
      );

      if (result.rows.length === 0 || !result.rows[0].active) {
        return res.status(401).json({
          error: 'Usuario no válido o inactivo'
        });
      }

      req.user = result.rows[0];
      req.user.allowed_modules = req.user.allowed_modules || decoded.allowedModules || ['rapidin'];
    } else {
      return res.status(401).json({
        error: 'Token inválido'
      });
    }

    updateRequestUserContext(req.user);
    next();
  } catch (error) {
    logger.error('Error verificando token:', error);

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Token inválido'
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expirado'
      });
    }

    return res.status(500).json({
      error: 'Error en autenticación'
    });
  }
};

export const verifyRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Usuario no autenticado'
      });
    }

    if (!roles.includes(req.user.role) && !roles.includes(req.user.base_role)) {
      return res.status(403).json({
        error: 'No tienes permisos para esta acción'
      });
    }

    next();
  };
};

