import express from 'express';
import { withdrawFromContractor, addToContractor } from '../services/yangoService.js';
import { errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';
import pool from '../database/connection.js';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { filterByCountry } from '../middleware/permissions.js';
import { isFleetPendingOrIncomingTransactionError } from '../utils/yangoFleetTransactionErrors.js';

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
      const msg = result.message || 'Error al recargar en Yango Pro';
      const pendingTx = isFleetPendingOrIncomingTransactionError(msg);
      return res.status(pendingTx ? 409 : result.status || 502).json({
        success: false,
        message: msg,
        ...(pendingTx && { code: 'FLEET_PENDING_TRANSACTION' }),
      });
    }
    return res.json({ success: true, message: 'Recarga realizada en Yango Pro', data: result.data });
  } catch (err) {
    logger.error('Error en POST /api/yango/recharge:', err);
    return errorResponse(res, err.message, 500);
  }
}

/**
 * Rapidín — sin llamar a Fleet. Solo afecta la solicitud `request_id` (un conductor por solicitud).
 * Requiere estado approved y deposit_type yango en observations; no aplica a otras solicitudes ni estados.
 */
async function rechargeManualRoute(req, res) {
  try {
    const requestId = req.body?.request_id;
    const amount = req.body?.amount;
    const note = (req.body?.note ?? req.body?.description ?? '').toString().trim().slice(0, 500);
    const fleetErrorSnapshot = (req.body?.fleet_error_snapshot ?? '').toString().trim().slice(0, 1000);
    const userId = req.user?.id;

    if (!requestId || amount == null || amount === '') {
      return res.status(400).json({ success: false, message: 'Faltan request_id y amount' });
    }
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }

    const reqRow = await pool.query(
      `SELECT id, status, observations FROM module_rapidin_loan_requests WHERE id = $1`,
      [requestId]
    );
    if (reqRow.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
    }
    const { status, observations } = reqRow.rows[0];
    if (status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Solo se puede registrar recarga manual en solicitudes aprobadas' });
    }

    let obs = {};
    try {
      if (observations) {
        obs = typeof observations === 'string' ? JSON.parse(observations) : { ...observations };
      }
    } catch (_) {
      obs = {};
    }
    if (obs.deposit_type !== 'yango') {
      return res.status(400).json({
        success: false,
        message: 'La recarga manual solo aplica cuando el depósito es Yango Pro',
      });
    }

    obs.yango_manual_recharge = {
      recorded_at: new Date().toISOString(),
      recorded_by_user_id: userId,
      amount: String(amount),
      ...(note ? { note } : {}),
      ...(fleetErrorSnapshot ? { fleet_error_snapshot: fleetErrorSnapshot } : {}),
      source: 'manual_skip_fleet',
    };

    await pool.query(
      `UPDATE module_rapidin_loan_requests SET observations = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [JSON.stringify(obs), requestId]
    );

    logger.info(`[Rapidín] Recarga manual registrada request_id=${requestId} user_id=${userId} amount=${amount}`);
    return res.json({
      success: true,
      message: 'Recarga registrada en el sistema (sin llamada a Fleet). Puede continuar con el desembolso.',
    });
  } catch (err) {
    logger.error('Error en POST /api/yango/recharge-manual:', err);
    return errorResponse(res, err.message, 500);
  }
}

router.post('/withdraw', express.json(), withdrawRoute);
router.post('/recharge', express.json(), verifyToken, filterByCountry, verifyRole('approver', 'admin'), rechargeRoute);
router.post(
  '/recharge-manual',
  express.json(),
  verifyToken,
  filterByCountry,
  verifyRole('approver', 'admin'),
  rechargeManualRoute
);

export default router;
