import { Router } from 'express';
import { validateUUID } from '../../../middleware/validations.js';
import { uploadVoucher } from '../../../middleware/upload.js';
import { successResponse, errorResponse } from '../../../utils/responses.js';
import { logger, businessLog } from '../../../utils/logger.js';
import { getTipoCambioByCountry, setTipoCambio, listTiposCambio } from '../../services/tipo-cambio/miautoTipoCambioService.js';
import { listBySolicitud, createAdjunto } from '../../services/adjuntos/miautoAdjuntoService.js';
import { sendEvolutionGoMediaMessage, sendEvolutionGoTextMessage } from '../../../services/evolutionGoWhatsAppService.js';
import {
  normalizeWhatsAppPhoneDigits,
  refreshMiautoWhatsAppPhone,
  resolveMiautoWhatsAppPhone,
} from '../../../services/whatsappPhoneSyncService.js';
import {
  generateExpenseCycles,
  getExpenseConfiguration,
  listBySolicitud as listOtrosGastosBySolicitud,
  updateExpenseConfiguration,
} from '../../services/gastos/miautoOtrosGastosService.js';
import { getSolicitudById } from '../../services/solicitud/miautoSolicitudService.js';
import {
  getAdditionalExpenseChargePreview,
  chargeSelectedAdditionalExpensesWithReceipts,
} from '../../services/cuotas/miautoFleetChargeService.js';
import pool from '../../../database/connection.js';

const router = Router();

function trimOrUndefined(x) {
  if (x == null) return undefined;
  const s = String(x).trim();
  return s === '' ? undefined : s;
}

function miautoDriverNameFromSolicitud(sol) {
  return [
    sol?.driver_first_name || sol?.first_name,
    sol?.driver_last_name || sol?.last_name,
  ].filter(Boolean).join(' ').trim()
    || sol?.driver_name
    || sol?.full_name
    || sol?.dni
    || 'Conductor';
}

async function insertWhatsAppLog({ solicitudId, driverName, phone, message, status, error, userId }) {
  try {
    await pool.query(
      `INSERT INTO module_miauto_whatsapp_log (solicitud_id, driver_name, phone, message, status, error, created_by, sent_at)
       VALUES ($1, $2, $3, $4, $5::text, $6, $7, CASE WHEN $5::text = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
      [solicitudId, driverName, phone, message, status, error || null, userId || null]
    );
  } catch (errorLog) {
    if (errorLog?.code !== '42703') {
      logger.error('Error insertando log WhatsApp MiAuto:', errorLog);
    }
  }
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

// POST /api/miauto/solicitudes/:id/whatsapp-phone/refresh
router.post('/solicitudes/:id/whatsapp-phone/refresh', validateUUID, async (req, res) => {
  try {
    const result = await refreshMiautoWhatsAppPhone(req.params.id, req.user?.id || null);
    return successResponse(res, result, 'Teléfono WhatsApp actualizado');
  } catch (error) {
    logger.error('Error refrescando teléfono WhatsApp Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al refrescar teléfono', error.statusCode || 500);
  }
});

// POST /api/miauto/solicitudes/:id/send-whatsapp
router.post('/solicitudes/:id/send-whatsapp', validateUUID, async (req, res) => {
  try {
    const sol = await getSolicitudById(req.params.id);
    if (!sol) return errorResponse(res, 'Solicitud no encontrada', 404);
    const resolvedPhone = await resolveMiautoWhatsAppPhone(req.params.id);
    const rawPhone = resolvedPhone?.phone || sol.phone;
    if (!rawPhone || !String(rawPhone).trim()) {
      return errorResponse(res, 'La solicitud no tiene número de teléfono asociado', 400);
    }
    const country = sol.country || 'PE';
    const phone = normalizeWhatsAppPhoneDigits(rawPhone, country);
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const notaVentaId = trimOrUndefined(req.body?.nota_venta_id);
    let comprobanteAdjunto = null;
    if (!message) return errorResponse(res, 'El mensaje no puede estar vacío', 400);

    if (notaVentaId) {
      const notaRes = await pool.query(
        `SELECT number_full, print_a4
         FROM module_miauto_nota_venta
         WHERE id = $1::uuid
           AND solicitud_id = $2::uuid
           AND deleted_at IS NULL
         LIMIT 1`,
        [notaVentaId, req.params.id]
      );
      const nota = notaRes.rows[0];
      if (!nota?.print_a4) {
        return errorResponse(res, 'La nota de venta seleccionada no tiene PDF disponible', 400);
      }
      comprobanteAdjunto = {
        url: nota.print_a4,
        name: `${nota.number_full || 'comprobante-de-pago'}.pdf`,
        mime: 'application/pdf',
      };
    }

    if (comprobanteAdjunto) {
      const documentResult = await sendEvolutionGoMediaMessage(
        phone,
        {
          caption: message,
          fileUrl: comprobanteAdjunto.url,
          fileName: comprobanteAdjunto.name,
          type: 'document',
          defaultCountry: country,
        },
        {
          token: process.env.EVOLUTION_GO_MIAUTO_TOKEN,
          tokenName: 'EVOLUTION_GO_MIAUTO_TOKEN',
        }
      );
      if (documentResult.success) {
        await insertWhatsAppLog({
          solicitudId: req.params.id,
          driverName: miautoDriverNameFromSolicitud(sol),
          phone,
          message: `[COMPROBANTE ENVIADO] ${comprobanteAdjunto.name}\n${message}`,
          status: 'sent',
          error: null,
          userId: req.user?.id || null,
        });
        return successResponse(res, { sent: true, attachment_sent: true }, 'Mensaje enviado por WhatsApp');
      }

      const fallbackMessage = `${message}\n\nComprobante de pago: ${comprobanteAdjunto.url}`;
      const fallbackResult = await sendEvolutionGoTextMessage(phone, fallbackMessage, {
        token: process.env.EVOLUTION_GO_MIAUTO_TOKEN,
        tokenName: 'EVOLUTION_GO_MIAUTO_TOKEN',
        defaultCountry: country,
      });
      if (!fallbackResult.success) {
        await insertWhatsAppLog({
          solicitudId: req.params.id,
          driverName: miautoDriverNameFromSolicitud(sol),
          phone,
          message: `[COMPROBANTE FALLIDO] ${comprobanteAdjunto.name}\n${message}`,
          status: 'failed',
          error: documentResult.error || fallbackResult.error || 'Error al enviar WhatsApp',
          userId: req.user?.id || null,
        });
        return errorResponse(res, documentResult.error || fallbackResult.error || 'Error al enviar WhatsApp', 400);
      }
      await insertWhatsAppLog({
        solicitudId: req.params.id,
        driverName: miautoDriverNameFromSolicitud(sol),
        phone,
        message: `[COMPROBANTE ENVIADO COMO LINK] ${comprobanteAdjunto.name}\n${fallbackMessage}`,
        status: 'sent',
        error: documentResult.error || null,
        userId: req.user?.id || null,
      });
      return successResponse(
        res,
        { sent: true, attachment_sent: false, fallback_link_sent: true, attachment_error: documentResult.error },
        'Mensaje enviado por WhatsApp con enlace del comprobante'
      );
    }

    const result = await sendEvolutionGoTextMessage(phone, message, {
      token: process.env.EVOLUTION_GO_MIAUTO_TOKEN,
      tokenName: 'EVOLUTION_GO_MIAUTO_TOKEN',
      defaultCountry: country,
    });
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

router.get('/solicitudes/:id/otros-gastos/cobrar/preview', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos para realizar cobros', 403);
    const preview = await getAdditionalExpenseChargePreview(req.params.id);
    return successResponse(res, preview);
  } catch (error) {
    logger.error('Error consultando cobro Fleet de otros gastos:', error);
    return errorResponse(res, error.message || 'Error al consultar el saldo Fleet', error.statusCode || 500);
  }
});

router.post('/solicitudes/:id/otros-gastos/cobrar', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos para realizar cobros', 403);
    const result = await chargeSelectedAdditionalExpensesWithReceipts(
      req.params.id,
      req.body?.otros_gastos_ids,
      { userId: req.user?.id || null }
    );
    businessLog('miauto.otros_gastos.fleet_charge_confirmed', {
      solicitudId: req.params.id,
      otrosGastosIds: req.body?.otros_gastos_ids,
      summary: {
        total: result.total,
        success: result.success,
        partial: result.partial,
        failed: result.failed,
        skipped: result.skipped,
      },
    }, {
      entityType: 'module_miauto_solicitud',
      entityId: req.params.id,
      actorType: 'user',
      actorId: req.user?.id || null,
    });
    return successResponse(res, result, 'Cobro Fleet de otros gastos procesado');
  } catch (error) {
    logger.error('Error confirmando cobro Fleet de otros gastos:', error);
    return errorResponse(res, error.message || 'Error al confirmar el cobro Fleet', error.statusCode || 500);
  }
});

router.get('/solicitudes/:id/otros-gastos/configuracion', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos para ver esta configuracion', 403);
    return successResponse(res, await getExpenseConfiguration(req.params.id));
  } catch (error) {
    logger.error('Error obteniendo configuracion de otros gastos:', error);
    return errorResponse(res, error.message || 'Error al obtener configuracion', 400);
  }
});

router.patch('/solicitudes/:id/otros-gastos/configuracion', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos para configurar gastos', 403);
    const config = await updateExpenseConfiguration(req.params.id, req.body || {}, req.user?.id || null);
    return successResponse(res, config, 'Configuracion de gastos actualizada');
  } catch (error) {
    logger.error('Error actualizando configuracion de otros gastos:', error);
    return errorResponse(res, error.message || 'Error al actualizar configuracion', 400);
  }
});

router.post('/solicitudes/:id/otros-gastos/generar', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos para generar gastos', 403);
    const result = await generateExpenseCycles(req.params.id, {
      periodYear: req.body?.periodo_anio,
      vehicleTaxTotal: req.body?.impuesto_vehicular_monto_total,
      userId: req.user?.id || null,
      forceManual: true,
    });
    return successResponse(res, result, 'Ciclos de gastos generados');
  } catch (error) {
    logger.error('Error generando otros gastos:', error);
    return errorResponse(res, error.message || 'Error al generar gastos', 400);
  }
});

export default router;
