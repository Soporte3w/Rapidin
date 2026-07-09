import { Router } from 'express';
import { validateUUID } from '../../../middleware/validations.js';
import { successResponse, errorResponse } from '../../../utils/responses.js';
import { logger } from '../../../utils/logger.js';
import {
  anularNotaVentaBySolicitud,
  downloadNotaVentaPdfBySolicitud,
  generarNotaVentaCuotasPagadas,
  listNotasVentaBySolicitud,
} from '../../services/facturacion/miautoNotaVentaService.js';

const router = Router();

function statusForNotaVentaError(error) {
  if (error?.source === 'facturador' && Number(error.status) === 401) return 502;
  if (error?.status && error.status >= 400 && error.status < 600) return error.status;
  return 400;
}

function messageForNotaVentaError(error, fallback) {
  if (error?.source === 'facturador' && Number(error.status) === 401) {
    return 'El facturador no se encuentra autenticado. Verifica FACTURADOR_LOGIN_EMAIL y FACTURADOR_LOGIN_PASSWORD en el servidor.';
  }
  return error.message || fallback;
}

function sendNotaVentaError(res, error, logMessage, fallback) {
  const status = statusForNotaVentaError(error);
  logger.error(logMessage, error);
  return errorResponse(res, messageForNotaVentaError(error, fallback), status, error.data || null);
}

router.get('/solicitudes/:id/notas-venta', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para ver notas de venta', 403);
    }
    const data = await listNotasVentaBySolicitud(req.params.id);
    return successResponse(res, data);
  } catch (error) {
    logger.error('Error listando notas de venta Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar notas de venta', 500);
  }
});

router.post('/solicitudes/:id/notas-venta/generar', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para generar notas de venta', 403);
    }
    const data = await generarNotaVentaCuotasPagadas(req.params.id, req.body?.cuota_ids, {
      customer_id: req.body?.customer_id,
      observation: req.body?.observation,
      created_by: req.user?.id || null,
    });
    return successResponse(res, data, 'Nota de venta generada correctamente');
  } catch (error) {
    return sendNotaVentaError(res, error, 'Error generando nota de venta Mi Auto:', 'Error al generar nota de venta');
  }
});

router.get('/solicitudes/:id/notas-venta/:notaVentaId/pdf', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para descargar notas de venta', 403);
    }
    const data = await downloadNotaVentaPdfBySolicitud(req.params.id, req.params.notaVentaId);
    const fallbackName = String(data.fileName || 'nota-venta.pdf').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '');
    res.setHeader('Content-Type', data.contentType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(data.fileName || fallbackName)}`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(data.buffer);
  } catch (error) {
    return sendNotaVentaError(res, error, 'Error descargando nota de venta Mi Auto:', 'Error al descargar nota de venta');
  }
});

router.patch('/solicitudes/:id/notas-venta/:notaVentaId/anular', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para anular notas de venta', 403);
    }
    const data = await anularNotaVentaBySolicitud(req.params.id, req.params.notaVentaId, req.user?.id || null);
    return successResponse(res, data, 'Nota de venta anulada correctamente');
  } catch (error) {
    return sendNotaVentaError(res, error, 'Error anulando nota de venta Mi Auto:', 'Error al anular nota de venta');
  }
});

export default router;
