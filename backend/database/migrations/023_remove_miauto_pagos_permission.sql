-- La pantalla independiente de Pagos de Mi Auto fue retirada.
-- Conserva los permisos de pagos de Rapidin y Mi Moto.

DO $$
BEGIN
  IF to_regclass('public.systems_roles_financiator') IS NOT NULL THEN
    UPDATE systems_roles_financiator
    SET allowed_modules = array_remove(allowed_modules, 'miauto.pagos'),
        updated_at = CURRENT_TIMESTAMP
    WHERE 'miauto.pagos' = ANY(allowed_modules);
  END IF;

  IF to_regclass('public.systems_users_financiator') IS NOT NULL THEN
    UPDATE systems_users_financiator
    SET allowed_modules = array_remove(allowed_modules, 'miauto.pagos'),
        updated_at = CURRENT_TIMESTAMP
    WHERE 'miauto.pagos' = ANY(allowed_modules);
  END IF;

  IF to_regclass('public.module_rapidin_users') IS NOT NULL THEN
    UPDATE module_rapidin_users
    SET allowed_modules = array_remove(allowed_modules, 'miauto.pagos')
    WHERE 'miauto.pagos' = ANY(allowed_modules);
  END IF;
END
$$;
