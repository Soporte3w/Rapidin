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

async function testDriverQuery() {
    try {
        await client.connect();
        console.log('✅ Conectado a la base de datos\n');

        // Test 1: Ver algunos números de ejemplo
        console.log('📋 Ejemplos de números en la tabla drivers:\n');
        const sampleResult = await client.query(`
            SELECT phone, license_country, active, first_name, last_name 
            FROM drivers 
            WHERE active = true
            LIMIT 10
        `);
        console.table(sampleResult.rows);

        // Test 2: Probar búsqueda con un número de ejemplo
        if (sampleResult.rows.length > 0) {
            const testPhone = sampleResult.rows[0].phone;
            const testCountry = sampleResult.rows[0].license_country;

            console.log(`\n🔍 Probando búsqueda con: ${testPhone} (${testCountry})\n`);

            const testResult = await client.query(`
                SELECT phone, license_country, active, first_name, last_name, document_number 
                FROM drivers 
                WHERE phone = $1 AND license_country = $2 AND active = true
                LIMIT 1
            `, [testPhone, testCountry]);

            if (testResult.rows.length > 0) {
                console.log('✅ Conductor encontrado:');
                console.table(testResult.rows);
            } else {
                console.log('❌ No se encontró el conductor');
            }
        }

        // Test 3: Contar conductores activos por país
        console.log('\n📊 Conductores activos por país:\n');
        const statsResult = await client.query(`
            SELECT license_country, COUNT(*) as total
            FROM drivers
            WHERE active = true
            GROUP BY license_country
            ORDER BY license_country
        `);
        console.table(statsResult.rows);

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error);
    } finally {
        await client.end();
    }
}

testDriverQuery();






