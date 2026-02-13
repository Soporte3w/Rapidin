import express from 'express';
import { login, getCurrentUser, sendOTP, verifyOTP } from '../services/authService.js';
import { verifyToken } from '../middleware/auth.js';
import { validateLogin } from '../middleware/validations.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.post('/login', validateLogin, async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await login(email, password);
        return successResponse(res, result, 'Login exitoso');
    } catch (error) {
        logger.error('Error en login:', error);
        return errorResponse(res, error.message, 401);
    }
});

router.post('/send-otp', async (req, res) => {
    try {
        const { phone, country } = req.body;

        if (!phone || !country) {
            return errorResponse(res, 'Teléfono y país son requeridos', 400);
        }

        if (!phone.startsWith('+') || phone.length < 12) {
            return errorResponse(res, 'Número de teléfono inválido', 400);
        }

        await sendOTP(phone, country);
        return successResponse(res, { message: 'Código enviado exitosamente' }, 'Código enviado');
    } catch (error) {
        logger.error('Error enviando OTP:', error);
        return errorResponse(res, error.message || 'Error al enviar código', 500);
    }
});

router.post('/verify-otp', async (req, res) => {
    try {
        const { phone, code, country } = req.body;

        if (!phone || !code || !country) {
            return errorResponse(res, 'Teléfono, código y país son requeridos', 400);
        }

        // NO limpiar el teléfono - debe llegar con el + desde el frontend
        const result = await verifyOTP(phone, code, country);
        return successResponse(res, result, 'Verificación exitosa');
    } catch (error) {
        logger.error('Error verificando OTP:', error);
        return errorResponse(res, error.message || 'Código inválido', 401);
    }
});

router.get('/me', verifyToken, async (req, res) => {
    try {
        const user = await getCurrentUser(req.user.id);
        return successResponse(res, user);
    } catch (error) {
        logger.error('Error obteniendo usuario actual:', error);
        return errorResponse(res, error.message, 404);
    }
});

export default router;







