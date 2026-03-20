-- Moneda por cuota de otros gastos: viene del plan (cronograma_vehiculo.inicial_moneda).
ALTER TABLE module_miauto_otros_gastos
  ADD COLUMN IF NOT EXISTS moneda VARCHAR(10) NOT NULL DEFAULT 'PEN' CHECK (moneda IN ('PEN', 'USD'));
COMMENT ON COLUMN module_miauto_otros_gastos.moneda IS 'Moneda de la cuota (amount_due, paid_amount); corresponde al plan del vehículo (inicial_moneda).';
