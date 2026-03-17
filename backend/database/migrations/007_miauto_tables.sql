-- Mi Auto: tablas propias (prefijo module_miauto_), sin FKs a préstamos Rapidin.
-- cited_by y reviewed_by opcionales a module_rapidin_users si se comparte admin.

-- Catálogo de apps en las que ha trabajado el conductor
CREATE TABLE IF NOT EXISTS module_miauto_app (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    country VARCHAR(10) CHECK (country IN ('PE', 'CO')),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Solicitudes de Mi Auto (conductores que quieren un auto)
CREATE TABLE IF NOT EXISTS module_miauto_solicitud (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
    dni VARCHAR(20) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(255),
    license_number VARCHAR(100),
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pendiente'
        CHECK (status IN ('pendiente', 'citado', 'rechazado', 'desistido', 'aprobado')),
    rejection_reason TEXT,
    cited_at TIMESTAMP,
    cited_by UUID REFERENCES module_rapidin_users(id),
    appointment_date DATE,
    reagendo_count INTEGER NOT NULL DEFAULT 0,
    reviewed_at TIMESTAMP,
    reviewed_by UUID REFERENCES module_rapidin_users(id),
    observations TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Relación solicitud <-> apps (N:M)
CREATE TABLE IF NOT EXISTS module_miauto_solicitud_app (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES module_miauto_app(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(solicitud_id, app_id)
);

-- Adjuntos (foto licencia, comprobante viajes)
CREATE TABLE IF NOT EXISTS module_miauto_adjunto (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
    tipo VARCHAR(50) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_miauto_solicitud_status ON module_miauto_solicitud(status);
CREATE INDEX IF NOT EXISTS idx_miauto_solicitud_country ON module_miauto_solicitud(country);
CREATE INDEX IF NOT EXISTS idx_miauto_solicitud_created ON module_miauto_solicitud(created_at);
CREATE INDEX IF NOT EXISTS idx_miauto_solicitud_app_solicitud ON module_miauto_solicitud_app(solicitud_id);
CREATE INDEX IF NOT EXISTS idx_miauto_adjunto_solicitud ON module_miauto_adjunto(solicitud_id);

CREATE TRIGGER update_miauto_app_updated_at
    BEFORE UPDATE ON module_miauto_app
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_miauto_solicitud_updated_at
    BEFORE UPDATE ON module_miauto_solicitud
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed apps por defecto (opcional)
INSERT INTO module_miauto_app (code, name, country) VALUES
    ('yango', 'Yango', NULL),
    ('uber', 'Uber', NULL),
    ('indriver', 'InDriver', NULL),
    ('beat', 'Beat', NULL),
    ('didii', 'Didii', NULL)
ON CONFLICT (code) DO NOTHING;
