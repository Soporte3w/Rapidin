-- Tipo de cambio (valor del dólar) por país para Mi Auto
CREATE TABLE IF NOT EXISTS module_miauto_tipo_cambio (
  country VARCHAR(10) NOT NULL PRIMARY KEY CHECK (country IN ('PE', 'CO')),
  moneda_local VARCHAR(10) NOT NULL CHECK (moneda_local IN ('PEN', 'COP')),
  valor_usd_a_local DECIMAL(12,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by UUID
);

CREATE INDEX IF NOT EXISTS idx_miauto_tipo_cambio_country ON module_miauto_tipo_cambio(country);
