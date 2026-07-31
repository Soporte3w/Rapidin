-- Persistencia de SOAT consultado por placa en Factiliza.
-- Los registros históricos con placa quedan pendientes para un backfill reanudable.

ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS soat_fecha_inicio DATE,
  ADD COLUMN IF NOT EXISTS soat_compania VARCHAR(160),
  ADD COLUMN IF NOT EXISTS soat_estado VARCHAR(40),
  ADD COLUMN IF NOT EXISTS soat_numero_poliza VARCHAR(120),
  ADD COLUMN IF NOT EXISTS soat_codigo_sbs_aseguradora VARCHAR(80),
  ADD COLUMN IF NOT EXISTS soat_codigo_unico_poliza VARCHAR(120),
  ADD COLUMN IF NOT EXISTS soat_validation_status VARCHAR(20) NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS soat_validation_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS soat_validation_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS soat_validation_error VARCHAR(500);

UPDATE module_miauto_solicitud
SET soat_validation_status = 'pending',
    soat_validation_checked_at = NULL,
    soat_validation_error = NULL
WHERE NULLIF(TRIM(placa_asignada), '') IS NOT NULL
  AND soat_fecha_vencimiento IS NULL;

UPDATE module_miauto_solicitud
SET soat_validation_status = 'not_applicable',
    soat_validation_checked_at = CURRENT_TIMESTAMP
WHERE NULLIF(TRIM(placa_asignada), '') IS NULL;

ALTER TABLE module_miauto_solicitud
  DROP CONSTRAINT IF EXISTS module_miauto_solicitud_soat_validation_status_check;

ALTER TABLE module_miauto_solicitud
  ADD CONSTRAINT module_miauto_solicitud_soat_validation_status_check
  CHECK (soat_validation_status IN ('pending', 'valid', 'error', 'not_applicable'));

ALTER TABLE module_miauto_solicitud
  DROP CONSTRAINT IF EXISTS module_miauto_solicitud_soat_validation_attempts_check;

ALTER TABLE module_miauto_solicitud
  ADD CONSTRAINT module_miauto_solicitud_soat_validation_attempts_check
  CHECK (soat_validation_attempts >= 0);

-- La regla continúa siendo administrable, pero todos los cronogramas existentes
-- y los nuevos parten de cinco cobros mensuales antes del vencimiento.
UPDATE module_miauto_cronograma_vehiculo
SET requisitos_gastos = jsonb_set(
      COALESCE(requisitos_gastos, '{}'::jsonb),
      '{soat,cobro,meses_anticipo}',
      '5'::jsonb,
      true
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE COALESCE(NULLIF(requisitos_gastos #>> '{soat,cobro,meses_anticipo}', '')::int, 0) <> 5;
