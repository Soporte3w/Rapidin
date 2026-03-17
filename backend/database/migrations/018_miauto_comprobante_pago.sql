-- Comprobantes de pago del conductor (cuota inicial; varios si pago parcial)
CREATE TABLE IF NOT EXISTS module_miauto_comprobante_pago (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
  monto DECIMAL(12,2),
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES module_rapidin_users(id)
);

CREATE INDEX IF NOT EXISTS idx_miauto_comprobante_pago_solicitud ON module_miauto_comprobante_pago(solicitud_id);
