-- Columna para indicar que la mora de esta cuota no fue cobrada (admin eligió no cobrarla).
ALTER TABLE module_rapidin_installments
  ADD COLUMN IF NOT EXISTS late_fee_waived BOOLEAN DEFAULT false;

COMMENT ON COLUMN module_rapidin_installments.late_fee_waived IS 'Si true, la mora de esta cuota no fue cobrada (registro manual con opción "no cobrar mora").';
