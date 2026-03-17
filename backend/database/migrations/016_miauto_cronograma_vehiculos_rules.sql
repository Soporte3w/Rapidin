-- Cronogramas Mi Auto (estructura espejo de YegoMiAutoConfig)
CREATE TABLE IF NOT EXISTS module_miauto_cronograma (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  country VARCHAR(10) NOT NULL CHECK (country IN ('PE', 'CO')),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS module_miauto_cronograma_vehiculo (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cronograma_id UUID NOT NULL REFERENCES module_miauto_cronograma(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  inicial DECIMAL(12,2) NOT NULL DEFAULT 0,
  inicial_moneda VARCHAR(10) NOT NULL DEFAULT 'USD' CHECK (inicial_moneda IN ('USD', 'PEN')),
  cuotas_semanales INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS module_miauto_cronograma_rule (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cronograma_id UUID NOT NULL REFERENCES module_miauto_cronograma(id) ON DELETE CASCADE,
  viajes VARCHAR(255) DEFAULT '',
  bono_auto DECIMAL(12,2) NOT NULL DEFAULT 0,
  bono_auto_moneda VARCHAR(10) NOT NULL DEFAULT 'PEN' CHECK (bono_auto_moneda IN ('USD', 'PEN')),
  cuotas_por_vehiculo JSONB NOT NULL DEFAULT '[]',
  cuota_moneda_por_vehiculo JSONB NOT NULL DEFAULT '[]',
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_miauto_cronograma_country ON module_miauto_cronograma(country);
CREATE INDEX IF NOT EXISTS idx_miauto_cronograma_active ON module_miauto_cronograma(active);
CREATE INDEX IF NOT EXISTS idx_miauto_cronograma_vehiculo_cronograma ON module_miauto_cronograma_vehiculo(cronograma_id);
CREATE INDEX IF NOT EXISTS idx_miauto_cronograma_rule_cronograma ON module_miauto_cronograma_rule(cronograma_id);
