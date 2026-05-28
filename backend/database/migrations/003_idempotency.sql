-- ============================================================
-- Yego Rapidín 4.0 — Migración Fase 1: Idempotencia y Protección
-- ============================================================
-- Ya ejecutada en producción (Mayo 2026).
-- Documentada aquí para referencia futura.

-- 1. execution_hash en billing_audit_trail (idempotencia de cobros)
ALTER TABLE module_miauto_billing_audit_trail ADD COLUMN IF NOT EXISTS execution_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_miauto_bat_exec_hash ON module_miauto_billing_audit_trail(execution_hash) WHERE execution_hash IS NOT NULL;

-- 2. Tabla de lock para cron jobs (evitar doble ejecución)
CREATE TABLE IF NOT EXISTS module_miauto_cron_lock (
    job_name TEXT PRIMARY KEY,
    locked BOOLEAN DEFAULT false,
    locked_at TIMESTAMPTZ,
    locked_by TEXT,
    execution_id UUID,
    expires_at TIMESTAMPTZ
);

-- 3. Trazabilidad de ajustes de paid_amount
CREATE TABLE IF NOT EXISTS module_miauto_paid_adjustment_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cuota_semanal_id UUID REFERENCES module_miauto_cuota_semanal(id),
    solicitud_id UUID NOT NULL,
    paid_amount_antes NUMERIC(12,2),
    paid_amount_despues NUMERIC(12,2),
    motivo TEXT NOT NULL,
    adjustado_por UUID REFERENCES module_rapidin_users(id),
    correlation_id UUID,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_miauto_pal_cuota ON module_miauto_paid_adjustment_log(cuota_semanal_id);
