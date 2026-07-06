CREATE TABLE IF NOT EXISTS module_miauto_nota_venta (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
    facturador_sale_note_id INTEGER NOT NULL,
    number_full VARCHAR(50),
    external_id VARCHAR(120),
    print_a4 TEXT,
    customer_id INTEGER NOT NULL,
    currency_type_id VARCHAR(10) NOT NULL DEFAULT 'PEN',
    exchange_rate_sale NUMERIC(12,4),
    total NUMERIC(12,2) NOT NULL DEFAULT 0,
    payload JSONB,
    response JSONB,
    cash_response JSONB,
    created_by UUID REFERENCES module_rapidin_users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS module_miauto_nota_venta_cuota (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nota_venta_id UUID NOT NULL REFERENCES module_miauto_nota_venta(id) ON DELETE CASCADE,
    cuota_semanal_id UUID NOT NULL REFERENCES module_miauto_cuota_semanal(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (cuota_semanal_id)
);

CREATE INDEX IF NOT EXISTS idx_miauto_nota_venta_solicitud
    ON module_miauto_nota_venta(solicitud_id);

CREATE INDEX IF NOT EXISTS idx_miauto_nota_venta_cuota_nota
    ON module_miauto_nota_venta_cuota(nota_venta_id);
