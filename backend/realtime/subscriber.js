import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { logger } from '../utils/logger.js';

let wss = null;

export const initializeWebSocket = (expressApp) => {
  const server = createServer(expressApp);
  const wsPort = process.env.WS_PORT || 3001;

  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    logger.info('Cliente WebSocket conectado');

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        logger.debug('Mensaje recibido:', data);
      } catch (error) {
        logger.error('Error procesando mensaje WebSocket:', error);
      }
    });

    ws.on('close', () => {
      logger.info('Cliente WebSocket desconectado');
    });

    ws.on('error', (error) => {
      logger.error('Error en WebSocket:', error);
    });
  });

  server.listen(wsPort, () => {
    logger.info(`Servidor WebSocket escuchando en puerto ${wsPort}`);
  });

  return wss;
};

export const broadcast = (event, data) => {
  if (!wss) {
    logger.warn('WebSocket server no inicializado');
    return;
  }

  const message = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString()
  });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });

  logger.debug(`Broadcast enviado: ${event}`, { clients: wss.clients.size });
};

export const notifyLoanRequestCreated = (request) => {
  broadcast('loan_request_created', request);
};

export const notifyLoanRequestUpdated = (request) => {
  broadcast('loan_request_updated', request);
};

export const notifyLoanCreated = (loan) => {
  broadcast('loan_created', loan);
};

export const notifyPaymentReceived = (payment) => {
  broadcast('payment_received', payment);
};

export const notifyInstallmentUpdated = (installment) => {
  broadcast('installment_updated', installment);
};

export const notifyNotificationSent = (notification) => {
  broadcast('notification_sent', notification);
};







