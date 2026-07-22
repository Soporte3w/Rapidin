-- Compatibilidad para bases donde la migración inicial de Mi Moto ya fue aplicada.
ALTER TABLE module_mimoto_solicitud ADD COLUMN IF NOT EXISTS first_name VARCHAR(120);
ALTER TABLE module_mimoto_solicitud ADD COLUMN IF NOT EXISTS last_name VARCHAR(160);

UPDATE module_mimoto_solicitud
SET first_name = COALESCE(NULLIF(BTRIM(first_name), ''), 'Conductor'),
    last_name = COALESCE(NULLIF(BTRIM(last_name), ''), document_number)
WHERE first_name IS NULL OR BTRIM(first_name) = '' OR last_name IS NULL OR BTRIM(last_name) = '';

ALTER TABLE module_mimoto_solicitud ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE module_mimoto_solicitud ALTER COLUMN last_name SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE module_mimoto_solicitud
    ADD CONSTRAINT module_mimoto_first_name_not_blank CHECK (BTRIM(first_name) <> '');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE module_mimoto_solicitud
    ADD CONSTRAINT module_mimoto_last_name_not_blank CHECK (BTRIM(last_name) <> '');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION normalize_mimoto_permissions(mods TEXT[])
RETURNS TEXT[] AS $$
DECLARE
  result TEXT[] := COALESCE(mods, ARRAY[]::TEXT[]);
BEGIN
  IF 'mimoto' = ANY(result)
     OR result && ARRAY['mimoto.dashboard','mimoto.prestamos','mimoto.pagos']::TEXT[] THEN
    result := result || ARRAY[
      'mimoto', 'mimoto.nueva_solicitud', 'mimoto.solicitudes',
      'mimoto.alquiler_venta', 'mimoto.validar_comprobantes', 'mimoto.mensajes',
      'mimoto.analisis', 'mimoto.configuracion', 'mimoto.usuarios'
    ];
  END IF;
  result := ARRAY(
    SELECT DISTINCT permission
    FROM UNNEST(result) AS permission
    WHERE permission NOT IN ('mimoto.dashboard','mimoto.prestamos','mimoto.pagos')
    ORDER BY permission
  );
  RETURN result;
END;
$$ LANGUAGE plpgsql;

UPDATE systems_users_financiator
SET allowed_modules = normalize_mimoto_permissions(
  allowed_modules || CASE WHEN role = 'admin' THEN ARRAY['mimoto']::TEXT[] ELSE ARRAY[]::TEXT[] END
)
WHERE role = 'admin'
   OR allowed_modules && ARRAY['mimoto','mimoto.dashboard','mimoto.prestamos','mimoto.pagos']::TEXT[];

UPDATE systems_roles_financiator
SET allowed_modules = normalize_mimoto_permissions(
  allowed_modules || CASE WHEN code = 'admin' THEN ARRAY['mimoto']::TEXT[] ELSE ARRAY[]::TEXT[] END
)
WHERE code = 'admin'
   OR allowed_modules && ARRAY['mimoto','mimoto.dashboard','mimoto.prestamos','mimoto.pagos']::TEXT[];

UPDATE module_rapidin_users
SET allowed_modules = normalize_mimoto_permissions(allowed_modules)
WHERE allowed_modules && ARRAY['mimoto','mimoto.dashboard','mimoto.prestamos','mimoto.pagos']::TEXT[];

DROP FUNCTION normalize_mimoto_permissions(TEXT[]);
