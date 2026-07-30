/**
 * Yego Rapidín 4.0 — Correlation ID Middleware
 *
 * Inyecta X-Correlation-ID en cada request.
 * Si el cliente lo envía, se reutiliza; si no, se genera uno nuevo.
 * También almacena el contexto del usuario autenticado.
 */
import { asyncLocalStorage } from '../utils/logger.js';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

export function correlationIdMiddleware(req, res, next) {
  const correlationId = req.headers['x-correlation-id'] || randomUUID();

  const store = {
    correlationId,
    userId: req.user?.id || null,
    userRole: req.user?.role || null,
    actorType: req.user ? 'user' : 'system',
    dbQueryCount: 0,
    dbDurationMs: 0,
    dbPoolWaitMs: 0,
  };

  // Exponer en response header para debugging
  res.setHeader('x-correlation-id', correlationId);

  asyncLocalStorage.run(store, () => {
    next();
  });
}

/**
 * Middleware que registra el inicio y fin de cada request.
 * Se coloca DESPUÉS de correlationIdMiddleware.
 */
export function requestLogMiddleware(req, res, next) {
  const start = Date.now();
  const ctx = asyncLocalStorage.getStore();
  const cid = ctx?.correlationId || 'no-cid';

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`, {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: duration,
      dbQueryCount: ctx?.dbQueryCount || 0,
      dbDurationMs: ctx?.dbDurationMs || 0,
      dbPoolWaitMs: ctx?.dbPoolWaitMs || 0,
      correlationId: cid,
    });
  });

  next();
}
