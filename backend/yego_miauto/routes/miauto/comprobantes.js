import { Router } from 'express';
import { validateUUID } from '../../../middleware/validations.js';
import { uploadVoucher } from '../../../middleware/upload.js';
import { successResponse, errorResponse } from '../../../utils/responses.js';
import { logger, businessLog } from '../../../utils/logger.js';
import { listBySolicitud as listComprobantesPago, createComprobantePago, validateComprobante, rejectComprobante, addPagoManual } from '../../services/comprobantes/miautoComprobantePagoService.js';
import {
  listBySolicitud as listComprobantesCuotaSemanal,
  createComprobanteCuotaSemanal,
  createComprobanteConformidadAdmin,
  deleteComprobanteConformidadAdmin,
  validateComprobanteCuotaSemanal,
  rejectComprobanteCuotaSemanal,
  addPagoManualCuotaSemanal,
} from '../../services/comprobantes/miautoComprobanteCuotaSemanalService.js';
import {
  listBySolicitud as listComprobantesOtrosGastos,
  createComprobanteOtrosGastos,
  validateComprobanteOtrosGastos,
  rejectComprobanteOtrosGastos,
} from '../../services/comprobantes/miautoComprobanteOtrosGastosService.js';
import pool from '../../../database/connection.js';

const router = Router();

function auditMiautoMutation(eventType, entityType, entityId, payload = {}) {
  businessLog(eventType, payload, {
    entityType,
    entityId: entityId || '',
    actorType: 'user',
  });
}

function trimOrUndefined(x) {
  if (x == null) return undefined;
  const s = String(x).trim();
  return s === '' ? undefined : s;
}

async function ensureSolicitudOwnedByDriver(solicitudId, req, res) {
  if (req.user?.role !== 'driver') return true;
  const ownRes = await pool.query(
    'SELECT phone, country FROM module_miauto_solicitud WHERE id = $1 LIMIT 1',
    [solicitudId]
  );
  const sol = ownRes.rows[0];
  if (!sol) return true;
  const driverPhone = (req.user?.phone || '').toString().trim();
  const driverCountry = (req.user?.country || 'PE').toString().trim();
  const solPhone = (sol.phone || '').toString().trim();
  const solCountry = (sol.country || '').toString().trim();
  const phoneMatch = driverPhone && solPhone && (driverPhone === solPhone || driverPhone.replace(/\D/g, '') === solPhone.replace(/\D/g, ''));
  const countryMatch = driverCountry === solCountry;
  if (!phoneMatch || !countryMatch) {
    errorResponse(res, 'No tienes permiso para acceder a esta solicitud', 403);
    return false;
  }
  return true;
}

// GET /api/miauto/solicitudes/:id/comprobantes-pago
router.get('/solicitudes/:id/comprobantes-pago', validateUUID, async (req, res) => {
  try {
    const list = await listComprobantesPago(req.params.id);
    return successResponse(res, list);
  } catch (error) {
    logger.error('Error listando comprobantes de pago Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar comprobantes', 500);
  }
});

// POST /api/miauto/solicitudes/:id/comprobantes-pago
router.post(
  '/solicitudes/:id/comprobantes-pago',
  validateUUID,
  uploadVoucher.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return errorResponse(res, 'Archivo requerido', 400);
      }
      const monto = req.body.monto != null ? parseFloat(req.body.monto) : null;
      const moneda = trimOrUndefined(req.body.moneda);
      let list = await createComprobantePago(req.params.id, req.file, monto, req.user?.id);
      if (list.length > 0 && monto != null && !Number.isNaN(monto) && moneda) {
        const lastId = list[list.length - 1].id;
        list = await validateComprobante(
          req.params.id,
          lastId,
          req.user?.id,
          { monto, moneda: moneda.toUpperCase() === 'PEN' ? 'PEN' : 'USD' }
        );
      }
      return successResponse(res, list, list.length && list[list.length - 1].estado === 'validado' ? 'Comprobante subido y validado' : 'Comprobante subido', 201);
    } catch (error) {
      logger.error('Error subiendo comprobante de pago Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al subir comprobante', 400);
    }
  }
);

// POST /api/miauto/solicitudes/:id/pago-manual
router.post(
  '/solicitudes/:id/pago-manual',
  validateUUID,
  async (req, res) => {
    try {
      const monto = req.body.monto != null ? parseFloat(req.body.monto) : null;
      const moneda = trimOrUndefined(req.body.moneda);
      if (monto == null || Number.isNaN(monto) || monto <= 0 || !moneda) {
        return errorResponse(res, 'monto (número > 0) y moneda (PEN o USD) son requeridos', 400);
      }
      const list = await addPagoManual(req.params.id, req.user?.id, {
        monto,
        moneda: moneda.toUpperCase() === 'PEN' ? 'PEN' : 'USD',
      });
      auditMiautoMutation('pago.manual_registered', 'pago', null, { solicitudId: req.params.id, monto, moneda });
      return successResponse(res, list, 'Pago manual registrado', 201);
    } catch (error) {
      logger.error('Error agregando pago manual Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al agregar pago', 400);
    }
  }
);

// PATCH /api/miauto/solicitudes/:id/comprobantes-pago/:comprobanteId/validar
router.patch(
  '/solicitudes/:id/comprobantes-pago/:comprobanteId/validar',
  validateUUID,
  async (req, res) => {
    try {
      const monto = req.body.monto != null ? parseFloat(req.body.monto) : undefined;
      const moneda = trimOrUndefined(req.body.moneda);
      const list = await validateComprobante(
        req.params.id,
        req.params.comprobanteId,
        req.user?.id,
        (monto != null && !Number.isNaN(monto) && moneda) ? { monto, moneda: moneda.toUpperCase() === 'PEN' ? 'PEN' : 'USD' } : {}
      );
      auditMiautoMutation('comprobante.validated', 'comprobante', req.params.comprobanteId, { solicitudId: req.params.id });
      return successResponse(res, list, 'Comprobante validado');
    } catch (error) {
      logger.error('Error validando comprobante Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al validar comprobante', 400);
    }
  }
);

// PATCH /api/miauto/solicitudes/:id/comprobantes-pago/:comprobanteId/rechazar
router.patch(
  '/solicitudes/:id/comprobantes-pago/:comprobanteId/rechazar',
  validateUUID,
  async (req, res) => {
    try {
      const motivo = trimOrUndefined(req.body.motivo);
      const list = await rejectComprobante(
        req.params.id,
        req.params.comprobanteId,
        req.user?.id,
        { motivo: motivo || undefined }
      );
      auditMiautoMutation('comprobante.rejected', 'comprobante', req.params.comprobanteId, { solicitudId: req.params.id, motivo });
      return successResponse(res, list, 'Comprobante rechazado');
    } catch (error) {
      logger.error('Error rechazando comprobante Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al rechazar comprobante', 400);
    }
  }
);

// --- Cuotas semanales Mi Auto ---

// GET /api/miauto/solicitudes/:id/comprobantes-cuota-semanal
router.get('/solicitudes/:id/comprobantes-cuota-semanal', validateUUID, async (req, res) => {
  try {
    if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
    const list = await listComprobantesCuotaSemanal(req.params.id);
    return successResponse(res, list);
  } catch (error) {
    logger.error('Error listando comprobantes cuota semanal Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar comprobantes', 500);
  }
});

// POST /api/miauto/solicitudes/:id/cuotas-semanales/:cuotaSemanalId/comprobantes
router.post(
  '/solicitudes/:id/cuotas-semanales/:cuotaSemanalId/comprobantes',
  validateUUID,
  uploadVoucher.single('file'),
  async (req, res) => {
    try {
      if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
      if (!req.file) {
        return errorResponse(res, 'Archivo requerido', 400);
      }
      const monto = req.body.monto != null ? parseFloat(req.body.monto) : null;
      const moneda = trimOrUndefined(req.body.moneda);
      const list = await createComprobanteCuotaSemanal(
        req.params.id,
        req.params.cuotaSemanalId,
        req.file,
        monto,
        moneda || 'PEN',
        req.user?.id
      );
      return successResponse(res, list, 'Comprobante subido', 201);
    } catch (error) {
      logger.error('Error subiendo comprobante cuota semanal Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al subir comprobante', 400);
    }
  }
);

// POST /api/miauto/solicitudes/:id/cuotas-semanales/:cuotaSemanalId/comprobantes-conformidad-admin
router.post(
  '/solicitudes/:id/cuotas-semanales/:cuotaSemanalId/comprobantes-conformidad-admin',
  validateUUID,
  uploadVoucher.single('file'),
  async (req, res) => {
    try {
      if (req.user?.role === 'driver') {
        return errorResponse(res, 'No autorizado', 403);
      }
      if (!req.file) {
        return errorResponse(res, 'Archivo requerido', 400);
      }
      if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
      const list = await createComprobanteConformidadAdmin(
        req.params.id,
        req.params.cuotaSemanalId,
        req.file,
        req.user?.id,
        { monto: req.body?.monto, moneda: req.body?.moneda }
      );
      return successResponse(res, list, 'Comprobante de conformidad subido', 201);
    } catch (error) {
      logger.error('Error subiendo conformidad cuota semanal Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al subir comprobante de conformidad', 400);
    }
  }
);

// DELETE /api/miauto/solicitudes/:id/comprobantes-cuota-semanal/:comprobanteId/conformidad-admin
router.delete(
  '/solicitudes/:id/comprobantes-cuota-semanal/:comprobanteId/conformidad-admin',
  validateUUID,
  async (req, res) => {
    try {
      if (req.user?.role === 'driver') {
        return errorResponse(res, 'No autorizado', 403);
      }
      if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
      const list = await deleteComprobanteConformidadAdmin(req.params.id, req.params.comprobanteId);
      return successResponse(res, list, 'Comprobante de conformidad eliminado');
    } catch (error) {
      logger.error('Error eliminando conformidad cuota semanal Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al eliminar comprobante de conformidad', 400);
    }
  }
);

// PATCH /api/miauto/solicitudes/:id/comprobantes-cuota-semanal/:comprobanteId/validar
router.patch(
  '/solicitudes/:id/comprobantes-cuota-semanal/:comprobanteId/validar',
  validateUUID,
  async (req, res) => {
    try {
      const monto = req.body.monto != null ? parseFloat(req.body.monto) : undefined;
      const moneda = trimOrUndefined(req.body.moneda);
      const list = await validateComprobanteCuotaSemanal(
        req.params.id,
        req.params.comprobanteId,
        req.user?.id,
        (monto != null && !Number.isNaN(monto) && moneda) ? { monto, moneda: moneda.toUpperCase() === 'PEN' ? 'PEN' : 'USD' } : {}
      );
      auditMiautoMutation('comprobante_cuota.validated', 'comprobante_cuota_semanal', req.params.comprobanteId, { solicitudId: req.params.id });
      return successResponse(res, list, 'Comprobante validado');
    } catch (error) {
      logger.error('Error validando comprobante cuota semanal Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al validar comprobante', 400);
    }
  }
);

// PATCH /api/miauto/solicitudes/:id/comprobantes-cuota-semanal/:comprobanteId/rechazar
router.patch(
  '/solicitudes/:id/comprobantes-cuota-semanal/:comprobanteId/rechazar',
  validateUUID,
  async (req, res) => {
    try {
      const motivo = trimOrUndefined(req.body.motivo);
      const list = await rejectComprobanteCuotaSemanal(
        req.params.id,
        req.params.comprobanteId,
        req.user?.id,
        { motivo: motivo || undefined }
      );
      auditMiautoMutation('comprobante_cuota.rejected', 'comprobante_cuota_semanal', req.params.comprobanteId, { solicitudId: req.params.id, motivo });
      return successResponse(res, list, 'Comprobante rechazado');
    } catch (error) {
      logger.error('Error rechazando comprobante cuota semanal Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al rechazar comprobante', 400);
    }
  }
);

// POST /api/miauto/solicitudes/:id/cuotas-semanales/:cuotaSemanalId/pago-manual
router.post(
  '/solicitudes/:id/cuotas-semanales/:cuotaSemanalId/pago-manual',
  validateUUID,
  async (req, res) => {
    try {
      const monto = req.body.monto != null ? parseFloat(req.body.monto) : null;
      const moneda = trimOrUndefined(req.body.moneda);
      if (monto == null || Number.isNaN(monto) || monto <= 0 || !moneda) {
        return errorResponse(res, 'monto (número > 0) y moneda (PEN o USD) son requeridos', 400);
      }
      const list = await addPagoManualCuotaSemanal(
        req.params.id,
        req.params.cuotaSemanalId,
        req.user?.id,
        { monto, moneda: moneda.toUpperCase() === 'PEN' ? 'PEN' : 'USD' }
      );
      auditMiautoMutation('pago_cuota.manual_registered', 'cuota_semanal', req.params.cuotaSemanalId, { solicitudId: req.params.id, monto, moneda });
      return successResponse(res, list, 'Pago manual registrado', 201);
    } catch (error) {
      logger.error('Error registrando pago manual cuota semanal Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al registrar pago', 400);
    }
  }
);

// --- Otros gastos ---

// GET /api/miauto/solicitudes/:id/comprobantes-otros-gastos
router.get('/solicitudes/:id/comprobantes-otros-gastos', validateUUID, async (req, res) => {
  try {
    if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
    const list = await listComprobantesOtrosGastos(req.params.id);
    return successResponse(res, list);
  } catch (error) {
    logger.error('Error listando comprobantes otros gastos Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar comprobantes', 500);
  }
});

// POST /api/miauto/solicitudes/:id/otros-gastos/:otrosGastosId/comprobantes
router.post(
  '/solicitudes/:id/otros-gastos/:otrosGastosId/comprobantes',
  validateUUID,
  uploadVoucher.single('file'),
  async (req, res) => {
    try {
      if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
      if (!req.file) {
        return errorResponse(res, 'Archivo requerido', 400);
      }
      const monto = req.body.monto != null ? parseFloat(req.body.monto) : null;
      const moneda = trimOrUndefined(req.body.moneda);
      const list = await createComprobanteOtrosGastos(
        req.params.id,
        req.params.otrosGastosId,
        req.file,
        monto,
        moneda || 'PEN',
        req.user?.id
      );
      return successResponse(res, list, 'Comprobante subido', 201);
    } catch (error) {
      logger.error('Error subiendo comprobante otros gastos Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al subir comprobante', 400);
    }
  }
);

// PATCH /api/miauto/solicitudes/:id/comprobantes-otros-gastos/:comprobanteId/validar
router.patch(
  '/solicitudes/:id/comprobantes-otros-gastos/:comprobanteId/validar',
  validateUUID,
  async (req, res) => {
    try {
      const monto = req.body.monto != null ? parseFloat(req.body.monto) : undefined;
      const moneda = trimOrUndefined(req.body.moneda);
      const list = await validateComprobanteOtrosGastos(
        req.params.id,
        req.params.comprobanteId,
        req.user?.id,
        (monto != null && !Number.isNaN(monto) && moneda) ? { monto, moneda: moneda.toUpperCase() === 'PEN' ? 'PEN' : 'USD' } : {}
      );
      return successResponse(res, list, 'Comprobante validado');
    } catch (error) {
      logger.error('Error validando comprobante otros gastos Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al validar comprobante', 400);
    }
  }
);

// PATCH /api/miauto/solicitudes/:id/comprobantes-otros-gastos/:comprobanteId/rechazar
router.patch(
  '/solicitudes/:id/comprobantes-otros-gastos/:comprobanteId/rechazar',
  validateUUID,
  async (req, res) => {
    try {
      const motivo = trimOrUndefined(req.body.motivo);
      const list = await rejectComprobanteOtrosGastos(
        req.params.id,
        req.params.comprobanteId,
        req.user?.id,
        { motivo: motivo || undefined }
      );
      return successResponse(res, list, 'Comprobante rechazado');
    } catch (error) {
      logger.error('Error rechazando comprobante otros gastos Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al rechazar comprobante', 400);
    }
  }
);

export default router;
