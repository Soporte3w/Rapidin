-- Índices de soporte para los recorridos críticos de Rapidín y Mi Auto.
--
-- IMPORTANTE:
--   * Este archivo NO debe ejecutarse dentro de BEGIN/COMMIT porque usa
--     CREATE INDEX CONCURRENTLY.
--   * Aplicar un índice por vez en producción y comprobar pg_index.indisvalid.
--   * Los índices existentes no se eliminan en este despliegue.

SET lock_timeout = '3s';
SET statement_timeout = '0';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rapidin_payment_installments_installment_payment
  ON module_rapidin_payment_installments (installment_id, payment_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rapidin_loans_driver_country_status
  ON module_rapidin_loans (driver_id, country, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rapidin_loan_requests_driver_status_created
  ON module_rapidin_loan_requests (driver_id, status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rapidin_installments_loan_status_due
  ON module_rapidin_installments (loan_id, status, due_date, installment_number);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_miauto_cuota_schedule_active
  ON module_miauto_cuota_semanal (solicitud_id, week_start_date, due_date, id)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_miauto_comp_cuota_pending_by_sol
  ON module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id)
  WHERE validated_at IS NULL
    AND LOWER(COALESCE(NULLIF(TRIM(estado::text), ''), 'pendiente')) = 'pendiente';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rapidin_drivers_park_id_not_blank
  ON module_rapidin_drivers (park_id)
  WHERE park_id IS NOT NULL AND BTRIM(park_id) <> '';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rapidin_audit_entity_changed
  ON module_rapidin_data_audit_log (table_name, record_id, changed_at DESC);

RESET statement_timeout;
RESET lock_timeout;
