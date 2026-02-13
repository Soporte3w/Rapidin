import express from 'express';
import { withdrawFromContractor, addToContractor } from '../services/yangoService.js';
import { errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';
import pool from '../database/connection.js';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';

const router = express.Router();

async function withdrawRoute(req, res) {
  try {
    const id = req.body?.driver_profile_id;
    const amount = req.body?.amount;
    const description = req.body?.description ?? '';
    const cookie = req.body?.cookie ?? req.headers['x-yango-cookie'];
    const parkId = req.body?.park_id ?? req.headers['x-park-id'];

    if (!id || amount == null || amount === '') {
      return res.status(400).json({ success: false, message: 'Faltan driver_profile_id y amount' });
    }

    const result = await withdrawFromContractor(id, String(amount), description, cookie, parkId);
    if (!result.success) {
      return res.status(result.status || 502).json({ success: false, message: result.message || 'Error en withdraw Yango' });
    }
    return res.json({ message: 'Cobro realizado exitosamente', data: result.data, status: 200 });
  } catch (err) {
    logger.error('Error en POST /api/yango/withdraw:', err);
    return errorResponse(res, err.message, 500);
  }
}

/** Recarga (add) a Yango Pro: recibe request_id y amount, obtiene driver_profile_id y park_id del conductor. */
async function rechargeRoute(req, res) {
  try {
    const requestId = req.body?.request_id;
    const amount = req.body?.amount;
    const description = req.body?.description ?? '';

    if (!requestId || amount == null || amount === '') {
      return res.status(400).json({ success: false, message: 'Faltan request_id y amount' });
    }

    const driverRow = await pool.query(
      `SELECT d.external_driver_id, d.park_id
       FROM module_rapidin_loan_requests r
       JOIN module_rapidin_drivers d ON d.id = r.driver_id
       WHERE r.id = $1`,
      [requestId]
    );
    if (!driverRow.rows[0]) {
      return res.status(404).json({ success: false, message: 'Solicitud o conductor no encontrado' });
    }
    const driver_profile_id = driverRow.rows[0].external_driver_id;
    const park_id = driverRow.rows[0].park_id || undefined;

    if (!driver_profile_id) {
      return res.status(400).json({ success: false, message: 'El conductor no tiene external_driver_id (Yango Pro)' });
    }

    const cookie = req.body?.cookie ?? req.headers['x-yango-cookie'];
    const parkId = req.body?.park_id ?? req.headers['x-park-id'] ?? park_id;

    const result = await addToContractor(driver_profile_id, String(amount), description, cookie, parkId);
    if (!result.success) {
      return res.status(result.status || 502).json({ success: false, message: result.message || 'Error al recargar en Yango Pro' });
    }
    return res.json({ success: true, message: 'Recarga realizada en Yango Pro', data: result.data });
  } catch (err) {
    logger.error('Error en POST /api/yango/recharge:', err);
    return errorResponse(res, err.message, 500);
  }
}

router.post('/withdraw', express.json(), withdrawRoute);
router.post('/recharge', express.json(), verifyToken, filterByCountry, verifyRole('approver', 'admin'), rechargeRoute);

export default router;
