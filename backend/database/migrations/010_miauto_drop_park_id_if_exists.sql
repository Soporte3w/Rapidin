-- Si se aplicó una versión anterior de 009 que añadía park_id, quitarlo (flota = rapidin_driver_id → rd.park_id).
DROP INDEX IF EXISTS idx_miauto_solicitud_park;
ALTER TABLE module_miauto_solicitud DROP COLUMN IF EXISTS park_id;
