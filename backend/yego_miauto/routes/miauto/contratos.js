import { Router } from 'express';
import { param } from 'express-validator';
import { validateUUID, validateResults } from '../../../middleware/validations.js';
import { uploadVoucher } from '../../../middleware/upload.js';
import { successResponse, errorResponse } from '../../../utils/responses.js';
import { logger } from '../../../utils/logger.js';
import {
  deleteContratoDocumento,
  listContratosBySolicitud,
  uploadContratoDocumento,
} from '../../services/contratos/miautoContratoDocumentoService.js';

const router = Router();

const validateContratoId = [
  param('contratoId').isUUID().withMessage('ID de contrato inválido'),
  validateResults,
];

router.get('/solicitudes/:id/contratos', validateUUID, async (req, res) => {
  try {
    const data = await listContratosBySolicitud(req.params.id);
    return successResponse(res, data);
  } catch (error) {
    logger.error('Error listando contratos Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar contratos', 500);
  }
});

router.post('/solicitudes/:id/contratos', validateUUID, uploadVoucher.single('file'), async (req, res) => {
  try {
    if (!req.file) return errorResponse(res, 'Archivo de contrato requerido', 400);
    const data = await uploadContratoDocumento(req.params.id, req.file, req.user?.id || null);
    return successResponse(res, data, 'Contrato subido correctamente', 201);
  } catch (error) {
    logger.error('Error subiendo contrato Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al subir contrato', 400);
  }
});

router.delete('/solicitudes/:id/contratos/:contratoId', validateUUID, validateContratoId, async (req, res) => {
  try {
    const ok = await deleteContratoDocumento(req.params.id, req.params.contratoId, req.user?.id || null);
    if (!ok) return errorResponse(res, 'Contrato no encontrado o ya eliminado', 404);
    return successResponse(res, null, 'Contrato eliminado');
  } catch (error) {
    logger.error('Error eliminando contrato Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al eliminar contrato', 500);
  }
});

export default router;
