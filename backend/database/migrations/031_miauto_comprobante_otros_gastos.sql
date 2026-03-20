-- Comprobantes de pago para cuotas "otros gastos" (conductor sube por cuota; admin valida/rechaza).
CREATE TABLE IF NOT EXISTS module_miauto_comprobante_otros_gastos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
  otros_gastos_id UUID NOT NULL REFERENCES module_miauto_otros_gastos(id) ON DELETE CASCADE,
  monto DECIMAL(12,2),
  moneda VARCHAR(10) NOT NULL DEFAULT 'PEN' CHECK (moneda IN ('PEN', 'USD')),
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'validado', 'rechazado')),
  validated_at TIMESTAMP,
  validated_by UUID REFERENCES module_rapidin_users(id),
  rechazado_at TIMESTAMP,
  rechazo_razon TEXT,
  rechazado_by UUID REFERENCES module_rapidin_users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_miauto_comp_otros_gastos_solicitud ON module_miauto_comprobante_otros_gastos(solicitud_id);
CREATE INDEX IF NOT EXISTS idx_miauto_comp_otros_gastos_otro ON module_miauto_comprobante_otros_gastos(otros_gastos_id);

COMMENT ON TABLE module_miauto_comprobante_otros_gastos IS 'Comprobantes de pago por cuota de otros gastos; conductor sube, admin valida o rechaza.';
