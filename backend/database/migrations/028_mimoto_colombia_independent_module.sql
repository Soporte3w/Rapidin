BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS module_mimoto_fleet (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  park_id TEXT NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  country VARCHAR(2) NOT NULL DEFAULT 'CO' CHECK (country = 'CO'),
  timezone VARCHAR(64) NOT NULL DEFAULT 'America/Bogota',
  currency VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (currency IN ('COP', 'USD')),
  credential_ref TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by UUID REFERENCES systems_users_financiator(id),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES systems_users_financiator(id)
);

CREATE TABLE IF NOT EXISTS module_mimoto_cronograma (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fleet_id UUID REFERENCES module_mimoto_fleet(id),
  name VARCHAR(180) NOT NULL,
  country VARCHAR(2) NOT NULL DEFAULT 'CO' CHECK (country = 'CO'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  tasa_interes_mora NUMERIC(10,6) NOT NULL DEFAULT 0 CHECK (tasa_interes_mora >= 0),
  bono_tiempo_activo BOOLEAN NOT NULL DEFAULT FALSE,
  cuotas_otros_gastos INTEGER NOT NULL DEFAULT 26 CHECK (cuotas_otros_gastos > 0),
  requisitos_vehiculo JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by UUID REFERENCES systems_users_financiator(id),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS module_mimoto_cronograma_vehiculo (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cronograma_id UUID NOT NULL REFERENCES module_mimoto_cronograma(id) ON DELETE CASCADE,
  name VARCHAR(180) NOT NULL,
  inicial NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (inicial >= 0),
  inicial_moneda VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (inicial_moneda IN ('COP', 'USD')),
  cuotas_semanales INTEGER NOT NULL CHECK (cuotas_semanales > 0),
  precio_total NUMERIC(18,2) CHECK (precio_total IS NULL OR precio_total >= 0),
  moneda VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (moneda IN ('COP', 'USD')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  orden INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by UUID REFERENCES systems_users_financiator(id),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS module_mimoto_cronograma_rule (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cronograma_id UUID NOT NULL REFERENCES module_mimoto_cronograma(id) ON DELETE CASCADE,
  viajes VARCHAR(80) NOT NULL DEFAULT '',
  bono_moto NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (bono_moto >= 0),
  bono_moto_moneda VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (bono_moto_moneda IN ('COP', 'USD')),
  cuotas_por_vehiculo JSONB NOT NULL DEFAULT '[]'::jsonb,
  cuota_moneda_por_vehiculo JSONB NOT NULL DEFAULT '[]'::jsonb,
  pct_recaudo NUMERIC(8,4) NOT NULL DEFAULT 0 CHECK (pct_recaudo BETWEEN 0 AND 100),
  cobro_saldo NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (cobro_saldo >= 0),
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS module_mimoto_tipo_cambio (
  country VARCHAR(2) PRIMARY KEY DEFAULT 'CO' CHECK (country = 'CO'),
  moneda_local VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (moneda_local = 'COP'),
  valor_usd_a_local NUMERIC(18,6) NOT NULL CHECK (valor_usd_a_local > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by UUID REFERENCES systems_users_financiator(id)
);

CREATE TABLE IF NOT EXISTS module_mimoto_solicitud (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fleet_id UUID NOT NULL REFERENCES module_mimoto_fleet(id),
  country VARCHAR(2) NOT NULL DEFAULT 'CO' CHECK (country = 'CO'),
  document_type VARCHAR(3) NOT NULL CHECK (document_type IN ('CC', 'CE', 'PPT')),
  document_number VARCHAR(30) NOT NULL,
  first_name VARCHAR(120) NOT NULL,
  last_name VARCHAR(160) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(180),
  license_number VARCHAR(80),
  description TEXT,
  apps_trabajadas JSONB NOT NULL DEFAULT '[]'::jsonb,
  driver_id_fleet TEXT,
  recaudo_driver_id TEXT,
  cronograma_id UUID REFERENCES module_mimoto_cronograma(id),
  cronograma_vehiculo_id UUID REFERENCES module_mimoto_cronograma_vehiculo(id),
  pago_tipo VARCHAR(20) CHECK (pago_tipo IN ('completo', 'parcial')),
  pago_estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (pago_estado IN ('pendiente', 'parcial', 'pagado', 'rechazado')),
  fecha_inicio_cobro_semanal DATE,
  fecha_entrega_vehiculo DATE,
  placa_asignada VARCHAR(20),
  status VARCHAR(30) NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'citado', 'en_revision', 'aprobado', 'activo', 'rechazado', 'retirado', 'cancelado')),
  rejection_reason TEXT,
  appointment_date TIMESTAMPTZ,
  reagendo_count INTEGER NOT NULL DEFAULT 0 CHECK (reagendo_count >= 0),
  cited_at TIMESTAMPTZ,
  cited_by UUID REFERENCES systems_users_financiator(id),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES systems_users_financiator(id),
  observations TEXT,
  withdrawn_at TIMESTAMPTZ,
  withdrawal_reason TEXT,
  cuotas_semanales_bonificadas INTEGER NOT NULL DEFAULT 0 CHECK (cuotas_semanales_bonificadas >= 0),
  gastos_automaticos_activos BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by UUID REFERENCES systems_users_financiator(id),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES systems_users_financiator(id),
  CONSTRAINT module_mimoto_document_number_not_blank CHECK (BTRIM(document_number) <> ''),
  CONSTRAINT module_mimoto_first_name_not_blank CHECK (BTRIM(first_name) <> ''),
  CONSTRAINT module_mimoto_last_name_not_blank CHECK (BTRIM(last_name) <> ''),
  CONSTRAINT module_mimoto_phone_colombia CHECK (phone ~ '^57[0-9]{10}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mimoto_active_driver_fleet
  ON module_mimoto_solicitud(fleet_id, driver_id_fleet)
  WHERE deleted_at IS NULL
    AND driver_id_fleet IS NOT NULL
    AND status NOT IN ('rechazado', 'retirado', 'cancelado');
CREATE INDEX IF NOT EXISTS idx_mimoto_solicitud_document ON module_mimoto_solicitud(document_type, document_number);
CREATE INDEX IF NOT EXISTS idx_mimoto_solicitud_status ON module_mimoto_solicitud(status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS module_mimoto_solicitud_cita (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id) ON DELETE CASCADE,
  tipo VARCHAR(40) NOT NULL,
  appointment_date TIMESTAMPTZ NOT NULL,
  resultado VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES systems_users_financiator(id)
);

CREATE TABLE IF NOT EXISTS module_mimoto_adjunto (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id) ON DELETE CASCADE,
  tipo VARCHAR(60) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  mime_type VARCHAR(120),
  file_size INTEGER CHECK (file_size IS NULL OR file_size >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES systems_users_financiator(id)
);

CREATE TABLE IF NOT EXISTS module_mimoto_contrato_documento (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  file_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  mime_type VARCHAR(120),
  file_size INTEGER CHECK (file_size IS NULL OR file_size >= 0),
  created_by UUID REFERENCES systems_users_financiator(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_by UUID REFERENCES systems_users_financiator(id),
  deleted_at TIMESTAMPTZ,
  UNIQUE (solicitud_id, version)
);

CREATE TABLE IF NOT EXISTS module_mimoto_comprobante_pago (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id) ON DELETE CASCADE,
  monto NUMERIC(18,2) CHECK (monto IS NULL OR monto > 0),
  moneda VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (moneda IN ('COP', 'USD')),
  file_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'validado', 'rechazado', 'anulado')),
  origen VARCHAR(30) NOT NULL DEFAULT 'conductor' CHECK (origen IN ('conductor', 'admin', 'pago_manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES systems_users_financiator(id),
  validated_at TIMESTAMPTZ,
  validated_by UUID REFERENCES systems_users_financiator(id),
  rechazado_at TIMESTAMPTZ,
  rechazado_by UUID REFERENCES systems_users_financiator(id),
  rechazo_razon TEXT,
  updated_by UUID REFERENCES systems_users_financiator(id),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS module_mimoto_cuota_semanal (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  due_date DATE NOT NULL,
  week_number INTEGER NOT NULL CHECK (week_number > 0),
  viajes INTEGER NOT NULL DEFAULT 0 CHECK (viajes >= 0),
  cuota_semanal NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (cuota_semanal >= 0),
  bono_moto NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (bono_moto >= 0),
  amount_due NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount_due >= 0),
  moneda VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (moneda IN ('COP', 'USD')),
  partner_fees_raw NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (partner_fees_raw >= 0),
  pct_recaudo NUMERIC(8,4) NOT NULL DEFAULT 0 CHECK (pct_recaudo BETWEEN 0 AND 100),
  recaudo_aplicado NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (recaudo_aplicado >= 0),
  cobro_saldo NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (cobro_saldo >= 0),
  capital_paid NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (capital_paid >= 0),
  late_fee_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (late_fee_total >= 0),
  late_fee NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (late_fee >= 0),
  late_fee_paid NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (late_fee_paid >= 0),
  mora_extra_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (mora_extra_total >= 0),
  mora_extra NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (mora_extra >= 0),
  mora_extra_paid NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (mora_extra_paid >= 0),
  paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  fecha_ultimo_abono DATE,
  mora_extra_desde DATE,
  pago_puntual BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'overdue', 'paid', 'bonificada', 'cancelled')),
  montos_fuente VARCHAR(30) NOT NULL DEFAULT 'sistema',
  generation_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  payment_chunks JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by UUID REFERENCES systems_users_financiator(id),
  deleted_at TIMESTAMPTZ,
  UNIQUE (solicitud_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_mimoto_cuota_pending
  ON module_mimoto_cuota_semanal(solicitud_id, due_date, status)
  WHERE deleted_at IS NULL AND status IN ('pending', 'partial', 'overdue');

CREATE TABLE IF NOT EXISTS module_mimoto_comprobante_cuota_semanal (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id) ON DELETE CASCADE,
  cuota_semanal_id UUID NOT NULL REFERENCES module_mimoto_cuota_semanal(id),
  monto NUMERIC(18,2) NOT NULL CHECK (monto > 0),
  moneda VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (moneda IN ('COP', 'USD')),
  file_name VARCHAR(255),
  file_path TEXT,
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'validado', 'rechazado', 'anulado')),
  origen VARCHAR(30) NOT NULL DEFAULT 'conductor' CHECK (origen IN ('conductor', 'admin_confirmacion', 'pago_manual', 'fleet')),
  aplicacion_chunks JSONB NOT NULL DEFAULT '[]'::jsonb,
  acredito_en_cronograma BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES systems_users_financiator(id),
  validated_at TIMESTAMPTZ,
  validated_by UUID REFERENCES systems_users_financiator(id),
  rechazado_at TIMESTAMPTZ,
  rechazado_by UUID REFERENCES systems_users_financiator(id),
  rechazo_razon TEXT,
  updated_by UUID REFERENCES systems_users_financiator(id),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS module_mimoto_bono_tiempo (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id) ON DELETE CASCADE,
  source_key VARCHAR(160) NOT NULL,
  source_cuota_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_week_number INTEGER NOT NULL CHECK (target_week_number > 0),
  target_cuota_semanal_id UUID REFERENCES module_mimoto_cuota_semanal(id),
  status VARCHAR(20) NOT NULL DEFAULT 'reservado' CHECK (status IN ('reservado', 'aplicado', 'anulado')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TIMESTAMPTZ,
  UNIQUE (solicitud_id, source_key)
);

CREATE TABLE IF NOT EXISTS module_mimoto_evidencia_cobro_fleet (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id),
  cuota_semanal_id UUID REFERENCES module_mimoto_cuota_semanal(id),
  fleet_id UUID NOT NULL REFERENCES module_mimoto_fleet(id),
  monto NUMERIC(18,2) NOT NULL CHECK (monto > 0),
  moneda VARCHAR(3) NOT NULL CHECK (moneda IN ('COP', 'USD')),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_reference TEXT,
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES systems_users_financiator(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS module_mimoto_paid_adjustment_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cuota_semanal_id UUID NOT NULL REFERENCES module_mimoto_cuota_semanal(id),
  campo VARCHAR(60) NOT NULL,
  valor_anterior NUMERIC(18,2),
  valor_nuevo NUMERIC(18,2),
  motivo TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ajustado_por UUID REFERENCES systems_users_financiator(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS module_mimoto_billing_audit_trail (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cuota_semanal_id UUID REFERENCES module_mimoto_cuota_semanal(id),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id),
  week_start_date DATE,
  semana_ordinal INTEGER,
  event_type TEXT NOT NULL,
  billing_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_by TEXT NOT NULL,
  actor_id UUID REFERENCES systems_users_financiator(id),
  correlation_id UUID,
  execution_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mimoto_billing_execution_hash
  ON module_mimoto_billing_audit_trail(execution_hash)
  WHERE execution_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS module_mimoto_cron_lock (
  job_name TEXT PRIMARY KEY,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  execution_id UUID,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS module_mimoto_import_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_size_bytes BIGINT,
  import_type VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'validating', 'importing', 'completed', 'partial', 'failed')),
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  total_rows INTEGER NOT NULL DEFAULT 0,
  success_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  imported_by UUID REFERENCES systems_users_financiator(id),
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE (file_hash, import_type)
);

CREATE TABLE IF NOT EXISTS module_mimoto_gasto_ciclo (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id) ON DELETE CASCADE,
  tipo VARCHAR(80) NOT NULL,
  periodo_anio INTEGER NOT NULL CHECK (periodo_anio BETWEEN 2000 AND 2200),
  ciclo_numero INTEGER NOT NULL DEFAULT 1 CHECK (ciclo_numero > 0),
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE,
  total_cuotas INTEGER NOT NULL CHECK (total_cuotas > 0),
  monto_total NUMERIC(18,2) CHECK (monto_total IS NULL OR monto_total >= 0),
  monto_cuota NUMERIC(18,2) NOT NULL CHECK (monto_cuota >= 0),
  moneda VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (moneda IN ('COP', 'USD')),
  estado VARCHAR(20) NOT NULL DEFAULT 'activo' CHECK (estado IN ('borrador', 'activo', 'completado', 'cancelado')),
  origen VARCHAR(30) NOT NULL DEFAULT 'sistema',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES systems_users_financiator(id),
  updated_by UUID REFERENCES systems_users_financiator(id),
  UNIQUE (solicitud_id, tipo, periodo_anio, ciclo_numero)
);

CREATE TABLE IF NOT EXISTS module_mimoto_otros_gastos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id) ON DELETE CASCADE,
  ciclo_id UUID NOT NULL REFERENCES module_mimoto_gasto_ciclo(id),
  tipo VARCHAR(80) NOT NULL,
  numero_cuota INTEGER NOT NULL CHECK (numero_cuota > 0),
  total_cuotas INTEGER NOT NULL CHECK (total_cuotas > 0),
  periodo_anio INTEGER NOT NULL CHECK (periodo_anio BETWEEN 2000 AND 2200),
  due_date DATE NOT NULL,
  amount_due NUMERIC(18,2) NOT NULL CHECK (amount_due >= 0),
  paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'overdue', 'paid', 'cancelled')),
  moneda VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (moneda IN ('COP', 'USD')),
  origen VARCHAR(30) NOT NULL DEFAULT 'sistema',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by UUID REFERENCES systems_users_financiator(id),
  deleted_at TIMESTAMPTZ,
  UNIQUE (ciclo_id, numero_cuota)
);

CREATE TABLE IF NOT EXISTS module_mimoto_comprobante_otros_gastos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id) ON DELETE CASCADE,
  otros_gastos_id UUID NOT NULL REFERENCES module_mimoto_otros_gastos(id),
  monto NUMERIC(18,2) NOT NULL CHECK (monto > 0),
  moneda VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (moneda IN ('COP', 'USD')),
  monto_original NUMERIC(18,2),
  moneda_original VARCHAR(3) CHECK (moneda_original IS NULL OR moneda_original IN ('COP', 'USD')),
  tipo_cambio NUMERIC(18,6),
  monto_aplicado NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (monto_aplicado >= 0),
  moneda_aplicada VARCHAR(3) CHECK (moneda_aplicada IS NULL OR moneda_aplicada IN ('COP', 'USD')),
  file_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'validado', 'rechazado', 'anulado')),
  origen VARCHAR(30) NOT NULL DEFAULT 'conductor' CHECK (origen IN ('conductor', 'admin', 'fleet')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES systems_users_financiator(id),
  validated_at TIMESTAMPTZ,
  validated_by UUID REFERENCES systems_users_financiator(id),
  rechazado_at TIMESTAMPTZ,
  rechazado_by UUID REFERENCES systems_users_financiator(id),
  rechazo_razon TEXT
);

CREATE TABLE IF NOT EXISTS module_mimoto_gasto_pago_aplicacion (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id),
  otros_gastos_id UUID NOT NULL REFERENCES module_mimoto_otros_gastos(id),
  comprobante_id UUID REFERENCES module_mimoto_comprobante_otros_gastos(id),
  fuente VARCHAR(30) NOT NULL CHECK (fuente IN ('comprobante', 'fleet', 'manual')),
  monto NUMERIC(18,2) NOT NULL CHECK (monto > 0),
  moneda VARCHAR(3) NOT NULL CHECK (moneda IN ('COP', 'USD')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES systems_users_financiator(id)
);

CREATE TABLE IF NOT EXISTS module_mimoto_gasto_cobro_fleet_intento (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id),
  otros_gastos_id UUID NOT NULL REFERENCES module_mimoto_otros_gastos(id),
  fleet_id UUID NOT NULL REFERENCES module_mimoto_fleet(id),
  monto_solicitado NUMERIC(18,2) NOT NULL CHECK (monto_solicitado > 0),
  monto_cobrado NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (monto_cobrado >= 0),
  moneda VARCHAR(3) NOT NULL CHECK (moneda IN ('COP', 'USD')),
  saldo_consultado NUMERIC(18,2),
  estado VARCHAR(20) NOT NULL CHECK (estado IN ('pending', 'success', 'partial', 'failed', 'simulated')),
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  external_reference TEXT,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES systems_users_financiator(id)
);

CREATE TABLE IF NOT EXISTS module_mimoto_whatsapp_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id),
  driver_name VARCHAR(240) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  message_type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'document')),
  media_url TEXT,
  media_name VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  error TEXT,
  created_by UUID REFERENCES systems_users_financiator(id),
  queued_at TIMESTAMPTZ,
  processing_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS module_mimoto_nota_venta (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_mimoto_solicitud(id),
  provider VARCHAR(80),
  provider_document_id TEXT,
  number_full VARCHAR(100),
  currency_type_id VARCHAR(3) NOT NULL DEFAULT 'COP' CHECK (currency_type_id IN ('COP', 'USD')),
  total NUMERIC(18,2) NOT NULL CHECK (total >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'created', 'cancelled', 'failed')),
  pdf_url TEXT,
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES systems_users_financiator(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at TIMESTAMPTZ,
  cancellation_response JSONB
);

CREATE TABLE IF NOT EXISTS module_mimoto_nota_venta_cuota (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nota_venta_id UUID NOT NULL REFERENCES module_mimoto_nota_venta(id) ON DELETE CASCADE,
  cuota_semanal_id UUID NOT NULL REFERENCES module_mimoto_cuota_semanal(id),
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (nota_venta_id, cuota_semanal_id)
);

CREATE OR REPLACE VIEW module_mimoto_cuota_saldo_view AS
SELECT
  c.*,
  GREATEST(0, c.amount_due - c.capital_paid) AS saldo_capital,
  GREATEST(0, c.late_fee) AS saldo_mora,
  GREATEST(0, c.mora_extra) AS saldo_mora_extra,
  GREATEST(0, c.amount_due - c.capital_paid)
    + GREATEST(0, c.late_fee)
    + GREATEST(0, c.mora_extra) AS saldo_total
FROM module_mimoto_cuota_semanal c
WHERE c.deleted_at IS NULL;

COMMIT;
