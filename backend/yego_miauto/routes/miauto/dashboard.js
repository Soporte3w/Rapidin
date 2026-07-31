import { Router } from 'express';
import { validateUUID } from '../../../middleware/validations.js';
import { successResponse, errorResponse } from '../../../utils/responses.js';
import { logger } from '../../../utils/logger.js';
import { getSolicitudById } from '../../services/solicitud/miautoSolicitudService.js';
import { getCuotasSemanalesApiPayload } from '../../services/cuotas/miautoCuotaSemanalService.js';
import { listBySolicitud as listComprobantesCuotaSemanal } from '../../services/comprobantes/miautoComprobanteCuotaSemanalService.js';
import { listBySolicitud as listComprobantesOtrosGastos } from '../../services/comprobantes/miautoComprobanteOtrosGastosService.js';
import { listBySolicitud as listEvidenciasFleet } from '../../services/evidencias/miautoEvidenciaFleetService.js';
import { listNotasVentaBySolicitud } from '../../services/facturacion/miautoNotaVentaService.js';
import { listContratosBySolicitud } from '../../services/contratos/miautoContratoDocumentoService.js';

const router = Router();

async function optionalList(label, loader) {
  try {
    return await loader();
  } catch (error) {
    logger.warn(`No se pudo cargar ${label} en el detalle Mi Auto`, { message: error.message });
    return [];
  }
}

/**
 * Carga inicial del detalle administrativo en una petición HTTP. Los endpoints
 * individuales permanecen disponibles para refrescos y compatibilidad.
 */
router.get('/solicitudes/:id/dashboard', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para ver este detalle', 403);
    }
    const solicitudId = req.params.id;
    const [
      solicitud,
      cuotas,
      comprobantesCuotaSemanal,
      comprobantesOtrosGastos,
      evidenciasFleet,
      notasVenta,
      contratos,
    ] = await Promise.all([
      getSolicitudById(solicitudId, {
        skipYangoLicenseLookup: true,
        includeVehicleImage: false,
      }),
      getCuotasSemanalesApiPayload(solicitudId, { incluirAbonoComprobantePendiente: true }),
      optionalList('comprobantes de cuota semanal', () => listComprobantesCuotaSemanal(solicitudId)),
      optionalList('comprobantes de otros gastos', () => listComprobantesOtrosGastos(solicitudId)),
      optionalList('evidencias Fleet', () => listEvidenciasFleet(solicitudId)),
      optionalList('notas de venta', () => listNotasVentaBySolicitud(solicitudId)),
      optionalList('contratos', () => listContratosBySolicitud(solicitudId)),
    ]);
    if (!solicitud) return errorResponse(res, 'Solicitud no encontrada', 404);
    return successResponse(res, {
      solicitud,
      cuotas,
      comprobantes_cuota_semanal: comprobantesCuotaSemanal,
      comprobantes_otros_gastos: comprobantesOtrosGastos,
      evidencias_fleet: evidenciasFleet,
      notas_venta: notasVenta,
      contratos,
    });
  } catch (error) {
    logger.error('Error cargando dashboard de solicitud Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al cargar el detalle', 500);
  }
});

export default router;
