BEGIN;

UPDATE module_mimoto_cuota_semanal
SET capital_paid = amount_due,
    paid_amount = GREATEST(paid_amount, amount_due),
    late_fee_total = 0,
    late_fee = 0,
    late_fee_paid = 0,
    mora_extra_total = 0,
    mora_extra = 0,
    mora_extra_paid = 0,
    mora_extra_desde = NULL,
    mora_extra_calculated_through = NULL,
    pago_puntual = FALSE,
    status = 'paid',
    generation_context = generation_context || jsonb_build_object(
      'first_week_covered_by_rule', TRUE,
      'first_week_normalized_at', CURRENT_TIMESTAMP
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE week_number = 1
  AND deleted_at IS NULL
  AND (
    status <> 'paid'
    OR capital_paid <> amount_due
    OR paid_amount < amount_due
    OR late_fee_total <> 0
    OR late_fee <> 0
    OR late_fee_paid <> 0
    OR mora_extra_total <> 0
    OR mora_extra <> 0
    OR mora_extra_paid <> 0
    OR pago_puntual
  );

DO $$ BEGIN
  ALTER TABLE module_mimoto_cuota_semanal
    ADD CONSTRAINT module_mimoto_first_week_covered_check
    CHECK (
      week_number <> 1
      OR (
        status = 'paid'
        AND capital_paid = amount_due
        AND paid_amount >= amount_due
        AND late_fee_total = 0
        AND late_fee = 0
        AND late_fee_paid = 0
        AND mora_extra_total = 0
        AND mora_extra = 0
        AND mora_extra_paid = 0
        AND pago_puntual = FALSE
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
