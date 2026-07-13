CREATE TABLE IF NOT EXISTS module_miauto_bono_tiempo (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
    source_key VARCHAR(255) NOT NULL,
    source_cuota_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    target_week_number INTEGER NOT NULL,
    target_cuota_semanal_id UUID REFERENCES module_miauto_cuota_semanal(id),
    status VARCHAR(20) NOT NULL DEFAULT 'reservado'
        CHECK (status IN ('reservado', 'aplicado')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_at TIMESTAMPTZ,
    UNIQUE (solicitud_id, source_key),
    UNIQUE (target_cuota_semanal_id)
);

CREATE INDEX IF NOT EXISTS idx_miauto_bono_tiempo_solicitud
    ON module_miauto_bono_tiempo(solicitud_id, created_at);
