BEGIN;

ALTER TABLE module_mimoto_whatsapp_log
  ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_name VARCHAR(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'module_mimoto_whatsapp_log_message_type_check'
  ) THEN
    ALTER TABLE module_mimoto_whatsapp_log
      ADD CONSTRAINT module_mimoto_whatsapp_log_message_type_check
      CHECK (message_type IN ('text', 'document'));
  END IF;
END $$;

COMMIT;
