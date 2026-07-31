import { Router } from 'express';
import { uploadVoucher } from '../../middleware/upload.js';
import { authenticate } from '../../middleware/auth.js';
import { verifyModule } from '../../middleware/permissions.js';
import { errorResponse, successResponse } from '../../utils/responses.js';
import { logger } from '../../utils/logger.js';
import { getMimotoPublicConfig, MIMOTO_CONFIG } from '../config/mimotoConfig.js';
import {
  createCronograma,
  createSolicitud,
  deleteCronograma,
  getSolicitudDetail,
  isSolicitudOwnedByDriver,
  listCronogramas,
  listFleets,
  listMessageRecipients,
  listSolicitudes,
  toggleCronogramaActive,
  updateCronograma,
  updateSolicitud,
} from '../services/mimotoCoreService.js';
import {
  applyPaymentToExpense,
  applyPaymentToQuota,
  listValidationVouchers,
  simulateFleetCascade,
  updateVoucherBankStatus,
} from '../services/mimotoPaymentService.js';
import { createExpenseCycle } from '../services/mimotoExpenseService.js';
import {
  getAnalysisSummary,
  getExchangeRate,
  setExchangeRate,
} from '../services/mimotoReportingService.js';
import { previewOrGenerateWeeklyQuota } from '../services/mimotoWeeklyBillingService.js';
import {
  deleteMimotoFleetEvidenceFile,
  deleteMimotoContract,
  uploadMimotoContract,
  uploadMimotoExpenseVoucherFile,
  uploadMimotoFleetEvidenceFiles,
  uploadMimotoVoucherFile,
} from '../services/mimotoDocumentService.js';
import {
  listMimotoMessages,
  queueMimotoMessage,
  refreshMimotoWhatsAppPhone,
} from '../services/mimotoWhatsAppService.js';
import {
  getMimotoAutomationReadiness,
  runMimotoDailyMora,
  runMimotoExpenseMaintenance,
} from '../services/mimotoAutomationService.js';
import { runMimotoWeeklyGeneration } from '../services/mimotoWeeklyService.js';
import { runMimotoFleetCharge } from '../services/mimotoFleetChargeService.js';
import { generateMimotoSaleNote, getMimotoBillingStatus } from '../services/mimotoBillingService.js';

const router = Router();
router.use(authenticate);
router.use(verifyModule('mimoto'));

router.use((req, res, next) => {
  if (req.user?.role !== 'driver') return next();
  const readOwnData = req.method === 'GET'
    && (req.path === '/config/public' || req.path === '/solicitudes' || /^\/solicitudes\/[^/]+$/.test(req.path));
  const uploadOwnVoucher = req.method === 'POST'
    && (/^\/solicitudes\/[^/]+\/cuotas\/[^/]+\/comprobantes$/.test(req.path)
      || /^\/solicitudes\/[^/]+\/otros-gastos\/[^/]+\/comprobantes$/.test(req.path));
  return readOwnData || uploadOwnVoucher
    ? next()
    : errorResponse(res, 'Esta operación requiere permisos administrativos', 403);
});

router.use('/solicitudes/:id', async (req, res, next) => {
  if (req.user?.role !== 'driver') return next();
  try {
    const owned = await isSolicitudOwnedByDriver(req.params.id, req.user?.phone);
    return owned ? next() : errorResponse(res, 'No tienes acceso a esta solicitud', 403);
  } catch (error) {
    logger.error('Error validando propiedad Mi Moto:', error);
    return errorResponse(res, 'No se pudo validar el acceso a la solicitud', 403);
  }
});

function actorId(req) {
  return req.user?.id || null;
}

function handler(label, callback, fallbackStatus = 400) {
  return async (req, res) => {
    try {
      return await callback(req, res);
    } catch (error) {
      logger.error(`Error Mi Moto ${label}:`, error);
      const status = /no encontrad/i.test(error.message)
        ? 404
        : /desactivado|no se pueden aplicar/i.test(error.message)
          ? 423
          : fallbackStatus;
      return errorResponse(res, error.message || `Error ${label}`, status);
    }
  };
}

function requireMimotoEnabled(req, res, next) {
  return MIMOTO_CONFIG.enabled
    ? next()
    : errorResponse(res, 'Yego Mi Moto está desactivado; la operación financiera está bloqueada', 423);
}

function requireMimotoEnabledForWrite(req, res, next) {
  return req.body?.dry_run !== false
    ? next()
    : requireMimotoEnabled(req, res, next);
}

router.get('/config/public', (_req, res) => successResponse(res, getMimotoPublicConfig()));

router.get('/fleets', handler('listando flotas', async (req, res) => {
  const active = req.query.active == null ? undefined : req.query.active !== 'false';
  return successResponse(res, await listFleets({ active }));
}));

router.get('/cronogramas', handler('listando cronogramas', async (req, res) => {
  const active = req.query.active == null ? undefined : req.query.active !== 'false';
  return successResponse(res, await listCronogramas({ active }));
}));

router.post('/cronogramas', handler('creando cronograma', async (req, res) =>
  successResponse(res, await createCronograma(req.body, actorId(req)), 'Cronograma creado', 201)));

router.put('/cronogramas/:id', handler('actualizando cronograma', async (req, res) =>
  successResponse(res, await updateCronograma(req.params.id, req.body, actorId(req)), 'Cronograma actualizado')));

router.patch('/cronogramas/:id/toggle-active', handler('cambiando estado del cronograma', async (req, res) =>
  successResponse(res, await toggleCronogramaActive(req.params.id, actorId(req)), 'Estado actualizado')));

router.delete('/cronogramas/:id', handler('eliminando cronograma', async (req, res) =>
  successResponse(
    res,
    await deleteCronograma(req.params.id, actorId(req)),
    'Cronograma eliminado'
  ), 409));

router.get('/tipo-cambio', handler('consultando tipo de cambio', async (_req, res) =>
  successResponse(res, await getExchangeRate())));

router.put('/tipo-cambio', handler('actualizando tipo de cambio', async (req, res) =>
  successResponse(res, await setExchangeRate(req.body.valor_usd_a_local, actorId(req)), 'Tipo de cambio actualizado')));

router.get('/solicitudes', handler('listando solicitudes', async (req, res) =>
  successResponse(res, await listSolicitudes({
    status: req.query.status,
    fleetId: req.query.fleet_id,
    cronogramaId: req.query.cronograma_id,
    cuotaEstado: req.query.cuota_estado,
    dateFrom: req.query.date_from,
    dateTo: req.query.date_to,
    q: req.query.q,
    driverPhone: req.user?.role === 'driver' ? req.user?.phone : undefined,
    page: req.query.page,
    limit: req.query.limit,
  }))));

router.get('/message-recipients', handler('listando destinatarios', async (req, res) => {
  if (req.user?.role === 'driver') return errorResponse(res, 'Sin permisos', 403);
  return successResponse(res, await listMessageRecipients());
}));

router.post('/solicitudes', handler('creando solicitud', async (req, res) =>
  successResponse(res, await createSolicitud(req.body, actorId(req)), 'Solicitud creada', 201)));

router.get('/solicitudes/:id', handler('consultando solicitud', async (req, res) => {
  const detail = await getSolicitudDetail(req.params.id);
  return detail ? successResponse(res, detail) : errorResponse(res, 'Solicitud Mi Moto no encontrada', 404);
}));

router.patch('/solicitudes/:id', handler('actualizando solicitud', async (req, res) =>
  successResponse(res, await updateSolicitud(req.params.id, req.body, actorId(req)), 'Solicitud actualizada')));

router.post('/solicitudes/:id/cuotas/generar', requireMimotoEnabledForWrite, handler('generando cuota', async (req, res) =>
  successResponse(res, await previewOrGenerateWeeklyQuota(req.params.id, req.body, actorId(req)),
    req.body.dry_run === false ? 'Cuota generada' : 'Simulación generada')));

router.post('/solicitudes/:id/cobros/fleet/simular', handler('simulando cascada Fleet', async (req, res) =>
  successResponse(res, await simulateFleetCascade(req.params.id, req.body.saldo_disponible, req.body.moneda || 'COP'))));

router.post('/solicitudes/:id/cuotas/:cuotaId/pago-manual', requireMimotoEnabled, handler('aplicando pago manual', async (req, res) =>
  successResponse(res, await applyPaymentToQuota({
    solicitudId: req.params.id,
    quotaId: req.params.cuotaId,
    amount: req.body.monto,
    currency: req.body.moneda,
    source: 'manual',
    actorId: actorId(req),
  }), 'Pago aplicado')));

router.post(
  '/solicitudes/:id/cuotas/:cuotaId/comprobantes',
  requireMimotoEnabled,
  uploadVoucher.single('file'),
  handler('subiendo comprobante', async (req, res) => {
    if (!req.file) return errorResponse(res, 'El archivo es requerido', 400);
    const voucher = await uploadMimotoVoucherFile(req.params.id, req.params.cuotaId, req.file);
    const result = await applyPaymentToQuota({
      solicitudId: req.params.id,
      quotaId: req.params.cuotaId,
      amount: req.body.monto,
      currency: req.body.moneda,
      source: req.user?.role === 'driver' ? 'conductor' : 'admin_confirmacion',
      actorId: actorId(req),
      voucher,
    });
    return successResponse(res, result, 'Comprobante subido y aplicado', 201);
  })
);

router.get('/comprobantes/validacion', handler('listando comprobantes', async (req, res) =>
  successResponse(res, await listValidationVouchers({ estado: req.query.estado, limit: req.query.limit }))));

router.patch('/comprobantes/:id/estado', handler('validando comprobante', async (req, res) =>
  successResponse(res, await updateVoucherBankStatus(
    req.params.id,
    req.body.tipo,
    req.body.estado,
    req.body.motivo,
    actorId(req)
  ), 'Estado actualizado')));

router.post('/solicitudes/:id/contratos', uploadVoucher.single('file'), handler('subiendo contrato', async (req, res) => {
  if (!req.file) return errorResponse(res, 'El archivo es requerido', 400);
  return successResponse(res, await uploadMimotoContract(req.params.id, req.file, actorId(req)), 'Contrato subido', 201);
}));

router.delete('/solicitudes/:id/contratos/:contractId', handler('eliminando contrato', async (req, res) => {
  const deleted = await deleteMimotoContract(req.params.id, req.params.contractId, actorId(req));
  return deleted ? successResponse(res, null, 'Contrato eliminado') : errorResponse(res, 'Contrato no encontrado', 404);
}));

router.post(
  '/solicitudes/:id/evidencias-fleet',
  uploadVoucher.array('files', 20),
  handler('subiendo evidencias Fleet', async (req, res) => {
    if (!req.files?.length) return errorResponse(res, 'Selecciona al menos un archivo', 400);
    if (!req.body.cuota_semanal_id) return errorResponse(res, 'La cuota semanal es requerida', 400);
    const rows = await uploadMimotoFleetEvidenceFiles(
      req.params.id,
      req.body.cuota_semanal_id,
      req.files,
      actorId(req)
    );
    return successResponse(res, rows, `${rows.length} evidencia(s) subida(s)`, 201);
  })
);

router.delete(
  '/solicitudes/:id/evidencias-fleet/:evidenceId',
  handler('eliminando evidencia Fleet', async (req, res) => {
    const deleted = await deleteMimotoFleetEvidenceFile(
      req.params.id,
      req.params.evidenceId,
      actorId(req)
    );
    return deleted
      ? successResponse(res, null, 'Evidencia eliminada')
      : errorResponse(res, 'Evidencia no encontrada', 404);
  })
);

router.post('/solicitudes/:id/otros-gastos/ciclos', requireMimotoEnabled, handler('creando ciclo de gasto', async (req, res) =>
  successResponse(res, await createExpenseCycle(req.params.id, req.body, actorId(req)), 'Ciclo creado', 201)));

router.post('/solicitudes/:id/otros-gastos/:gastoId/pago-manual', requireMimotoEnabled, handler('aplicando pago de gasto', async (req, res) =>
  successResponse(res, await applyPaymentToExpense({
    solicitudId: req.params.id,
    expenseId: req.params.gastoId,
    amount: req.body.monto,
    currency: req.body.moneda,
    source: 'manual',
    actorId: actorId(req),
  }), 'Pago aplicado')));

router.post(
  '/solicitudes/:id/otros-gastos/:gastoId/comprobantes',
  requireMimotoEnabled,
  uploadVoucher.single('file'),
  handler('subiendo comprobante de gasto', async (req, res) => {
    if (!req.file) return errorResponse(res, 'El archivo es requerido', 400);
    const voucher = await uploadMimotoExpenseVoucherFile(req.params.id, req.params.gastoId, req.file);
    const result = await applyPaymentToExpense({
      solicitudId: req.params.id,
      expenseId: req.params.gastoId,
      amount: req.body.monto,
      currency: req.body.moneda,
      source: req.user?.role === 'driver' ? 'conductor' : 'admin',
      actorId: actorId(req),
      voucher,
    });
    return successResponse(res, result, 'Comprobante subido y aplicado', 201);
  })
);

router.get('/mensajes', handler('listando mensajes', async (req, res) =>
  successResponse(res, await listMimotoMessages({
    page: req.query.page,
    limit: req.query.limit,
    status: req.query.status,
  }))));

router.post('/solicitudes/:id/whatsapp-phone/refresh', handler('actualizando teléfono WhatsApp', async (req, res) =>
  successResponse(
    res,
    await refreshMimotoWhatsAppPhone(req.params.id, actorId(req)),
    'Teléfono WhatsApp actualizado'
  )));

router.post('/solicitudes/:id/mensajes', requireMimotoEnabled, handler('encolando mensaje', async (req, res) =>
  successResponse(
    res,
    await queueMimotoMessage(req.params.id, req.body.message, actorId(req), {
      voucherId: req.body.voucher_id,
    }),
    'Mensaje en cola',
    201
  )));

router.get('/analysis/summary', handler('consultando análisis', async (_req, res) =>
  successResponse(res, await getAnalysisSummary())));

router.get('/automation/readiness', handler('consultando automatización', async (_req, res) =>
  successResponse(res, await getMimotoAutomationReadiness())));

router.post('/automation/mora/dry-run', handler('simulando mora diaria', async (req, res) =>
  successResponse(res, await runMimotoDailyMora({ dryRun: true, asOf: req.body.as_of }))));

router.post('/automation/gastos/dry-run', handler('simulando mantenimiento de gastos', async (req, res) =>
  successResponse(res, await runMimotoExpenseMaintenance({ dryRun: true, asOf: req.body.as_of }))));

router.post('/automation/cuotas/dry-run', handler('simulando generación semanal', async (_req, res) =>
  successResponse(res, await runMimotoWeeklyGeneration({ dryRun: true }))));

router.post('/automation/fleet/dry-run', handler('simulando cobro Fleet', async (req, res) =>
  successResponse(res, await runMimotoFleetCharge({ dryRun: true, asOf: req.body.as_of }))));

router.get('/facturacion/status', (_req, res) => successResponse(res, getMimotoBillingStatus()));

router.post('/solicitudes/:id/notas-venta/generar', handler(
  'generando documento de venta',
  async (req, res) => successResponse(
    res,
    await generateMimotoSaleNote(req.params.id, req.body),
    'Documento generado'
  ),
  503
));

export default router;
