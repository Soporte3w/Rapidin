-- Validación de comprobantes de pago por admin; al validar se descuenta de la cuota inicial
ALTER TABLE module_miauto_comprobante_pago
  ADD COLUMN IF NOT EXISTS validado BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS validated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS validated_by UUID REFERENCES module_rapidin_users(id);

COMMENT ON COLUMN module_miauto_comprobante_pago.validado IS 'Si el admin validó este comprobante (cuenta para la cuota inicial)';
COMMENT ON COLUMN module_miauto_comprobante_pago.validated_at IS 'Fecha en que se validó';
COMMENT ON COLUMN module_miauto_comprobante_pago.validated_by IS 'Usuario admin que validó';
