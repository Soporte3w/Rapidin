BEGIN;

-- La placa, dentro de una flota, identifica la operación financiera Mi Moto.
-- Impide que generación y cobro resuelvan dos solicitudes hacia el mismo vehículo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mimoto_active_plate_fleet
  ON module_mimoto_solicitud (
    fleet_id,
    UPPER(REGEXP_REPLACE(BTRIM(placa_asignada), '[^A-Za-z0-9]', '', 'g'))
  )
  WHERE deleted_at IS NULL
    AND placa_asignada IS NOT NULL
    AND BTRIM(placa_asignada) <> ''
    AND status NOT IN ('rechazado', 'retirado', 'cancelado');

COMMIT;
