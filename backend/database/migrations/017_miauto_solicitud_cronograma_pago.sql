-- Asignación de cronograma y vehículo a solicitud aprobada + tipo de pago
ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS cronograma_id UUID REFERENCES module_miauto_cronograma(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cronograma_vehiculo_id UUID REFERENCES module_miauto_cronograma_vehiculo(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pago_tipo VARCHAR(20) CHECK (pago_tipo IS NULL OR pago_tipo IN ('completo', 'parcial')),
  ADD COLUMN IF NOT EXISTS pago_estado VARCHAR(20) DEFAULT 'pendiente' CHECK (pago_estado IN ('pendiente', 'completo'));

CREATE INDEX IF NOT EXISTS idx_miauto_solicitud_cronograma ON module_miauto_solicitud(cronograma_id);
CREATE INDEX IF NOT EXISTS idx_miauto_solicitud_cronograma_vehiculo ON module_miauto_solicitud(cronograma_vehiculo_id);
