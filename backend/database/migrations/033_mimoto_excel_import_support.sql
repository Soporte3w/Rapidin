BEGIN;

ALTER TABLE module_mimoto_solicitud
  ADD COLUMN IF NOT EXISTS inicial_acordada NUMERIC(18,2)
    CHECK (inicial_acordada IS NULL OR inicial_acordada >= 0),
  ADD COLUMN IF NOT EXISTS inicial_moneda VARCHAR(3) NOT NULL DEFAULT 'COP'
    CHECK (inicial_moneda IN ('COP', 'USD')),
  ADD COLUMN IF NOT EXISTS import_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_import_id UUID REFERENCES module_mimoto_import_log(id);

ALTER TABLE module_mimoto_cuota_semanal
  ADD COLUMN IF NOT EXISTS source_import_id UUID REFERENCES module_mimoto_import_log(id);

INSERT INTO module_mimoto_cronograma
  (id, fleet_id, name, country, active, tasa_interes_mora, bono_tiempo_activo,
   cuotas_otros_gastos, requisitos_vehiculo)
VALUES
  ('c0610000-0000-4000-8000-000000000002', NULL,
   'Plan 61 semanas - Victory Combat 100 (histórico)', 'CO', TRUE, 0.04, FALSE, 26,
   '{"source":"excel_yego_mimoto_2026-07-21","legacy":true}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  active = EXCLUDED.active,
  requisitos_vehiculo = EXCLUDED.requisitos_vehiculo,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO module_mimoto_cronograma_vehiculo
  (id, cronograma_id, name, inicial, inicial_moneda, cuotas_semanales,
   precio_total, moneda, metadata, orden, active)
VALUES
  ('61020000-0000-4000-8000-000000000001',
   'c0610000-0000-4000-8000-000000000002',
   'Victory Combat 100 - Inicial 1.192.800 (histórico)',
   1192800, 'COP', 61, NULL, 'COP', '{"cuota_base":155000,"legacy":true}', 1, TRUE),
  ('61020000-0000-4000-8000-000000000002',
   'c0610000-0000-4000-8000-000000000002',
   'Victory Combat 100 - Inicial 500.000 (histórico)',
   500000, 'COP', 61, NULL, 'COP', '{"cuota_base":180000,"legacy":true}', 2, TRUE)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  inicial = EXCLUDED.inicial,
  cuotas_semanales = EXCLUDED.cuotas_semanales,
  metadata = EXCLUDED.metadata,
  orden = EXCLUDED.orden,
  active = TRUE,
  deleted_at = NULL,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO module_mimoto_cronograma_rule
  (id, cronograma_id, viajes, bono_moto, bono_moto_moneda,
   cuotas_por_vehiculo, cuota_moneda_por_vehiculo, pct_recaudo, cobro_saldo, orden)
VALUES
  ('61021000-0000-4000-8000-000000000001',
   'c0610000-0000-4000-8000-000000000002', '0-39', 0, 'COP',
   '[{"vehiculo_id":"61020000-0000-4000-8000-000000000001","cuota":155000},{"vehiculo_id":"61020000-0000-4000-8000-000000000002","cuota":180000}]'::jsonb,
   '[]'::jsonb, 0, 0, 1),
  ('61021000-0000-4000-8000-000000000002',
   'c0610000-0000-4000-8000-000000000002', '40-74', 0, 'COP',
   '[{"vehiculo_id":"61020000-0000-4000-8000-000000000001","cuota":140000},{"vehiculo_id":"61020000-0000-4000-8000-000000000002","cuota":165000}]'::jsonb,
   '[]'::jsonb, 0, 0, 2),
  ('61021000-0000-4000-8000-000000000003',
   'c0610000-0000-4000-8000-000000000002', '75+', 0, 'COP',
   '[{"vehiculo_id":"61020000-0000-4000-8000-000000000001","cuota":125000},{"vehiculo_id":"61020000-0000-4000-8000-000000000002","cuota":150000}]'::jsonb,
   '[]'::jsonb, 0, 0, 3)
ON CONFLICT (id) DO UPDATE SET
  viajes = EXCLUDED.viajes,
  cuotas_por_vehiculo = EXCLUDED.cuotas_por_vehiculo,
  cuota_moneda_por_vehiculo = EXCLUDED.cuota_moneda_por_vehiculo,
  orden = EXCLUDED.orden,
  updated_at = CURRENT_TIMESTAMP;

COMMIT;
