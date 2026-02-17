-- Permitir mismo DNI en varias flotas: un conductor (dni, country) puede tener varios registros según park_id (flota).
-- Así cada préstamo se asocia al conductor de esa flota y las observaciones (número de cuenta, flota) quedan por préstamo.
-- Antes: UNIQUE(dni, country). Después: UNIQUE(dni, country, COALESCE(park_id, '')).

-- Nombre típico de la constraint en PostgreSQL para UNIQUE(dni, country)
ALTER TABLE module_rapidin_drivers DROP CONSTRAINT IF EXISTS module_rapidin_drivers_dni_country_key;

-- Índice único por (dni, country, park_id). COALESCE(park_id, '') permite varias filas con mismo dni+country y distinto park_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rapidin_drivers_dni_country_park
  ON module_rapidin_drivers (dni, country, COALESCE(TRIM(park_id), ''));
