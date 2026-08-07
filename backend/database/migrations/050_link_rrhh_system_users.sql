-- Vincula el acceso del financiador con el directorio corporativo de RR. HH.
-- La identidad interna continúa siendo UUID para conservar todas las FK existentes.

ALTER TABLE systems_users_financiator
ADD COLUMN IF NOT EXISTS rrhh_user_id TEXT;

ALTER TABLE systems_users_financiator
ADD COLUMN IF NOT EXISTS custom_allowed_modules TEXT[];

CREATE UNIQUE INDEX IF NOT EXISTS ux_systems_users_financiator_rrhh_user_id
ON systems_users_financiator(rrhh_user_id)
WHERE rrhh_user_id IS NOT NULL;

-- Solo enlaza coincidencias inequívocas. Las cuentas locales sin contraparte se conservan.
UPDATE systems_users_financiator AS system_user
SET rrhh_user_id = rrhh_user.id,
    updated_at = CURRENT_TIMESTAMP
FROM module_rrhh_users AS rrhh_user
WHERE system_user.rrhh_user_id IS NULL
  AND LOWER(system_user.email) = LOWER(rrhh_user.email)
  AND NOT EXISTS (
    SELECT 1
    FROM systems_users_financiator AS linked_user
    WHERE linked_user.rrhh_user_id = rrhh_user.id
      AND linked_user.id <> system_user.id
  );

COMMENT ON COLUMN systems_users_financiator.rrhh_user_id IS
'Identificador del usuario en module_rrhh_users; se mantiene separado del UUID interno usado por las FK del financiador.';

COMMENT ON COLUMN systems_users_financiator.custom_allowed_modules IS
'Permisos particulares del usuario. NULL hereda los permisos del rol asignado.';
