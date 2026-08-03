import { Router } from 'express';
import { validateUUID } from '../../../middleware/validations.js';
import { successResponse, errorResponse } from '../../../utils/responses.js';
import { logger, businessLog } from '../../../utils/logger.js';
import {
  listCronogramas,
  listCronogramasLite,
  getCronogramaById,
  createCronograma,
  updateCronograma,
  deleteCronograma,
  toggleCronogramaActive,
} from '../../services/cronograma/miautoCronogramaService.js';
import {
  getMiautoAutomationConfig,
  updateMiautoAutomationConfig,
} from '../../services/config/miautoAutomationConfigService.js';
import {
  getMiautoFleetChargeRunDetail,
  listMiautoFleetChargeRuns,
} from '../../services/cuotas/miautoFleetChargeRunService.js';
import {
  runFleetCobroPendientesDeRun,
  runFleetCobroTodosPendientes,
} from '../../../jobs/miautoWeeklyCharge.js';
import { getMiautoFleetPendingQueuePreview } from '../../services/cuotas/miautoFleetChargeService.js';

const router = Router();

// GET /api/miauto/automation-config
router.get('/automation-config', async (req, res) => {
  try {
    if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos para ver esta configuración', 403);
    return successResponse(res, await getMiautoAutomationConfig());
  } catch (error) {
    logger.error('Error obteniendo automatización Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al obtener la automatización', 500);
  }
});

// PUT /api/miauto/automation-config
router.put('/automation-config', async (req, res) => {
  try {
    if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos para configurar automatizaciones', 403);
    const config = await updateMiautoAutomationConfig(req.body || {}, req.user?.id || null);
    logger.info('miauto.automation_config.updated', {
      userId: req.user?.id || null,
      weeklyGenerationEnabled: config.weekly_generation_enabled,
      weeklyGenerationDay: config.weekly_generation_day,
      weeklyGenerationTime: config.weekly_generation_time,
      weeklyFleetChargeEnabled: config.weekly_fleet_charge_enabled,
      weeklyFleetChargeDay: config.weekly_fleet_charge_day,
      weeklyFleetChargeTime: config.weekly_fleet_charge_time,
      weeklyFleetRetryEnabled: config.weekly_fleet_retry_enabled,
      weeklyFleetRetryIntervalMinutes: config.weekly_fleet_retry_interval_minutes,
      weeklyFleetRetryMaxAttempts: config.weekly_fleet_retry_max_attempts,
      dailyAdditionalExpensesEnabled: config.daily_additional_expenses_enabled,
      dailyAdditionalExpensesTime: config.daily_additional_expenses_time,
    });
    return successResponse(res, config, 'Automatización actualizada');
  } catch (error) {
    logger.error('Error actualizando automatización Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al actualizar la automatización', 400);
  }
});

// GET /api/miauto/fleet-charge-runs
router.get('/fleet-charge-runs', async (req, res) => {
  try {
    if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos para ver los cobros automáticos', 403);
    return successResponse(res, await listMiautoFleetChargeRuns(req.query.limit));
  } catch (error) {
    logger.error('Error obteniendo ejecuciones de cobro Fleet Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al obtener las ejecuciones de cobro Fleet', 500);
  }
});

router.get('/fleet-charge-runs/pending', async (req, res) => {
  try {
    if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos para ver la cola Fleet', 403);
    return successResponse(res, await getMiautoFleetPendingQueuePreview(req.query.limit));
  } catch (error) {
    logger.error('Error obteniendo la cola pendiente Fleet Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al obtener la cola pendiente Fleet', 500);
  }
});

router.post('/fleet-charge-runs/retry-all', async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin' || req.user?.base_role === 'admin';
    if (!isAdmin) return errorResponse(res, 'Solo un administrador puede reprocesar cobros Fleet', 403);
    const result = await runFleetCobroTodosPendientes({ triggeredBy: req.user?.id || null });
    if (!result.ok) return errorResponse(res, result.error || 'No se pudo reprocesar la cola Fleet', 409);
    businessLog('miauto.fleet_charge.manual_retry_all', {
      retryRunId: result.run_id,
      requested: result.cuotas_solicitadas,
      processed: result.cuotas_procesadas,
      success: result.success,
      partial: result.partial,
      failed: result.failed,
      remaining: result.pendientes_despues,
      userId: req.user?.id || null,
    });
    return successResponse(res, result, 'Reproceso general Fleet completado');
  } catch (error) {
    logger.error('Error reprocesando toda la cola Fleet Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al reprocesar toda la cola Fleet', 500);
  }
});

router.get('/fleet-charge-runs/:runId', async (req, res) => {
  try {
    if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos para ver los cobros automáticos', 403);
    const runId = String(req.params.runId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      return errorResponse(res, 'ID de ejecución inválido', 400);
    }
    const detail = await getMiautoFleetChargeRunDetail(runId);
    if (!detail) return errorResponse(res, 'Ejecución de cobro no encontrada', 404);
    return successResponse(res, detail);
  } catch (error) {
    logger.error('Error obteniendo detalle de cobro Fleet Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al obtener el detalle del cobro Fleet', 500);
  }
});

router.post('/fleet-charge-runs/:runId/retry', async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin' || req.user?.base_role === 'admin';
    if (!isAdmin) return errorResponse(res, 'Solo un administrador puede reprocesar cobros Fleet', 403);
    const runId = String(req.params.runId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      return errorResponse(res, 'ID de ejecución inválido', 400);
    }
    const source = await getMiautoFleetChargeRunDetail(runId);
    if (!source) return errorResponse(res, 'Ejecución de cobro no encontrada', 404);
    const retryableCount = source.attempts.filter((attempt) => attempt.retryable).length;
    if (retryableCount === 0) {
      return errorResponse(res, 'Esta ejecución ya no tiene cuotas pendientes para reprocesar', 409);
    }
    const result = await runFleetCobroPendientesDeRun(runId, { triggeredBy: req.user?.id || null });
    if (!result.ok) return errorResponse(res, result.error || 'No se pudo reprocesar la cola pendiente', 409);
    businessLog('miauto.fleet_charge.manual_retry', {
      sourceRunId: runId,
      retryRunId: result.run_id,
      requested: result.cuotas_solicitadas,
      processed: result.cuotas_procesadas,
      success: result.success,
      partial: result.partial,
      failed: result.failed,
      remaining: result.pendientes_despues,
      userId: req.user?.id || null,
    });
    return successResponse(res, result, 'Reproceso de la semana completado');
  } catch (error) {
    logger.error('Error reprocesando cobros Fleet Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al reprocesar cobros Fleet', 500);
  }
});

function auditMiautoMutation(eventType, entityType, entityId, payload = {}) {
  businessLog(eventType, payload, {
    entityType,
    entityId: entityId || '',
    actorType: 'user',
  });
}

function trimOrUndefined(x) {
  if (x == null) return undefined;
  const s = String(x).trim();
  return s === '' ? undefined : s;
}

// GET /api/miauto/cronogramas
router.get('/cronogramas', async (req, res) => {
  try {
    const { country, active, lite } = req.query;
    const countryVal = trimOrUndefined(country);
    const isLite = lite === 'true' || lite === '1';
    const list = isLite
      ? await listCronogramasLite({ country: countryVal, active })
      : await listCronogramas({ country: countryVal, active });
    return successResponse(res, list);
  } catch (error) {
    logger.error('Error listando cronogramas Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar cronogramas', 500);
  }
});

// GET /api/miauto/cronogramas/:id
router.get('/cronogramas/:id', validateUUID, async (req, res) => {
  try {
    const cronograma = await getCronogramaById(req.params.id);
    if (!cronograma) return errorResponse(res, 'Cronograma no encontrado', 404);
    return successResponse(res, cronograma);
  } catch (error) {
    logger.error('Error obteniendo cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al obtener cronograma', 500);
  }
});

// POST /api/miauto/cronogramas
router.post('/cronogramas', async (req, res) => {
  try {
    const cronograma = await createCronograma(req.body);
    auditMiautoMutation('cronograma.created', 'cronograma', cronograma?.id);
    return successResponse(res, cronograma, 'Cronograma creado', 201);
  } catch (error) {
    logger.error('Error creando cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al crear cronograma', 400);
  }
});

// PUT /api/miauto/cronogramas/:id
router.put('/cronogramas/:id', validateUUID, async (req, res) => {
  try {
    const result = await updateCronograma(req.params.id, req.body, req.user?.id || null);
    if (!result) return errorResponse(res, 'Cronograma no encontrado', 404);
    const { cronograma, skippedVehicles } = result;
    auditMiautoMutation('cronograma.updated', 'cronograma', req.params.id);
    return successResponse(res, { ...cronograma, skippedVehicles }, 'Cronograma actualizado');
  } catch (error) {
    logger.error('Error actualizando cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al actualizar cronograma', 400);
  }
});

// DELETE /api/miauto/cronogramas/:id
router.delete('/cronogramas/:id', validateUUID, async (req, res) => {
  try {
    const deleted = await deleteCronograma(req.params.id);
    if (!deleted) return errorResponse(res, 'Cronograma no encontrado', 404);
    auditMiautoMutation('cronograma.deleted', 'cronograma', req.params.id);
    return successResponse(res, { deleted: true }, 'Cronograma eliminado');
  } catch (error) {
    logger.error('Error eliminando cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al eliminar cronograma', 400);
  }
});

// PATCH /api/miauto/cronogramas/:id/toggle-active
router.patch('/cronogramas/:id/toggle-active', validateUUID, async (req, res) => {
  try {
    const cronograma = await toggleCronogramaActive(req.params.id);
    if (!cronograma) return errorResponse(res, 'Cronograma no encontrado', 404);
    auditMiautoMutation('cronograma.toggled', 'cronograma', req.params.id);
    return successResponse(res, cronograma, 'Estado actualizado');
  } catch (error) {
    logger.error('Error cambiando estado cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al cambiar estado', 400);
  }
});

export default router;
