-- Cambiar tipo 'reagendo' a 'cita_reagendada' en historial de citas
UPDATE module_miauto_solicitud_cita SET tipo = 'cita_reagendada' WHERE tipo = 'reagendo';

ALTER TABLE module_miauto_solicitud_cita
  DROP CONSTRAINT IF EXISTS module_miauto_solicitud_cita_tipo_check;

ALTER TABLE module_miauto_solicitud_cita
  ADD CONSTRAINT module_miauto_solicitud_cita_tipo_check
  CHECK (tipo IN ('citado', 'cita_reagendada'));
