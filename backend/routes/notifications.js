import express from 'express';
import { sendNotification, getNotifications, retryNotification } from '../services/notificationService.js';
import { verifyToken } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);

router.post('/send', async (req, res) => {
  try {
    const result = await sendNotification(req.body);
    return successResponse(res, result, 'Notificación enviada');
  } catch (error) {
    logger.error('Error enviando notificación:', error);
    return errorResponse(res, error.message, 400);
  }
});

router.get('/', async (req, res) => {
  try {
    const { driver_id, loan_id, sent } = req.query;
    
    const filters = {};
    if (driver_id) filters.driver_id = driver_id;
    if (loan_id) filters.loan_id = loan_id;
    if (sent !== undefined) filters.sent = sent === 'true';

    const notifications = await getNotifications(filters);
    return successResponse(res, notifications);
  } catch (error) {
    logger.error('Error obteniendo notificaciones:', error);
    return errorResponse(res, 'Error obteniendo notificaciones', 500);
  }
});

router.post('/:id/retry', validateUUID, async (req, res) => {
  try {
    const result = await retryNotification(req.params.id);
    return successResponse(res, result, 'Notificación reenviada');
  } catch (error) {
    logger.error('Error reintentando notificación:', error);
    return errorResponse(res, error.message, 400);
  }
});

export default router;







