-- Horario diario administrable para generar y actualizar otros gastos de Mi Auto.

ALTER TABLE module_miauto_automation_config
  ADD COLUMN IF NOT EXISTS daily_additional_expenses_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS daily_additional_expenses_time TIME NOT NULL DEFAULT '02:15';
