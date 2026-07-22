BEGIN;

ALTER TABLE module_mimoto_cronograma
  ADD COLUMN IF NOT EXISTS modo_evaluacion VARCHAR(20) NOT NULL DEFAULT 'viajes'
    CHECK (modo_evaluacion IN ('viajes', 'viajes_horas'));

ALTER TABLE module_mimoto_cronograma_rule
  ADD COLUMN IF NOT EXISTS horas_minimas NUMERIC(8,2)
    CHECK (horas_minimas IS NULL OR horas_minimas >= 0);

ALTER TABLE module_mimoto_cuota_semanal
  ADD COLUMN IF NOT EXISTS horas_conectadas NUMERIC(8,2)
    CHECK (horas_conectadas IS NULL OR horas_conectadas >= 0);

-- El tarifario general de 78 semanas exige viajes y horas. Los demás planes
-- entregados solo condicionan la cuota por cantidad de viajes.
UPDATE module_mimoto_cronograma
SET modo_evaluacion = CASE
      WHEN id = 'c0780000-0000-4000-8000-000000000001' THEN 'viajes_horas'
      ELSE 'viajes'
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  'c0780000-0000-4000-8000-000000000001',
  'c0780000-0000-4000-8000-000000000002',
  'c0610000-0000-4000-8000-000000000001',
  'c0610000-0000-4000-8000-000000000002'
);

UPDATE module_mimoto_cronograma_rule
SET horas_minimas = CASE orden
      WHEN 1 THEN 0
      WHEN 2 THEN 17
      WHEN 3 THEN 30
      ELSE 0
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE cronograma_id = 'c0780000-0000-4000-8000-000000000001';

UPDATE module_mimoto_cronograma_rule
SET horas_minimas = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE cronograma_id <> 'c0780000-0000-4000-8000-000000000001';

-- Las horas del Excel se conservaron en generation_context. Solo se vuelcan
-- a la columna financiera cuando el cronograma declara que las utiliza.
UPDATE module_mimoto_cuota_semanal q
SET horas_conectadas = NULLIF(q.generation_context->>'observed_hours', '')::numeric,
    updated_at = CURRENT_TIMESTAMP
FROM module_mimoto_solicitud s
JOIN module_mimoto_cronograma c ON c.id = s.cronograma_id
WHERE q.solicitud_id = s.id
  AND c.modo_evaluacion = 'viajes_horas'
  AND q.generation_context ? 'observed_hours'
  AND jsonb_typeof(q.generation_context->'observed_hours') = 'number';

-- La vista fue creada con c.* antes de existir horas_conectadas. Se recrea
-- para exponer la métrica sin cambiar las fórmulas financieras del saldo.
DROP VIEW IF EXISTS module_mimoto_cuota_saldo_view;

CREATE VIEW module_mimoto_cuota_saldo_view AS
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
