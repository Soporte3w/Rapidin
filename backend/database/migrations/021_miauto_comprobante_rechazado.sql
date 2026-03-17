-- Rechazo de comprobantes por admin (ej. foto no legible)
ALTER TABLE module_miauto_comprobante_pago
  ADD COLUMN IF NOT EXISTS rechazado BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS rechazado_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rechazo_razon TEXT,
  ADD COLUMN IF NOT EXISTS rechazado_by UUID REFERENCES module_rapidin_users(id);

COMMENT ON COLUMN module_miauto_comprobante_pago.rechazado IS 'Si el admin rechazó este comprobante (ej. no legible)';
COMMENT ON COLUMN module_miauto_comprobante_pago.rechazado_at IS 'Fecha en que se rechazó';
COMMENT ON COLUMN module_miauto_comprobante_pago.rechazo_razon IS 'Motivo del rechazo';
COMMENT ON COLUMN module_miauto_comprobante_pago.rechazado_by IS 'Usuario admin que rechazó';
