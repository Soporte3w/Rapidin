/**
 * Yego Rapidín 4.0 — Servicio de mensajería WhatsApp Mi Auto
 * Recibe mensajes pre-armados del frontend, envía en lote, registra trazabilidad.
 */
import { query } from '../../config/database.js';
import { sendWhatsAppMessage } from '../../services/authService.js';
import { logger } from '../../utils/logger.js';

/**
 * Envía mensajes WhatsApp en lote.
 * Secuencial (no Promise.all) para no saturar la API 3W.
 * @param {{ solicitud_id, phone, driver_name, message }[]} items
 * @param {string|null} userId
 * @param {string|null} instanceToken
 * @returns {{ sent: [], failed: [], total: number }}
 */
export async function sendBulkWhatsApp(items, userId, instanceToken = null) {
  const token = instanceToken || process.env.WHATSAPP_MIAUTO_TOKEN || process.env.WHATSAPP_OTP_TOKEN;
  const results = { sent: [], failed: [], total: items.length };

  for (const item of items) {
    try {
      if (!item.phone || item.phone.length < 8) {
        await insertLog(item.solicitud_id, item.driver_name, item.phone || 'sin-teléfono', item.message, 'failed', 'Teléfono inválido', userId);
        results.failed.push({ solicitudId: item.solicitud_id, driverName: item.driver_name, error: 'Teléfono inválido' });
        continue;
      }

      const result = await sendWhatsAppMessage(item.phone, item.message, token);

      if (result.success) {
        await insertLog(item.solicitud_id, item.driver_name, item.phone, item.message, 'sent', null, userId);
        results.sent.push({ solicitudId: item.solicitud_id, driverName: item.driver_name, phone: item.phone });
      } else {
        await insertLog(item.solicitud_id, item.driver_name, item.phone, item.message, 'failed', result.error, userId);
        results.failed.push({ solicitudId: item.solicitud_id, driverName: item.driver_name, error: result.error });
      }
    } catch (error) {
      logger.error(`Error en envío WhatsApp solicitud ${item.solicitud_id}: ${error.message}`);
      await insertLog(item.solicitud_id, item.driver_name || 'desconocido', item.phone || 'desconocido', item.message || '', 'failed', error.message?.slice(0, 500), userId);
      results.failed.push({ solicitudId: item.solicitud_id, error: error.message });
    }
  }

  return results;
}

async function insertLog(solicitudId, driverName, phone, message, status, error, userId) {
  try {
    await query(
      `INSERT INTO module_miauto_whatsapp_log (solicitud_id, driver_name, phone, message, status, error, created_by, sent_at)
       VALUES ($1, $2, $3, $4, $5::text, $6, $7, CASE WHEN $5::text = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
      [solicitudId, driverName, phone, message, status, error || null, userId || null]
    );
  } catch (e) {
    if (e?.code === '42703') return;
    logger.error(`Error insertando log WhatsApp: ${e.message}`);
  }
}

/**
 * Obtiene historial de envíos con filtros y paginación.
 */
export async function getWhatsAppLog({ solicitudId, status, page = 1, limit = 50 } = {}) {
  const conditions = [];
  const params = [];
  let p = 0;

  if (solicitudId) {
    p++; conditions.push(`solicitud_id = $${p}`);
    params.push(solicitudId);
  }
  if (status) {
    p++; conditions.push(`status = $${p}`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (Math.max(1, Number(page)) - 1) * Math.min(100, Number(limit));

  p++; params.push(Math.min(100, Number(limit)));
  p++; params.push(offset);

  const { rows } = await query(
    `SELECT id, solicitud_id, driver_name, phone, status, error, created_by, sent_at, created_at
     FROM module_miauto_whatsapp_log ${where}
     ORDER BY created_at DESC LIMIT $${p - 1} OFFSET $${p}`, params
  );

  const countRes = await query(
    `SELECT COUNT(*) as total FROM module_miauto_whatsapp_log ${where}`,
    params.slice(0, conditions.length)
  );

  return {
    data: rows,
    total: parseInt(countRes.rows[0]?.total || 0, 10),
    page: Number(page),
    limit: Number(limit),
  };
}
