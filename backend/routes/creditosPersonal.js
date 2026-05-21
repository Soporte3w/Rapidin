import express from 'express';
import { verifyToken } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { uploadVoucher } from '../middleware/upload.js';
import { successResponse, errorResponse, paginatedResponse } from '../utils/responses.js';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { uploadFileToMedia } from '../services/voucherService.js';
import {
  fetchRRHHUsers,
  createCreditoPersonal,
  getCreditoPersonalById,
  listCreditosPersonales,
  addDocumentoCredito,
  getLastBankDetailsForUser,
  getConfigCreditoPersonal,
  updateConfigCreditoPersonal,
  getDocumentosCredito,
  deleteDocumentoCredito,
  approveCreditoPersonal,
  deleteCreditoPersonal,
  generateCompromisoWord,
} from '../services/creditosPersonalService.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.get('/usuarios', async (req, res) => {
  try {
    const { q } = req.query;
    const users = await fetchRRHHUsers(q || '');
    return successResponse(res, users);
  } catch (error) {
    logger.error('Error buscando usuarios RRHH:', error);
    return errorResponse(res, error.message, 500);
  }
});

router.get('/config', async (req, res) => {
  try {
    const config = await getConfigCreditoPersonal();
    return successResponse(res, config);
  } catch (error) {
    logger.error('Error obteniendo config créditos personal:', error);
    return errorResponse(res, error.message, 500);
  }
});

router.put('/config', async (req, res) => {
  try {
    const config = await updateConfigCreditoPersonal(req.body, req.user?.id);
    return successResponse(res, config, 'Configuración actualizada');
  } catch (error) {
    logger.error('Error actualizando config créditos personal:', error);
    return errorResponse(res, error.message, 400);
  }
});

router.get('/', async (req, res) => {
  try {
    const { status, page, limit, q } = req.query;
    const result = await listCreditosPersonales({ status, page, limit, q });
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    return paginatedResponse(res, result.data, pageNum, limitNum, result.total);
  } catch (error) {
    logger.error('Error listando créditos personal:', error);
    return errorResponse(res, error.message, 500);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const credito = await getCreditoPersonalById(req.params.id);
    if (!credito) return errorResponse(res, 'Crédito no encontrado', 404);
    return successResponse(res, credito);
  } catch (error) {
    logger.error('Error obteniendo crédito personal:', error);
    return errorResponse(res, error.message, 500);
  }
});

router.get('/usuarios/:userGestionId/bancarios', async (req, res) => {
  try {
    const bank = await getLastBankDetailsForUser(req.params.userGestionId);
    return successResponse(res, bank || {});
  } catch (error) {
    logger.error('Error obteniendo datos bancarios:', error);
    return errorResponse(res, error.message, 500);
  }
});

router.get('/:id/documentos', async (req, res) => {
  try {
    const docs = await getDocumentosCredito(req.params.id);
    return successResponse(res, docs);
  } catch (error) {
    logger.error('Error obteniendo documentos:', error);
    return errorResponse(res, error.message, 500);
  }
});

router.delete('/:creditoId/documentos/all', async (req, res) => {
  try {
    await query('DELETE FROM module_rapidin_creditos_personal_docs WHERE credito_id = $1', [req.params.creditoId]);
    return successResponse(res, null, 'Documentos eliminados');
  } catch (error) {
    logger.error('Error eliminando documentos:', error);
    return errorResponse(res, error.message, 500);
  }
});

router.delete('/documentos/:docId', async (req, res) => {
  try {
    await deleteDocumentoCredito(req.params.docId);
    return successResponse(res, null, 'Documento eliminado');
  } catch (error) {
    logger.error('Error eliminando documento:', error);
    return errorResponse(res, error.message, 500);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteCreditoPersonal(req.params.id);
    return successResponse(res, null, 'Crédito eliminado');
  } catch (error) {
    logger.error('Error eliminando crédito:', error);
    return errorResponse(res, error.message, 500);
  }
});

router.post('/', async (req, res) => {
  try {
    const credito = await createCreditoPersonal(req.body, req.user?.id);
    return successResponse(res, credito, 'Crédito personal creado', 201);
  } catch (error) {
    logger.error('Error creando crédito personal:', error);
    return errorResponse(res, error.message, 400);
  }
});

router.post('/:id/aprobar', async (req, res) => {
  try {
    const credito = await approveCreditoPersonal(req.params.id, req.user?.id);
    return successResponse(res, credito, 'Crédito aprobado y activado');
  } catch (error) {
    logger.error('Error aprobando crédito:', error);
    return errorResponse(res, error.message, 400);
  }
});

router.get('/:id/compromiso-word', async (req, res) => {
  try {
    const { buffer, fileName } = await generateCompromisoWord(req.params.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(buffer);
  } catch (error) {
    logger.error('Error generando Word:', error);
    return errorResponse(res, error.message, 400);
  }
});

router.post('/:id/documentos', uploadVoucher.single('file'), async (req, res) => {
  try {
    if (!req.file) return errorResponse(res, 'Archivo requerido', 400);
    
    const credito = await getCreditoPersonalById(req.params.id);
    if (!credito) return errorResponse(res, 'Crédito no encontrado', 404);
    
    const ext = (req.file.originalname || '').split('.').pop()?.toLowerCase() || 'pdf';
    const fullName = `${credito.first_name}_${credito.last_name}`.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9]/g, '');
    const fileName = `${fullName}_${credito.dni}.${ext}`;
    const storagePath = `credito-personales/${fileName}`;
    
    const fileUrl = await uploadFileToMedia({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: storagePath,
    });
    
    await addDocumentoCredito(req.params.id, fileName, fileUrl, req.user?.id);
    return successResponse(res, { fileName, filePath: fileUrl }, 'Documento subido', 201);
  } catch (error) {
    logger.error('Error subiendo documento:', error);
    return errorResponse(res, error.message || 'Error al subir documento', 400);
  }
});

export default router;
