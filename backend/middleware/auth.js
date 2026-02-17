import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

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
      'SELECT id, email, first_name, last_name, role, country, active FROM module_rapidin_users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].active) {
      return res.status(401).json({
        error: 'Usuario no válido o inactivo'
      });
    }

    req.user = result.rows[0];
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
      // Es un admin - buscar en module_rapidin_users
      const result = await query(
        'SELECT id, email, first_name, last_name, role, country, active FROM module_rapidin_users WHERE id = $1',
        [decoded.userId]
      );

      if (result.rows.length === 0 || !result.rows[0].active) {
        return res.status(401).json({
          error: 'Usuario no válido o inactivo'
        });
      }

      req.user = result.rows[0];
    } else {
      return res.status(401).json({
        error: 'Token inválido'
      });
    }

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

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'No tienes permisos para esta acción'
      });
    }

    next();
  };
};







