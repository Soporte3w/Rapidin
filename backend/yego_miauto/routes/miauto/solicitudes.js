import { Router } from 'express';
import { validateUUID } from '../../../middleware/validations.js';
import { successResponse, errorResponse, paginatedResponse } from '../../../utils/responses.js';
import { logger, businessLog } from '../../../utils/logger.js';
import {
  listSolicitudes,
  listAlquilerVenta,
  getSolicitudById,
  createSolicitud,
  updateSolicitud,
  reagendarSolicitud,
  marcarLlegada,
  noVinoRechazar,
  generarYegoMiAuto,
  ActiveSolicitudError,
  getActiveSolicitudInfo,
} from '../../services/solicitud/miautoSolicitudService.js';
import { getPartnerNameById } from '../../../services/partnersService.js';
import pool from '../../../database/connection.js';

const router = Router();

function auditMiautoMutation(eventType, entityType, entityId, payload = {}) {
  businessLog(eventType, payload, {
    entityType,
    entityId: entityId || '',
    actorType: 'user',
  });
}

const STATUS_LABELS_MIAUTO = { pendiente: 'Pendiente', citado: 'Cita agendada', aprobado: 'Aprobado' };
const activeBlockingMessage = (flota, statusLabel) =>
  `Ya tienes una solicitud con estado "${statusLabel}" en la flota "${flota}". No puedes crear otra.`;

function trimOrUndefined(x) {
  if (x == null) return undefined;
  const s = String(x).trim();
  return s === '' ? undefined : s;
}

function getAppsFromBody(body) {
  if (Array.isArray(body?.apps)) return body.apps;
  if (Array.isArray(body?.app_ids)) return body.app_ids;
  return [];
}

async function getParkIdByRapidinDriverId(rapidinDriverId) {
  const pid = trimOrUndefined(rapidinDriverId);
  if (!pid) return null;
  const row = await pool.query('SELECT park_id FROM module_rapidin_drivers WHERE id = $1 LIMIT 1', [pid]);
  return trimOrUndefined(row.rows[0]?.park_id) ?? null;
}

function sameFlota(activeParkId, currentParkId) {
  if (activeParkId == null) return true;
  return activeParkId === currentParkId;
}

// GET /api/miauto/alquiler-venta
router.get('/alquiler-venta', async (req, res) => {
  try {
    const { country, page, limit, q, cronograma_id, cuota_estado } = req.query;
    const result = await listAlquilerVenta({
      country: trimOrUndefined(country),
      page,
      limit,
      q: trimOrUndefined(q),
      cronograma_id: trimOrUndefined(cronograma_id),
      cuota_estado: trimOrUndefined(cuota_estado),
    });
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 20));
    return paginatedResponse(res, result.data, pageNum, limitNum, result.total);
  } catch (error) {
    logger.error('Error listando Alquiler/Venta Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar', 500);
  }
});

// GET /api/miauto/solicitudes
router.get('/solicitudes', async (req, res) => {
  try {
    const { status, country, date_from, date_to, page, limit, park_id, rapidin_driver_id, driver, q } = req.query;
    const filters = {
      status,
      country,
      date_from,
      date_to,
      page,
      limit,
      park_id: trimOrUndefined(park_id),
      rapidin_driver_id: trimOrUndefined(rapidin_driver_id),
      driver: typeof driver === 'string' ? driver : undefined,
      q: typeof q === 'string' ? q : undefined,
    };
    if (req.user?.role === 'driver') {
      filters.driver_phone = req.user.phone;
      filters.driver_country = req.user.country || 'PE';
      filters.forDriver = true;
    }
    const result = await listSolicitudes(filters);
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    return paginatedResponse(res, result.data, pageNum, limitNum, result.total);
  } catch (error) {
    logger.error('Error listando solicitudes Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar solicitudes', 500);
  }
});

// GET /api/miauto/active-blocking
router.get('/active-blocking', async (req, res) => {
  try {
    if (req.user?.role !== 'driver') return successResponse(res, { hasActive: false });
    const phone = req.user.phone;
    const country = req.user.country || 'PE';
    if (!phone) return successResponse(res, { hasActive: false });

    const activeInfo = await getActiveSolicitudInfo(phone, country, null);
    if (!activeInfo) return successResponse(res, { hasActive: false });

    const flotaName = activeInfo.park_id
      ? (await getPartnerNameById(activeInfo.park_id) || activeInfo.park_id)
      : 'Sin flota asignada';
    const activeParkId = trimOrUndefined(activeInfo.park_id) ?? null;
    const currentRapidinId = trimOrUndefined(req.query.rapidin_driver_id);
    const currentParkId = currentRapidinId ? await getParkIdByRapidinDriverId(currentRapidinId) : null;
    const sameFlotaResult = sameFlota(activeParkId, currentParkId);

    return successResponse(res, {
      hasActive: true,
      sameFlota: sameFlotaResult,
      flota: flotaName,
      status: activeInfo.status,
      statusLabel: STATUS_LABELS_MIAUTO[activeInfo.status] || activeInfo.status,
    });
  } catch (error) {
    logger.error('Error en GET /miauto/active-blocking:', error);
    return errorResponse(res, error.message || 'Error al verificar solicitud activa', 500);
  }
});

// POST /api/miauto/solicitudes
router.post('/solicitudes', async (req, res) => {
  try {
    const { country, dni, phone, email, license_number, description, rapidin_driver_id } = req.body;
    if (!dni || !country) return errorResponse(res, 'country y dni son requeridos', 400);

    const solicitud = await createSolicitud({
      country,
      dni,
      phone,
      email,
      license_number,
      description,
      apps: getAppsFromBody(req.body),
      rapidin_driver_id,
    });
    auditMiautoMutation('solicitud.created', 'solicitud', solicitud?.id, { country, dni });
    return successResponse(res, solicitud, 'Solicitud creada', 201);
  } catch (error) {
    if (error instanceof ActiveSolicitudError) {
      const flotaName = error.park_id
        ? (await getPartnerNameById(error.park_id) || error.park_id)
        : 'Sin flota asignada';
      const statusLabel = STATUS_LABELS_MIAUTO[error.status] || error.status;
      return errorResponse(res, activeBlockingMessage(flotaName, statusLabel), 400, { flota: flotaName, status: error.status });
    }
    logger.error('Error creando solicitud Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al crear solicitud', 400);
  }
});

// GET /api/miauto/solicitudes/:id
router.get('/solicitudes/:id', validateUUID, async (req, res) => {
  try {
    const solicitud = await getSolicitudById(req.params.id, {
      skipYangoLicenseLookup: req.user?.role !== 'driver',
    });
    if (!solicitud) {
      return errorResponse(res, 'Solicitud no encontrada', 404);
    }
    return successResponse(res, solicitud);
  } catch (error) {
    logger.error('Error obteniendo solicitud Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al obtener solicitud', 500);
  }
});

// PATCH /api/miauto/solicitudes/:id/generar-yego-mi-auto
router.patch('/solicitudes/:id/generar-yego-mi-auto', validateUUID, async (req, res) => {
  try {
    const placa_asignada = req.body?.placa_asignada;
    const fecha_inicio_cobro_semanal = req.body?.fecha_inicio_cobro_semanal;
    const solicitud = await generarYegoMiAuto(req.params.id, { placa_asignada, fecha_inicio_cobro_semanal });
    if (!solicitud) return errorResponse(res, 'Solicitud no encontrada', 404);
    auditMiautoMutation('solicitud.generated_miauto', 'solicitud', req.params.id, { placa_asignada, fecha_inicio_cobro_semanal });
    return successResponse(res, solicitud, 'Yego Mi Auto generado; cobro semanal iniciado');
  } catch (error) {
    logger.error('Error generando Yego Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al generar Yego Mi Auto', 400);
  }
});

// PATCH /api/miauto/solicitudes/:id
router.patch('/solicitudes/:id', validateUUID, async (req, res) => {
  try {
    const body = req.body;
    const appsVal = getAppsFromBody(body);
    const payload = {};
    if (body.hasOwnProperty('status')) payload.status = body.status;
    if (body.hasOwnProperty('rejection_reason')) payload.rejection_reason = body.rejection_reason;
    if (body.hasOwnProperty('appointment_date')) payload.appointment_date = body.appointment_date;
    if (body.hasOwnProperty('observations')) payload.observations = body.observations;
    if (body.hasOwnProperty('withdrawal_reason')) payload.withdrawal_reason = body.withdrawal_reason;
    if (appsVal.length) payload.apps = appsVal;
    if (body.hasOwnProperty('cronograma_id')) payload.cronograma_id = trimOrUndefined(body.cronograma_id) || null;
    if (body.hasOwnProperty('cronograma_vehiculo_id')) payload.cronograma_vehiculo_id = trimOrUndefined(body.cronograma_vehiculo_id) || null;
    if (body.hasOwnProperty('pago_tipo')) payload.pago_tipo = trimOrUndefined(body.pago_tipo) || null;
    if (body.hasOwnProperty('pago_estado')) payload.pago_estado = trimOrUndefined(body.pago_estado) || null;
    if (body.hasOwnProperty('placa_asignada')) {
      const p = trimOrUndefined(body.placa_asignada);
      payload.placa_asignada = p === undefined ? null : p;
    }
    const solicitud = await updateSolicitud(req.params.id, payload, req.user?.id);
    if (!solicitud) {
      return errorResponse(res, 'Solicitud no encontrada', 404);
    }
    auditMiautoMutation('solicitud.updated', 'solicitud', req.params.id);
    return successResponse(res, solicitud, 'Solicitud actualizada');
  } catch (error) {
    logger.error('Error actualizando solicitud Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al actualizar solicitud', 400);
  }
});

// POST /api/miauto/solicitudes/:id/reagendar
router.post('/solicitudes/:id/reagendar', validateUUID, async (req, res) => {
  try {
    const { appointment_date } = req.body;
    if (!appointment_date) {
      return errorResponse(res, 'appointment_date es requerido', 400);
    }
    const solicitud = await reagendarSolicitud(req.params.id, appointment_date, req.user?.id);
    if (!solicitud) {
      return errorResponse(res, 'Solicitud no encontrada', 404);
    }
    return successResponse(res, solicitud, 'Cita reprogramada');
  } catch (error) {
    logger.error('Error reagendando solicitud Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al reprogramar', 400);
  }
});

// POST /api/miauto/solicitudes/:id/marcar-llegada
router.post('/solicitudes/:id/marcar-llegada', validateUUID, async (req, res) => {
  try {
    const solicitud = await marcarLlegada(req.params.id);
    if (!solicitud) {
      return errorResponse(res, 'Solicitud no encontrada', 404);
    }
    return successResponse(res, solicitud, 'Llegada registrada');
  } catch (error) {
    logger.error('Error marcando llegada Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al marcar llegada', 400);
  }
});

// POST /api/miauto/solicitudes/:id/no-vino-rechazar
router.post('/solicitudes/:id/no-vino-rechazar', validateUUID, async (req, res) => {
  try {
    const solicitud = await noVinoRechazar(req.params.id, req.user?.id);
    if (!solicitud) {
      return errorResponse(res, 'Solicitud no encontrada', 404);
    }
    return successResponse(res, solicitud, 'Solicitud rechazada por inasistencia');
  } catch (error) {
    logger.error('Error rechazando por inasistencia:', error);
    return errorResponse(res, error.message || 'Error al rechazar', 400);
  }
});

// POST /api/miauto/solicitudes/:id/desactivar
router.post('/solicitudes/:id/desactivar', validateUUID, async (req, res) => {
  try {
    const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim() : '';
    const solicitud = await updateSolicitud(req.params.id, {
      status: 'desactivado',
      observations: motivo || undefined,
    }, req.user?.id);
    if (!solicitud) return errorResponse(res, 'Solicitud no encontrada', 404);
    return successResponse(res, solicitud, 'Solicitud desactivada');
  } catch (error) {
    logger.error('Error desactivando solicitud Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al desactivar solicitud', 400);
  }
});

export default router;
