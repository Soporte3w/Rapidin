import { Router } from 'express';
import { validateUUID } from '../../../middleware/validations.js';
import { uploadVoucher } from '../../../middleware/upload.js';
import { successResponse, errorResponse } from '../../../utils/responses.js';
import { logger } from '../../../utils/logger.js';
import { getTipoCambioByCountry, setTipoCambio, listTiposCambio } from '../../services/tipo-cambio/miautoTipoCambioService.js';
import { listBySolicitud, createAdjunto } from '../../services/adjuntos/miautoAdjuntoService.js';
import { sendWhatsAppMessage } from '../../../services/authService.js';
import { listBySolicitud as listOtrosGastosBySolicitud } from '../../services/gastos/miautoOtrosGastosService.js';
import { getSolicitudById } from '../../services/solicitud/miautoSolicitudService.js';
import pool from '../../../database/connection.js';

const router = Router();

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

// GET /api/miauto/tipo-cambio?country=PE
router.get('/tipo-cambio', async (req, res) => {
  try {
    const country = trimOrUndefined(req.query.country) || req.user?.country || 'PE';
    const tc = await getTipoCambioByCountry(country);
    return successResponse(res, tc);
  } catch (error) {
    logger.error('Error obteniendo tipo de cambio Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al obtener tipo de cambio', 500);
  }
});

// GET /api/miauto/tipo-cambio/all
router.get('/tipo-cambio/all', async (req, res) => {
  try {
    const list = await listTiposCambio();
    return successResponse(res, list);
  } catch (error) {
    logger.error('Error listando tipos de cambio Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar', 500);
  }
});

// PUT /api/miauto/tipo-cambio
router.put('/tipo-cambio', async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para actualizar tipo de cambio', 403);
    }
    const { country, valor_usd_a_local, moneda_local } = req.body;
    const countryVal = trimOrUndefined(country) || 'PE';
    if (!['PE', 'CO'].includes(countryVal)) {
      return errorResponse(res, 'country debe ser PE o CO', 400);
    }
    const result = await setTipoCambio(countryVal, valor_usd_a_local, moneda_local, req.user?.id);
    return successResponse(res, result, 'Tipo de cambio actualizado');
  } catch (error) {
    logger.error('Error actualizando tipo de cambio Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al actualizar tipo de cambio', 400);
  }
});

// GET /api/miauto/solicitudes/:id/adjuntos
router.get('/solicitudes/:id/adjuntos', validateUUID, async (req, res) => {
  try {
    const adjuntos = await listBySolicitud(req.params.id);
    return successResponse(res, adjuntos);
  } catch (error) {
    logger.error('Error listando adjuntos Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar adjuntos', 500);
  }
});

// POST /api/miauto/solicitudes/:id/adjuntos
router.post(
  '/solicitudes/:id/adjuntos',
  validateUUID,
  uploadVoucher.single('file'),
  async (req, res) => {
    try {
      const { tipo } = req.body;
      if (!tipo || !['licencia', 'comprobante_viajes'].includes(tipo)) {
        return errorResponse(res, 'tipo debe ser licencia o comprobante_viajes', 400);
      }
      if (!req.file) {
        return errorResponse(res, 'Archivo requerido', 400);
      }
      const adjuntos = await createAdjunto(req.params.id, tipo, req.file);
      return successResponse(res, adjuntos, 'Adjunto subido', 201);
    } catch (error) {
      logger.error('Error subiendo adjunto Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al subir adjunto', 400);
    }
  }
);

// POST /api/miauto/solicitudes/:id/send-whatsapp
router.post('/solicitudes/:id/send-whatsapp', validateUUID, async (req, res) => {
  try {
    const sol = await getSolicitudById(req.params.id);
    if (!sol) return errorResponse(res, 'Solicitud no encontrada', 404);
    const rawPhone = sol.phone;
    if (!rawPhone || !String(rawPhone).trim()) {
      return errorResponse(res, 'La solicitud no tiene número de teléfono asociado', 400);
    }
    const digits = String(rawPhone).replace(/\D/g, '');
    const country = sol.country || 'PE';
    let phone = digits;
    if (digits.length >= 10 && (digits.startsWith('51') || digits.startsWith('57'))) {
      phone = digits;
    } else if (country === 'PE' && digits.length === 9) {
      phone = '51' + digits;
    } else if (country === 'CO' && digits.length === 10) {
      phone = '57' + digits;
    }
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return errorResponse(res, 'El mensaje no puede estar vacío', 400);
    const result = await sendWhatsAppMessage(phone, message);
    if (!result.success) return errorResponse(res, result.error || 'Error al enviar WhatsApp', 400);
    return successResponse(res, { sent: true }, 'Mensaje enviado por WhatsApp');
  } catch (error) {
    logger.error('Error enviando WhatsApp MiAuto:', error);
    return errorResponse(res, error.message || 'Error al enviar', 500);
  }
});

// GET /api/miauto/solicitudes/:id/otros-gastos
router.get('/solicitudes/:id/otros-gastos', validateUUID, async (req, res) => {
  try {
    if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
    const list = await listOtrosGastosBySolicitud(req.params.id);
    return successResponse(res, list);
  } catch (error) {
    logger.error('Error listando otros gastos Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar otros gastos', 500);
  }
});

export default router;
