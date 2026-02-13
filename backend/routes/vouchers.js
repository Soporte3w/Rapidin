import express from 'express';
import path from 'path';
import fs from 'fs';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { getAllVouchers, reviewVoucher } from '../services/voucherService.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import pool from '../database/connection.js';
import { validateUUID } from '../middleware/validations.js';

const router = express.Router();

router.use(verifyToken);
router.use(verifyRole('admin', 'payer'));

// Listar todos los vouchers (admin)
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const filters = status ? { status } : {};
    const vouchers = await getAllVouchers(filters);
    return successResponse(res, vouchers);
  } catch (error) {
    return errorResponse(res, error.message || 'Error al listar comprobantes', 500);
  }
});

// Revisar voucher (aprobar o rechazar)
router.patch('/:id/review', validateUUID, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;
    if (!status || !['approved', 'rejected'].includes(status)) {
      return errorResponse(res, 'status debe ser "approved" o "rejected"', 400);
    }
    await reviewVoucher(id, status, req.user.id, rejectionReason);
    return successResponse(res, { ok: true }, status === 'approved' ? 'Comprobante aprobado' : 'Comprobante rechazado');
  } catch (error) {
    return errorResponse(res, error.message || 'Error al revisar comprobante', 400);
  }
});

// Descargar archivo del comprobante (admin)
router.get('/:id/file', validateUUID, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT file_path, file_name FROM module_rapidin_payment_vouchers WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return errorResponse(res, 'Comprobante no encontrado', 404);
    }
    const voucher = result.rows[0];

    // Si file_path es una URL (subida a media/S3), redirigir
    if (voucher.file_path && voucher.file_path.startsWith('http')) {
      return res.redirect(voucher.file_path);
    }

    if (!fs.existsSync(voucher.file_path)) {
      return errorResponse(res, 'Archivo no encontrado', 404);
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${voucher.file_name}"`);
    res.sendFile(path.resolve(voucher.file_path));
  } catch (error) {
    return errorResponse(res, error.message || 'Error al obtener el archivo', 500);
  }
});

export default router;
