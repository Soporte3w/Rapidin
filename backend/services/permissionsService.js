import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

export const getAllowedCountries = async (userId, role) => {
  if (role === 'admin') {
    return ['PE', 'CO'];
  }

  const userPermissions = await query(
    'SELECT country FROM module_rapidin_user_country_permissions WHERE user_id = $1',
    [userId]
  );

  if (userPermissions.rows.length > 0) {
    return userPermissions.rows.map(r => r.country);
  }

  const rolePermissions = await query(
    'SELECT country FROM module_rapidin_role_country_permissions WHERE role = $1',
    [role]
  );

  if (rolePermissions.rows.length > 0) {
    return rolePermissions.rows.map(r => r.country);
  }

  const user = await query(
    'SELECT country FROM module_rapidin_users WHERE id = $1',
    [userId]
  );

  return user.rows.length > 0 ? [user.rows[0].country] : [];
};

export const assignCountryPermission = async (userId, country) => {
  await query(
    'INSERT INTO module_rapidin_user_country_permissions (user_id, country) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [userId, country]
  );
};

export const removeCountryPermission = async (userId, country) => {
  await query(
    'DELETE FROM module_rapidin_user_country_permissions WHERE user_id = $1 AND country = $2',
    [userId, country]
  );
};







