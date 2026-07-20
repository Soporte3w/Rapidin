-- Cola persistente para limitar el envío masivo de WhatsApp Mi Auto.

ALTER TABLE module_miauto_whatsapp_log
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;

ALTER TABLE module_miauto_whatsapp_log
  DROP CONSTRAINT IF EXISTS module_miauto_whatsapp_log_status_check;

ALTER TABLE module_miauto_whatsapp_log
  ADD CONSTRAINT module_miauto_whatsapp_log_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'failed'));

-- Los usuarios administrativos se gestionan actualmente en esta tabla.
ALTER TABLE module_miauto_whatsapp_log
  DROP CONSTRAINT IF EXISTS module_miauto_whatsapp_log_created_by_fkey;

ALTER TABLE module_miauto_whatsapp_log
  ADD CONSTRAINT module_miauto_whatsapp_log_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES systems_users_financiator(id) ON DELETE SET NULL NOT VALID;

CREATE INDEX IF NOT EXISTS idx_miauto_whatsapp_queue
  ON module_miauto_whatsapp_log (status, queued_at)
  WHERE queued_at IS NOT NULL AND status IN ('pending', 'processing');
