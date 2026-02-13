import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

async function checkDriversTable() {
    try {
        await client.connect();
        console.log('✅ Conectado a la base de datos\n');

        // Obtener estructura de la tabla
        const result = await client.query(`
            SELECT 
                column_name, 
                data_type, 
                character_maximum_length,
                is_nullable,
                column_default
            FROM information_schema.columns 
            WHERE table_name = 'module_rapidin_drivers' 
            ORDER BY ordinal_position;
        `);

        console.log('📋 Estructura de la tabla module_rapidin_drivers:\n');
        console.log('┌────────────────────────┬──────────────────┬─────────┬──────────┬────────────────┐');
        console.log('│ Campo                  │ Tipo             │ Tamaño  │ Nullable │ Default        │');
        console.log('├────────────────────────┼──────────────────┼─────────┼──────────┼────────────────┤');

        result.rows.forEach(row => {
            const field = row.column_name.padEnd(22);
            const type = row.data_type.padEnd(16);
            const length = (row.character_maximum_length || '-').toString().padEnd(7);
            const nullable = row.is_nullable.padEnd(8);
            const defaultVal = (row.column_default || '-').substring(0, 14).padEnd(14);
            console.log(`│ ${field} │ ${type} │ ${length} │ ${nullable} │ ${defaultVal} │`);
        });

        console.log('└────────────────────────┴──────────────────┴─────────┴──────────┴────────────────┘\n');

        // Verificar si hay conductores en la tabla
        const countResult = await client.query('SELECT COUNT(*) as total FROM module_rapidin_drivers');
        console.log(`📊 Total de conductores registrados: ${countResult.rows[0].total}\n`);

        // Mostrar algunos ejemplos si existen
        if (parseInt(countResult.rows[0].total) > 0) {
            const sampleResult = await client.query('SELECT dni, first_name, last_name, phone, email, country FROM module_rapidin_drivers LIMIT 3');
            console.log('👥 Ejemplos de conductores:');
            console.table(sampleResult.rows);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

checkDriversTable();






