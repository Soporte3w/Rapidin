CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS systems_roles_financiator (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    base_role TEXT NOT NULL CHECK (base_role IN ('admin', 'analyst', 'approver', 'payer')),
    allowed_modules TEXT[] NOT NULL DEFAULT '{rapidin}',
    active BOOLEAN NOT NULL DEFAULT true,
    system_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_systems_roles_financiator_active
ON systems_roles_financiator(active);

CREATE OR REPLACE FUNCTION update_systems_roles_financiator_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_systems_roles_financiator_updated_at ON systems_roles_financiator;
CREATE TRIGGER trigger_update_systems_roles_financiator_updated_at
    BEFORE UPDATE ON systems_roles_financiator
    FOR EACH ROW
    EXECUTE FUNCTION update_systems_roles_financiator_updated_at();

INSERT INTO systems_roles_financiator
    (code, name, description, base_role, allowed_modules, system_default)
VALUES
    ('admin', 'Administrador', 'Acceso administrativo completo.', 'admin', ARRAY[
      'rapidin','rapidin.dashboard','rapidin.solicitudes','rapidin.nueva_solicitud','rapidin.prestamos','rapidin.pagos','rapidin.cobros_masivos','rapidin.analisis','rapidin.provisiones','rapidin.configuracion','rapidin.usuarios',
      'miauto','miauto.nueva_solicitud','miauto.solicitudes','miauto.alquiler_venta','miauto.pagos','miauto.validar_comprobantes','miauto.mensajes','miauto.analisis','miauto.configuracion','miauto.usuarios',
      'mimoto','mimoto.dashboard','mimoto.nueva_solicitud','mimoto.prestamos','mimoto.pagos','mimoto.analisis','mimoto.configuracion'
    ], true),
    ('analyst', 'Analista', 'Revisión y análisis operativo.', 'analyst', ARRAY[
      'rapidin','rapidin.dashboard','rapidin.solicitudes','rapidin.analisis','rapidin.provisiones'
    ], true),
    ('approver', 'Aprobador', 'Aprobación de solicitudes y flujos operativos.', 'approver', ARRAY[
      'rapidin','rapidin.dashboard','rapidin.solicitudes','rapidin.nueva_solicitud','rapidin.prestamos','rapidin.analisis'
    ], true),
    ('payer', 'Pagador', 'Gestión de pagos y cobranzas.', 'payer', ARRAY[
      'rapidin','rapidin.dashboard','rapidin.pagos','rapidin.cobros_masivos'
    ], true)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    base_role = EXCLUDED.base_role,
    system_default = true,
    updated_at = CURRENT_TIMESTAMP;

