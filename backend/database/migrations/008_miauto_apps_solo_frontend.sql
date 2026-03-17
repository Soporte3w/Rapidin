-- Quitar tablas de apps: las aplicaciones solo existen en el frontend.
-- Guardar en la solicitud un array (JSONB) con los códigos/nombres seleccionados.

-- 1. Añadir columna en solicitud
ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS apps_trabajadas JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN module_miauto_solicitud.apps_trabajadas IS 'Códigos o nombres de apps en las que ha trabajado (definidas solo en frontend).';

-- 2. Migrar datos existentes desde module_miauto_solicitud_app (si existen)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'module_miauto_solicitud_app') THEN
    UPDATE module_miauto_solicitud s
    SET apps_trabajadas = (
      SELECT COALESCE(jsonb_agg(a.code), '[]')
      FROM module_miauto_solicitud_app sa
      JOIN module_miauto_app a ON a.id = sa.app_id
      WHERE sa.solicitud_id = s.id
    )
    WHERE EXISTS (SELECT 1 FROM module_miauto_solicitud_app sa WHERE sa.solicitud_id = s.id);
  END IF;
END $$;

-- 3. Eliminar tablas de apps
DROP TABLE IF EXISTS module_miauto_solicitud_app;
DROP TABLE IF EXISTS module_miauto_app;
