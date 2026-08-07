export const SYSTEM_USERS_TABLE = 'systems_users_financiator';
export const SYSTEM_ROLES_TABLE = 'systems_roles_financiator';
export const LEGACY_USERS_TABLE = 'module_rapidin_users';
export const RRHH_USERS_TABLE = 'module_rrhh_users';

export const SYSTEM_USER_SELECT =
  'id, email, password_hash, first_name, last_name, role, country, active, allowed_modules, rrhh_user_id, custom_allowed_modules';

export const SYSTEM_USER_PUBLIC_SELECT =
  'id, email, first_name, last_name, role, country, active, allowed_modules, rrhh_user_id, custom_allowed_modules';
