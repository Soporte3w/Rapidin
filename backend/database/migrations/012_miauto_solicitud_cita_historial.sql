-- Historial de citas y reagendos por solicitud (control con fechas)
CREATE TABLE IF NOT EXISTS module_miauto_solicitud_cita (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('citado', 'reagendo')),
  appointment_date TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES module_rapidin_users(id)
);

CREATE INDEX IF NOT EXISTS idx_miauto_solicitud_cita_solicitud ON module_miauto_solicitud_cita(solicitud_id);
CREATE INDEX IF NOT EXISTS idx_miauto_solicitud_cita_created ON module_miauto_solicitud_cita(created_at);

COMMENT ON TABLE module_miauto_solicitud_cita IS 'Historial de cada cita y cada reagendo para control con fechas';
