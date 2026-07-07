DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'module_miauto_comprobante_cuota_semanal_estado_check'
      AND conrelid = 'module_miauto_comprobante_cuota_semanal'::regclass
  ) THEN
    ALTER TABLE module_miauto_comprobante_cuota_semanal
      DROP CONSTRAINT module_miauto_comprobante_cuota_semanal_estado_check;
  END IF;

  ALTER TABLE module_miauto_comprobante_cuota_semanal
    ADD CONSTRAINT module_miauto_comprobante_cuota_semanal_estado_check
    CHECK (
      LOWER(COALESCE(NULLIF(TRIM(estado::text), ''), 'pendiente'))
      IN ('pendiente', 'confirmado', 'validado', 'rechazado')
    );
END $$;
