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
  corregirFechaInicioCobro,
  ActiveSolicitudError,
  getActiveSolicitudInfo,
  anexarContratoAdicional,
  listContratosRelacionados,
} from '../../services/solicitud/miautoSolicitudService.js';
import { getPartnerNameById } from '../../../services/partnersService.js';
import { getContractorProfile, searchFleetContractorFull } from '../../../services/yangoService.js';
import { getDniFromPeruvianLicense } from '../../services/utils/miautoLicenseDocument.js';
import pool from '../../../database/connection.js';
import { createMiautoControlReportExport } from '../../services/reportes/miautoControlReportService.js';

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

async function ensureSolicitudOwnedByDriver(solicitudId, req, res) {
  if (req.user?.role !== 'driver') return true;
  const result = await pool.query(
    'SELECT phone, country FROM module_miauto_solicitud WHERE id = $1 AND deleted_at IS NULL',
    [solicitudId]
  );
  const solicitud = result.rows[0];
  if (!solicitud) return true;
  const authPhone = String(req.user?.phone || '').replace(/[^0-9]/g, '');
  const contractPhone = String(solicitud.phone || '').replace(/[^0-9]/g, '');
  const authCountry = String(req.user?.country || 'PE').trim();
  const contractCountry = String(solicitud.country || '').trim();
  if (!authPhone || authPhone !== contractPhone || authCountry !== contractCountry) {
    errorResponse(res, 'No tienes permiso para acceder a este contrato', 403);
    return false;
  }
  return true;
}

// GET /api/miauto/alquiler-venta/exportar
router.get('/alquiler-venta/exportar', async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para exportar el reporte de control', 403);
    }
    const { buffer, fileName } = await createMiautoControlReportExport({
      country: trimOrUndefined(req.query.country),
      cronograma_id: trimOrUndefined(req.query.cronograma_id),
      conductor_id: trimOrUndefined(req.query.conductor_id),
      solicitud_id: trimOrUndefined(req.query.solicitud_id),
      week_from: trimOrUndefined(req.query.week_from),
      week_to: trimOrUndefined(req.query.week_to),
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', String(buffer.length));
    return res.send(buffer);
  } catch (error) {
    logger.error('Error exportando reporte de control Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al exportar el reporte de control', error.statusCode || 500);
  }
});

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
    const { status, country, date_from, date_to, page, limit, park_id, driver_id_fleet, driver, q } = req.query;
    const filters = {
      status,
      country,
      date_from,
      date_to,
      page,
      limit,
      park_id: trimOrUndefined(park_id),
      driver_id_fleet: trimOrUndefined(driver_id_fleet),
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
    const currentRapidinId = trimOrUndefined(req.query.driver_id_fleet);
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

// GET /api/miauto/yango/contractor-suggestions
router.get('/yango/contractor-suggestions', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return successResponse(res, { suggestions: [] });
    const result = await searchFleetContractorFull(q);
    if (!result.success) return errorResponse(res, result.error || 'Sin resultados', 404);
    return successResponse(res, { suggestions: result.suggestions });
  } catch (error) {
    logger.error('Error buscando contractor en Yango:', error);
    return errorResponse(res, error.message || 'Error al buscar conductor', 500);
  }
});

// POST /api/miauto/solicitudes
router.post('/solicitudes', async (req, res) => {
  try {
    const { country, dni, phone, email, license_number, description, driver_id_fleet } = req.body;
    if (!country) return errorResponse(res, 'country es requerido', 400);
    let resolvedDni = trimOrUndefined(dni);
    let resolvedLicenseNumber = trimOrUndefined(license_number);

    // En el alta administrativa, Yango devuelve la licencia en el perfil completo.
    // El DNI peruano corresponde a los 8 dígitos posteriores a la letra inicial.
    if (req.user?.role !== 'driver' && trimOrUndefined(driver_id_fleet)) {
      const profile = await getContractorProfile(driver_id_fleet);
      if (!profile.success) {
        return errorResponse(res, profile.error || 'No se pudo obtener la licencia del conductor en Yango', 400);
      }
      resolvedLicenseNumber = trimOrUndefined(profile.license_number);
      resolvedDni = getDniFromPeruvianLicense(resolvedLicenseNumber);
      if (!resolvedDni) {
        return errorResponse(
          res,
          'La licencia obtenida de Yango debe tener una letra inicial seguida de 8 dígitos',
          400
        );
      }
    }

    if (!resolvedDni) return errorResponse(res, 'dni es requerido', 400);
    const cronogramaId = trimOrUndefined(req.body.cronograma_id);
    const pagoTipo = trimOrUndefined(req.body.pago_tipo);

    const solicitud = await createSolicitud({
      country,
      dni: resolvedDni,
      phone,
      email,
      license_number: resolvedLicenseNumber,
      description,
      apps: getAppsFromBody(req.body),
      driver_id_fleet,
      cronograma_id: cronogramaId,
      cronograma_vehiculo_id: trimOrUndefined(req.body.cronograma_vehiculo_id),
      placa_asignada: trimOrUndefined(req.body.placa_asignada),
      fecha_inicio_cobro_semanal: trimOrUndefined(req.body.fecha_inicio_cobro_semanal)?.slice(0, 10),
      pago_tipo: pagoTipo,
      pago_estado: trimOrUndefined(req.body.pago_estado),
      status: trimOrUndefined(req.body.status),
    }, req.user?.id);
    auditMiautoMutation('solicitud.created', 'solicitud', solicitud?.id, { country, dni: resolvedDni });
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

// GET /api/miauto/solicitudes/:id/contratos-relacionados
router.get('/solicitudes/:id/contratos-relacionados', validateUUID, async (req, res) => {
  try {
    if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
    const contratos = await listContratosRelacionados(req.params.id);
    return successResponse(res, contratos);
  } catch (error) {
    logger.error('Error listando contratos relacionados Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar contratos', 500);
  }
});

// POST /api/miauto/solicitudes/:id/contratos-adicionales
router.post('/solicitudes/:id/contratos-adicionales', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para anexar contratos', 403);
    }
    const contrato = await anexarContratoAdicional(req.params.id, {
      cronograma_id: trimOrUndefined(req.body?.cronograma_id),
      cronograma_vehiculo_id: trimOrUndefined(req.body?.cronograma_vehiculo_id),
      pago_tipo: trimOrUndefined(req.body?.pago_tipo),
      placa_asignada: trimOrUndefined(req.body?.placa_asignada),
    }, req.user?.id);
    auditMiautoMutation('contrato_adicional.created', 'solicitud', contrato?.id, {
      contrato_origen_id: req.params.id,
      placa_asignada: contrato?.placa_asignada,
    });
    return successResponse(res, contrato, 'Contrato adicional anexado', 201);
  } catch (error) {
    const message = error?.code === '23505' && error?.constraint === 'uq_miauto_active_contract_plate'
      ? 'La placa ya pertenece a otro contrato activo'
      : error.message;
    logger.error('Error anexando contrato adicional Mi Auto:', error);
    return errorResponse(res, message || 'Error al anexar contrato', 400);
  }
});

// GET /api/miauto/solicitudes/:id
router.get('/solicitudes/:id', validateUUID, async (req, res) => {
  try {
    if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
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

// PATCH /api/miauto/solicitudes/:id/fecha-inicio-cobro
router.patch('/solicitudes/:id/fecha-inicio-cobro', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para modificar el inicio de cobro', 403);
    }
    const result = await corregirFechaInicioCobro(
      req.params.id,
      req.body?.fecha_inicio_cobro_semanal,
      req.user?.id,
    );
    if (!result) return errorResponse(res, 'Solicitud no encontrada', 404);
    if (result.correction.changed) {
      auditMiautoMutation('solicitud.start_date_corrected', 'solicitud', req.params.id, {
        fecha_anterior: result.correction.currentDate,
        fecha_nueva: result.correction.nextDate,
        fecha_entrega_actualizada: result.fecha_entrega_actualizada,
      });
    }
    return successResponse(
      res,
      result,
      result.correction.changed
        ? 'Inicio de cobro modificado correctamente'
        : 'La fecha seleccionada ya era el inicio de cobro',
    );
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    logger.error('Error modificando inicio de cobro Mi Auto:', error);
    return errorResponse(
      res,
      error.message || 'Error al modificar el inicio de cobro',
      statusCode,
      error?.code ? { code: error.code } : undefined,
    );
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

// POST /api/miauto/solicitudes/:id/activar
router.post('/solicitudes/:id/activar', validateUUID, async (req, res) => {
  try {
    const solicitud = await updateSolicitud(req.params.id, {
      status: 'aprobado',
      observations: 'Solicitud reactivada por administración.',
    }, req.user?.id);
    if (!solicitud) return errorResponse(res, 'Solicitud no encontrada', 404);
    return successResponse(res, solicitud, 'Solicitud reactivada');
  } catch (error) {
    logger.error('Error reactivando solicitud Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al reactivar solicitud', 400);
  }
});

export default router;
