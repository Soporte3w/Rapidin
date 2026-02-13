-- Migration 002: Initial data

-- Default admin user (password: admin123)
INSERT INTO module_rapidin_users (email, password_hash, first_name, last_name, role, country, active)
VALUES 
    ('admin@rapidin.com', '$2a$10$rOzJqZqZqZqZqZqZqZqZqOqZqZqZqZqZqZqZqZqZqZqZqZqZqZqZq', 'Admin', 'System', 'admin', 'PE', true)
ON CONFLICT (email) DO NOTHING;

-- Role country permissions (admin has access to all countries)
INSERT INTO module_rapidin_role_country_permissions (role, country)
VALUES 
    ('admin', 'PE'),
    ('admin', 'CO'),
    ('analyst', 'PE'),
    ('analyst', 'CO'),
    ('approver', 'PE'),
    ('approver', 'CO'),
    ('payer', 'PE'),
    ('payer', 'CO')
ON CONFLICT (role, country) DO NOTHING;

-- Default loan conditions for Peru (mora 5% semanal)
INSERT INTO module_rapidin_loan_conditions (country, version, active, late_fee_type, late_fee_rate, late_fee_cap, initial_wait_days, payment_day_of_week, min_weeks, max_weeks)
VALUES 
    ('PE', 1, true, 'linear', 5.0, 50.0, 7, 1, 4, 24)
ON CONFLICT (country, version) DO NOTHING;

-- Default loan conditions for Colombia
INSERT INTO module_rapidin_loan_conditions (country, version, active, late_fee_type, late_fee_rate, late_fee_cap, initial_wait_days, payment_day_of_week, min_weeks, max_weeks)
VALUES 
    ('CO', 1, true, 'linear', 2.5, 50.0, 7, 1, 4, 24)
ON CONFLICT (country, version) DO NOTHING;

-- Cycle configuration for Peru (ciclo 1 = 5.50% semanal)
INSERT INTO module_rapidin_cycle_config (country, cycle, max_credit_line, interest_rate, requires_guarantor, min_guarantor_amount, active)
VALUES 
    ('PE', 1, 500.00, 5.50, false, NULL, true),
    ('PE', 2, 1000.00, 4.5, false, NULL, true),
    ('PE', 3, 2000.00, 4.0, true, 1000.00, true),
    ('PE', 4, 3000.00, 3.5, true, 2000.00, true),
    ('PE', 5, 5000.00, 3.0, true, 3000.00, true)
ON CONFLICT (country, cycle) DO NOTHING;

-- Cycle configuration for Colombia
INSERT INTO module_rapidin_cycle_config (country, cycle, max_credit_line, interest_rate, requires_guarantor, min_guarantor_amount, active)
VALUES 
    ('CO', 1, 500000.00, 5.0, false, NULL, true),
    ('CO', 2, 1000000.00, 4.5, false, NULL, true),
    ('CO', 3, 2000000.00, 4.0, true, 1000000.00, true),
    ('CO', 4, 3000000.00, 3.5, true, 2000000.00, true),
    ('CO', 5, 5000000.00, 3.0, true, 3000000.00, true)
ON CONFLICT (country, cycle) DO NOTHING;







