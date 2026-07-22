BEGIN;

ALTER TABLE module_mimoto_cuota_semanal
  ADD COLUMN IF NOT EXISTS recaudo_pool NUMERIC(18,2) NOT NULL DEFAULT 0
    CHECK (recaudo_pool >= 0),
  ADD COLUMN IF NOT EXISTS recaudo_cascada_destino JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS saldo_favor_conductor NUMERIC(18,2) NOT NULL DEFAULT 0
    CHECK (saldo_favor_conductor >= 0);

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
