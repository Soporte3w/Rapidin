ALTER TABLE module_miauto_cuota_semanal
  ADD COLUMN IF NOT EXISTS pago_puntual BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN module_miauto_cuota_semanal.pago_puntual IS
  'Marca manual operativa para indicar si la cuota semanal fue pagada puntualmente.';
