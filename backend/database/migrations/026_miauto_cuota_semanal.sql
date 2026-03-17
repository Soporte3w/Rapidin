-- Cuotas semanales Mi Auto (cobro cada lunes; mora diaria si no paga)
CREATE TABLE IF NOT EXISTS module_miauto_cuota_semanal (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  due_date DATE NOT NULL,
  num_viajes INTEGER,
  partner_fees_raw DECIMAL(12,2),
  partner_fees_83 DECIMAL(12,2),
  bono_auto DECIMAL(12,2) NOT NULL DEFAULT 0,
  cuota_semanal DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount_due DECIMAL(12,2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  late_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'overdue', 'paid', 'partial')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(solicitud_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_miauto_cuota_semanal_solicitud ON module_miauto_cuota_semanal(solicitud_id);
CREATE INDEX IF NOT EXISTS idx_miauto_cuota_semanal_due_date ON module_miauto_cuota_semanal(due_date);

-- Primer lunes en que empieza el cobro semanal (se setea al hacer "Generar Yego Mi Auto")
ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS fecha_inicio_cobro_semanal DATE NULL;

COMMENT ON COLUMN module_miauto_solicitud.fecha_inicio_cobro_semanal IS 'Primer lunes en que empieza el cobro semanal; se setea al hacer Generar Yego Mi Auto.';
