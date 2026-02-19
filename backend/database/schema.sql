-- Yego Rapidín 4.0 - Database Schema
-- PostgreSQL 14+

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Users table
CREATE TABLE IF NOT EXISTS module_rapidin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'analyst', 'approver', 'payer')),
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    active BOOLEAN DEFAULT true,
    last_access TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drivers table
CREATE TABLE IF NOT EXISTS module_rapidin_drivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    dni VARCHAR(20) NOT NULL,
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(255),
    yego_premium BOOLEAN DEFAULT false,
    cycle INTEGER DEFAULT 1,
    credit_line DECIMAL(12, 2) DEFAULT 0,
    completed_trips INTEGER DEFAULT 0,
    acceptance_rate DECIMAL(5, 2) DEFAULT 0,
    active BOOLEAN DEFAULT true,
    external_driver_id VARCHAR(100),
    park_id VARCHAR(100),
    license VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dni, country)
);

-- Loan requests table
CREATE TABLE IF NOT EXISTS module_rapidin_loan_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_id UUID REFERENCES module_rapidin_drivers(id),
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    requested_amount DECIMAL(12, 2) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending' 
        CHECK (status IN ('pending', 'rejected', 'approved', 'signed', 'disbursed', 'cancelled')),
    rejection_reason TEXT,
    observations TEXT,
    created_by UUID REFERENCES module_rapidin_users(id),
    approved_by UUID REFERENCES module_rapidin_users(id),
    approved_at TIMESTAMP,
    disbursed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    cycle INTEGER DEFAULT 1
);

-- Loans table
CREATE TABLE IF NOT EXISTS module_rapidin_loans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id UUID REFERENCES module_rapidin_loan_requests(id) UNIQUE,
    driver_id UUID REFERENCES module_rapidin_drivers(id) NOT NULL,
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    disbursed_amount DECIMAL(12, 2) NOT NULL,
    total_amount DECIMAL(12, 2) NOT NULL,
    interest_rate DECIMAL(5, 2) NOT NULL,
    number_of_installments INTEGER NOT NULL,
    payment_frequency VARCHAR(20) DEFAULT 'weekly',
    disbursed_at TIMESTAMP NOT NULL,
    first_payment_date DATE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active' 
        CHECK (status IN ('active', 'cancelled', 'defaulted')),
    pending_balance DECIMAL(12, 2) NOT NULL,
    requires_guarantor BOOLEAN DEFAULT false,
    guarantor_name VARCHAR(255),
    guarantor_dni VARCHAR(20),
    guarantor_phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Installments table
CREATE TABLE IF NOT EXISTS module_rapidin_installments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_id UUID REFERENCES module_rapidin_loans(id) ON DELETE CASCADE NOT NULL,
    installment_number INTEGER NOT NULL,
    installment_amount DECIMAL(12, 2) NOT NULL,
    principal_amount DECIMAL(12, 2) NOT NULL,
    interest_amount DECIMAL(12, 2) NOT NULL,
    due_date DATE NOT NULL,
    paid_date DATE,
    paid_amount DECIMAL(12, 2) DEFAULT 0,
    late_fee DECIMAL(12, 2) DEFAULT 0,
    paid_late_fee DECIMAL(12, 2) DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'pending' 
        CHECK (status IN ('pending', 'paid', 'overdue', 'cancelled')),
    days_overdue INTEGER DEFAULT 0,
    late_fee_base_date DATE NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(loan_id, installment_number)
);

-- Payments table
CREATE TABLE IF NOT EXISTS module_rapidin_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_id UUID REFERENCES module_rapidin_loans(id) NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    payment_date DATE NOT NULL,
    payment_method VARCHAR(50) DEFAULT 'manual',
    observations TEXT,
    registered_by UUID REFERENCES module_rapidin_users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payment installments distribution table
CREATE TABLE IF NOT EXISTS module_rapidin_payment_installments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id UUID REFERENCES module_rapidin_payments(id) ON DELETE CASCADE NOT NULL,
    installment_id UUID REFERENCES module_rapidin_installments(id) NOT NULL,
    applied_amount DECIMAL(12, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(payment_id, installment_id)
);

-- Log de cobros automáticos (job diario Yango)
CREATE TABLE IF NOT EXISTS module_rapidin_auto_payment_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_id UUID REFERENCES module_rapidin_loans(id) ON DELETE SET NULL,
    installment_id UUID REFERENCES module_rapidin_installments(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES module_rapidin_drivers(id) ON DELETE SET NULL,
    external_driver_id VARCHAR(100),
    driver_first_name VARCHAR(255),
    driver_last_name VARCHAR(255),
    flota VARCHAR(255),
    amount_to_charge DECIMAL(12, 2) NOT NULL,
    amount_charged DECIMAL(12, 2) DEFAULT 0,
    installment_number INTEGER,
    status VARCHAR(50) NOT NULL CHECK (status IN ('success', 'failed', 'partial')),
    reason TEXT,
    balance_at_attempt DECIMAL(12, 2),
    payment_id UUID REFERENCES module_rapidin_payments(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payment vouchers table (vouchers subidos por conductores)
CREATE TABLE IF NOT EXISTS module_rapidin_payment_vouchers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_id UUID REFERENCES module_rapidin_loans(id) NOT NULL,
    driver_id UUID REFERENCES module_rapidin_drivers(id) NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    payment_date DATE NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    observations TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by UUID REFERENCES module_rapidin_users(id),
    reviewed_at TIMESTAMP,
    rejection_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Voucher installments table (asociar vouchers con cuotas específicas)
CREATE TABLE IF NOT EXISTS module_rapidin_voucher_installments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    voucher_id UUID REFERENCES module_rapidin_payment_vouchers(id) ON DELETE CASCADE NOT NULL,
    installment_id UUID REFERENCES module_rapidin_installments(id) NOT NULL,
    applied_amount DECIMAL(12, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(voucher_id, installment_id)
);

-- Condiciones de préstamo (por país): MORA y reglas generales. NO es la tasa de interés del crédito.
-- Usado por: calculate_late_fee (mora), reglas de plazos (min_weeks, max_weeks), día de pago.
CREATE TABLE IF NOT EXISTS module_rapidin_loan_conditions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    version INTEGER NOT NULL DEFAULT 1,
    active BOOLEAN DEFAULT true,
    late_fee_type VARCHAR(20) DEFAULT 'linear' CHECK (late_fee_type IN ('linear', 'compound')),
    late_fee_rate DECIMAL(5, 2) NOT NULL,
    late_fee_cap DECIMAL(5, 2),
    initial_wait_days INTEGER DEFAULT 7,
    payment_day_of_week INTEGER DEFAULT 1 CHECK (payment_day_of_week BETWEEN 0 AND 6),
    min_weeks INTEGER DEFAULT 4,
    max_weeks INTEGER DEFAULT 24,
    created_by UUID REFERENCES module_rapidin_users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(country, version)
);

-- Configuración por ciclo (país + ciclo): TASA DE INTERÉS del préstamo (cronograma), línea de crédito, garante.
-- interest_rate = tasa que se aplica al préstamo (ej. 5.5% semanal ciclo 1 PE). Es la que usa la simulación.
CREATE TABLE IF NOT EXISTS module_rapidin_cycle_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    cycle INTEGER NOT NULL,
    max_credit_line DECIMAL(12, 2) NOT NULL,
    interest_rate DECIMAL(5, 2) NOT NULL,
    interest_rate_type VARCHAR(10) CHECK (interest_rate_type IN ('TEA', 'TES', 'TED')),
    reference_rate_id UUID REFERENCES module_rapidin_interest_rates(id),
    requires_guarantor BOOLEAN DEFAULT false,
    min_guarantor_amount DECIMAL(12, 2),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(country, cycle)
);

-- Tasas de referencia (opcional): TEA/TES/TED por país. No es la tasa aplicada al préstamo.
-- cycle_config.reference_rate_id puede apuntar aquí para auditoría o futura fórmula (ej. tasa = referencia + spread).
CREATE TABLE IF NOT EXISTS module_rapidin_interest_rates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    rate_type VARCHAR(10) NOT NULL CHECK (rate_type IN ('TEA', 'TES', 'TED')),
    rate_value DECIMAL(10, 4) NOT NULL,
    effective_date DATE NOT NULL,
    active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES module_rapidin_users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Notifications table
CREATE TABLE IF NOT EXISTS module_rapidin_notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_id UUID REFERENCES module_rapidin_drivers(id),
    loan_id UUID REFERENCES module_rapidin_loans(id),
    type VARCHAR(50) NOT NULL,
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('whatsapp', 'email', 'sms')),
    recipient VARCHAR(255) NOT NULL,
    subject VARCHAR(255),
    message TEXT NOT NULL,
    sent BOOLEAN DEFAULT false,
    sent_at TIMESTAMP,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Role country permissions table
CREATE TABLE IF NOT EXISTS module_rapidin_role_country_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role VARCHAR(50) NOT NULL,
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(role, country)
);

-- User country permissions table
CREATE TABLE IF NOT EXISTS module_rapidin_user_country_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES module_rapidin_users(id) ON DELETE CASCADE NOT NULL,
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, country)
);

-- Provisions table
CREATE TABLE IF NOT EXISTS module_rapidin_provisions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    calculation_date DATE NOT NULL,
    total_amount DECIMAL(15, 2) NOT NULL,
    provisioned_amount DECIMAL(15, 2) NOT NULL,
    provision_percentage DECIMAL(5, 2) NOT NULL,
    active_loans INTEGER NOT NULL,
    overdue_loans INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(country, calculation_date)
);

-- Documents table (loan_id NULL hasta que se apruebe la solicitud; request_id vincula con la solicitud)
CREATE TABLE IF NOT EXISTS module_rapidin_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_id UUID REFERENCES module_rapidin_loans(id),
    request_id UUID REFERENCES module_rapidin_loan_requests(id),
    type VARCHAR(50) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    signed BOOLEAN DEFAULT false,
    signed_at TIMESTAMP,
    signed_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Loan conditions history table
CREATE TABLE IF NOT EXISTS module_rapidin_loan_conditions_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    condition_id UUID REFERENCES module_rapidin_loan_conditions(id),
    modified_field VARCHAR(100) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    modified_by UUID REFERENCES module_rapidin_users(id),
    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for optimization
CREATE INDEX IF NOT EXISTS idx_drivers_dni_country ON module_rapidin_drivers(dni, country);
CREATE INDEX IF NOT EXISTS idx_drivers_cycle ON module_rapidin_drivers(cycle);
CREATE INDEX IF NOT EXISTS idx_loan_requests_status ON module_rapidin_loan_requests(status);
CREATE INDEX IF NOT EXISTS idx_loan_requests_driver ON module_rapidin_loan_requests(driver_id);
CREATE INDEX IF NOT EXISTS idx_loan_requests_country ON module_rapidin_loan_requests(country);
CREATE INDEX IF NOT EXISTS idx_loans_driver ON module_rapidin_loans(driver_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON module_rapidin_loans(status);
CREATE INDEX IF NOT EXISTS idx_installments_loan ON module_rapidin_installments(loan_id);
CREATE INDEX IF NOT EXISTS idx_installments_due_date ON module_rapidin_installments(due_date);
CREATE INDEX IF NOT EXISTS idx_installments_status ON module_rapidin_installments(status);
CREATE INDEX IF NOT EXISTS idx_payments_loan ON module_rapidin_payments(loan_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON module_rapidin_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_notifications_driver ON module_rapidin_notifications(driver_id);
CREATE INDEX IF NOT EXISTS idx_notifications_sent ON module_rapidin_notifications(sent);
CREATE INDEX IF NOT EXISTS idx_permissions_user ON module_rapidin_user_country_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_provisions_date ON module_rapidin_provisions(calculation_date);

-- Function to automatically update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to update updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON module_rapidin_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_drivers_updated_at BEFORE UPDATE ON module_rapidin_drivers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_loan_requests_updated_at BEFORE UPDATE ON module_rapidin_loan_requests
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_loans_updated_at BEFORE UPDATE ON module_rapidin_loans
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_installments_updated_at BEFORE UPDATE ON module_rapidin_installments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_cycle_config_updated_at BEFORE UPDATE ON module_rapidin_cycle_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_interest_rates_updated_at BEFORE UPDATE ON module_rapidin_interest_rates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();






