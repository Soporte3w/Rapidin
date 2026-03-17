-- Comprobantes de pago para cuotas semanales Mi Auto (conductor sube comprobante por cuota; admin valida)
CREATE TABLE IF NOT EXISTS module_miauto_comprobante_cuota_semanal (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
  cuota_semanal_id UUID NOT NULL REFERENCES module_miauto_cuota_semanal(id) ON DELETE CASCADE,
  monto DECIMAL(12,2) NOT NULL,
  moneda VARCHAR(10) NOT NULL DEFAULT 'PEN' CHECK (moneda IN ('PEN', 'USD')),
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'validado', 'rechazado')),
  validated_at TIMESTAMP,
  validated_by UUID REFERENCES module_rapidin_users(id),
  rechazado_at TIMESTAMP,
  rechazo_razon TEXT,
  rechazado_by UUID REFERENCES module_rapidin_users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_miauto_comp_cuota_sem_solicitud ON module_miauto_comprobante_cuota_semanal(solicitud_id);
CREATE INDEX IF NOT EXISTS idx_miauto_comp_cuota_sem_cuota ON module_miauto_comprobante_cuota_semanal(cuota_semanal_id);

-- Permitir status 'bonificada' en cuotas semanales (beneficio 4 cuotas seguidas al día)
ALTER TABLE module_miauto_cuota_semanal DROP CONSTRAINT IF EXISTS module_miauto_cuota_semanal_status_check;
ALTER TABLE module_miauto_cuota_semanal ADD CONSTRAINT module_miauto_cuota_semanal_status_check
  CHECK (status IN ('pending', 'overdue', 'paid', 'partial', 'bonificada'));

-- Cuántas cuotas semanales se han bonificado (p. ej. 1 cuando paga 4 seguidas a tiempo)
ALTER TABLE module_miauto_solicitud ADD COLUMN IF NOT EXISTS cuotas_semanales_bonificadas INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN module_miauto_solicitud.cuotas_semanales_bonificadas IS 'Cuotas semanales restadas por beneficios (ej. 1 si pagó 4 cuotas consecutivas a tiempo).';
