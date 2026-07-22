import { query } from '../../config/database.js';
import { auditService } from '../../services/auditService.js';
import {
  sendEvolutionGoMediaMessage,
  sendEvolutionGoTextMessage,
} from '../../services/evolutionGoWhatsAppService.js';
import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';
import { assertMimotoIsolationSql, normalizeColombianPhone } from './mimotoFinancialEngine.js';

const TOKEN_NAME = 'EVOLUTION_GO_MIMOTO_TOKEN';

async function getVoucherAttachment(solicitudId, voucherId) {
  if (!voucherId) return null;
  const result = await query(
    assertMimotoIsolationSql(
      `SELECT file_name, file_path
       FROM module_mimoto_comprobante_cuota_semanal
       WHERE id=$1 AND solicitud_id=$2 AND deleted_at IS NULL
       LIMIT 1`
    ),
    [voucherId, solicitudId]
  );
  const voucher = result.rows[0];
  if (!voucher?.file_path) throw new Error('El comprobante seleccionado no tiene archivo disponible');
  return {
    url: voucher.file_path,
    name: voucher.file_name || 'comprobante-mimoto.pdf',
  };
}

export async function queueMimotoMessage(solicitudId, message, actorId, { voucherId } = {}) {
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) throw new Error('El mensaje es requerido');
  const solicitud = await query(
    assertMimotoIsolationSql(
      `SELECT phone, first_name, last_name FROM module_mimoto_solicitud
       WHERE id=$1 AND deleted_at IS NULL`
    ),
    [solicitudId]
  );
  const row = solicitud.rows[0];
  if (!row) throw new Error('Solicitud Mi Moto no encontrada');
  const attachment = await getVoucherAttachment(solicitudId, voucherId);
  const phone = normalizeColombianPhone(row.phone);
  const result = await query(
    assertMimotoIsolationSql(
      `INSERT INTO module_mimoto_whatsapp_log
        (solicitud_id,driver_name,phone,message,message_type,media_url,media_name,status,created_by,queued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,CURRENT_TIMESTAMP) RETURNING *`
    ),
    [solicitudId, `${row.first_name} ${row.last_name}`.trim(), phone, cleanMessage,
      attachment ? 'document' : 'text', attachment?.url || null, attachment?.name || null, actorId || null]
  );
  return result.rows[0];
}

export async function refreshMimotoWhatsAppPhone(solicitudId, actorId) {
  const solicitudResult = await query(
    assertMimotoIsolationSql(
      `SELECT s.id, s.phone, s.driver_id_fleet, f.park_id
       FROM module_mimoto_solicitud s
       JOIN module_mimoto_fleet f ON f.id=s.fleet_id
       WHERE s.id=$1 AND s.deleted_at IS NULL
       LIMIT 1`
    ),
    [solicitudId]
  );
  const solicitud = solicitudResult.rows[0];
  if (!solicitud) throw new Error('Solicitud Mi Moto no encontrada');
  if (!solicitud.driver_id_fleet || !solicitud.park_id) {
    return {
      phone_before: solicitud.phone,
      phone_after: solicitud.phone,
      updated: false,
      warnings: ['La solicitud no tiene conductor Fleet o flota vinculada.'],
    };
  }

  const fleetResult = await query(
    `SELECT phone
     FROM drivers
     WHERE driver_id::text=$1 AND park_id::text=$2
     ORDER BY CASE WHEN work_status='working' THEN 0 ELSE 1 END
     LIMIT 1`,
    [String(solicitud.driver_id_fleet), String(solicitud.park_id)]
  );
  if (!fleetResult.rows[0]?.phone) {
    return {
      phone_before: solicitud.phone,
      phone_after: solicitud.phone,
      updated: false,
      warnings: ['Fleet no tiene un teléfono disponible para este conductor.'],
    };
  }

  let fleetPhone;
  try {
    fleetPhone = normalizeColombianPhone(fleetResult.rows[0].phone);
  } catch {
    return {
      phone_before: solicitud.phone,
      phone_after: solicitud.phone,
      updated: false,
      warnings: ['El teléfono registrado en Fleet no es un número colombiano válido.'],
    };
  }
  const currentPhone = String(solicitud.phone || '').replace(/\D/g, '');
  if (currentPhone === fleetPhone) {
    return { phone_before: solicitud.phone, phone_after: fleetPhone, updated: false, warnings: [] };
  }

  await query(
    assertMimotoIsolationSql(
      `UPDATE module_mimoto_solicitud
       SET phone=$1, updated_at=CURRENT_TIMESTAMP, updated_by=$2
       WHERE id=$3`
    ),
    [fleetPhone, actorId || null, solicitudId]
  );
  await auditService.recordChange(
    'module_mimoto_solicitud',
    solicitudId,
    'UPDATE',
    { phone: solicitud.phone },
    { phone: fleetPhone, source: 'whatsapp_phone_refresh', park_id: solicitud.park_id },
    actorId || null
  );
  return { phone_before: solicitud.phone, phone_after: fleetPhone, updated: true, warnings: [] };
}

export async function listMimotoMessages({ page = 1, limit = 50, status } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const statusFilter = status ? String(status) : null;
  const count = await query(
    assertMimotoIsolationSql(
      `SELECT COUNT(*)::int AS total
       FROM module_mimoto_whatsapp_log w
       WHERE ($1::text IS NULL OR w.status=$1)`
    ),
    [statusFilter]
  );
  const result = await query(
    assertMimotoIsolationSql(
      `SELECT w.*
       FROM module_mimoto_whatsapp_log w
       WHERE ($1::text IS NULL OR w.status=$1)
       ORDER BY w.created_at DESC
       LIMIT $2 OFFSET $3`
    ),
    [statusFilter, safeLimit, (safePage - 1) * safeLimit]
  );
  return {
    data: result.rows,
    total: count.rows[0]?.total || 0,
  };
}

export async function processMimotoMessageQueue({ limit = 3 } = {}) {
  if (!MIMOTO_CONFIG.automationEnabled) {
    return { skipped: true, reason: 'MIMOTO_AUTOMATION_ENABLED=false' };
  }
  const pending = await query(
    assertMimotoIsolationSql(
      `UPDATE module_mimoto_whatsapp_log SET status='processing', processing_at=CURRENT_TIMESTAMP
       WHERE id IN (
         SELECT id FROM module_mimoto_whatsapp_log WHERE status='pending'
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
       ) RETURNING *`
    ),
    [Math.max(1, Math.min(3, Number(limit) || 3))]
  );
  let sent = 0;
  let failed = 0;
  for (const item of pending.rows) {
    let response;
    if (item.message_type === 'document' && item.media_url) {
      response = await sendEvolutionGoMediaMessage(
        item.phone,
        {
          caption: item.message,
          fileUrl: item.media_url,
          fileName: item.media_name || 'comprobante-mimoto.pdf',
          type: 'document',
          defaultCountry: 'CO',
        },
        { token: process.env.EVOLUTION_GO_MIMOTO_TOKEN, tokenName: TOKEN_NAME }
      );
      if (!response.success) {
        response = await sendEvolutionGoTextMessage(
          item.phone,
          `${item.message}\n\nComprobante: ${item.media_url}`,
          { token: process.env.EVOLUTION_GO_MIMOTO_TOKEN, tokenName: TOKEN_NAME, defaultCountry: 'CO' }
        );
      }
    } else {
      response = await sendEvolutionGoTextMessage(item.phone, item.message, {
        token: process.env.EVOLUTION_GO_MIMOTO_TOKEN,
        tokenName: TOKEN_NAME,
        defaultCountry: 'CO',
      });
    }
    await query(
      assertMimotoIsolationSql(
        `UPDATE module_mimoto_whatsapp_log SET status=$1, sent_at=$2, error=$3 WHERE id=$4`
      ),
      [response.success ? 'sent' : 'failed', response.success ? new Date() : null,
        response.success ? null : response.error, item.id]
    );
    if (response.success) sent += 1;
    else failed += 1;
  }
  return { skipped: false, processed: pending.rowCount, sent, failed };
}
