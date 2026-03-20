-- Cuotas de "otros gastos" (saldo pendiente de la cuota inicial en pago parcial), 26 semanas.
-- Primera cuota vence en semana 2 del plan: siguiente lunes tras fecha_inicio_cobro_semanal (primer lunes en o después de fecha_inicio + 1 día); siguientes = lunes consecutivos.
CREATE TABLE IF NOT EXISTS module_miauto_otros_gastos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
  week_index INTEGER NOT NULL CHECK (week_index >= 1 AND week_index <= 26),
  due_date DATE NOT NULL,
  amount_due DECIMAL(12,2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'overdue', 'paid', 'partial')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(solicitud_id, week_index)
);

CREATE INDEX IF NOT EXISTS idx_miauto_otros_gastos_solicitud ON module_miauto_otros_gastos(solicitud_id);
CREATE INDEX IF NOT EXISTS idx_miauto_otros_gastos_due_date ON module_miauto_otros_gastos(due_date);

COMMENT ON TABLE module_miauto_otros_gastos IS '26 cuotas del saldo pendiente de la cuota inicial cuando pago_tipo=parcial; vencimientos en lunes desde semana 2 (siguiente lunes tras fecha_inicio_cobro_semanal).';
