-- Configuración de "otros gastos" y creación lazy.
-- Número de cuotas (semanas) para repartir el saldo pendiente (pago parcial): configurable por cronograma; solo afecta a nuevos contratos.
-- Solicitud guarda saldo y N al generar para no depender del valor actual del cronograma.

-- Cronograma: cuántas cuotas de "otros gastos" (default 26)
ALTER TABLE module_miauto_cronograma
  ADD COLUMN IF NOT EXISTS cuotas_otros_gastos INTEGER NOT NULL DEFAULT 26;
COMMENT ON COLUMN module_miauto_cronograma.cuotas_otros_gastos IS 'Número de cuotas en que se reparte el saldo pendiente de la cuota inicial (pago parcial). Solo aplica a nuevas generaciones de Yego Mi Auto.';

-- Solicitud: saldo y N fijados al generar (solo si pago parcial con saldo > 0)
ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS otros_gastos_saldo_total DECIMAL(12,2) NULL;
ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS otros_gastos_num_cuotas INTEGER NULL;
COMMENT ON COLUMN module_miauto_solicitud.otros_gastos_saldo_total IS 'Saldo pendiente repartido en otros gastos (fijado al generar Yego Mi Auto con pago parcial).';
COMMENT ON COLUMN module_miauto_solicitud.otros_gastos_num_cuotas IS 'Número de cuotas de otros gastos (fijado al generar; viene del cronograma).';

-- Permitir week_index hasta 99 para cronogramas con N distinto de 26
ALTER TABLE module_miauto_otros_gastos DROP CONSTRAINT IF EXISTS module_miauto_otros_gastos_week_index_check;
ALTER TABLE module_miauto_otros_gastos DROP CONSTRAINT IF EXISTS module_miauto_otros_gastos_status_check;
ALTER TABLE module_miauto_otros_gastos
  ADD CONSTRAINT module_miauto_otros_gastos_week_index_check CHECK (week_index >= 1 AND week_index <= 99);
ALTER TABLE module_miauto_otros_gastos
  ADD CONSTRAINT module_miauto_otros_gastos_status_check CHECK (status IN ('pending', 'overdue', 'paid', 'partial'));
