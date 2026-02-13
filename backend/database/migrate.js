import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cargar variables de entorno
dotenv.config();

const client = new Client({
    host: process.env.DB_HOST || '168.119.226.236',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'yego_integral',
    user: process.env.DB_USER || 'yego_user',
    password: process.env.DB_PASSWORD || '37>MNA&-35+',
});

async function applySchema() {
    try {
        console.log('🔄 Conectando a la base de datos yego_integral...');
        await client.connect();
        console.log('✅ Conectado exitosamente\n');

        // 1. Verificar si las tablas ya existen
        console.log('📋 Verificando tablas existentes...');
        const checkResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name LIKE 'module_rapidin_%'
      ORDER BY table_name;
    `);

        if (checkResult.rows.length > 0) {
            console.log('⚠️  Las siguientes tablas ya existen:');
            checkResult.rows.forEach(row => console.log(`   - ${row.table_name}`));
            console.log('\n¿Deseas continuar? (Se omitirán las creaciones duplicadas)');
        } else {
            console.log('✅ No hay tablas module_rapidin_* existentes\n');
        }

        // 2. Ejecutar schema
        console.log('🔄 Aplicando schema.sql...');
        const schemaSQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        await client.query(schemaSQL);
        console.log('✅ Schema aplicado correctamente\n');

        // 3. Ejecutar seed data
        console.log('🔄 Aplicando seed data...');
        const seedSQL = fs.readFileSync(path.join(__dirname, 'migrations', '002_seed_data.sql'), 'utf8');
        await client.query(seedSQL);
        console.log('✅ Datos iniciales cargados\n');

        // 4. Ejecutar triggers
        console.log('🔄 Aplicando triggers...');
        const triggersSQL = fs.readFileSync(path.join(__dirname, 'triggers', 'rapidin_notify.sql'), 'utf8');
        await client.query(triggersSQL);
        console.log('✅ Triggers creados\n');

        // 5. Ejecutar funciones
        console.log('🔄 Aplicando funciones...');
        const functionsSQL = fs.readFileSync(path.join(__dirname, 'functions', 'calculate_late_fee.sql'), 'utf8');
        await client.query(functionsSQL);
        console.log('✅ Funciones creadas\n');

        // 6. Verificar resultado final
        console.log('📊 Verificando tablas creadas...\n');
        const finalResult = await client.query(`
      SELECT 
        table_name,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
      FROM information_schema.tables t
      WHERE table_schema = 'public' 
      AND table_name LIKE 'module_rapidin_%'
      ORDER BY table_name;
    `);

        console.log('Tablas creadas:');
        console.log('┌─────────────────────────────────────────┬──────────┐');
        console.log('│ Tabla                                   │ Columnas │');
        console.log('├─────────────────────────────────────────┼──────────┤');
        finalResult.rows.forEach(row => {
            const tableName = row.table_name.padEnd(39);
            const columnCount = row.column_count.toString().padStart(8);
            console.log(`│ ${tableName} │ ${columnCount} │`);
        });
        console.log('└─────────────────────────────────────────┴──────────┘\n');

        console.log(`✅ ¡Migración completada! Total de tablas: ${finalResult.rows.length}`);

    } catch (error) {
        console.error('❌ Error durante la migración:', error.message);
        console.error(error);
        process.exit(1);
    } finally {
        await client.end();
    }
}

applySchema();
