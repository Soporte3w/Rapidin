BEGIN;

ALTER TABLE module_mimoto_solicitud
  ADD COLUMN IF NOT EXISTS cronograma_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE module_mimoto_cuota_semanal
  ADD COLUMN IF NOT EXISTS tasa_interes_mora_snapshot NUMERIC(10,6)
    CHECK (tasa_interes_mora_snapshot IS NULL OR tasa_interes_mora_snapshot >= 0),
  ADD COLUMN IF NOT EXISTS rule_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS mora_calculated_through DATE,
  ADD COLUMN IF NOT EXISTS mora_extra_calculated_through DATE;

ALTER TABLE module_mimoto_evidencia_cobro_fleet
  ADD COLUMN IF NOT EXISTS source_key TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_token UUID,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS error TEXT,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE module_mimoto_evidencia_cobro_fleet
    ADD CONSTRAINT module_mimoto_evidencia_fleet_status_check
    CHECK (status IN ('pending', 'processing', 'success', 'failed', 'simulated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mimoto_fleet_evidence_source_key
  ON module_mimoto_evidencia_cobro_fleet(source_key)
  WHERE source_key IS NOT NULL;

UPDATE module_mimoto_solicitud s
SET cronograma_snapshot = jsonb_build_object(
      'cronograma_id', c.id,
      'name', c.name,
      'tasa_interes_mora', c.tasa_interes_mora,
      'modo_evaluacion', c.modo_evaluacion,
      'bono_tiempo_activo', c.bono_tiempo_activo,
      'cuotas_otros_gastos', c.cuotas_otros_gastos,
      'requisitos_vehiculo', c.requisitos_vehiculo,
      'vehicle', to_jsonb(v),
      'rules', COALESCE((
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.orden)
        FROM module_mimoto_cronograma_rule r
        WHERE r.cronograma_id = c.id
      ), '[]'::jsonb),
      'captured_at', CURRENT_TIMESTAMP
    )
FROM module_mimoto_cronograma c, module_mimoto_cronograma_vehiculo v
WHERE s.cronograma_id = c.id
  AND v.id = s.cronograma_vehiculo_id
  AND v.cronograma_id = c.id
  AND s.deleted_at IS NULL
  AND s.cronograma_snapshot = '{}'::jsonb;

UPDATE module_mimoto_cuota_semanal q
SET tasa_interes_mora_snapshot = COALESCE(
      NULLIF(s.cronograma_snapshot->>'tasa_interes_mora', '')::numeric,
      c.tasa_interes_mora,
      0
    ),
    rule_snapshot = COALESCE((
      SELECT to_jsonb(r)
      FROM module_mimoto_cronograma_rule r
      WHERE r.id::text = q.generation_context->>'selected_rule_id'
      LIMIT 1
    ), '{}'::jsonb)
FROM module_mimoto_solicitud s
LEFT JOIN module_mimoto_cronograma c ON c.id = s.cronograma_id
WHERE q.solicitud_id = s.id
  AND q.tasa_interes_mora_snapshot IS NULL;

UPDATE module_mimoto_cuota_semanal
SET mora_calculated_through = CURRENT_DATE
WHERE mora_calculated_through IS NULL
  AND due_date < CURRENT_DATE;

UPDATE module_mimoto_cuota_semanal
SET mora_calculated_through = due_date
WHERE mora_calculated_through IS NULL;

UPDATE module_mimoto_cuota_semanal
SET mora_extra_calculated_through = CURRENT_DATE
WHERE mora_extra_calculated_through IS NULL
  AND paid_amount > 0;

UPDATE module_mimoto_evidencia_cobro_fleet
SET status = CASE WHEN simulated THEN 'simulated' ELSE 'success' END,
    completed_at = COALESCE(completed_at, created_at)
WHERE source_key IS NULL
  AND status = 'pending';

COMMIT;
