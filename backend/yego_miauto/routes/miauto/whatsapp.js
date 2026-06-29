/**
 * Yego Rapidín 4.0 — Rutas WhatsApp masivo Mi Auto
 * /api/miauto/admin/whatsapp/*
 */
import { Router } from 'express';
import { sendBulkWhatsApp, getWhatsAppLog } from '../../services/miautoWhatsAppService.js';
import { buildMiAutoMessage } from '../../services/miautoWhatsAppService.js';
import { errorResponse, successResponse } from '../../../utils/responses.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

/**
 * POST /api/miauto/admin/whatsapp/enviar
 * Envía mensajes WhatsApp a los conductores seleccionados.
 * Body: { solicitud_ids: string[] }
 */
router.post('/admin/whatsapp/enviar', async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos', 403);
    }

    const { solicitud_ids } = req.body;
    if (!Array.isArray(solicitud_ids) || solicitud_ids.length === 0) {
      return errorResponse(res, 'Seleccioná al menos un conductor', 400);
    }

    const userId = req.user?.id || null;
    const results = await sendBulkWhatsApp(solicitud_ids, userId);

    return successResponse(
      res,
      results,
      `Enviados: ${results.sent.length}. Fallidos: ${results.failed.length}. Total: ${results.total}`
    );
  } catch (error) {
    logger.error('Error en envío masivo WhatsApp:', error);
    return errorResponse(res, error.message, 500);
  }
});

/**
 * POST /api/miauto/admin/whatsapp/preview
 * Vista previa del mensaje (no envía).
 * Body: { solicitud_ids: string[] }
 */
router.post('/admin/whatsapp/preview', async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos', 403);
    }

    const { solicitud_ids } = req.body;
    if (!Array.isArray(solicitud_ids) || solicitud_ids.length === 0) {
      return errorResponse(res, 'Seleccioná al menos un conductor', 400);
    }

    const previews = [];
    for (const sid of solicitud_ids) {
      try {
        const data = await buildMiAutoMessage(sid);
        previews.push({ solicitud_id: sid, ...data });
      } catch (e) {
        previews.push({ solicitud_id: sid, error: e.message });
      }
    }

    return successResponse(res, previews);
  } catch (error) {
    logger.error('Error en preview WhatsApp:', error);
    return errorResponse(res, error.message, 500);
  }
});

/**
 * GET /api/miauto/admin/whatsapp/log
 * Historial de envíos.
 * Query: ?solicitud_id=&status=&page=&limit=
 */
router.get('/admin/whatsapp/log', async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos', 403);
    }

    const log = await getWhatsAppLog(req.query);
    return successResponse(res, log);
  } catch (error) {
    logger.error('Error consultando log WhatsApp:', error);
    return errorResponse(res, error.message, 500);
  }
});

export default router;
