/**
 * Yego Rapidín 4.0 — Audit Routes
 *
 * Endpoints de consulta de auditoría para administradores.
 *
 * GET  /api/audit/:entityType/:entityId          → Historial de cambios
 * GET  /api/audit/:entityType/:entityId/events   → Eventos de negocio
 * GET  /api/audit/cobros/:solicitudId            → Trazabilidad de cobros
 * GET  /api/audit/imports                         → Historial de importaciones
 * GET  /api/audit/consistency                     → Último reporte de consistencia
 * POST /api/audit/consistency/run                 → Ejecutar verificación de consistencia
 */
import { Router } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { query } from '../config/database.js';
import { auditService } from '../services/auditService.js';
import { runConsistencyCheck } from '../jobs/consistencyChecker.js';
import { successResponse, errorResponse } from '../utils/responses.js';

const router = Router();

router.use(verifyToken);

/**
 * GET /api/audit/:entityType/:entityId
 * Historial de cambios (audit_log) para una entidad específica.
 */
router.get('/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = parseInt(req.query.offset) || 0;

    const validTables = [
      'module_miauto_solicitud', 'module_miauto_cuota_semanal',
      'module_miauto_cronograma', 'module_miauto_cronograma_vehiculo',
      'module_miauto_comprobante_pago', 'module_miauto_comprobante_cuota_semanal',
      'module_rapidin_loans', 'module_rapidin_installments',
      'module_rapidin_payments', 'module_rapidin_payment_vouchers',
      'module_rapidin_loan_requests',
    ];

    if (!validTables.includes(entityType)) {
      return errorResponse(res, `Tipo de entidad no válido: ${entityType}`, 400);
    }

    const history = await auditService.getAuditHistory(entityType, entityId, limit, offset);
    const totalRes = await query(
      `SELECT COUNT(*)::int AS total FROM module_rapidin_data_audit_log WHERE table_name = $1 AND record_id = $2`,
      [entityType, entityId]
    );

    return successResponse(res, {
      history,
      total: totalRes.rows[0]?.total || 0,
    });
  } catch (err) {
    return errorResponse(res, `Error consultando auditoría: ${err.message}`, 500);
  }
});

/**
 * GET /api/audit/:entityType/:entityId/events
 * Eventos de negocio para una entidad.
 */
router.get('/:entityType/:entityId/events', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = parseInt(req.query.offset) || 0;

    const events = await auditService.getBusinessEventHistory(entityType, entityId, limit, offset);
    const totalRes = await query(
      `SELECT COUNT(*)::int AS total FROM module_rapidin_business_event_log WHERE entity_type = $1 AND entity_id = $2`,
      [entityType, entityId]
    );

    return successResponse(res, {
      events,
      total: totalRes.rows[0]?.total || 0,
    });
  } catch (err) {
    return errorResponse(res, `Error consultando eventos: ${err.message}`, 500);
  }
});

/**
 * GET /api/audit/cobros/:solicitudId

router.get('/cobros/:solicitudId', async (req, res) => {
  try {
    const { solicitudId } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = parseInt(req.query.offset) || 0;

    const trail = await auditService.getCobroAuditHistory(solicitudId, limit, offset);
    const totalRes = await query(
      `SELECT COUNT(*)::int AS total FROM module_miauto_billing_audit_trail WHERE solicitud_id = $1`,
      [solicitudId]
    );

    return successResponse(res, {
      trail,
      total: totalRes.rows[0]?.total || 0,
    });
  } catch (err) {
    return errorResponse(res, `Error consultando trazabilidad: ${err.message}`, 500);
  }
});

/**
 * GET /api/audit/imports
 * Historial de importaciones Excel.
 */
router.get('/imports', async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = parseInt(req.query.offset) || 0;

    const res_imports = await query(
      `SELECT il.*, u.first_name, u.last_name
       FROM module_miauto_import_log il
       LEFT JOIN module_rapidin_users u ON u.id = il.imported_by
       ORDER BY il.started_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const totalRes = await query(`SELECT COUNT(*)::int AS total FROM module_miauto_import_log`);

    return successResponse(res, {
      imports: res_imports.rows,
      total: totalRes.rows[0]?.total || 0,
    });
  } catch (err) {
    return errorResponse(res, `Error consultando importaciones: ${err.message}`, 500);
  }
});

/**
 * GET /api/audit/consistency
 * Último reporte de consistencia (no ejecuta, solo consulta si ya corrió).
 */
router.get('/consistency', async (req, res) => {
  try {
    const lastRun = await query(
      `SELECT * FROM module_rapidin_business_event_log
       WHERE event_type = 'consistency.check.completed'
       ORDER BY created_at DESC LIMIT 1`
    );

    if (lastRun.rows.length === 0) {
      return successResponse(res, {
        message: 'No se ha ejecutado verificación de consistencia aún',
        lastRun: null,
        reports: [],
      });
    }

    return successResponse(res, {
      lastRun: lastRun.rows[0],
      payload: lastRun.rows[0].payload,
    });
  } catch (err) {
    return errorResponse(res, `Error: ${err.message}`, 500);
  }
});

/**
 * POST /api/audit/consistency/run
 * Ejecuta verificación de consistencia y registra el resultado.
 */
router.post('/consistency/run', async (req, res) => {
  try {
    const result = await runConsistencyCheck();

    await auditService.recordBusinessEvent(
      'consistency.check.completed',
      'system',
      null,
      result,
      req.user?.id
    );

    return successResponse(res, result);
  } catch (err) {
    return errorResponse(res, `Error ejecutando verificación: ${err.message}`, 500);
  }
});

export default router;
