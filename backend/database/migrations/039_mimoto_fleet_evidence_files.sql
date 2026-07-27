BEGIN;

CREATE TABLE IF NOT EXISTS module_mimoto_evidencia_fleet_archivo (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id),
  cuota_semanal_id UUID NOT NULL REFERENCES module_mimoto_cuota_semanal(id),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT,
  file_size BIGINT CHECK (file_size IS NULL OR file_size >= 0),
  created_by UUID REFERENCES systems_users_financiator(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_by UUID REFERENCES systems_users_financiator(id),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mimoto_evidencia_fleet_archivo_solicitud
  ON module_mimoto_evidencia_fleet_archivo(solicitud_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mimoto_evidencia_fleet_archivo_cuota
  ON module_mimoto_evidencia_fleet_archivo(cuota_semanal_id, created_at DESC)
  WHERE deleted_at IS NULL;

COMMIT;
