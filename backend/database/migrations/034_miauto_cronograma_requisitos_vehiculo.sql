-- Requisitos de vehículo por cronograma (condición: nuevo/semiusado/seminuevo + gastos con montos)
ALTER TABLE module_miauto_cronograma
  ADD COLUMN IF NOT EXISTS requisitos_vehiculo JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN module_miauto_cronograma.requisitos_vehiculo IS
  'JSON: tipos_condicion {nuevo,semiusado,seminuevo}, gastos {seguro_todo_riesgo_gps,soat,impuesto} con incluido, monto, moneda (PEN|USD)';
