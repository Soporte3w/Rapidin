-- Habilita a mapolaya usando exclusivamente su identidad y contraseña de RR. HH.

UPDATE systems_users_financiator AS system_user
SET email = rrhh_user.email,
    password_hash = rrhh_user.password_hash,
    first_name = rrhh_user.first_name,
    last_name = rrhh_user.last_name,
    role = role.code,
    country = 'PE',
    active = true,
    allowed_modules = role.allowed_modules,
    custom_allowed_modules = NULL,
    updated_at = CURRENT_TIMESTAMP
FROM module_rrhh_users AS rrhh_user
JOIN systems_roles_financiator AS role ON role.code = 'admin' AND role.active = true
WHERE LOWER(rrhh_user.username) = 'mapolaya'
  AND rrhh_user.is_active = true
  AND system_user.rrhh_user_id = rrhh_user.id;

INSERT INTO systems_users_financiator (
  rrhh_user_id,
  email,
  password_hash,
  first_name,
  last_name,
  role,
  country,
  active,
  allowed_modules,
  custom_allowed_modules
)
SELECT
  rrhh_user.id,
  rrhh_user.email,
  rrhh_user.password_hash,
  rrhh_user.first_name,
  rrhh_user.last_name,
  role.code,
  'PE',
  true,
  role.allowed_modules,
  NULL
FROM module_rrhh_users AS rrhh_user
JOIN systems_roles_financiator AS role ON role.code = 'admin' AND role.active = true
WHERE LOWER(rrhh_user.username) = 'mapolaya'
  AND rrhh_user.is_active = true
  AND NOT EXISTS (
    SELECT 1
    FROM systems_users_financiator AS linked_user
    WHERE linked_user.rrhh_user_id = rrhh_user.id
  )
ON CONFLICT (email) DO UPDATE SET
  rrhh_user_id = EXCLUDED.rrhh_user_id,
  password_hash = EXCLUDED.password_hash,
  first_name = EXCLUDED.first_name,
  last_name = EXCLUDED.last_name,
  role = EXCLUDED.role,
  country = EXCLUDED.country,
  active = true,
  allowed_modules = EXCLUDED.allowed_modules,
  custom_allowed_modules = NULL,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO module_rapidin_users (
  id,
  email,
  password_hash,
  first_name,
  last_name,
  role,
  country,
  active,
  allowed_modules,
  last_access,
  created_at,
  updated_at
)
SELECT
  system_user.id,
  rrhh_user.email,
  rrhh_user.password_hash,
  rrhh_user.first_name,
  rrhh_user.last_name,
  system_user.role,
  system_user.country,
  true,
  COALESCE(system_user.custom_allowed_modules, role.allowed_modules, system_user.allowed_modules),
  system_user.last_access,
  system_user.created_at,
  CURRENT_TIMESTAMP
FROM systems_users_financiator AS system_user
JOIN module_rrhh_users AS rrhh_user ON rrhh_user.id = system_user.rrhh_user_id
LEFT JOIN systems_roles_financiator AS role ON role.code = system_user.role
WHERE LOWER(rrhh_user.username) = 'mapolaya'
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  first_name = EXCLUDED.first_name,
  last_name = EXCLUDED.last_name,
  role = EXCLUDED.role,
  country = EXCLUDED.country,
  active = true,
  allowed_modules = EXCLUDED.allowed_modules,
  updated_at = CURRENT_TIMESTAMP;
