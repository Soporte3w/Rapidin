-- Estado explícito del comprobante: pendiente | validado | rechazado (reemplaza booleanos validado/rechazado)
ALTER TABLE module_miauto_comprobante_pago
  ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'pendiente';

ALTER TABLE module_miauto_comprobante_pago
  DROP CONSTRAINT IF EXISTS chk_comprobante_estado;

ALTER TABLE module_miauto_comprobante_pago
  ADD CONSTRAINT chk_comprobante_estado CHECK (estado IN ('pendiente', 'validado', 'rechazado'));

-- Rellenar estado solo si existen las columnas antiguas (rechazado tiene prioridad sobre validado)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'module_miauto_comprobante_pago' AND column_name = 'rechazado') THEN
    UPDATE module_miauto_comprobante_pago SET estado = 'rechazado' WHERE rechazado = true;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'module_miauto_comprobante_pago' AND column_name = 'validado') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'module_miauto_comprobante_pago' AND column_name = 'rechazado') THEN
      UPDATE module_miauto_comprobante_pago SET estado = 'validado' WHERE validado = true AND (rechazado IS NOT TRUE);
    ELSE
      UPDATE module_miauto_comprobante_pago SET estado = 'validado' WHERE validado = true;
    END IF;
  END IF;
END $$;

UPDATE module_miauto_comprobante_pago SET estado = 'pendiente' WHERE estado IS NULL OR estado = '';

COMMENT ON COLUMN module_miauto_comprobante_pago.estado IS 'Estado del comprobante: pendiente, validado o rechazado';

-- Eliminar columnas redundantes si existen (la fuente de verdad es estado)
ALTER TABLE module_miauto_comprobante_pago DROP COLUMN IF EXISTS validado;
ALTER TABLE module_miauto_comprobante_pago DROP COLUMN IF EXISTS rechazado;
