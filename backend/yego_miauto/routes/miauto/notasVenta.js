import { Router } from 'express';
import { validateUUID } from '../../../middleware/validations.js';
import { successResponse, errorResponse } from '../../../utils/responses.js';
import { logger } from '../../../utils/logger.js';
import { anularNotaVentaBySolicitud, generarNotaVentaCuotasPagadas, listNotasVentaBySolicitud } from '../../services/facturacion/miautoNotaVentaService.js';

const router = Router();

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
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 400;
    logger.error('Error generando nota de venta Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al generar nota de venta', status, error.data || null);
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
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 400;
    logger.error('Error anulando nota de venta Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al anular nota de venta', status, error.data || null);
  }
});

export default router;
