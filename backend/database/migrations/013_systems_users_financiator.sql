CREATE TABLE IF NOT EXISTS systems_users_financiator (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'analyst', 'approver', 'payer')),
    allowed_modules TEXT[] NOT NULL DEFAULT '{rapidin}',
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    active BOOLEAN DEFAULT true,
    last_access TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO systems_users_financiator (
    id,
    email,
    password_hash,
    first_name,
    last_name,
    role,
    allowed_modules,
    country,
    active,
    last_access,
    created_at,
    updated_at
)
SELECT
    id,
    email,
    password_hash,
    first_name,
    last_name,
    role,
    COALESCE(allowed_modules, '{rapidin}'::text[]),
    country,
    COALESCE(active, true),
    last_access,
    created_at,
    updated_at
FROM module_rapidin_users
ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    password_hash = EXCLUDED.password_hash,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    role = EXCLUDED.role,
    allowed_modules = EXCLUDED.allowed_modules,
    country = EXCLUDED.country,
    active = EXCLUDED.active,
    last_access = EXCLUDED.last_access,
    updated_at = CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_systems_users_financiator_email ON systems_users_financiator(email);
CREATE INDEX IF NOT EXISTS idx_systems_users_financiator_active ON systems_users_financiator(active);
CREATE INDEX IF NOT EXISTS idx_systems_users_financiator_role ON systems_users_financiator(role);

DROP TRIGGER IF EXISTS update_systems_users_financiator_updated_at ON systems_users_financiator;
CREATE TRIGGER update_systems_users_financiator_updated_at
    BEFORE UPDATE ON systems_users_financiator
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
