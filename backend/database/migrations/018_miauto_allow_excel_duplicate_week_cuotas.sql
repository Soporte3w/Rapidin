-- Permite importar cronogramas Excel "tal como estan", incluso si una solicitud
-- trae mas de una cuota con la misma fecha/semana.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'module_miauto_cuota_semanal'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%solicitud_id%'
      AND pg_get_constraintdef(oid) ILIKE '%week_start_date%'
  LOOP
    EXECUTE format('ALTER TABLE module_miauto_cuota_semanal DROP CONSTRAINT IF EXISTS %I', rec.conname);
  END LOOP;
END $$;

DROP INDEX IF EXISTS module_miauto_cuota_semanal_solicitud_id_week_start_date_key;
DROP INDEX IF EXISTS idx_miauto_cuota_semanal_solicitud_week_unique;
DROP INDEX IF EXISTS idx_miauto_cuota_semanal_unique_week;
