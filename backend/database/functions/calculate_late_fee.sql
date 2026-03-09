-- Function to calculate late fee for an installment
--
-- MORA ES SEMANAL y usa la TASA DEL CICLO del préstamo (l.interest_rate = la del ciclo al desembolsar).
-- Ejemplo: saldo 23.42, 5.5% semanal (ciclo 1) → mora_semanal = 23.42 × 0.055 = 1.29 (por semana).
-- Por día: mora_por_dia = mora_semanal / 7 = 0.18. Total mora = mora_por_dia × días_vencido.
-- Tope (late_fee_cap) y tipo (linear/compound) se toman de module_rapidin_loan_conditions por país.
CREATE OR REPLACE FUNCTION calculate_late_fee(
    p_installment_id UUID,
    p_calculation_date DATE DEFAULT CURRENT_DATE
)
RETURNS DECIMAL(12, 2) AS $$
DECLARE
    v_installment RECORD;
    v_conditions RECORD;
    v_days_overdue INTEGER;
    v_late_fee DECIMAL(12, 2) := 0;
    v_base_amount DECIMAL(12, 2);
    v_tasa_semanal DECIMAL(10, 4);  -- tasa del préstamo (ciclo): % semanal (ej. 5.5)
    v_mora_semanal DECIMAL(12, 4);  -- mora por semana (ej. 1.29)
    v_mora_por_dia DECIMAL(12, 4);  -- mora por día = mora_semanal/7 (ej. 0.18)
    v_daily_rate DECIMAL(10, 6);    -- tasa diaria = tasa_semanal/7 (para compound)
BEGIN
    SELECT 
        i.*,
        l.country,
        l.total_amount,
        l.interest_rate
    INTO v_installment
    FROM module_rapidin_installments i
    JOIN module_rapidin_loans l ON l.id = i.loan_id
    WHERE i.id = p_installment_id;
    
    IF v_installment.status IN ('paid', 'cancelled') THEN
        RETURN 0;
    END IF;
    
    v_days_overdue := GREATEST(0, p_calculation_date - COALESCE(v_installment.late_fee_base_date, v_installment.due_date));
    
    IF v_days_overdue = 0 THEN
        RETURN 0;
    END IF;
    
    -- Tasa semanal = interés del préstamo (que viene del ciclo al desembolsar)
    v_tasa_semanal := COALESCE(v_installment.interest_rate, 0)::decimal;
    IF v_tasa_semanal <= 0 THEN
        RETURN 0;
    END IF;

    v_base_amount := v_installment.installment_amount - v_installment.paid_amount;
    
    -- Mora semanal = saldo × tasa_semanal del ciclo (ej. 23.42 × 0.055 = 1.29)
    v_mora_semanal := v_base_amount * (v_tasa_semanal / 100.0);
    -- Lo que se cobra por día = mora_semanal / 7 (ej. 1.29 / 7 = 0.18)
    v_mora_por_dia := v_mora_semanal / 7.0;
    v_daily_rate := v_tasa_semanal / 100.0 / 7.0;
    
    -- Tipo (linear/compound) y tope desde condiciones del país
    SELECT late_fee_type, late_fee_cap INTO v_conditions
    FROM module_rapidin_loan_conditions
    WHERE country = v_installment.country AND active = true
    ORDER BY version DESC
    LIMIT 1;
    
    IF COALESCE(v_conditions.late_fee_type, 'linear') = 'compound' THEN
        v_late_fee := v_base_amount * (POWER(1 + v_daily_rate, v_days_overdue) - 1);
    ELSE
        -- linear: total mora = (mora por día) × días
        v_late_fee := v_mora_por_dia * v_days_overdue;
    END IF;
    
    IF v_conditions.late_fee_cap IS NOT NULL AND v_conditions.late_fee_cap > 0 THEN
        v_late_fee := LEAST(v_late_fee, v_base_amount * v_conditions.late_fee_cap / 100.0);
    END IF;
    
    RETURN ROUND(v_late_fee, 2);
END;
$$ LANGUAGE plpgsql;







