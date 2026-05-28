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

const router = Router();

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

const cronogramasListCache = new Map();
const CRONOGRAMAS_CACHE_TTL_MS = 60 * 1000;

function getCronogramasCacheKey(country, active) {
  return `${String(country ?? '')}:${active === undefined || active === null ? '' : String(active)}`;
}

function invalidateCronogramasListCache() {
  cronogramasListCache.clear();
}

// GET /api/miauto/cronogramas
router.get('/cronogramas', async (req, res) => {
  try {
    const { country, active, lite } = req.query;
    const countryVal = trimOrUndefined(country);
    const isLite = lite === 'true' || lite === '1';
    const key = getCronogramasCacheKey(countryVal, active, isLite);
    const now = Date.now();
    const cached = cronogramasListCache.get(key);
    if (cached && cached.expires > now) {
      return successResponse(res, cached.data);
    }
    const list = isLite
      ? await listCronogramasLite({ country: countryVal, active })
      : await listCronogramas({ country: countryVal, active });
    cronogramasListCache.set(key, { data: list, expires: now + CRONOGRAMAS_CACHE_TTL_MS });
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
    invalidateCronogramasListCache();
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
    const cronograma = await updateCronograma(req.params.id, req.body);
    if (!cronograma) return errorResponse(res, 'Cronograma no encontrado', 404);
    invalidateCronogramasListCache();
    auditMiautoMutation('cronograma.updated', 'cronograma', req.params.id);
    return successResponse(res, cronograma, 'Cronograma actualizado');
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
    invalidateCronogramasListCache();
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
    invalidateCronogramasListCache();
    auditMiautoMutation('cronograma.toggled', 'cronograma', req.params.id);
    return successResponse(res, cronograma, 'Estado actualizado');
  } catch (error) {
    logger.error('Error cambiando estado cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al cambiar estado', 400);
  }
});

export default router;
