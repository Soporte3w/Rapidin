/**
 * Yego Rapidín 4.0 — Rutas WhatsApp masivo Mi Auto
 * /api/miauto/admin/whatsapp/*
 */
import { Router } from 'express';
import {
  enqueueBulkWhatsApp,
  getWhatsAppRecipients,
  getWhatsAppLog,
  getWhatsAppLogDays,
  getWhatsAppQueueStatuses,
} from '../../services/miautoWhatsAppService.js';
import { errorResponse, successResponse } from '../../../utils/responses.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

router.get('/admin/whatsapp/recipients', async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos', 403);
    }
    const recipients = await getWhatsAppRecipients({ country: req.query.country });
    return successResponse(res, recipients);
  } catch (error) {
    logger.error('Error cargando destinatarios WhatsApp:', error);
    return errorResponse(res, error.message, 500);
  }
});

/**
 * POST /api/miauto/admin/whatsapp/enviar
 * Programa mensajes WhatsApp pre-armados por el frontend.
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
    const results = await enqueueBulkWhatsApp(items, userId);

    return successResponse(
      res,
      results,
      `Programados: ${results.queued.length}. Rechazados: ${results.failed.length}. Total: ${results.total}`
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

router.get('/admin/whatsapp/log-days', async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos', 403);
    }

    const days = await getWhatsAppLogDays(req.query);
    return successResponse(res, days);
  } catch (error) {
    logger.error('Error consultando días del historial WhatsApp:', error);
    return errorResponse(res, error.message, 500);
  }
});

router.post('/admin/whatsapp/status', async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos', 403);
    }

    const statuses = await getWhatsAppQueueStatuses(req.body?.ids);
    return successResponse(res, statuses);
  } catch (error) {
    logger.error('Error consultando estados WhatsApp:', error);
    return errorResponse(res, error.message, 500);
  }
});

export default router;
