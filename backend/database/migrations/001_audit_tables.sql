-- ============================================================
-- Yego Rapidín 4.0 — Migración 001: Tablas de Auditoría
-- ============================================================

-- 1. Auditoría genérica de cambios en tablas (quién, cuándo, qué cambió)
CREATE TABLE IF NOT EXISTS module_rapidin_data_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name TEXT NOT NULL,
    record_id UUID NOT NULL,
    operation TEXT NOT NULL,  -- INSERT | UPDATE | DELETE
    old_data JSONB,
    new_data JSONB,
    changed_by UUID REFERENCES module_rapidin_users(id),
    changed_by_role TEXT,
    changed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    correlation_id UUID,
    ip_address INET
);
CREATE INDEX IF NOT EXISTS idx_rapidin_dal_table_record ON module_rapidin_data_audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_rapidin_dal_changed_at ON module_rapidin_data_audit_log(changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rapidin_dal_changed_by ON module_rapidin_data_audit_log(changed_by, changed_at DESC);

-- 2. Eventos de negocio (creación contrato, generación cronograma, cobro, pago, etc.)
CREATE TABLE IF NOT EXISTS module_rapidin_business_event_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type TEXT NOT NULL,          -- contract.created | schedule.generated | charge.generated | payment.registered | payment.validated | excel.imported | mora.calculated | fleet.withdraw
    entity_type TEXT NOT NULL,          -- solicitud | cronograma | cuota_semanal | payment | comprobante | import
    entity_id UUID NOT NULL,
    actor_type TEXT NOT NULL DEFAULT 'system',  -- system | user | admin | driver
    actor_id UUID,
    payload JSONB NOT NULL,
    correlation_id UUID,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rapidin_bel_entity ON module_rapidin_business_event_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rapidin_bel_type ON module_rapidin_business_event_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rapidin_bel_corr ON module_rapidin_business_event_log(correlation_id);

-- 3. Trazabilidad de cálculo de cobro (desglose completo de cada cuota semanal generada)
CREATE TABLE IF NOT EXISTS module_miauto_billing_audit_trail (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cuota_semanal_id UUID REFERENCES module_miauto_cuota_semanal(id),
    solicitud_id UUID NOT NULL,
    week_start_date DATE NOT NULL,
    semana_ordinal INTEGER,
    event_type TEXT NOT NULL,           -- generated | updated | cascaded | paid
    billing_context JSONB NOT NULL,     -- Desglose completo: inputs, plan, cálculo, cascada, mora, resultado
    generated_by TEXT NOT NULL,         -- cron_lunes | manual_regeneration | excel_import | admin_adjustment
    actor_id UUID,
    correlation_id UUID,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_miauto_bat_cuota ON module_miauto_billing_audit_trail(cuota_semanal_id);
CREATE INDEX IF NOT EXISTS idx_miauto_bat_solicitud ON module_miauto_billing_audit_trail(solicitud_id, week_start_date);
CREATE INDEX IF NOT EXISTS idx_miauto_bat_created ON module_miauto_billing_audit_trail(created_at DESC);

-- 4. Registro de importaciones Excel
CREATE TABLE IF NOT EXISTS module_miauto_import_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_name TEXT NOT NULL,
    file_hash TEXT,
    file_size_bytes BIGINT,
    import_type TEXT NOT NULL,          -- solicitudes | cuotas_semanales | pagos
    status TEXT NOT NULL DEFAULT 'started',  -- started | validating | importing | completed | failed | partial
    total_rows INTEGER DEFAULT 0,
    success_rows INTEGER DEFAULT 0,
    skipped_rows INTEGER DEFAULT 0,
    error_rows INTEGER DEFAULT 0,
    errors JSONB,                        -- [{ row, column, value, reason }]
    warnings JSONB,                      -- [{ row, msg, column }]
    dry_run BOOLEAN DEFAULT false,
    imported_by UUID REFERENCES module_rapidin_users(id),
    correlation_id UUID,
    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_miauto_il_status ON module_miauto_import_log(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_miauto_il_type ON module_miauto_import_log(import_type, started_at DESC);
