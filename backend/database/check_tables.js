import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.development' });

const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

async function checkTables() {
    try {
        await client.connect();
        console.log('✅ Conectado a la base de datos:', process.env.DB_NAME, '\n');

        // Listar todas las tablas
        const result = await client.query(`
            SELECT table_name, table_schema
            FROM information_schema.tables 
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema, table_name;
        `);

        console.log('📋 Tablas encontradas en la base de datos:\n');
        console.log('┌──────────────────────────┬──────────────┐');
        console.log('│ Tabla                     │ Schema       │');
        console.log('├──────────────────────────┼──────────────┤');
        
        result.rows.forEach(row => {
            const tableName = row.table_name.padEnd(24);
            const schema = row.table_schema.padEnd(12);
            console.log(`│ ${tableName} │ ${schema} │`);
        });
        
        console.log('└──────────────────────────┴──────────────┘\n');

        // Buscar específicamente tablas relacionadas con drivers
        const driversTables = result.rows.filter(row => 
            row.table_name.toLowerCase().includes('driver')
        );

        if (driversTables.length > 0) {
            console.log('🚗 Tablas relacionadas con drivers:\n');
            driversTables.forEach(row => {
                console.log(`   - ${row.table_schema}.${row.table_name}`);
            });
        } else {
            console.log('⚠️  No se encontraron tablas relacionadas con "driver"\n');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

checkTables();
