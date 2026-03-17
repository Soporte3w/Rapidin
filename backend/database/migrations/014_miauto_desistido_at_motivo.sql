-- When driver withdraws after being approved (withdrawn_at, withdrawal_reason)
ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS withdrawal_reason TEXT;

COMMENT ON COLUMN module_miauto_solicitud.withdrawn_at IS 'When the solicitud was marked as desistido (driver withdrew)';
COMMENT ON COLUMN module_miauto_solicitud.withdrawal_reason IS 'Reason why the driver withdrew';
