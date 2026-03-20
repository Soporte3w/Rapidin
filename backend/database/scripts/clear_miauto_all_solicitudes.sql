-- Borra TODOS los datos de solicitudes y alquiler/venta (Yego Mi Auto) para empezar de cero.
-- No borra: cronogramas, vehículos, reglas, tipo_cambio ni catálogo de apps (configuración).
-- Ejecutar: psql $DATABASE_URL -f backend/database/scripts/clear_miauto_all_solicitudes.sql

-- Orden: tablas hijas primero (por referencias a solicitud_id)

DELETE FROM module_miauto_comprobante_otros_gastos;
DELETE FROM module_miauto_comprobante_cuota_semanal;
DELETE FROM module_miauto_comprobante_pago;
DELETE FROM module_miauto_otros_gastos;
DELETE FROM module_miauto_cuota_semanal;
DELETE FROM module_miauto_solicitud_cita;
DELETE FROM module_miauto_adjunto;
-- (module_miauto_solicitud_app puede no existir si se eliminó en migraciones)
DELETE FROM module_miauto_solicitud;
