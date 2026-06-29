-- Yego Rapidín 4.0 — Tabla de auditoría de envíos WhatsApp Mi Auto
-- Trazabilidad completa: quién envió, a quién, qué mensaje, estado, errores.

CREATE TABLE IF NOT EXISTS module_miauto_whatsapp_log (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id),
  driver_name  VARCHAR(255) NOT NULL,
  phone        VARCHAR(20) NOT NULL,
  message      TEXT NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sent', 'failed')),
  error        TEXT,
  created_by   UUID REFERENCES module_rapidin_users(id),
  sent_at      TIMESTAMP,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_miauto_whatsapp_log_solicitud ON module_miauto_whatsapp_log(solicitud_id);
CREATE INDEX IF NOT EXISTS idx_miauto_whatsapp_log_status   ON module_miauto_whatsapp_log(status);
CREATE INDEX IF NOT EXISTS idx_miauto_whatsapp_log_created   ON module_miauto_whatsapp_log(created_at);
