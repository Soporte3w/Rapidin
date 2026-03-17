-- Permitir hora en la cita: appointment_date pasa de DATE a TIMESTAMP
ALTER TABLE module_miauto_solicitud
  ALTER COLUMN appointment_date TYPE TIMESTAMP USING appointment_date::timestamp;

COMMENT ON COLUMN module_miauto_solicitud.appointment_date IS 'Fecha y hora de la cita (agendar/reagendar).';
