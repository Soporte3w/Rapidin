#!/bin/bash

# Script para ejecutar el schema en la base de datos remota
# Base de datos: yego_integral
# Host: 168.119.226.236

echo "🔄 Conectando a la base de datos yego_integral..."

PGPASSWORD='37>MNA&-35+' psql -h 168.119.226.236 -U yego_user -d yego_integral -p 5432 << 'EOF'

-- Verificar si las tablas ya existen
DO $$ 
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'module_rapidin_users'
    ) THEN
        RAISE NOTICE '⚠️  Las tablas module_rapidin_* ya existen. Saltando creación...';
    ELSE
        RAISE NOTICE '✅ Creando tablas module_rapidin_*...';
    END IF;
END $$;

-- Ejecutar schema completo
\i database/schema.sql

-- Ejecutar seed data
\i database/migrations/002_seed_data.sql

-- Ejecutar triggers
\i database/triggers/rapidin_notify.sql

-- Ejecutar funciones
\i database/functions/calculate_late_fee.sql

-- Verificar tablas creadas
SELECT 
    table_name,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public' 
AND table_name LIKE 'module_rapidin_%'
ORDER BY table_name;

EOF

echo "✅ Schema aplicado correctamente!"






