-- Mi Auto: GPS es un unico cobro mensual al cierre de cada mes.
-- Conserva siempre registros con pagos/comprobantes y prioriza el Excel frente a legado sin uso.

DO $$
BEGIN
  IF EXISTS (
    WITH ranked AS (
      SELECT og.id,
             ROW_NUMBER() OVER (
               PARTITION BY og.solicitud_id,
                            EXTRACT(YEAR FROM og.due_date),
                            EXTRACT(MONTH FROM og.due_date)
               ORDER BY
                 (COALESCE(og.paid_amount, 0) > 0.005 OR EXISTS (
                   SELECT 1 FROM module_miauto_gasto_pago_aplicacion pa
                   WHERE pa.otros_gastos_id = og.id AND pa.reversed_at IS NULL
                 ) OR EXISTS (
                   SELECT 1 FROM module_miauto_comprobante_otros_gastos cp
                   WHERE cp.otros_gastos_id = og.id AND cp.estado <> 'rechazado'
                 )) DESC,
                 (og.origen = 'excel_import') DESC,
                 (og.due_date = (date_trunc('month', og.due_date::timestamp)
                   + INTERVAL '1 month - 1 day')::date) DESC,
                 og.due_date DESC,
                 og.id
             ) AS position
      FROM module_miauto_otros_gastos og
      WHERE og.tipo = 'gps' AND og.deleted_at IS NULL AND og.due_date IS NOT NULL
    )
    SELECT 1
    FROM ranked r
    JOIN module_miauto_otros_gastos og ON og.id = r.id
    WHERE r.position > 1
      AND (
        COALESCE(og.paid_amount, 0) > 0.005
        OR EXISTS (
          SELECT 1 FROM module_miauto_gasto_pago_aplicacion pa
          WHERE pa.otros_gastos_id = og.id AND pa.reversed_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM module_miauto_comprobante_otros_gastos cp
          WHERE cp.otros_gastos_id = og.id AND cp.estado <> 'rechazado'
        )
      )
  ) THEN
    RAISE EXCEPTION 'No se puede consolidar GPS: un mes tiene mas de un registro protegido';
  END IF;
END $$;

WITH ranked AS (
  SELECT og.id,
         ROW_NUMBER() OVER (
           PARTITION BY og.solicitud_id,
                        EXTRACT(YEAR FROM og.due_date),
                        EXTRACT(MONTH FROM og.due_date)
           ORDER BY
             (COALESCE(og.paid_amount, 0) > 0.005 OR EXISTS (
               SELECT 1 FROM module_miauto_gasto_pago_aplicacion pa
               WHERE pa.otros_gastos_id = og.id AND pa.reversed_at IS NULL
             ) OR EXISTS (
               SELECT 1 FROM module_miauto_comprobante_otros_gastos cp
               WHERE cp.otros_gastos_id = og.id AND cp.estado <> 'rechazado'
             )) DESC,
             (og.origen = 'excel_import') DESC,
             (og.due_date = (date_trunc('month', og.due_date::timestamp)
               + INTERVAL '1 month - 1 day')::date) DESC,
             og.due_date DESC,
             og.id
         ) AS position
  FROM module_miauto_otros_gastos og
  WHERE og.tipo = 'gps' AND og.deleted_at IS NULL AND og.due_date IS NOT NULL
)
UPDATE module_miauto_otros_gastos og
SET deleted_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
FROM ranked r
WHERE r.id = og.id AND r.position > 1;

-- Los GPS futuros sin movimientos se alinean al ultimo dia del mes.
UPDATE module_miauto_otros_gastos og
SET due_date = (date_trunc('month', og.due_date::timestamp)
                  + INTERVAL '1 month - 1 day')::date,
    periodo_anio = EXTRACT(YEAR FROM og.due_date)::smallint,
    updated_at = CURRENT_TIMESTAMP
WHERE og.tipo = 'gps'
  AND og.deleted_at IS NULL
  AND og.due_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date
  AND COALESCE(og.paid_amount, 0) <= 0.005
  AND NOT EXISTS (
    SELECT 1 FROM module_miauto_gasto_pago_aplicacion pa
    WHERE pa.otros_gastos_id = og.id AND pa.reversed_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM module_miauto_comprobante_otros_gastos cp
    WHERE cp.otros_gastos_id = og.id AND cp.estado <> 'rechazado'
  );

-- Renumera solo la presentacion del ciclo; no altera importes, pagos ni estados.
WITH numbered AS (
  SELECT og.id,
         ROW_NUMBER() OVER (PARTITION BY og.ciclo_id ORDER BY og.due_date, og.id)::int AS number,
         COUNT(*) OVER (PARTITION BY og.ciclo_id)::int AS total
  FROM module_miauto_otros_gastos og
  WHERE og.tipo = 'gps' AND og.deleted_at IS NULL AND og.ciclo_id IS NOT NULL
)
UPDATE module_miauto_otros_gastos og
SET numero_cuota = -n.number,
    total_cuotas = n.total,
    updated_at = CURRENT_TIMESTAMP
FROM numbered n
WHERE n.id = og.id;

UPDATE module_miauto_otros_gastos
SET numero_cuota = ABS(numero_cuota),
    week_index = ABS(numero_cuota)
WHERE tipo = 'gps' AND deleted_at IS NULL AND numero_cuota < 0;

UPDATE module_miauto_gasto_ciclo c
SET monto_total = totals.monto_total,
    fecha_inicio = totals.fecha_inicio,
    fecha_fin = totals.fecha_fin,
    numero_cuotas = totals.numero_cuotas,
    estado = CASE WHEN totals.pending_count = 0 THEN 'completado' ELSE 'activo' END,
    updated_at = CURRENT_TIMESTAMP
FROM (
  SELECT ciclo_id, SUM(amount_due) AS monto_total, MIN(due_date) AS fecha_inicio,
         MAX(due_date) AS fecha_fin, COUNT(*)::int AS numero_cuotas,
         COUNT(*) FILTER (WHERE COALESCE(paid_amount, 0) < amount_due - 0.005) AS pending_count
  FROM module_miauto_otros_gastos
  WHERE tipo = 'gps' AND deleted_at IS NULL AND ciclo_id IS NOT NULL
  GROUP BY ciclo_id
) totals
WHERE c.id = totals.ciclo_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_miauto_gps_solicitud_month
  ON module_miauto_otros_gastos (
    solicitud_id,
    (EXTRACT(YEAR FROM due_date)),
    (EXTRACT(MONTH FROM due_date))
  )
  WHERE tipo = 'gps' AND deleted_at IS NULL AND due_date IS NOT NULL;

-- Los contratos que ya cuentan con un cronograma de gastos entran en la
-- renovacion diaria. No habilita contratos sin gastos previamente configurados.
UPDATE module_miauto_solicitud s
SET gastos_automaticos_activos = TRUE,
    updated_at = CURRENT_TIMESTAMP
WHERE s.status = 'aprobado'
  AND s.deleted_at IS NULL
  AND s.gastos_automaticos_activos = FALSE
  AND EXISTS (
    SELECT 1
    FROM module_miauto_otros_gastos og
    WHERE og.solicitud_id = s.id AND og.deleted_at IS NULL
  );
