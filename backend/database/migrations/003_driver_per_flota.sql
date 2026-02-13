-- Permitir mismo conductor en varias flotas: una fila por (phone, country, park_id).
-- Se quita UNIQUE(dni, country) y se agrega UNIQUE(phone, country, park_id) tratando NULL como valor único.

ALTER TABLE module_rapidin_drivers DROP CONSTRAINT IF EXISTS module_rapidin_drivers_dni_country_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rapidin_drivers_phone_country_park
  ON module_rapidin_drivers (phone, country, COALESCE(park_id, ''))
  WHERE phone IS NOT NULL AND phone != '';
