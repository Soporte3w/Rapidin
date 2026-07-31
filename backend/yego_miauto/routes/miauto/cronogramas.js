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
    });
    return successResponse(res, config, 'Automatización actualizada');
  } catch (error) {
    logger.error('Error actualizando automatización Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al actualizar la automatización', 400);
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
