-- Mi Auto por flota: enlace a module_rapidin_drivers (flota y conductor en una sola referencia).
ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS rapidin_driver_id UUID REFERENCES module_rapidin_drivers(id) ON DELETE SET NULL;

COMMENT ON COLUMN module_miauto_solicitud.rapidin_driver_id IS 'Conductor en Rapidin (module_rapidin_drivers.id); la flota se obtiene por JOIN con rd.park_id.';

CREATE INDEX IF NOT EXISTS idx_miauto_solicitud_rapidin_driver ON module_miauto_solicitud(rapidin_driver_id);
