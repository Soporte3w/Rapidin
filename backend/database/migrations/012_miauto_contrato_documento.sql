CREATE TABLE IF NOT EXISTS module_miauto_contrato_documento (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    mime_type VARCHAR(120),
    file_size INTEGER,
    created_by UUID REFERENCES module_rapidin_users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_by UUID REFERENCES module_rapidin_users(id),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_miauto_contrato_documento_solicitud
    ON module_miauto_contrato_documento(solicitud_id);

CREATE INDEX IF NOT EXISTS idx_miauto_contrato_documento_activo
    ON module_miauto_contrato_documento(solicitud_id, created_at DESC)
    WHERE deleted_at IS NULL;
