-- ============================================================
-- Yego Rapidín 4.0 — Migración 002: Soft-delete y updated_by
-- ============================================================

-- Agregar updated_by a tablas de Mi Auto
ALTER TABLE module_miauto_solicitud ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_miauto_solicitud ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE module_miauto_solicitud ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES module_rapidin_users(id);

ALTER TABLE module_miauto_cuota_semanal ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_miauto_cuota_semanal ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE module_miauto_cronograma ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_miauto_cronograma ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE module_miauto_cronograma_vehiculo ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_miauto_cronograma_vehiculo ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE module_miauto_comprobante_pago ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_miauto_comprobante_pago ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE module_miauto_comprobante_cuota_semanal ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_miauto_comprobante_cuota_semanal ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE module_miauto_otros_gastos ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_miauto_otros_gastos ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Agregar updated_by a tablas de Rapidín
ALTER TABLE module_rapidin_loans ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_rapidin_loans ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE module_rapidin_installments ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_rapidin_installments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE module_rapidin_payments ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_rapidin_payments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE module_rapidin_payment_vouchers ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_rapidin_payment_vouchers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Agregar updated_by a datos maestros
ALTER TABLE module_rapidin_drivers ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
ALTER TABLE module_rapidin_drivers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE module_rapidin_cycle_config ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);

ALTER TABLE module_rapidin_loan_conditions ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES module_rapidin_users(id);
