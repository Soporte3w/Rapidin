import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

export const filterByCountry = async (req, res, next) => {
  try {
    if (!req.user) {
      return next();
    }

    if (req.user.role === 'admin') {
      req.allowedCountries = ['PE', 'CO'];
      return next();
    }

    const userPermissions = await query(
      `SELECT country FROM module_rapidin_user_country_permissions 
       WHERE user_id = $1`,
      [req.user.id]
    );

    const rolePermissions = await query(
      `SELECT country FROM module_rapidin_role_country_permissions 
       WHERE role = $1`,
      [req.user.role]
    );

    const userCountries = userPermissions.rows.map(r => r.country);
    const roleCountries = rolePermissions.rows.map(r => r.country);

    if (userCountries.length > 0) {
      req.allowedCountries = userCountries;
    } else if (roleCountries.length > 0) {
      req.allowedCountries = roleCountries;
    } else {
      req.allowedCountries = [req.user.country];
    }

    next();
  } catch (error) {
    logger.error('Error filtrando por país:', error);
    next();
  }
};

export const verifyCountry = (req, res, next) => {
  const country = req.body.country || req.params.country || req.query.country;

  if (!country) {
    return next();
  }

  if (!req.allowedCountries || req.allowedCountries.includes(country)) {
    return next();
  }

  return res.status(403).json({
    error: 'No tienes permisos para este país'
  });
};







