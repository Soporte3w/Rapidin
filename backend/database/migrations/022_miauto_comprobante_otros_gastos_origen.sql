-- Mi Auto: identifica quién subió cada comprobante de otros gastos.

ALTER TABLE module_miauto_comprobante_otros_gastos
  ADD COLUMN IF NOT EXISTS origen VARCHAR(20);

UPDATE module_miauto_comprobante_otros_gastos
SET origen = 'conductor'
WHERE origen IS NULL OR TRIM(origen) = '';

ALTER TABLE module_miauto_comprobante_otros_gastos
  ALTER COLUMN origen SET DEFAULT 'conductor',
  ALTER COLUMN origen SET NOT NULL;

ALTER TABLE module_miauto_comprobante_otros_gastos
  DROP CONSTRAINT IF EXISTS miauto_comprobante_otros_gastos_origen_check;

ALTER TABLE module_miauto_comprobante_otros_gastos
  ADD CONSTRAINT miauto_comprobante_otros_gastos_origen_check
  CHECK (origen IN ('conductor', 'admin'));

CREATE INDEX IF NOT EXISTS idx_miauto_comprobante_otros_validacion
  ON module_miauto_comprobante_otros_gastos(estado, created_at DESC);
