-- Function to calculate late fee for an installment
--
-- MORA por país del préstamo: se usa module_rapidin_loan_conditions según loan.country (PE o CO).
-- Se toma la condición activa de ese país (ORDER BY version DESC): cada país tiene su tasa.
-- Tasa diaria = tasa_semanal / 7 (ej. 5% semanal → 5/7 % por día; en decimal: 5/100/7).
-- Fórmula linear: mora = saldo_pendiente × (tasa_semanal/100/7) × días_vencido.
-- Ej. PE 5%, 2 días, saldo 25.50: mora = 25.50 × (5/100/7) × 2 = 0.36. Tope: late_fee_cap %.
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
    v_daily_rate DECIMAL(10, 6);
BEGIN
    -- Get installment and loan data
    SELECT 
        i.*,
        l.country,
        l.total_amount
    INTO v_installment
    FROM module_rapidin_installments i
    JOIN module_rapidin_loans l ON l.id = i.loan_id
    WHERE i.id = p_installment_id;
    
    -- If installment is paid or cancelled, no late fee
    IF v_installment.status IN ('paid', 'cancelled') THEN
        RETURN 0;
    END IF;
    
    -- Días de mora: desde due_date o, si hubo pago parcial, desde late_fee_base_date (día en que pagó)
    v_days_overdue := GREATEST(0, p_calculation_date - COALESCE(v_installment.late_fee_base_date, v_installment.due_date));
    
    IF v_days_overdue = 0 THEN
        RETURN 0;
    END IF;
    
    -- Condición de mora del país del préstamo (PE o CO); se usa la versión activa más reciente
    SELECT * INTO v_conditions
    FROM module_rapidin_loan_conditions
    WHERE country = v_installment.country AND active = true
    ORDER BY version DESC
    LIMIT 1;

    IF v_conditions IS NULL THEN
        RETURN 0;
    END IF;

    -- Calculate base amount (pending installment amount)
    v_base_amount := v_installment.installment_amount - v_installment.paid_amount;
    
    -- Tasa diaria = (tasa_semanal / 7); ej. 5% semanal → 5/7 % por día → en decimal 5/100/7
    v_daily_rate := v_conditions.late_fee_rate / 100.0 / 7.0;
    
    -- Calculate late fee by type
    IF v_conditions.late_fee_type = 'linear' THEN
        v_late_fee := v_base_amount * v_daily_rate * v_days_overdue;
    ELSIF v_conditions.late_fee_type = 'compound' THEN
        v_late_fee := v_base_amount * (POWER(1 + v_daily_rate, v_days_overdue) - 1);
    END IF;
    
    -- Apply cap if exists
    IF v_conditions.late_fee_cap IS NOT NULL THEN
        v_late_fee := LEAST(v_late_fee, v_base_amount * v_conditions.late_fee_cap / 100.0);
    END IF;
    
    RETURN ROUND(v_late_fee, 2);
END;
$$ LANGUAGE plpgsql;







