import express from 'express';
import { getLoanRequestById } from '../services/loanService.js';
import { simulateLoanOptions } from '../services/calculationsService.js';
import { applySimulationOption, disburseRequest } from '../services/loanService.js';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(filterByCountry);
router.use(verifyRole('analyst', 'approver', 'admin'));

router.post('/simulate', async (req, res) => {
  try {
    const { request_id } = req.body;

    if (!request_id) {
      return errorResponse(res, 'ID de solicitud requerido', 400);
    }

    const request = await getLoanRequestById(request_id);

    if (!request) {
      return errorResponse(res, 'Solicitud no encontrada', 404);
    }

    if (req.allowedCountries && !req.allowedCountries.includes(request.country)) {
      return errorResponse(res, 'No tienes permisos para esta solicitud', 403);
    }

    const conditions = await query(
      'SELECT * FROM module_rapidin_loan_conditions WHERE country = $1 AND active = true ORDER BY version DESC LIMIT 1',
      [request.country]
    );

    if (conditions.rows.length === 0) {
      return errorResponse(res, 'No hay condiciones de préstamo configuradas', 400);
    }

    let cycle = (request.cycle ?? request.driver_cycle) != null ? parseInt(request.cycle ?? request.driver_cycle, 10) : null;
    if (cycle == null && request.driver_id) {
      const driverRow = await query('SELECT cycle FROM module_rapidin_drivers WHERE id = $1', [request.driver_id]);
      cycle = driverRow.rows[0]?.cycle != null ? parseInt(driverRow.rows[0].cycle, 10) : 1;
    }
    if (cycle == null) cycle = 1;
    const amount = parseFloat(request.requested_amount) || 0;
    const options = await simulateLoanOptions(
      amount,
      request.country,
      cycle,
      conditions.rows[0]
    );

    return successResponse(res, options, 'Plan de pago del conductor');
  } catch (error) {
    logger.error('Error simulando préstamo:', error);
    return errorResponse(res, error.message, 400);
  }
});

router.post('/apply-option', async (req, res) => {
  try {
    const { request_id, option } = req.body;

    if (!request_id || !option) {
      return errorResponse(res, 'Solicitud ID y opción requeridos', 400);
    }

    const result = await applySimulationOption(request_id, option, req.user.id);
    return successResponse(res, result, 'Solicitud aprobada. Realice el desembolso para generar el cronograma.');
  } catch (error) {
    logger.error('Error aplicando opción:', error);
    return errorResponse(res, error.message, 400);
  }
});

router.post('/disburse', async (req, res) => {
  try {
    const { request_id, first_payment_today, first_payment_date } = req.body;

    if (!request_id) {
      return errorResponse(res, 'ID de solicitud requerido', 400);
    }

    const request = await getLoanRequestById(request_id);
    if (!request) {
      return errorResponse(res, 'Solicitud no encontrada', 404);
    }
    if (req.allowedCountries && !req.allowedCountries.includes(request.country)) {
      return errorResponse(res, 'No tienes permisos para esta solicitud', 403);
    }

    const disburseOptions = {};
    if (first_payment_today === true || first_payment_today === 'true') {
      disburseOptions.first_payment_today = true;
    } else if (first_payment_date) {
      disburseOptions.first_payment_date = first_payment_date;
    }

    const result = await disburseRequest(request_id, req.user.id, disburseOptions);
    return successResponse(res, result, 'Desembolso realizado. Cronograma generado.');
  } catch (error) {
    logger.error('Error en desembolso:', error);
    return errorResponse(res, error.message, 400);
  }
});

export default router;







