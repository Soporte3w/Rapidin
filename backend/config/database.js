import pkg from 'pg';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

const { Pool } = pkg;
dotenv.config();

const pool = new Pool({
    host: process.env.DB_HOST || '168.119.226.236',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'yego_integral',
    user: process.env.DB_USER || 'yego_user',
    password: process.env.DB_PASSWORD || '37>MNA&-35+',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
});

// Cache para evitar establecer search_path múltiples veces por conexión
const connectionSearchPathSet = new WeakSet();

pool.on('connect', async (client) => {
    // Establecer search_path solo una vez por conexión
    if (!connectionSearchPathSet.has(client)) {
        try {
            await client.query('SET search_path TO public, "$user"');
            connectionSearchPathSet.add(client);
        } catch (err) {
            logger.error('Error estableciendo search_path', err);
        }
    }
    logger.info('Conexión a PostgreSQL establecida');
});

pool.on('error', (err) => {
    logger.error('Error inesperado en el pool de PostgreSQL', err);
    process.exit(-1);
});

export const query = async (text, params) => {
    const start = Date.now();
    const client = await pool.connect();
    try {
        // Asegurar que el search_path esté configurado en esta conexión
        // Usar un flag simple en lugar de WeakSet para evitar problemas
        const clientId = client.processID || Math.random();
        if (!connectionSearchPathSet.has(client)) {
            await client.query('SET search_path TO public, "$user"');
            connectionSearchPathSet.add(client);
        }
        const res = await client.query(text, params);
        const duration = Date.now() - start;
        logger.debug('Query ejecutada', { text, duration, rows: res.rowCount });
        return res;
    } catch (error) {
        logger.error('Error en query', { text, error: error.message, stack: error.stack });
        throw error;
    } finally {
        client.release();
    }
};

export const getClient = async () => {
    const client = await pool.connect();
    return client;
};

export default pool;







