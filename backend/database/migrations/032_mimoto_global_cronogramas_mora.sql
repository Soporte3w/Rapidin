BEGIN;

-- Los cronogramas Mi Moto son globales. La flota pertenece a la solicitud.
UPDATE module_mimoto_cronograma
SET fleet_id = NULL,
    tasa_interes_mora = 0.04,
    updated_at = CURRENT_TIMESTAMP
WHERE deleted_at IS NULL
  AND (fleet_id IS NOT NULL OR tasa_interes_mora IS DISTINCT FROM 0.04);

COMMIT;
