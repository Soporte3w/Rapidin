-- Placa del vehículo físico asignado al conductor (contrato Mi Auto)
ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS placa_asignada VARCHAR(20) NULL;

COMMENT ON COLUMN module_miauto_solicitud.placa_asignada IS
  'Placa del auto entregado al conductor para este contrato; obligatoria al generar Yego Mi Auto.';
