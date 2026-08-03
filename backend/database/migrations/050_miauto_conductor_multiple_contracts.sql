CREATE TABLE IF NOT EXISTS module_miauto_conductor (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
  document_number VARCHAR(20),
  document_normalized VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (country, document_normalized)
);

ALTER TABLE module_miauto_solicitud
  ADD COLUMN IF NOT EXISTS conductor_id UUID,
  ADD COLUMN IF NOT EXISTS origen_registro VARCHAR(30) NOT NULL DEFAULT 'solicitud';

ALTER TABLE module_miauto_solicitud
  DROP CONSTRAINT IF EXISTS module_miauto_solicitud_origen_registro_check;

ALTER TABLE module_miauto_solicitud
  ADD CONSTRAINT module_miauto_solicitud_origen_registro_check
  CHECK (origen_registro IN ('solicitud', 'contrato_adicional'));

INSERT INTO module_miauto_conductor (country, document_number, document_normalized)
SELECT DISTINCT ON (country, document_normalized)
       country,
       dni,
       document_normalized
FROM (
  SELECT id,
         COALESCE(NULLIF(country, ''), 'PE') AS country,
         dni,
         COALESCE(
           NULLIF(
             REGEXP_REPLACE(
               REGEXP_REPLACE(COALESCE(dni, ''), '[^0-9]', '', 'g'),
               '^0+',
               ''
             ),
             ''
           ),
           'SOLICITUD:' || id::text
         ) AS document_normalized
  FROM module_miauto_solicitud
) legacy
ORDER BY country, document_normalized, id
ON CONFLICT (country, document_normalized) DO NOTHING;

UPDATE module_miauto_solicitud s
SET conductor_id = c.id
FROM module_miauto_conductor c
WHERE s.conductor_id IS NULL
  AND c.country = COALESCE(NULLIF(s.country, ''), 'PE')
  AND c.document_normalized = COALESCE(
    NULLIF(
      REGEXP_REPLACE(
        REGEXP_REPLACE(COALESCE(s.dni, ''), '[^0-9]', '', 'g'),
        '^0+',
        ''
      ),
      ''
    ),
    'SOLICITUD:' || s.id::text
  );

ALTER TABLE module_miauto_solicitud
  ALTER COLUMN conductor_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'module_miauto_solicitud_conductor_id_fkey'
  ) THEN
    ALTER TABLE module_miauto_solicitud
      ADD CONSTRAINT module_miauto_solicitud_conductor_id_fkey
      FOREIGN KEY (conductor_id) REFERENCES module_miauto_conductor(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_miauto_solicitud_conductor_created
  ON module_miauto_solicitud (conductor_id, created_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_miauto_active_contract_plate
  ON module_miauto_solicitud (
    UPPER(REGEXP_REPLACE(TRIM(COALESCE(placa_asignada, '')), '[^A-Z0-9]', '', 'g'))
  )
  WHERE status = 'aprobado'
    AND deleted_at IS NULL
    AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(placa_asignada, '')), '[^A-Z0-9]', '', 'g')) <> '';
