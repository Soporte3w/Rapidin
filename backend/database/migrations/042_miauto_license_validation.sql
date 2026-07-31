-- Persistencia de la validación de licencia peruana consultada en Factiliza.
-- Los registros históricos de Perú quedan pendientes para el backfill reanudable.

ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS license_category VARCHAR(40),
  ADD COLUMN IF NOT EXISTS license_factiliza_status VARCHAR(40),
  ADD COLUMN IF NOT EXISTS license_issued_date DATE,
  ADD COLUMN IF NOT EXISTS license_expiration_date DATE,
  ADD COLUMN IF NOT EXISTS license_restrictions TEXT,
  ADD COLUMN IF NOT EXISTS license_validation_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS license_validation_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS license_validation_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS license_validation_error VARCHAR(500);

UPDATE module_miauto_solicitud
SET license_validation_status = 'not_applicable',
    license_validation_checked_at = CURRENT_TIMESTAMP
WHERE UPPER(TRIM(COALESCE(country, ''))) <> 'PE'
  AND license_validation_status = 'pending';

UPDATE module_miauto_solicitud
SET license_validation_status = 'error',
    license_validation_checked_at = CURRENT_TIMESTAMP,
    license_validation_error = 'DNI inválido para consultar licencia en Perú'
WHERE UPPER(TRIM(COALESCE(country, ''))) = 'PE'
  AND COALESCE(dni, '') !~ '^\d{8}$'
  AND license_validation_status = 'pending';

ALTER TABLE module_miauto_solicitud
  DROP CONSTRAINT IF EXISTS module_miauto_solicitud_license_validation_status_check;

ALTER TABLE module_miauto_solicitud
  ADD CONSTRAINT module_miauto_solicitud_license_validation_status_check
  CHECK (license_validation_status IN ('pending', 'valid', 'invalid', 'error', 'not_applicable'));

ALTER TABLE module_miauto_solicitud
  DROP CONSTRAINT IF EXISTS module_miauto_solicitud_license_validation_attempts_check;

ALTER TABLE module_miauto_solicitud
  ADD CONSTRAINT module_miauto_solicitud_license_validation_attempts_check
  CHECK (license_validation_attempts >= 0);
