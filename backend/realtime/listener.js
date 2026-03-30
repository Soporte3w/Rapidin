import { Client } from 'pg';
import { broadcast } from './subscriber.js';
import { logger } from '../utils/logger.js';

let pgClient = null;

export const initializeDatabaseListener = async () => {
    try {
        const dbPassword = process.env.DB_PASSWORD;
        if (dbPassword == null || dbPassword === '') {
            logger.warn('DB_PASSWORD no definido; se omite el listener de notificaciones PostgreSQL');
            return;
        }
        pgClient = new Client({
            host: process.env.DB_HOST || 'localhost',
            port: Number(process.env.DB_PORT || 5432),
            database: process.env.DB_NAME || 'rapidin_db',
            user: process.env.DB_USER || 'postgres',
            password: dbPassword,
            connectionTimeoutMillis: 5000,
        });

        await pgClient.connect();
        logger.info('Cliente PostgreSQL conectado para notificaciones');

        pgClient.on('notification', (msg) => {
            try {
                const payload = JSON.parse(msg.payload);
                logger.debug('Notificación recibida de PostgreSQL:', payload);

                switch (payload.table) {
                    case 'module_rapidin_loan_requests':
                        if (payload.action === 'INSERT') {
                            broadcast('loan_request_created', { id: payload.id });
                        } else if (payload.action === 'UPDATE') {
                            broadcast('loan_request_updated', { id: payload.id });
                        }
                        break;

                    case 'module_rapidin_loans':
                        if (payload.action === 'INSERT') {
                            broadcast('loan_created', { id: payload.id });
                        }
                        break;

                    case 'module_rapidin_payments':
                        if (payload.action === 'INSERT') {
                            broadcast('payment_received', { id: payload.id });
                        }
                        break;

                    case 'module_rapidin_installments':
                        if (payload.action === 'UPDATE') {
                            broadcast('installment_updated', { id: payload.id });
                        }
                        break;

                    case 'module_rapidin_notifications':
                        if (payload.action === 'INSERT') {
                            broadcast('notification_sent', { id: payload.id });
                        }
                        break;
                }
            } catch (error) {
                logger.error('Error procesando notificación de PostgreSQL:', error);
            }
        });

        pgClient.on('error', (err) => {
            logger.error('Error en cliente PostgreSQL:', err);
            pgClient = null;
            // Intentar reconectar después de 10 segundos
            setTimeout(() => {
                if (!pgClient) {
                    logger.info('Intentando reconectar listener de base de datos...');
                    initializeDatabaseListener();
                }
            }, 10000);
        });

        await pgClient.query('LISTEN rapidin_changes');
        logger.info('Escuchando canal rapidin_changes');
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            logger.warn('No se pudo conectar a PostgreSQL para notificaciones. El servidor continuará funcionando sin notificaciones en tiempo real. Asegúrate de que PostgreSQL esté corriendo.');
        } else {
            logger.error('Error inicializando listener de base de datos:', error);
        }
        // No lanzar el error, permitir que el servidor continúe funcionando
    }
};

export const closeDatabaseListener = async () => {
    if (pgClient) {
        await pgClient.end();
        logger.info('Cliente PostgreSQL desconectado');
    }
};







