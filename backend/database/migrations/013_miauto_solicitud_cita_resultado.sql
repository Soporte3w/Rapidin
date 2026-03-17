-- Resultado de cada cita: si el conductor llegó o no (al reagendar = no llegó a la anterior)
ALTER TABLE module_miauto_solicitud_cita
  ADD COLUMN IF NOT EXISTS resultado VARCHAR(20) CHECK (resultado IS NULL OR resultado IN ('llego', 'no_llego'));

COMMENT ON COLUMN module_miauto_solicitud_cita.resultado IS 'llego = asistió a esta cita; no_llego = no asistió (se reagendó o se rechazó por inasistencia)';
