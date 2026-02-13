import express from 'express';
import { generateLoanContract, getDocuments, markDocumentAsSigned } from '../services/documentService.js';
import { verifyToken } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.post('/generate-contract/:loanId', validateUUID, async (req, res) => {
  try {
    const result = await generateLoanContract(req.params.loanId);
    return successResponse(res, result, 'Contrato generado exitosamente');
  } catch (error) {
    logger.error('Error generando contrato:', error);
    return errorResponse(res, error.message, 400);
  }
});

router.get('/loan/:loanId', validateUUID, async (req, res) => {
  try {
    const documents = await getDocuments(req.params.loanId);
    return successResponse(res, documents);
  } catch (error) {
    logger.error('Error obteniendo documentos:', error);
    return errorResponse(res, 'Error obteniendo documentos', 500);
  }
});

router.post('/:id/sign', validateUUID, async (req, res) => {
  try {
    const { signed_by } = req.body;
    await markDocumentAsSigned(req.params.id, signed_by);
    return successResponse(res, null, 'Documento marcado como firmado');
  } catch (error) {
    logger.error('Error firmando documento:', error);
    return errorResponse(res, error.message, 400);
  }
});

export default router;







