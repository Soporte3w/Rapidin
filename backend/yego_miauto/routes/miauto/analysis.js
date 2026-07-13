import { Router } from 'express';
import { errorResponse, successResponse } from '../../../utils/responses.js';
import { getMiAutoSupplySummary } from '../../../services/yangoService.js';

const router = Router();
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function limaYmd(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function defaultRange() {
  const today = limaYmd();
  return { dateFrom: `${today.slice(0, 7)}-01`, dateTo: today };
}

// GET /api/miauto/analysis/supply?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
router.get('/analysis/supply', async (req, res) => {
  const fallback = defaultRange();
  const dateFrom = String(req.query.date_from || fallback.dateFrom).slice(0, 10);
  const dateTo = String(req.query.date_to || fallback.dateTo).slice(0, 10);
  if (!YMD_RE.test(dateFrom) || !YMD_RE.test(dateTo) || dateFrom > dateTo) {
    return errorResponse(res, 'El rango de fechas es inválido', 400);
  }
  try {
    const result = await getMiAutoSupplySummary({ dateFrom, dateTo });
    if (!result.success) return errorResponse(res, result.error || 'No se pudo consultar Fleet', 502);
    return successResponse(res, result);
  } catch (error) {
    return errorResponse(res, error.message || 'No se pudo cargar el dashboard Supply', 500);
  }
});

export default router;
