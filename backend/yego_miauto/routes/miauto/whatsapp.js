/**
 * Yego Rapidín 4.0 — Rutas WhatsApp masivo Mi Auto
 * /api/miauto/admin/whatsapp/*
 */
import { Router } from 'express';
import { sendBulkWhatsApp, getWhatsAppLog } from '../../services/miautoWhatsAppService.js';
import { errorResponse, successResponse } from '../../../utils/responses.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

/**
 * POST /api/miauto/admin/whatsapp/enviar
 * Envía mensajes WhatsApp pre-armados por el frontend.
 * Body: { items: [{ solicitud_id, phone, driver_name, message }] }
 */
router.post('/admin/whatsapp/enviar', async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos', 403);
    }

    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse(res, 'Seleccioná al menos un conductor', 400);
    }

    const userId = req.user?.id || null;
    const results = await sendBulkWhatsApp(items, userId);

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
