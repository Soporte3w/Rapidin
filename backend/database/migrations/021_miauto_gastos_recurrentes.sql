-- Mi Auto: ciclos recurrentes, cuotas identificables y trazabilidad de pagos.
-- Migracion aditiva: conserva todos los registros historicos existentes.

ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS fecha_entrega_vehiculo DATE,
  ADD COLUMN IF NOT EXISTS vehiculo_anio SMALLINT,
  ADD COLUMN IF NOT EXISTS soat_fecha_vencimiento DATE,
  ADD COLUMN IF NOT EXISTS str_gps_monto_semanal NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS str_gps_moneda VARCHAR(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS inicial_parcial_activa BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS gastos_automaticos_activos BOOLEAN;

-- Los contratos existentes requieren revision antes de empezar a cobrar conceptos nuevos.
-- Los contratos creados despues de esta migracion quedan habilitados por defecto.
UPDATE module_miauto_solicitud
SET gastos_automaticos_activos = FALSE
WHERE gastos_automaticos_activos IS NULL;

ALTER TABLE module_miauto_solicitud
  ALTER COLUMN gastos_automaticos_activos SET DEFAULT TRUE,
  ALTER COLUMN gastos_automaticos_activos SET NOT NULL;

CREATE TABLE IF NOT EXISTS module_miauto_gasto_ciclo (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id),
  concepto VARCHAR(40) NOT NULL,
  periodo_anio SMALLINT NOT NULL,
  ciclo_numero INTEGER NOT NULL DEFAULT 1,
  moneda VARCHAR(3) NOT NULL,
  monto_total NUMERIC(12, 2),
  fecha_inicio DATE,
  fecha_fin DATE,
  fecha_vencimiento_referencia DATE,
  numero_cuotas INTEGER NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'activo',
  origen VARCHAR(30) NOT NULL DEFAULT 'sistema',
  config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID,
  updated_by UUID,
  CONSTRAINT miauto_gasto_ciclo_concepto_check CHECK (
    concepto IN ('gps', 'soat', 'impuesto_vehicular', 'str_gps', 'todo_riesgo_mas_gps_agrupado', 'inicial_parcial', 'src', 'generico')
  ),
  CONSTRAINT miauto_gasto_ciclo_estado_check CHECK (estado IN ('borrador', 'activo', 'completado', 'cancelado')),
  CONSTRAINT miauto_gasto_ciclo_moneda_check CHECK (moneda IN ('PEN', 'USD', 'COP')),
  CONSTRAINT miauto_gasto_ciclo_cuotas_check CHECK (numero_cuotas > 0),
  UNIQUE (solicitud_id, concepto, periodo_anio, ciclo_numero)
);

ALTER TABLE module_miauto_otros_gastos
  ADD COLUMN IF NOT EXISTS ciclo_id UUID REFERENCES module_miauto_gasto_ciclo(id),
  ADD COLUMN IF NOT EXISTS numero_cuota INTEGER,
  ADD COLUMN IF NOT EXISTS total_cuotas INTEGER,
  ADD COLUMN IF NOT EXISTS periodo_anio SMALLINT,
  ADD COLUMN IF NOT EXISTS source_key VARCHAR(180),
  ADD COLUMN IF NOT EXISTS origen VARCHAR(30) NOT NULL DEFAULT 'sistema',
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS updated_by UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_miauto_otros_gastos_ciclo_cuota
  ON module_miauto_otros_gastos(ciclo_id, numero_cuota)
  WHERE ciclo_id IS NOT NULL AND numero_cuota IS NOT NULL AND deleted_at IS NULL;

-- La restriccion antigua impide repetir el numero de cuota en un nuevo ano.
-- La unicidad pasa a estar definida por ciclo_id + numero_cuota.
ALTER TABLE module_miauto_otros_gastos
  DROP CONSTRAINT IF EXISTS module_miauto_otros_gastos_solicitud_id_week_index_tipo_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_miauto_otros_gastos_source_key
  ON module_miauto_otros_gastos(source_key)
  WHERE source_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_miauto_gasto_ciclo_solicitud
  ON module_miauto_gasto_ciclo(solicitud_id, concepto, periodo_anio);

CREATE INDEX IF NOT EXISTS idx_miauto_otros_gastos_cobranza
  ON module_miauto_otros_gastos(solicitud_id, due_date, status)
  WHERE deleted_at IS NULL;

ALTER TABLE module_miauto_comprobante_otros_gastos
  ADD COLUMN IF NOT EXISTS monto_original NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS moneda_original VARCHAR(3),
  ADD COLUMN IF NOT EXISTS tipo_cambio NUMERIC(14, 6),
  ADD COLUMN IF NOT EXISTS monto_aplicado NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS moneda_aplicada VARCHAR(3),
  ADD COLUMN IF NOT EXISTS created_by UUID;

CREATE TABLE IF NOT EXISTS module_miauto_gasto_pago_aplicacion (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id),
  otros_gastos_id UUID NOT NULL REFERENCES module_miauto_otros_gastos(id),
  comprobante_id UUID REFERENCES module_miauto_comprobante_otros_gastos(id),
  origen VARCHAR(20) NOT NULL,
  source_key VARCHAR(220) NOT NULL,
  monto_original NUMERIC(12, 2) NOT NULL,
  moneda_original VARCHAR(3) NOT NULL,
  tipo_cambio NUMERIC(14, 6),
  monto_aplicado NUMERIC(12, 2) NOT NULL,
  moneda_aplicada VARCHAR(3) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_by UUID,
  reversed_at TIMESTAMPTZ,
  reversed_by UUID,
  reversal_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT miauto_gasto_pago_origen_check CHECK (origen IN ('comprobante', 'fleet', 'cascada', 'manual', 'import')),
  CONSTRAINT miauto_gasto_pago_monto_check CHECK (monto_aplicado > 0),
  UNIQUE (source_key)
);

CREATE INDEX IF NOT EXISTS idx_miauto_gasto_pago_cuota
  ON module_miauto_gasto_pago_aplicacion(otros_gastos_id, applied_at)
  WHERE reversed_at IS NULL;

CREATE TABLE IF NOT EXISTS module_miauto_gasto_cobro_fleet_intento (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id),
  otros_gastos_id UUID NOT NULL REFERENCES module_miauto_otros_gastos(id),
  source_key VARCHAR(220) NOT NULL UNIQUE,
  estado VARCHAR(20) NOT NULL DEFAULT 'processing',
  monto_retiro NUMERIC(12, 2) NOT NULL,
  moneda_retiro VARCHAR(3) NOT NULL,
  monto_acreditar NUMERIC(12, 2) NOT NULL,
  moneda_acreditar VARCHAR(3) NOT NULL,
  external_driver_id TEXT,
  park_id TEXT,
  response JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  CONSTRAINT miauto_gasto_fleet_estado_check CHECK (estado IN ('processing', 'success', 'failed', 'reconcile'))
);

CREATE INDEX IF NOT EXISTS idx_miauto_gasto_fleet_reconcile
  ON module_miauto_gasto_cobro_fleet_intento(estado, created_at)
  WHERE estado IN ('processing', 'reconcile');

ALTER TABLE module_miauto_cuota_semanal
  ADD COLUMN IF NOT EXISTS otros_gastos_cascada_destino JSONB;

-- Organiza el historial previo en ciclos "legacy" sin alterar montos ni estados.
INSERT INTO module_miauto_gasto_ciclo (
  solicitud_id, concepto, periodo_anio, ciclo_numero, moneda, monto_total,
  fecha_inicio, fecha_fin, numero_cuotas, estado, origen, config_snapshot
)
SELECT og.solicitud_id,
       CASE
         WHEN LOWER(TRIM(COALESCE(og.tipo, ''))) IN (
           'gps', 'soat', 'impuesto_vehicular', 'str_gps',
           'todo_riesgo_mas_gps_agrupado', 'inicial_parcial', 'src'
         ) THEN LOWER(TRIM(og.tipo))
         ELSE 'generico'
       END,
       EXTRACT(YEAR FROM MIN(og.due_date))::smallint,
       1,
       MIN(og.moneda),
       SUM(og.amount_due),
       MIN(og.due_date),
       MAX(og.due_date),
       COUNT(*)::integer,
       CASE WHEN BOOL_AND(og.status = 'paid') THEN 'completado' ELSE 'activo' END,
       'legacy',
       jsonb_build_object('migrated', true)
FROM module_miauto_otros_gastos og
WHERE og.deleted_at IS NULL
  AND og.ciclo_id IS NULL
  AND og.due_date IS NOT NULL
GROUP BY og.solicitud_id,
         CASE
           WHEN LOWER(TRIM(COALESCE(og.tipo, ''))) IN (
             'gps', 'soat', 'impuesto_vehicular', 'str_gps',
             'todo_riesgo_mas_gps_agrupado', 'inicial_parcial', 'src'
           ) THEN LOWER(TRIM(og.tipo))
           ELSE 'generico'
         END,
         EXTRACT(YEAR FROM og.due_date)
ON CONFLICT (solicitud_id, concepto, periodo_anio, ciclo_numero) DO NOTHING;

WITH numbered AS (
  SELECT og.id,
         c.id AS ciclo_id,
         ROW_NUMBER() OVER (
           PARTITION BY og.solicitud_id,
                        CASE
                          WHEN LOWER(TRIM(COALESCE(og.tipo, ''))) IN (
                            'gps', 'soat', 'impuesto_vehicular', 'str_gps',
                            'todo_riesgo_mas_gps_agrupado', 'inicial_parcial', 'src'
                          ) THEN LOWER(TRIM(og.tipo))
                          ELSE 'generico'
                        END,
                        EXTRACT(YEAR FROM og.due_date)
           ORDER BY og.due_date, og.week_index, og.id
         )::integer AS numero_cuota,
         COUNT(*) OVER (
           PARTITION BY og.solicitud_id,
                        CASE
                          WHEN LOWER(TRIM(COALESCE(og.tipo, ''))) IN (
                            'gps', 'soat', 'impuesto_vehicular', 'str_gps',
                            'todo_riesgo_mas_gps_agrupado', 'inicial_parcial', 'src'
                          ) THEN LOWER(TRIM(og.tipo))
                          ELSE 'generico'
                        END,
                        EXTRACT(YEAR FROM og.due_date)
         )::integer AS total_cuotas,
         EXTRACT(YEAR FROM og.due_date)::smallint AS periodo_anio
  FROM module_miauto_otros_gastos og
  JOIN module_miauto_gasto_ciclo c
    ON c.solicitud_id = og.solicitud_id
   AND c.concepto = CASE
     WHEN LOWER(TRIM(COALESCE(og.tipo, ''))) IN (
       'gps', 'soat', 'impuesto_vehicular', 'str_gps',
       'todo_riesgo_mas_gps_agrupado', 'inicial_parcial', 'src'
     ) THEN LOWER(TRIM(og.tipo))
     ELSE 'generico'
   END
   AND c.periodo_anio = EXTRACT(YEAR FROM og.due_date)::smallint
   AND c.ciclo_numero = 1
  WHERE og.deleted_at IS NULL AND og.ciclo_id IS NULL AND og.due_date IS NOT NULL
)
UPDATE module_miauto_otros_gastos og
SET ciclo_id = n.ciclo_id,
    numero_cuota = n.numero_cuota,
    total_cuotas = n.total_cuotas,
    periodo_anio = n.periodo_anio,
    origen = 'legacy'
FROM numbered n
WHERE og.id = n.id;
