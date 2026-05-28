import { Router } from 'express';
import { validateUUID } from '../../../middleware/validations.js';
import { successResponse, errorResponse } from '../../../utils/responses.js';
import { logger } from '../../../utils/logger.js';
import { getCuotasSemanalesConRacha, recalcularMoraGlobal } from '../../services/cuotas/miautoCuotaSemanalService.js';
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

// GET /api/miauto/solicitudes/:id/cuotas-semanales
router.get('/solicitudes/:id/cuotas-semanales', validateUUID, async (req, res) => {
  try {
    if (!(await ensureSolicitudOwnedByDriver(req.params.id, req, res))) return;
    const incluirAbonoComprobantePendiente = req.user?.role !== 'driver';
    const { data: list, racha, cuotas_semanales_bonificadas, total_cuotas_cargadas } = await getCuotasSemanalesConRacha(req.params.id, {
      incluirAbonoComprobantePendiente,
    });
    const rachaNum = typeof racha === 'number' && Number.isFinite(racha) ? Math.max(0, Math.floor(racha)) : 0;
    const bonoAplicado = typeof cuotas_semanales_bonificadas === 'number' && Number.isFinite(cuotas_semanales_bonificadas) ? Math.max(0, Math.floor(cuotas_semanales_bonificadas)) : 0;
    const totalCargadas = typeof total_cuotas_cargadas === 'number' ? Math.max(0, Math.floor(total_cuotas_cargadas)) : 0;
    return successResponse(res, { data: list, racha: rachaNum, cuotas_semanales_bonificadas: bonoAplicado, total_cuotas_cargadas: totalCargadas });
  } catch (error) {
    logger.error('Error listando cuotas semanales Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al listar cuotas semanales', 500);
  }
});

// POST /api/miauto/admin/recalcular-mora
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

export default router;
