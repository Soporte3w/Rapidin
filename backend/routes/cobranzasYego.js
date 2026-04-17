import express from 'express';
import XLSX from 'xlsx-js-style';
import { processCobranzas, getCobranzasBatchLog, getCobranzasHistory } from '../services/cobranzasYegoService.js';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { errorResponse } from '../utils/responses.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(verifyToken);
router.use(verifyRole('payer', 'admin'));

/** POST /api/cobranzas-yego/process — cobra por Fleet directo (driver_id → saldo → retiro → log) */
router.post('/process', async (req, res) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse(res, 'Envía { items: [...] } con al menos una fila', 400);
    }
    if (items.length > 800) {
      return errorResponse(res, 'Máximo 800 filas por lote', 400);
    }
    const out = await processCobranzas(items, req.user.id, { maxItems: 800 });
    const msg = out.summary.fail === 0
      ? `Todos los cobros realizados (${out.summary.ok})`
      : `Proceso finalizado: ${out.summary.ok} ok, ${out.summary.fail} con error`;
    return res.status(out.summary.fail === 0 ? 201 : 200).json({ data: out, message: msg });
  } catch (error) {
    logger.error('Error procesando cobranzas YEGO:', error);
    return errorResponse(res, error.message || 'Error al procesar', 500);
  }
});

/** GET /api/cobranzas-yego/history — lista batches agrupados, paginado */
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const { rows, total } = await getCobranzasHistory({ limit, offset });
    return res.json({ data: rows, total, limit, offset });
  } catch (error) {
    logger.error('Error obteniendo historial cobranzas YEGO:', error);
    return errorResponse(res, error.message || 'Error al obtener historial', 500);
  }
});

/** GET /api/cobranzas-yego/batch/:batchId — detalle de un batch */
router.get('/batch/:batchId', async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(batchId)) return errorResponse(res, 'batch_id inválido', 400);
    const rows = await getCobranzasBatchLog(batchId);
    return res.json({ data: rows });
  } catch (error) {
    logger.error('Error obteniendo batch cobranzas YEGO:', error);
    return errorResponse(res, error.message || 'Error al obtener batch', 500);
  }
});

/** GET /api/cobranzas-yego/export/:batchId — descarga Excel con resultados coloreados */
const STATUS_LABEL = {
  cobrado:            'Cobrado',
  cobrado_parcial:    'Cobro parcial',
  saldo_insuficiente: 'Sin saldo',
  error_fleet:        'Error Fleet',
  dato_invalido:      'Dato inválido',
};

const STATUS_FILL = {
  cobrado:            { fgColor: { rgb: 'C6EFCE' } },
  cobrado_parcial:    { fgColor: { rgb: 'FFEB9C' } },
  saldo_insuficiente: { fgColor: { rgb: 'FFC7CE' } },
  error_fleet:        { fgColor: { rgb: 'FFC7CE' } },
  dato_invalido:      { fgColor: { rgb: 'FFC7CE' } },
};

router.get('/export/:batchId', async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(batchId)) return errorResponse(res, 'batch_id inválido', 400);

    const rows = await getCobranzasBatchLog(batchId);
    if (rows.length === 0) return errorResponse(res, 'No hay resultados para este batch', 404);

    const headerStyle = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '2F2F2F' } } };
    const headers = ['Conductor', 'driver_id', 'Hoja (semana)', 'Fila', 'A cobrar', 'Cobrado', 'Fecha', 'Saldo Fleet', 'Estado', 'Detalle'];

    const sheetData = [
      headers.map((h) => ({ v: h, t: 's', s: headerStyle })),
      ...rows.map((r) => {
        const s = { fill: STATUS_FILL[r.status] || {} };
        return [
          { v: r.conductor || '',                                                                         t: 's', s },
          { v: r.external_driver_id || '',                                                               t: 's', s },
          { v: r.sheet_name || '',                                                                       t: 's', s },
          { v: r.row_in_sheet ?? '',          t: r.row_in_sheet != null ? 'n' : 's',                    s },
          { v: r.amount != null ? Number(r.amount) : '',          t: r.amount != null ? 'n' : 's',      s },
          { v: r.amount_charged != null ? Number(r.amount_charged) : '', t: r.amount_charged != null ? 'n' : 's', s },
          { v: r.payment_date ? new Date(r.payment_date).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '', t: 's', s },
          { v: r.balance_fleet != null ? Number(r.balance_fleet) : '', t: r.balance_fleet != null ? 'n' : 's', s },
          { v: STATUS_LABEL[r.status] || r.status,                                                      t: 's', s },
          { v: r.error_detail || '',                                                                     t: 's', s },
        ];
      }),
    ];

    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    ws['!cols'] = [22, 34, 20, 6, 13, 13, 12, 12, 20, 40].map((w) => ({ wch: w }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Resultados cobros');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="cobranzas-yego-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (error) {
    logger.error('Error exportando Excel cobranzas YEGO:', error);
    return errorResponse(res, error.message || 'Error al exportar', 500);
  }
});

export default router;
