-- Borra los datos que rellena el script import-miauto-placas-from-excel.js
-- (placa_asignada, observations, license_number, cronograma_id, cronograma_vehiculo_id, rapidin_driver_id)
-- Si existe conductor_nombre (migración 038), añadir: conductor_nombre = NULL
-- Ejecutar: psql $DATABASE_URL -f backend/database/scripts/clear_miauto_import_data.sql

UPDATE module_miauto_solicitud
SET
  placa_asignada = NULL,
  observations = NULL,
  license_number = NULL,
  cronograma_id = NULL,
  cronograma_vehiculo_id = NULL,
  rapidin_driver_id = NULL,
  updated_at = CURRENT_TIMESTAMP
WHERE placa_asignada IS NOT NULL
   OR observations IS NOT NULL
   OR license_number IS NOT NULL
   OR cronograma_id IS NOT NULL
   OR cronograma_vehiculo_id IS NOT NULL
   OR rapidin_driver_id IS NOT NULL;
