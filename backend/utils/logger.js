/**
 * Yego Rapidín 4.0 — Logger profesional multi-canal
 *
 * Canales:
 *  - business.log    → Eventos de negocio (contrato creado, cobro generado, etc.)
 *  - technical.log   → Errores técnicos, timeouts, reintentos
 *  - audit.log       → Registro de auditoría (quién hizo qué)
 *  - combined.log    → Todo (debug/desarrollo)
 *  - error.log       → Solo errores
 *
 * Cada línea lleva correlation_id para trazabilidad end-to-end.
 */
import winston from 'winston';
import { AsyncLocalStorage } from 'async_hooks';

export const asyncLocalStorage = new AsyncLocalStorage();

const correlationIdFormat = winston.format((info) => {
  const store = asyncLocalStorage.getStore();
  if (store?.correlationId) {
    info.correlationId = store.correlationId;
  }
  if (store?.userId) {
    info.userId = store.userId;
  }
  if (store?.actorType) {
    info.actorType = store.actorType;
  }
  return info;
});

const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  correlationIdFormat(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const LOG_MAX_SIZE_BYTES = 20 * 1024 * 1024;
const LOG_MAX_FILES = 5;

function rotatingFile(filename, options = {}) {
  return new winston.transports.File({
    filename,
    maxsize: LOG_MAX_SIZE_BYTES,
    maxFiles: LOG_MAX_FILES,
    tailable: true,
    ...options,
  });
}

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: baseFormat,
  defaultMeta: { service: 'rapidin-api', channel: 'combined' },
  transports: [
    rotatingFile('error.log', { level: 'error' }),
    rotatingFile('combined.log'),
  ],
});

const businessLogger = winston.createLogger({
  level: 'info',
  format: baseFormat,
  defaultMeta: { service: 'rapidin-api', channel: 'business' },
  transports: [rotatingFile('business.log')],
});

const technicalLogger = winston.createLogger({
  level: 'info',
  format: baseFormat,
  defaultMeta: { service: 'rapidin-api', channel: 'technical' },
  transports: [rotatingFile('technical.log')],
});

const auditLogger = winston.createLogger({
  level: 'info',
  format: baseFormat,
  defaultMeta: { service: 'rapidin-api', channel: 'audit' },
  transports: [rotatingFile('audit.log')],
});

if (process.env.NODE_ENV !== 'production') {
  const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, correlationId, channel, ...rest }) => {
      const cid = correlationId ? `[${String(correlationId).slice(0, 8)}]` : '';
      const ch = channel ? `[${channel}]` : '';
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      return `${timestamp} ${level} ${ch}${cid} ${message}${extra}`;
    })
  );
  logger.add(new winston.transports.Console({ format: consoleFormat }));
}

/**
 * Logger de eventos de negocio.
 */
export function businessLog(eventType, payload = {}, meta = {}) {
  const { entityType, entityId, actorType, actorId } = meta;
  businessLogger.info(eventType, {
    eventType,
    entityType: entityType || '',
    entityId: entityId || '',
    actorType: actorType || 'system',
    actorId: actorId || null,
    payload,
  });
}

/**
 * Logger técnico (errores, timeouts, reintentos, integraciones).
 */
export function technicalLog(level, message, meta = {}) {
  const fn = technicalLogger[level] || technicalLogger.info;
  fn.call(technicalLogger, message, meta);
}

/**
 * Logger de auditoría (quién hizo qué).
 */
export function auditLog(action, meta = {}) {
  auditLogger.info(action, meta);
}

export { logger };
