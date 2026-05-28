-- ============================================================
-- Yego Rapidín 4.0 — Triggers de Auditoría Automática
-- Captura INSERT/UPDATE/DELETE en tablas críticas sin depender del código.
-- ============================================================

CREATE OR REPLACE FUNCTION module_rapidin_audit_trigger_fn()
RETURNS TRIGGER AS $$
DECLARE
    v_operation TEXT;
    v_old_data JSONB;
    v_new_data JSONB;
    v_record_id UUID;
    v_changed_by UUID;
    v_correlation_id UUID;
BEGIN
    v_operation := TG_OP;
    v_record_id := COALESCE(NEW.id, OLD.id);
    BEGIN
        v_correlation_id := COALESCE(
            (NEW::jsonb ->> 'correlation_id')::uuid,
            (OLD::jsonb ->> 'correlation_id')::uuid
        );
    EXCEPTION WHEN OTHERS THEN
        v_correlation_id := NULL;
    END;
    BEGIN
        v_changed_by := COALESCE(
            (NEW::jsonb ->> 'updated_by')::uuid,
            (NEW::jsonb ->> 'changed_by')::uuid,
            (OLD::jsonb ->> 'updated_by')::uuid
        );
    EXCEPTION WHEN OTHERS THEN
        v_changed_by := NULL;
    END;
    IF v_operation = 'INSERT' THEN
        v_new_data := to_jsonb(NEW);
        v_old_data := NULL;
    ELSIF v_operation = 'UPDATE' THEN
        v_new_data := to_jsonb(NEW);
        v_old_data := to_jsonb(OLD);
    ELSIF v_operation = 'DELETE' THEN
        v_old_data := to_jsonb(OLD);
        v_new_data := NULL;
    END IF;
    INSERT INTO module_rapidin_data_audit_log (table_name, record_id, operation, old_data, new_data, changed_by, correlation_id)
    VALUES (TG_TABLE_NAME, v_record_id, v_operation, v_old_data, v_new_data, v_changed_by, v_correlation_id);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Aplicar triggers a tablas de Mi Auto
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'module_miauto_solicitud',
        'module_miauto_cuota_semanal',
        'module_miauto_cronograma',
        'module_miauto_cronograma_vehiculo',
        'module_miauto_comprobante_pago',
        'module_miauto_comprobante_cuota_semanal',
        'module_miauto_otros_gastos',
        'module_miauto_adjunto'
    ] LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS trg_audit_%I ON %I;
            CREATE TRIGGER trg_audit_%I
                AFTER INSERT OR UPDATE OR DELETE ON %I
                FOR EACH ROW EXECUTE FUNCTION module_rapidin_audit_trigger_fn();
        ', tbl, tbl, tbl, tbl);
    END LOOP;
END $$;

-- Aplicar triggers a tablas de Rapidín
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'module_rapidin_loans',
        'module_rapidin_installments',
        'module_rapidin_payments',
        'module_rapidin_payment_vouchers',
        'module_rapidin_loan_requests',
        'module_rapidin_drivers',
        'module_rapidin_loan_conditions',
        'module_rapidin_cycle_config',
        'module_rapidin_creditos_personal'
    ] LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS trg_audit_%I ON %I;
            CREATE TRIGGER trg_audit_%I
                AFTER INSERT OR UPDATE OR DELETE ON %I
                FOR EACH ROW EXECUTE FUNCTION module_rapidin_audit_trigger_fn();
        ', tbl, tbl, tbl, tbl);
    END LOOP;
END $$;
