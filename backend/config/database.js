import pkg from 'pg';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';
import { AsyncLocalStorage } from 'async_hooks';
import { asyncLocalStorage } from '../utils/logger.js';

const { Pool } = pkg;
dotenv.config();

const positiveNumberFromEnv = (name, fallback) => {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const poolOpts = {
    max: positiveNumberFromEnv('DB_POOL_MAX', 20),
    idleTimeoutMillis: positiveNumberFromEnv('DB_POOL_IDLE_TIMEOUT_MS', 120000),
    connectionTimeoutMillis: positiveNumberFromEnv('DB_POOL_CONNECTION_TIMEOUT_MS', 30000),
    keepAlive: true,
    keepAliveInitialDelayMillis: positiveNumberFromEnv('DB_KEEPALIVE_INITIAL_DELAY_MS', 10000),
    application_name: process.env.DB_APPLICATION_NAME?.trim() || 'rapidin-api',
    // Se envía en el startup packet. Así no se ejecuta un SET concurrente con
    // la primera consulta de una conexión recién creada.
    options: process.env.DB_CONNECTION_OPTIONS?.trim() || '-c search_path=public',
};

const databaseUrl = process.env.DATABASE_URL?.trim();

let pool;
if (databaseUrl) {
    pool = new Pool({
        connectionString: databaseUrl,
        ...poolOpts,
    });
} else {
    const dbHost = process.env.DB_HOST;
    const dbName = process.env.DB_NAME;
    const dbUser = process.env.DB_USER;
    const dbPassword = process.env.DB_PASSWORD;
    if (!dbHost || !dbName || !dbUser || dbPassword == null || dbPassword === '') {
        throw new Error(
            'Configuración DB incompleta: defina DATABASE_URL o bien DB_HOST, DB_NAME, DB_USER y DB_PASSWORD en .env ' +
                '(sin credenciales por defecto en código). Si usa PM2, arranque con cwd en backend/ o pase env en ecosystem.'
        );
    }
    pool = new Pool({
        host: dbHost,
        port: Number(process.env.DB_PORT || 5432),
        database: dbName,
        user: dbUser,
        password: dbPassword,
        ...poolOpts,
    });
}

pool.on('connect', () => {
    logger.info('Conexión a PostgreSQL establecida');
});

pool.on('error', (err) => {
    logger.error('Error inesperado en el pool de PostgreSQL', err);
    process.exit(-1);
});

const transactionStorage = new AsyncLocalStorage();

function recordQueryMetrics(durationMs, poolWaitMs) {
    const requestContext = asyncLocalStorage.getStore();
    if (!requestContext) return;
    requestContext.dbQueryCount = (requestContext.dbQueryCount || 0) + 1;
    requestContext.dbDurationMs = (requestContext.dbDurationMs || 0) + durationMs;
    requestContext.dbPoolWaitMs = (requestContext.dbPoolWaitMs || 0) + poolWaitMs;
}

async function executeQuery(client, text, params, poolWaitMs = 0) {
    const queryStart = Date.now();
    try {
        const res = await client.query(text, params);
        const duration = Date.now() - queryStart;
        recordQueryMetrics(duration, poolWaitMs);
        logger.debug('Query ejecutada', { text, duration, poolWaitMs, rows: res.rowCount });
        const slowQueryMs = positiveNumberFromEnv('DB_SLOW_QUERY_MS', 500);
        if (duration >= slowQueryMs) {
            logger.warn('Query lenta', {
                durationMs: duration,
                poolWaitMs,
                rows: res.rowCount,
                statement: String(text).replace(/\s+/g, ' ').trim().slice(0, 240),
            });
        }
        return res;
    } catch (error) {
        const duration = Date.now() - queryStart;
        recordQueryMetrics(duration, poolWaitMs);
        logger.error('Error en query', { text, error: error.message, stack: error.stack });
        throw error;
    }
}

export const query = async (text, params) => {
    const transactionClient = transactionStorage.getStore();
    if (transactionClient) {
        return executeQuery(transactionClient, text, params, 0);
    }

    const waitStart = Date.now();
    const client = await pool.connect();
    const poolWaitMs = Date.now() - waitStart;
    try {
        return await executeQuery(client, text, params, poolWaitMs);
    } finally {
        client.release();
    }
};

/**
 * Ejecuta todo el callback sobre una única conexión. Las llamadas al helper
 * query() realizadas dentro del callback reutilizan automáticamente ese client.
 */
export const withTransaction = async (callback) => {
    const currentClient = transactionStorage.getStore();
    if (currentClient) return callback(currentClient);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await transactionStorage.run(client, () => callback(client));
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            logger.error('Error ejecutando rollback', { error: rollbackError.message });
        }
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






