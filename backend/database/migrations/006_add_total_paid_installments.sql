-- Total pagado por cuota = paid_amount + paid_late_fee (así en BD se ve 45.26, no solo 45)
ALTER TABLE module_rapidin_installments
  ADD COLUMN IF NOT EXISTS total_paid DECIMAL(12, 2)
  GENERATED ALWAYS AS (COALESCE(paid_amount, 0) + COALESCE(paid_late_fee, 0)) STORED;

COMMENT ON COLUMN module_rapidin_installments.total_paid IS 'Total pagado en esta cuota: paid_amount + paid_late_fee.';
