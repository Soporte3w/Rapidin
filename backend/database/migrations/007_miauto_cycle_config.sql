-- Migration 007: Mi Auto Cycle Config
-- Agrega columna miauto_cycle a drivers y tabla separada de ciclos para conductores Yego Mi Auto.

ALTER TABLE module_rapidin_drivers ADD COLUMN IF NOT EXISTS miauto_cycle INTEGER DEFAULT 1;

CREATE TABLE IF NOT EXISTS module_rapidin_miauto_cycle_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    cycle INTEGER NOT NULL,
    max_credit_line DECIMAL(12, 2) NOT NULL,
    interest_rate DECIMAL(5, 2) NOT NULL,
    requires_guarantor BOOLEAN DEFAULT false,
    min_guarantor_amount DECIMAL(12, 2),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(country, cycle)
);

-- Seed PE Mi Auto cycles
INSERT INTO module_rapidin_miauto_cycle_config (country, cycle, max_credit_line, interest_rate, requires_guarantor) VALUES
    ('PE', 1, 250.00, 5.50, false),
    ('PE', 2, 250.00, 5.50, false),
    ('PE', 3, 300.00, 5.25, false),
    ('PE', 4, 300.00, 5.25, false),
    ('PE', 5, 350.00, 5.00, false),
    ('PE', 6, 350.00, 5.00, false),
    ('PE', 7, 400.00, 4.50, true),
    ('PE', 8, 400.00, 4.50, true)
ON CONFLICT (country, cycle) DO NOTHING;
