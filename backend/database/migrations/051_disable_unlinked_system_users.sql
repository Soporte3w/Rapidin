-- El directorio de RR. HH. es la única fuente válida de identidad del financiador.
-- Las cuentas históricas se conservan para auditoría, pero pierden acceso.

UPDATE systems_users_financiator
SET active = false,
    updated_at = CURRENT_TIMESTAMP
WHERE rrhh_user_id IS NULL
  AND active IS DISTINCT FROM false;

UPDATE module_rapidin_users AS legacy_user
SET active = false,
    updated_at = CURRENT_TIMESTAMP
FROM systems_users_financiator AS system_user
WHERE legacy_user.id = system_user.id
  AND system_user.rrhh_user_id IS NULL
  AND legacy_user.active IS DISTINCT FROM false;
