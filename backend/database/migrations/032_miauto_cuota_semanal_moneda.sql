-- Moneda por cuota semanal: viene de la fila del cronograma (cuota_moneda_por_vehiculo) para esa semana.
ALTER TABLE module_miauto_cuota_semanal
  ADD COLUMN IF NOT EXISTS moneda VARCHAR(10) NOT NULL DEFAULT 'PEN' CHECK (moneda IN ('PEN', 'USD'));
COMMENT ON COLUMN module_miauto_cuota_semanal.moneda IS 'Moneda de la cuota; corresponde a la fila del cronograma (regla por viajes) para el vehículo asignado.';
