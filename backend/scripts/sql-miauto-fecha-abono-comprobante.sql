-- Mi Auto: fecha del último abono registrado en la cuota y fecha del primer comprobante subido.
-- La mora sobre saldo de capital pendiente usa estas fechas (día siguiente al evento → hoy Lima).
-- Ejecutar una vez contra la BD del API: psql $DATABASE_URL -f backend/scripts/sql-miauto-fecha-abono-comprobante.sql

ALTER TABLE module_miauto_cuota_semanal
  ADD COLUMN IF NOT EXISTS fecha_ultimo_abono date NULL,
  ADD COLUMN IF NOT EXISTS fecha_primer_comprobante date NULL;

COMMENT ON COLUMN module_miauto_cuota_semanal.fecha_ultimo_abono IS
  'Lima YYYY-MM-DD: última vez que aumentó paid_amount (Fleet, comprobante validado, admin, cascada).';
COMMENT ON COLUMN module_miauto_cuota_semanal.fecha_primer_comprobante IS
  'Lima YYYY-MM-DD: primera vez que el conductor subió comprobante para esta cuota (si aún no hay fecha_ultimo_abono).';
