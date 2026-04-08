import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateUUID } from '../middleware/validations.js';
import { successResponse, errorResponse, paginatedResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';
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
} from '../services/miautoSolicitudService.js';
import {
  listCronogramas,
  listCronogramasLite,
  getCronogramaById,
  createCronograma,
  updateCronograma,
  deleteCronograma,
  toggleCronogramaActive,
} from '../services/miautoCronogramaService.js';
import { getTipoCambioByCountry, setTipoCambio, listTiposCambio } from '../services/miautoTipoCambioService.js';
import { getPartnerNameById } from '../services/partnersService.js';
import { listBySolicitud, createAdjunto } from '../services/miautoAdjuntoService.js';
import { listBySolicitud as listComprobantesPago, createComprobantePago, validateComprobante, rejectComprobante, addPagoManual } from '../services/miautoComprobantePagoService.js';
import { getCuotasSemanalesConRacha, recalcularMoraGlobal } from '../services/miautoCuotaSemanalService.js';
import {
  listBySolicitud as listComprobantesCuotaSemanal,
  createComprobanteCuotaSemanal,
  createComprobanteConformidadAdmin,
  deleteComprobanteConformidadAdmin,
  validateComprobanteCuotaSemanal,
  rejectComprobanteCuotaSemanal,
  addPagoManualCuotaSemanal,
} from '../services/miautoComprobanteCuotaSemanalService.js';
import {
  listBySolicitud as listComprobantesOtrosGastos,
  createComprobanteOtrosGastos,
  validateComprobanteOtrosGastos,
  rejectComprobanteOtrosGastos,
} from '../services/miautoComprobanteOtrosGastosService.js';
import { listBySolicitud as listOtrosGastosBySolicitud } from '../services/miautoOtrosGastosService.js';
import { sendWhatsAppMessage } from '../services/authService.js';
import pool from '../database/connection.js';
import { uploadVoucher } from '../middleware/upload.js';

const router = express.Router();
router.use(authenticate);

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
  return activeParkId === currentParkId || (activeParkId == null && currentParkId == null);
}

/** Si el usuario es conductor, verifica que la solicitud sea suya (por phone + country). Retorna true si OK, false si no. */
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

// GET /api/miauto/alquiler-venta (solicitudes con Yego Mi Auto generado; para sección Alquiler / Venta)
router.get('/alquiler-venta', authenticate, async (req, res) => {
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
    const { status, country, date_from, date_to, page, limit, park_id, rapidin_driver_id } = req.query;
    const filters = {
      status,
      country,
      date_from,
      date_to,
      page,
      limit,
      park_id: trimOrUndefined(park_id),
      rapidin_driver_id: trimOrUndefined(rapidin_driver_id),
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

// Cache en memoria para GET /cronogramas (TTL 60s). Se invalida al crear/actualizar/eliminar/toggle.
const cronogramasListCache = new Map();
const CRONOGRAMAS_CACHE_TTL_MS = 60 * 1000;

function getCronogramasCacheKey(country, active) {
  return `${String(country ?? '')}:${active === undefined || active === null ? '' : String(active)}`;
}

function invalidateCronogramasListCache() {
  cronogramasListCache.clear();
}

// GET /api/miauto/cronogramas — por defecto payload completo; ?lite=true → solo { id, name } (combos)
router.get('/cronogramas', async (req, res) => {
  try {
    const { country, active, lite } = req.query;
    const countryVal = trimOrUndefined(country);
    const isLite = lite === 'true' || lite === '1';
    const key = getCronogramasCacheKey(countryVal, active, isLite);
    const now = Date.now();
    const cached = cronogramasListCache.get(key);
    if (cached && cached.expires > now) {
      return successResponse(res, cached.data);
    }
    const list = isLite
      ? await listCronogramasLite({ country: countryVal, active })
      : await listCronogramas({ country: countryVal, active });
    cronogramasListCache.set(key, { data: list, expires: now + CRONOGRAMAS_CACHE_TTL_MS });
    return successResponse(res, list);
  } catch (error) {
    logger.error('Error listando cronogramas Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar cronogramas', 500);
  }
});

// GET /api/miauto/cronogramas/:id
router.get('/cronogramas/:id', validateUUID, async (req, res) => {
  try {
    const cronograma = await getCronogramaById(req.params.id);
    if (!cronograma) return errorResponse(res, 'Cronograma no encontrado', 404);
    return successResponse(res, cronograma);
  } catch (error) {
    logger.error('Error obteniendo cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al obtener cronograma', 500);
  }
});

// POST /api/miauto/cronogramas
router.post('/cronogramas', async (req, res) => {
  try {
    const cronograma = await createCronograma(req.body);
    invalidateCronogramasListCache();
    return successResponse(res, cronograma, 'Cronograma creado', 201);
  } catch (error) {
    logger.error('Error creando cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al crear cronograma', 400);
  }
});

// PUT /api/miauto/cronogramas/:id
router.put('/cronogramas/:id', validateUUID, async (req, res) => {
  try {
    const cronograma = await updateCronograma(req.params.id, req.body);
    if (!cronograma) return errorResponse(res, 'Cronograma no encontrado', 404);
    invalidateCronogramasListCache();
    return successResponse(res, cronograma, 'Cronograma actualizado');
  } catch (error) {
    logger.error('Error actualizando cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al actualizar cronograma', 400);
  }
});

// DELETE /api/miauto/cronogramas/:id
router.delete('/cronogramas/:id', validateUUID, async (req, res) => {
  try {
    const deleted = await deleteCronograma(req.params.id);
    if (!deleted) return errorResponse(res, 'Cronograma no encontrado', 404);
    invalidateCronogramasListCache();
    return successResponse(res, { deleted: true }, 'Cronograma eliminado');
  } catch (error) {
    logger.error('Error eliminando cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al eliminar cronograma', 400);
  }
});

// PATCH /api/miauto/cronogramas/:id/toggle-active
router.patch('/cronogramas/:id/toggle-active', validateUUID, async (req, res) => {
  try {
    const cronograma = await toggleCronogramaActive(req.params.id);
    if (!cronograma) return errorResponse(res, 'Cronograma no encontrado', 404);
    invalidateCronogramasListCache();
    return successResponse(res, cronograma, 'Estado actualizado');
  } catch (error) {
    logger.error('Error cambiando estado cronograma Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al cambiar estado', 400);
  }
});

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

// GET /api/miauto/tipo-cambio/all (admin: listar todos los países)
router.get('/tipo-cambio/all', async (req, res) => {
  try {
    const list = await listTiposCambio();
    return successResponse(res, list);
  } catch (error) {
    logger.error('Error listando tipos de cambio Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar', 500);
  }
});

// POST /api/miauto/admin/recalcular-mora (admin: alinear mora en BD para todas las cuotas vencidas, incl. parciales)
router.post('/admin/recalcular-mora', async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para recalcular mora', 403);
    }
    const { updated } = await recalcularMoraGlobal();
    return successResponse(res, { updated }, 'Mora recalculada en todas las cuotas vencidas');
  } catch (error) {
    logger.error('Error recalculando mora Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al recalcular mora', 500);
  }
});

// PUT /api/miauto/tipo-cambio (admin: actualizar valor del dólar por país)
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

// PATCH /api/miauto/solicitudes/:id/generar-yego-mi-auto  body: { placa_asignada, fecha_inicio_cobro_semanal? }
router.patch('/solicitudes/:id/generar-yego-mi-auto', validateUUID, async (req, res) => {
  try {
    const placa_asignada = req.body?.placa_asignada;
    const fecha_inicio_cobro_semanal = req.body?.fecha_inicio_cobro_semanal;
    const solicitud = await generarYegoMiAuto(req.params.id, { placa_asignada, fecha_inicio_cobro_semanal });
    if (!solicitud) return errorResponse(res, 'Solicitud no encontrada', 404);
    return successResponse(res, solicitud, 'Yego Mi Auto generado; cobro semanal iniciado');
  } catch (error) {
    logger.error('Error generando Yego Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al generar Yego Mi Auto', 400);
  }
});

// PATCH /api/miauto/solicitudes/:id — solo se actualizan los campos enviados en el body (evita borrar cronograma_vehiculo_id al aprobar)
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
    return successResponse(res, solicitud, 'Solicitud actualizada');
  } catch (error) {
    logger.error('Error actualizando solicitud Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al actualizar solicitud', 400);
  }
});

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

router.get('/solicitudes/:id/adjuntos', validateUUID, async (req, res) => {
  try {
    const adjuntos = await listBySolicitud(req.params.id);
    return successResponse(res, adjuntos);
  } catch (error) {
    logger.error('Error listando adjuntos Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar adjuntos', 500);
  }
});

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

router.get('/solicitudes/:id/comprobantes-pago', validateUUID, async (req, res) => {
  try {
    const list = await listComprobantesPago(req.params.id);
    return successResponse(res, list);
  } catch (error) {
    logger.error('Error listando comprobantes de pago Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar comprobantes', 500);
  }
});

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
      // Si el admin envía monto y moneda, validar el comprobante recién creado (crear + validar en un paso)
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
      return successResponse(res, list, 'Pago manual registrado', 201);
    } catch (error) {
      logger.error('Error agregando pago manual Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al agregar pago', 400);
    }
  }
);

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
      return successResponse(res, list, 'Comprobante validado');
    } catch (error) {
      logger.error('Error validando comprobante Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al validar comprobante', 400);
    }
  }
);

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
      return successResponse(res, list, 'Comprobante rechazado');
    } catch (error) {
      logger.error('Error rechazando comprobante Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al rechazar comprobante', 400);
    }
  }
);

// --- Cuotas semanales Mi Auto (después de Generar Yego Mi Auto) ---

router.get('/solicitudes/:id/cuotas-semanales', validateUUID, async (req, res) => {
  try {
    if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
    const { data: list, racha, cuotas_semanales_bonificadas } = await getCuotasSemanalesConRacha(req.params.id);
    const rachaNum = typeof racha === 'number' && Number.isFinite(racha) ? Math.max(0, Math.floor(racha)) : 0;
    const bonoAplicado = typeof cuotas_semanales_bonificadas === 'number' && Number.isFinite(cuotas_semanales_bonificadas) ? Math.max(0, Math.floor(cuotas_semanales_bonificadas)) : 0;
    return successResponse(res, { data: list, racha: rachaNum, cuotas_semanales_bonificadas: bonoAplicado });
  } catch (error) {
    logger.error('Error listando cuotas semanales Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar cuotas semanales', 500);
  }
});

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

/** Comprobante de conformidad del pago (solo admin; solo si la cuota ya está pagada o bonificada). */
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
        req.user?.id
      );
      return successResponse(res, list, 'Comprobante de conformidad subido', 201);
    } catch (error) {
      logger.error('Error subiendo conformidad cuota semanal Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al subir comprobante de conformidad', 400);
    }
  }
);

/** Eliminar comprobante de conformidad del admin (solo staff; para poder subir uno nuevo). */
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
      return successResponse(res, list, 'Comprobante validado');
    } catch (error) {
      logger.error('Error validando comprobante cuota semanal Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al validar comprobante', 400);
    }
  }
);

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
      return successResponse(res, list, 'Comprobante rechazado');
    } catch (error) {
      logger.error('Error rechazando comprobante cuota semanal Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al rechazar comprobante', 400);
    }
  }
);

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
      return successResponse(res, list, 'Pago manual registrado', 201);
    } catch (error) {
      logger.error('Error registrando pago manual cuota semanal Mi Auto:', error);
      return errorResponse(res, error.message || 'Error al registrar pago', 400);
    }
  }
);

export default router;
