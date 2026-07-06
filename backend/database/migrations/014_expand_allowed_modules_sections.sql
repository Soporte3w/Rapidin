-- Expande permisos por producto a permisos por sección.
-- Mantiene las llaves de producto para compatibilidad, pero agrega cada sección visible.

CREATE OR REPLACE FUNCTION expand_financiator_allowed_modules(mods text[])
RETURNS text[] AS $$
DECLARE
  result text[] := COALESCE(mods, ARRAY[]::text[]);
BEGIN
  IF 'rapidin' = ANY(result) THEN
    result := result || ARRAY[
      'rapidin.dashboard',
      'rapidin.solicitudes',
      'rapidin.nueva_solicitud',
      'rapidin.prestamos',
      'rapidin.pagos',
      'rapidin.cobros_masivos',
      'rapidin.analisis',
      'rapidin.provisiones',
      'rapidin.configuracion',
      'rapidin.usuarios'
    ];
  END IF;

  IF 'miauto' = ANY(result) THEN
    result := result || ARRAY[
      'miauto.nueva_solicitud',
      'miauto.solicitudes',
      'miauto.alquiler_venta',
      'miauto.pagos',
      'miauto.validar_comprobantes',
      'miauto.mensajes',
      'miauto.analisis',
      'miauto.configuracion',
      'miauto.usuarios'
    ];
  END IF;

  IF 'mimoto' = ANY(result) THEN
    result := result || ARRAY[
      'mimoto.dashboard',
      'mimoto.nueva_solicitud',
      'mimoto.prestamos',
      'mimoto.pagos',
      'mimoto.analisis',
      'mimoto.configuracion'
    ];
  END IF;

  RETURN ARRAY(SELECT DISTINCT value FROM unnest(result) AS value ORDER BY value);
END;
$$ LANGUAGE plpgsql;

UPDATE systems_users_financiator
SET allowed_modules = expand_financiator_allowed_modules(allowed_modules)
WHERE allowed_modules && ARRAY['rapidin', 'miauto', 'mimoto']::text[];

UPDATE module_rapidin_users
SET allowed_modules = expand_financiator_allowed_modules(allowed_modules)
WHERE allowed_modules && ARRAY['rapidin', 'miauto', 'mimoto']::text[];

DROP FUNCTION expand_financiator_allowed_modules(text[]);

