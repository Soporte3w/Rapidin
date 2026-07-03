-- ============================================================
-- Migracion 009: Vista de saldo Mi Auto con imputacion mora -> capital
-- ============================================================
-- Esta vista no modifica datos. Expone una lectura auditable de la regla:
-- 1. El pago cubre primero la mora normal.
-- 2. Solo el excedente baja capital/cuota.
-- 3. La mora_extra solo corresponde si ya no queda mora normal pendiente,
--    hubo abono a capital y aun queda capital vencido pendiente.

CREATE OR REPLACE VIEW module_miauto_cuota_saldo_view AS
WITH base AS (
  SELECT
    c.id,
    c.solicitud_id,
    c.week_start_date,
    c.due_date,
    c.status,
    c.moneda,
    ROUND(COALESCE(c.amount_due, 0)::numeric, 2) AS capital_cuota,
    ROUND(COALESCE(c.late_fee, 0)::numeric, 2) AS mora_normal,
    ROUND(COALESCE(c.mora_extra, 0)::numeric, 2) AS mora_extra,
    c.mora_extra_desde,
    ROUND(COALESCE(c.mora_extra_total, 0)::numeric, 2) AS mora_extra_total,
    ROUND(COALESCE(c.paid_amount, 0)::numeric, 2) AS pagado_total,
    c.fecha_ultimo_abono,
    c.fecha_primer_comprobante,
    c.created_at,
    c.updated_at
  FROM module_miauto_cuota_semanal c
  WHERE c.deleted_at IS NULL
),
imputacion AS (
  SELECT
    b.*,
    ROUND(LEAST(b.pagado_total, b.mora_normal), 2) AS pagado_a_mora_normal,
    ROUND(GREATEST(0, b.pagado_total - b.mora_normal), 2) AS pagado_a_capital
  FROM base b
)
SELECT
  i.id,
  i.solicitud_id,
  i.week_start_date,
  i.due_date,
  i.status,
  i.moneda,
  i.capital_cuota,
  i.mora_normal,
  i.mora_extra,
  i.mora_extra_desde,
  i.mora_extra_total,
  i.pagado_total,
  i.pagado_a_mora_normal,
  i.pagado_a_capital,
  ROUND(GREATEST(0, i.mora_normal - i.pagado_total), 2) AS mora_normal_pendiente,
  ROUND(GREATEST(0, i.capital_cuota - i.pagado_a_capital), 2) AS capital_pendiente,
  ROUND(
    GREATEST(0, i.mora_normal - i.pagado_total)
    + GREATEST(0, i.capital_cuota - i.pagado_a_capital)
    + i.mora_extra,
    2
  ) AS saldo_total,
  (
    LOWER(COALESCE(i.status, '')) = 'overdue'
    AND GREATEST(0, i.mora_normal - i.pagado_total) <= 0.005
    AND i.pagado_a_capital > 0.005
    AND GREATEST(0, i.capital_cuota - i.pagado_a_capital) > 0.005
  ) AS corresponde_mora_extra,
  i.fecha_ultimo_abono,
  i.fecha_primer_comprobante,
  i.created_at,
  i.updated_at
FROM imputacion i;

COMMENT ON VIEW module_miauto_cuota_saldo_view IS
  'Vista auditable de saldo Mi Auto: imputa pagos primero a mora normal, luego a capital, y marca cuando corresponde mora_extra.';

COMMENT ON COLUMN module_miauto_cuota_saldo_view.mora_normal_pendiente IS
  'GREATEST(0, mora_normal - pagado_total). Si es mayor a 0, no debe correr mora_extra.';

COMMENT ON COLUMN module_miauto_cuota_saldo_view.pagado_a_capital IS
  'Parte del pagado_total que queda despues de cubrir mora_normal.';

COMMENT ON COLUMN module_miauto_cuota_saldo_view.capital_pendiente IS
  'Capital/cuota pendiente despues de aplicar pagado_a_capital.';

COMMENT ON COLUMN module_miauto_cuota_saldo_view.corresponde_mora_extra IS
  'True solo si no queda mora normal pendiente, hubo abono a capital y queda capital vencido pendiente.';
