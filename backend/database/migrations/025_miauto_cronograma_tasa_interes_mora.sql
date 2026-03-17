-- Tasa de interés por mora por cronograma (pago semanal cada lunes; si no paga a tiempo: interés por día)
ALTER TABLE module_miauto_cronograma
  ADD COLUMN IF NOT EXISTS tasa_interes_mora DECIMAL(5,4) DEFAULT 0;

COMMENT ON COLUMN module_miauto_cronograma.tasa_interes_mora IS 'Tasa de interés por mora (ej. 0.05 = 5%). Si el conductor no paga la cuota semanal (lunes), interés por día = (cuota_semanal * tasa) / 7.';
