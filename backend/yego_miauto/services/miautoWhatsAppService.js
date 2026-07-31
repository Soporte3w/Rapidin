/**
 * Yego Rapidín 4.0 — Servicio de mensajería WhatsApp Mi Auto
 * Recibe mensajes pre-armados, los encola y registra su trazabilidad.
 */
import { getClient, query } from '../../config/database.js';
import { sendEvolutionGoTextMessage } from '../../services/evolutionGoWhatsAppService.js';
import { logger } from '../../utils/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUEUE_LOCK_NAME = 'miauto_whatsapp_queue_v1';
const PROCESSING_RECOVERY_MINUTES = 10;
export const MIAUTO_WHATSAPP_QUEUE_POLICY = Object.freeze({
  maxMessages: 3,
  windowSeconds: 120,
});

async function getApprovedSolicitudIds(items) {
  const ids = [...new Set(
    items.map((item) => String(item?.solicitud_id || '').trim()).filter((id) => UUID_RE.test(id))
  )];
  if (ids.length === 0) return new Set();

  const { rows } = await query(
    `SELECT id::text AS id
     FROM module_miauto_solicitud
     WHERE id = ANY($1::uuid[])
       AND status = 'aprobado'`,
    [ids]
  );
  return new Set(rows.map((row) => row.id.toLowerCase()));
}

/**
 * Registra mensajes en la cola persistente. El worker aplica el límite global.
 * @param {{ solicitud_id, phone, driver_name, message }[]} items
 * @param {string|null} userId
 * @returns {{ queued: [], failed: [], total: number }}
 */
export async function enqueueBulkWhatsApp(items, userId) {
  const results = { queued: [], failed: [], total: items.length };
  const approvedSolicitudIds = await getApprovedSolicitudIds(items);

  for (const item of items) {
    try {
      const solicitudId = String(item.solicitud_id || '').trim().toLowerCase();
      if (!approvedSolicitudIds.has(solicitudId)) {
        const error = 'La solicitud no pertenece a Alquiler/Venta activo';
        results.failed.push({ solicitudId: item.solicitud_id, driverName: item.driver_name, error });
        continue;
      }

      if (String(item.phone || '').replace(/\D/g, '').length < 8) {
        results.failed.push({ solicitudId: item.solicitud_id, driverName: item.driver_name, error: 'Teléfono inválido' });
        continue;
      }
      if (!String(item.message || '').trim()) {
        results.failed.push({ solicitudId: item.solicitud_id, driverName: item.driver_name, error: 'Mensaje requerido' });
        continue;
      }

      const { rows } = await query(
        `INSERT INTO module_miauto_whatsapp_log
           (solicitud_id, driver_name, phone, message, status, created_by, queued_at)
         VALUES ($1::uuid, $2, $3, $4, 'pending', $5, CURRENT_TIMESTAMP)
         RETURNING id`,
        [solicitudId, item.driver_name || 'Conductor', item.phone, String(item.message).trim(), userId || null]
      );
      results.queued.push({
        id: rows[0].id,
        solicitudId,
        driverName: item.driver_name,
        phone: item.phone,
      });
    } catch (error) {
      logger.error(`Error programando WhatsApp solicitud ${item.solicitud_id}: ${error.message}`);
      results.failed.push({ solicitudId: item.solicitud_id, error: error.message });
    }
  }

  return results;
}

async function claimQueueMessages() {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
      [QUEUE_LOCK_NAME]
    );
    if (!lockResult.rows[0]?.acquired) {
      await client.query('ROLLBACK');
      return [];
    }

    await client.query(
      `UPDATE module_miauto_whatsapp_log
       SET status = 'failed',
           error = 'Envío interrumpido; requiere revisión manual'
       WHERE status = 'processing'
         AND queued_at IS NOT NULL
         AND processing_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 minute')`,
      [PROCESSING_RECOVERY_MINUTES]
    );

    const attemptsResult = await client.query(
      `SELECT COUNT(*)::int AS total
       FROM module_miauto_whatsapp_log
       WHERE queued_at IS NOT NULL
         AND processing_at >= CURRENT_TIMESTAMP - ($1 * INTERVAL '1 second')`,
      [MIAUTO_WHATSAPP_QUEUE_POLICY.windowSeconds]
    );
    const availableSlots = Math.max(
      0,
      MIAUTO_WHATSAPP_QUEUE_POLICY.maxMessages - Number(attemptsResult.rows[0]?.total || 0)
    );
    if (availableSlots === 0) {
      await client.query('COMMIT');
      return [];
    }

    const queueResult = await client.query(
      `SELECT id, phone, message
       FROM module_miauto_whatsapp_log
       WHERE status = 'pending' AND queued_at IS NOT NULL
       ORDER BY queued_at ASC, created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [availableSlots]
    );
    const ids = queueResult.rows.map((row) => row.id);
    if (ids.length > 0) {
      await client.query(
        `UPDATE module_miauto_whatsapp_log
         SET status = 'processing', processing_at = CURRENT_TIMESTAMP, error = NULL
         WHERE id = ANY($1::uuid[])`,
        [ids]
      );
    }
    await client.query('COMMIT');
    return queueResult.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function processMiautoWhatsAppQueue() {
  const messages = await claimQueueMessages();
  if (messages.length === 0) return { processed: 0 };

  const token = process.env.EVOLUTION_GO_MIAUTO_TOKEN;
  let sent = 0;
  let failed = 0;
  for (const message of messages) {
    const result = await sendEvolutionGoTextMessage(message.phone, message.message, {
      token,
      tokenName: 'EVOLUTION_GO_MIAUTO_TOKEN',
    });
    if (result.success) {
      sent += 1;
      await query(
        `UPDATE module_miauto_whatsapp_log
         SET status = 'sent', sent_at = CURRENT_TIMESTAMP, error = NULL
         WHERE id = $1`,
        [message.id]
      );
    } else {
      failed += 1;
      await query(
        `UPDATE module_miauto_whatsapp_log
         SET status = 'failed', error = $2
         WHERE id = $1`,
        [message.id, String(result.error || 'Error al enviar').slice(0, 500)]
      );
    }
  }

  logger.info('Mi Auto: lote WhatsApp procesado', {
    attempted: messages.length,
    sent,
    failed,
    ...MIAUTO_WHATSAPP_QUEUE_POLICY,
  });
  return { processed: messages.length, sent, failed };
}

export async function getWhatsAppQueueStatuses(ids = []) {
  const validIds = [...new Set(
    ids.map((id) => String(id || '').trim()).filter((id) => UUID_RE.test(id))
  )];
  if (validIds.length === 0) return [];

  const { rows } = await query(
    `SELECT id, status, error, processing_at, sent_at
     FROM module_miauto_whatsapp_log
     WHERE id = ANY($1::uuid[])`,
    [validIds]
  );
  return rows;
}

/**
 * Obtiene historial de envíos con filtros y paginación.
 */
const WHATSAPP_LOG_DATE_EXPRESSION = 'COALESCE(sent_at, queued_at, created_at)';

/**
 * Lista liviana para selección de destinatarios. No incluye cuotas, imágenes,
 * resúmenes financieros ni configuración completa de cronogramas.
 */
export async function getWhatsAppRecipients({ country = 'PE' } = {}) {
  const normalizedCountry = String(country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
  const { rows } = await query(
    `SELECT s.id,
            s.phone,
            s.cronograma_id,
            COALESCE(
              NULLIF(BTRIM(CONCAT_WS(' ', rd.first_name, rd.last_name)), ''),
              NULLIF(BTRIM(CONCAT_WS(' ', yd.first_name, yd.last_name)), ''),
              'Conductor'
            ) AS driver_name,
            c.name AS cronograma_name,
            v.name AS vehiculo_name
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id::text = s.driver_id_fleet
     LEFT JOIN LATERAL (
       SELECT d.first_name, d.last_name
       FROM drivers d
       WHERE d.driver_id = s.driver_id_fleet
       LIMIT 1
     ) yd ON TRUE
     LEFT JOIN module_miauto_cronograma c ON c.id = s.cronograma_id
     LEFT JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id
     WHERE s.status = 'aprobado' AND s.country = $1
     ORDER BY s.fecha_inicio_cobro_semanal DESC NULLS LAST, s.created_at DESC`,
    [normalizedCountry]
  );
  return rows || [];
}

function appendWhatsAppLogFilters({ solicitudId, status, date, search } = {}) {
  const conditions = [];
  const params = [];

  if (solicitudId) {
    params.push(solicitudId);
    conditions.push(`solicitud_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (date) {
    params.push(date);
    conditions.push(
      `(${WHATSAPP_LOG_DATE_EXPRESSION} AT TIME ZONE 'America/Lima')::date = $${params.length}::date`
    );
  }
  if (String(search || '').trim()) {
    params.push(`%${String(search).trim()}%`);
    conditions.push(`(
      COALESCE(driver_name, '') ILIKE $${params.length}
      OR COALESCE(phone, '') ILIKE $${params.length}
      OR COALESCE(error, '') ILIKE $${params.length}
    )`);
  }

  return {
    params,
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
  };
}

export async function getWhatsAppLogDays({ solicitudId, status, search } = {}) {
  const { where, params } = appendWhatsAppLogFilters({ solicitudId, status, search });
  const { rows } = await query(
    `SELECT (${WHATSAPP_LOG_DATE_EXPRESSION} AT TIME ZONE 'America/Lima')::date::text AS date,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'processing')::int AS processing
     FROM module_miauto_whatsapp_log
     ${where}
     GROUP BY 1
     ORDER BY 1 DESC`,
    params
  );

  return rows;
}

export async function getWhatsAppLog({ solicitudId, status, date, search, page = 1, limit = 50 } = {}) {
  const { where, params } = appendWhatsAppLogFilters({ solicitudId, status, date, search });
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;

  const dataParams = [...params, safeLimit, offset];
  const limitPosition = params.length + 1;
  const offsetPosition = params.length + 2;

  const { rows } = await query(
    `SELECT id, solicitud_id, driver_name, phone, status, error, created_by,
            sent_at, queued_at, created_at
     FROM module_miauto_whatsapp_log ${where}
     ORDER BY ${WHATSAPP_LOG_DATE_EXPRESSION} DESC
     LIMIT $${limitPosition} OFFSET $${offsetPosition}`,
    dataParams
  );

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM module_miauto_whatsapp_log ${where}`,
    params
  );

  return {
    data: rows,
    total: Number(countRes.rows[0]?.total || 0),
    page: safePage,
    limit: safeLimit,
  };
}
