-- Corrige la Semana 38 del contrato CRL047, cuyo recaudo fue tomado del mismo
-- driver_id_fleet que ya estaba asociado al contrato CYK434. El cobro Fleet
-- efectivamente acreditado se conserva; solo se retira el recaudo duplicado.
WITH target AS MATERIALIZED (
  SELECT c.id, c.solicitud_id, c.week_start_date,
         c.num_viajes, c.partner_fees_raw, c.partner_fees_83,
         c.partner_fees_yango_raw, c.amount_due, c.paid_amount,
         c.cobro_desde_saldo_conductor, c.status
  FROM module_miauto_cuota_semanal c
  INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
  WHERE c.id = 'f76513b5-62db-4e6a-a551-8a60314cc40e'::uuid
    AND c.solicitud_id = '90ae700e-38e6-4037-b682-0087ef95cc12'::uuid
    AND c.week_start_date = DATE '2026-08-03'
    AND c.deleted_at IS NULL
    AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '[^A-Z0-9]', '', 'g')) = 'CRL047'
    AND c.num_viajes = 0
    AND c.partner_fees_raw = 278.86
    AND c.partner_fees_83 = 232.37
    AND c.partner_fees_yango_raw = 278.86
    AND c.amount_due = 287.63
    AND c.paid_amount = 260.00
    AND c.cobro_desde_saldo_conductor = 260.00
  FOR UPDATE OF c
), corrected AS (
  UPDATE module_miauto_cuota_semanal c
  SET partner_fees_raw = 0,
      partner_fees_83 = 0,
      partner_fees_yango_raw = NULL,
      amount_due = 520.00,
      status = 'partial',
      updated_at = CURRENT_TIMESTAMP
  FROM target t
  WHERE c.id = t.id
  RETURNING c.id, c.solicitud_id, c.week_start_date,
            c.num_viajes, c.partner_fees_raw, c.partner_fees_83,
            c.partner_fees_yango_raw, c.amount_due, c.paid_amount,
            c.cobro_desde_saldo_conductor, c.status
)
INSERT INTO module_miauto_billing_audit_trail
  (cuota_semanal_id, solicitud_id, week_start_date, semana_ordinal,
   event_type, billing_context, generated_by)
SELECT corrected.id,
       corrected.solicitud_id,
       corrected.week_start_date,
       38,
       'corrected',
       jsonb_build_object(
         'reason', 'weekly_income_duplicated_across_contracts',
         'plate', 'CRL047',
         'previous', jsonb_build_object(
           'num_viajes', target.num_viajes,
           'partner_fees_raw', target.partner_fees_raw,
           'partner_fees_83', target.partner_fees_83,
           'partner_fees_yango_raw', target.partner_fees_yango_raw,
           'amount_due', target.amount_due,
           'paid_amount', target.paid_amount,
           'cobro_desde_saldo_conductor', target.cobro_desde_saldo_conductor,
           'status', target.status
         ),
         'corrected', jsonb_build_object(
           'num_viajes', corrected.num_viajes,
           'partner_fees_raw', corrected.partner_fees_raw,
           'partner_fees_83', corrected.partner_fees_83,
           'partner_fees_yango_raw', corrected.partner_fees_yango_raw,
           'amount_due', corrected.amount_due,
           'paid_amount', corrected.paid_amount,
           'cobro_desde_saldo_conductor', corrected.cobro_desde_saldo_conductor,
           'status', corrected.status
         )
       ),
       'data_migration_051'
FROM corrected
INNER JOIN target ON target.id = corrected.id;
