-- % comisión y cobro del saldo por fila de cronograma; snapshot en cuota semanal
ALTER TABLE module_miauto_cronograma_rule
  ADD COLUMN IF NOT EXISTS pct_comision NUMERIC(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cobro_saldo NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN module_miauto_cronograma_rule.pct_comision IS 'Porcentaje de comisión (0-100) para la fila del cronograma.';
COMMENT ON COLUMN module_miauto_cronograma_rule.cobro_saldo IS 'Cobro del saldo (monto fijo asociado a la fila; moneda según cuota semanal).';

ALTER TABLE module_miauto_cuota_semanal
  ADD COLUMN IF NOT EXISTS pct_comision NUMERIC(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cobro_saldo NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN module_miauto_cuota_semanal.pct_comision IS 'Snapshot de pct_comision de la regla aplicada al generar la semana.';
COMMENT ON COLUMN module_miauto_cuota_semanal.cobro_saldo IS 'Snapshot de cobro_saldo de la regla aplicada al generar la semana.';
