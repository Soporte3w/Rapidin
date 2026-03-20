-- Gastos/coberturas variables por carro (SRC, SOAT, GPS, impuesto, todo riesgo+GPS, etc.)
ALTER TABLE module_miauto_cronograma_vehiculo
  ADD COLUMN IF NOT EXISTS requisitos_gastos JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN module_miauto_cronograma_vehiculo.requisitos_gastos IS
  'JSON por vehículo: todo_riesgo_y_gps_modo, src, gps, soat, impuesto_vehicular, todo_riesgo, todo_riesgo_mas_gps_agrupado (montos y metadatos de cobro). Tipo nuevo/seminuevo/semiusado va en cronograma.requisitos_vehiculo.tipo_vehiculo';
