-- Nombre y apellidos del conductor desde Excel/importación; se muestra como Conductor cuando no hay rapidin_driver_id.
ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS conductor_nombre VARCHAR(255) NULL;

COMMENT ON COLUMN module_miauto_solicitud.conductor_nombre IS 'Nombre y apellidos del conductor desde Excel/importación; se muestra como Conductor cuando no hay rapidin_driver_id.';
