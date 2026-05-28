/**
 * Yego Rapidín 4.0 — CobroAuditTrail
 *
 * Registra la trazabilidad completa de cada cálculo de cobro semanal.
 * Único punto de escritura de auditoría de cobros.
 */
import { query } from '../../../config/database.js';
import { auditLog } from '../../../utils/logger.js';

/**
 * Construye el contexto de auditoría para un cálculo de cobro.
 *
 * @param {object} ctx
 * @param {string} ctx.solicitudId
 * @param {string} ctx.weekStartDate
 * @param {number} ctx.semanaOrdinal
 * @param {string} ctx.eventType - 'generated' | 'updated' | 'cascaded' | 'paid'
 * @param {string} ctx.generatedBy - 'cron_lunes' | 'manual_regeneration' | 'excel_import' | 'admin_adjustment'
 * @param {object} ctx.inputs - Datos de entrada
 * @param {object} ctx.planResolution - Resolución del plan
 * @param {object} ctx.cuotaCalculation - Resultado del cálculo
 * @param {object} ctx.cascada - Resultado de la cascada
 * @param {object} ctx.mora - Resultado de la mora
 * @param {object} ctx.resultado - Resultado final
 * @param {object} ctx.actor - { userId, correlationId }
 */
export function buildCobroAuditContext(ctx) {
  return {
    version: '1.0',
    generated_by: ctx.generatedBy,
    event_type: ctx.eventType,
    inputs: ctx.inputs || {},
    plan_resolution: ctx.planResolution || {},
    cuota_calculation: ctx.cuotaCalculation || {},
    cascada: ctx.cascada || {},
    mora: ctx.mora || {},
    resultado: ctx.resultado || {},
  };
}

/**
 * Persiste la trazabilidad de un cálculo de cobro en billing_audit_trail.
 */
export async function persistCobroAudit({
  cuotaSemanalId,
  solicitudId,
  weekStartDate,
  semanaOrdinal,
  eventType,
  billingContext,
  generatedBy,
  actorId = null,
  correlationId = null,
  executionHash = null,
}) {
  try {
    await query(
      `INSERT INTO module_miauto_billing_audit_trail (cuota_semanal_id, solicitud_id, week_start_date, semana_ordinal, event_type, billing_context, generated_by, actor_id, correlation_id, execution_hash)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
      [
        cuotaSemanalId,
        solicitudId,
        weekStartDate,
        semanaOrdinal,
        eventType,
        JSON.stringify(billingContext),
        generatedBy,
        actorId,
        correlationId,
        executionHash,
      ]
    );
  } catch (err) {
    auditLog('billing_audit.persist.error', {
      cuotaSemanalId,
      solicitudId,
      eventType,
      error: err.message,
    });
  }
}

/**
 * Recupera el historial de auditoría de billing para una solicitud.
 */
export async function getCobroAuditHistory(solicitudId, limit = 50, offset = 0) {
  const res = await query(
    `SELECT * FROM module_miauto_billing_audit_trail
     WHERE solicitud_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [solicitudId, limit, offset]
  );
  return res.rows;
}
