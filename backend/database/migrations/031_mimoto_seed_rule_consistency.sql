BEGIN;

-- Elimina únicamente reglas antiguas que duplican los rangos oficiales de los
-- tres tarifarios sembrados. No afecta cronogramas creados por usuarios.
WITH canonical(cronograma_id, viajes, rule_id) AS (
  VALUES
    ('c0780000-0000-4000-8000-000000000001'::uuid, '0-39', '78011000-0000-4000-8000-000000000001'::uuid),
    ('c0780000-0000-4000-8000-000000000001'::uuid, '40-74', '78011000-0000-4000-8000-000000000002'::uuid),
    ('c0780000-0000-4000-8000-000000000001'::uuid, '75+', '78011000-0000-4000-8000-000000000003'::uuid),
    ('c0780000-0000-4000-8000-000000000002'::uuid, '0-39', '78021000-0000-4000-8000-000000000001'::uuid),
    ('c0780000-0000-4000-8000-000000000002'::uuid, '40-74', '78021000-0000-4000-8000-000000000002'::uuid),
    ('c0780000-0000-4000-8000-000000000002'::uuid, '75+', '78021000-0000-4000-8000-000000000003'::uuid),
    ('c0610000-0000-4000-8000-000000000001'::uuid, '0-39', '61011000-0000-4000-8000-000000000001'::uuid),
    ('c0610000-0000-4000-8000-000000000001'::uuid, '40-74', '61011000-0000-4000-8000-000000000002'::uuid),
    ('c0610000-0000-4000-8000-000000000001'::uuid, '75+', '61011000-0000-4000-8000-000000000003'::uuid)
)
DELETE FROM module_mimoto_cronograma_rule rule
USING canonical
WHERE rule.cronograma_id = canonical.cronograma_id
  AND LOWER(REGEXP_REPLACE(BTRIM(rule.viajes), '\s+', '', 'g')) = LOWER(canonical.viajes)
  AND rule.id <> canonical.rule_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mimoto_cronograma_rule_viajes
  ON module_mimoto_cronograma_rule (
    cronograma_id,
    LOWER(REGEXP_REPLACE(BTRIM(viajes), '\s+', '', 'g'))
  );

COMMIT;
