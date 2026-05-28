/**
 * Yego Rapidín 4.0 — Audit Service
 *
 * Registro de cambios en tablas:
 *  - Desde la app (programático): auditService.recordChange()
 *  - Desde la DB (triggers): automatic via audit_log_trigger_fn()
 *
 * Registro de eventos de negocio:
 *  - businessEventService.record()
 *
 * Registro de trazabilidad de cobros:
 *  - billingAuditService.record()
 */
import { query } from '../config/database.js';
import { businessLog, auditLog } from '../utils/logger.js';
import { asyncLocalStorage } from '../utils/logger.js';

function getRequestContext() {
  const store = asyncLocalStorage.getStore();
  return {
    correlationId: store?.correlationId || null,
    userId: store?.userId || null,
    userRole: store?.userRole || null,
    actorType: store?.actorType || 'system',
  };
}

/**
 * Registra un cambio en una tabla (INSERT/UPDATE/DELETE).
 * Uso: await auditService.recordChange('module_miauto_solicitud', id, 'UPDATE', oldData, newData)
 */
async function recordChange(tableName, recordId, operation, oldData, newData, actorId = null) {
  const ctx = getRequestContext();
  const userId = actorId || ctx.userId;

  try {
    await query(
      `INSERT INTO module_rapidin_data_audit_log (table_name, record_id, operation, old_data, new_data, changed_by, changed_by_role, correlation_id)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
      [
        tableName,
        recordId,
        operation,
        oldData ? JSON.stringify(oldData) : null,
        newData ? JSON.stringify(newData) : null,
        userId,
        ctx.userRole || null,
        ctx.correlationId,
      ]
    );
  } catch (err) {
    auditLog('audit.recordChange.error', {
      table: tableName,
      recordId,
      operation,
      error: err.message,
    });
  }
}

/**
 * Registra un evento de negocio en la tabla business_event_log.
 */
async function recordBusinessEvent(eventType, entityType, entityId, payload, actorId = null) {
  const ctx = getRequestContext();
  const userId = actorId || ctx.userId;

  try {
    await query(
      `INSERT INTO module_rapidin_business_event_log (event_type, entity_type, entity_id, actor_type, actor_id, payload, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        eventType,
        entityType,
        entityId,
        ctx.actorType,
        userId,
        JSON.stringify(payload),
        ctx.correlationId,
      ]
    );

    businessLog(eventType, payload, {
      entityType,
      entityId,
      actorType: ctx.actorType,
      actorId: userId,
    });
  } catch (err) {
    auditLog('audit.recordBusinessEvent.error', {
      eventType,
      entityType,
      entityId,
      error: err.message,
    });
  }
}

/**
 * Registra la trazabilidad completa de un cálculo de cobro.
 */
async function recordCobroAudit(cuotaSemanalId, solicitudId, weekStartDate, semanaOrdinal, eventType, billingContext, generatedBy, actorId = null) {
  const ctx = getRequestContext();
  const userId = actorId || ctx.userId;

  try {
    await query(
      `INSERT INTO module_miauto_billing_audit_trail (cuota_semanal_id, solicitud_id, week_start_date, semana_ordinal, event_type, billing_context, generated_by, actor_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        cuotaSemanalId,
        solicitudId,
        weekStartDate,
        semanaOrdinal,
        eventType,
        JSON.stringify(billingContext),
        generatedBy,
        userId,
        ctx.correlationId,
      ]
    );
  } catch (err) {
    auditLog('audit.recordCobroAudit.error', {
      cuotaSemanalId,
      solicitudId,
      eventType,
      error: err.message,
    });
  }
}

/**
 * Obtiene el historial de auditoría para una entidad específica.
 */
async function getAuditHistory(tableName, recordId, limit = 50, offset = 0) {
  const res = await query(
    `SELECT al.*, u.first_name, u.last_name, u.email
     FROM module_rapidin_data_audit_log al
     LEFT JOIN module_rapidin_users u ON u.id = al.changed_by
     WHERE al.table_name = $1 AND al.record_id = $2
     ORDER BY al.changed_at DESC
     LIMIT $3 OFFSET $4`,
    [tableName, recordId, limit, offset]
  );
  return res.rows;
}

/**
 * Obtiene el historial de eventos de negocio para una entidad.
 */
async function getBusinessEventHistory(entityType, entityId, limit = 50, offset = 0) {
  const res = await query(
    `SELECT * FROM module_rapidin_business_event_log
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [entityType, entityId, limit, offset]
  );
  return res.rows;
}

/**
 * Obtiene la trazabilidad de cobros para una solicitud.
 */
async function getCobroAuditHistory(solicitudId, limit = 50, offset = 0) {
  const res = await query(
    `SELECT * FROM module_miauto_billing_audit_trail
     WHERE solicitud_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [solicitudId, limit, offset]
  );
  return res.rows;
}

export const auditService = {
  recordChange,
  recordBusinessEvent,
  recordCobroAudit,
  getAuditHistory,
  getBusinessEventHistory,
  getCobroAuditHistory,
  getRequestContext,
};
