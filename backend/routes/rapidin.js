import express from 'express';
import { validateDNI, createOrUpdateDriver, getDriver } from '../services/calculationsService.js';
import { createLoanRequest } from '../services/loanService.js';
import { validateLoanRequest } from '../middleware/validations.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.post('/request', validateLoanRequest, async (req, res) => {
  try {
    const { dni, country, requested_amount, first_name, last_name, phone, email, yego_premium } = req.body;

    const dniValidation = await validateDNI(dni);
    if (!dniValidation.valid) {
      return errorResponse(res, dniValidation.message, 400);
    }

    let driver = await getDriver(dni, country);

    if (!driver) {
      driver = await createOrUpdateDriver({
        dni,
        country,
        first_name,
        last_name,
        phone,
        email,
        yego_premium: yego_premium || false
      });
    }

    const request = await createLoanRequest({
      driver_id: driver.id,
      country,
      requested_amount
    });

    return successResponse(res, request, 'Solicitud creada exitosamente', 201);
  } catch (error) {
    logger.error('Error creando solicitud:', error);
    return errorResponse(res, error.message, 400);
  }
});

export default router;

