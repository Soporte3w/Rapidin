import { Router } from 'express';
import { validateUUID } from '../../../middleware/validations.js';
import { successResponse, errorResponse } from '../../../utils/responses.js';
import { logger } from '../../../utils/logger.js';
import { getCuotasSemanalesConRacha, getSemanasDisponibles, recalcularMoraGlobal, updateMoraDiaria } from '../../services/cuotas/miautoCuotaSemanalService.js';
import { regenerateMiAutoCuotaForWeekMonday } from '../../../jobs/miautoWeeklyCharge.js';
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

// GET /api/miauto/solicitudes/:id/semanas-disponibles
router.get('/solicitudes/:id/semanas-disponibles', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para ver semanas disponibles', 403);
    }
    const data = await getSemanasDisponibles(req.params.id);
    return successResponse(res, data);
  } catch (error) {
    logger.error('Error obteniendo semanas disponibles Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al obtener semanas disponibles', 500);
  }
});

// POST /api/miauto/solicitudes/:id/cuotas-semanales/generar
router.post('/solicitudes/:id/cuotas-semanales/generar', validateUUID, async (req, res) => {
  try {
    if (req.user?.role === 'driver') {
      return errorResponse(res, 'Sin permisos para generar cuotas manualmente', 403);
    }

    const { week_start_date } = req.body;
    if (!week_start_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(week_start_date).trim().slice(0, 10))) {
      return errorResponse(res, 'Indica una fecha válida (YYYY-MM-DD) para generar la cuota', 400);
    }

    const weekYmd = String(week_start_date).trim().slice(0, 10);

    const solCheck = await pool.query(
      'SELECT id, status, fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1',
      [req.params.id]
    );
    const sol = solCheck.rows[0];
    if (!sol) return errorResponse(res, 'Solicitud no encontrada', 404);
    if (sol.status !== 'aprobado') return errorResponse(res, 'Solo se pueden generar cuotas para solicitudes aprobadas', 400);
    if (!sol.fecha_inicio_cobro_semanal) return errorResponse(res, 'La solicitud aún no tiene fecha de inicio de cobro', 400);

    const todayYmd = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    if (weekYmd > todayYmd) {
      return errorResponse(res, 'No se pueden generar cuotas para semanas futuras', 400);
    }

    const existing = await pool.query(
      'SELECT id, paid_amount, status FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND week_start_date = $2 AND deleted_at IS NULL',
      [req.params.id, weekYmd]
    );
    if (existing.rows.length > 0) {
      const ex = existing.rows[0];
      if (parseFloat(ex.paid_amount || 0) > 0.005) {
        return errorResponse(res, 'Esta semana ya tiene una cuota con pagos registrados y no se puede regenerar', 400);
      }
    }

    const result = await regenerateMiAutoCuotaForWeekMonday(req.params.id, weekYmd, {
      incomeMaxAttempts: 4,
      incomeFallbackZeroOnFailure: true,
    });

    if (!result.ok) {
      return errorResponse(res, result.error || 'No se pudo generar la cuota semanal', 400);
    }

    await updateMoraDiaria(req.params.id);

    return successResponse(res, result, 'Cuota semanal generada correctamente');
  } catch (error) {
    logger.error('Error generando cuota semanal manual Mi Auto:', error);
    return errorResponse(res, error.message || 'Error al generar cuota semanal', 500);
  }
});

export default router;
