import { query } from '../../config/database.js';
import { uploadFileToMedia } from '../../services/voucherService.js';
import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';
import { assertMimotoIsolationSql } from './mimotoFinancialEngine.js';

function safeFileName(value, fallback) {
  return String(value || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 180);
}

async function ensureSolicitud(id) {
  const result = await query(
    assertMimotoIsolationSql('SELECT id, document_number FROM module_mimoto_solicitud WHERE id=$1 AND deleted_at IS NULL'),
    [id]
  );
  if (!result.rows[0]) throw new Error('Solicitud Mi Moto no encontrada');
  return result.rows[0];
}

export async function uploadMimotoContract(solicitudId, file, actorId) {
  const solicitud = await ensureSolicitud(solicitudId);
  const versionResult = await query(
    assertMimotoIsolationSql('SELECT COALESCE(MAX(version),0)+1 AS version FROM module_mimoto_contrato_documento WHERE solicitud_id=$1'),
    [solicitudId]
  );
  const version = versionResult.rows[0].version;
  const original = safeFileName(file.originalname, 'contrato.pdf');
  const upload = { ...file, originalname: `mimoto/${solicitudId}/contratos/v${version}-${solicitud.document_number}-${original}` };
  const filePath = await uploadFileToMedia(upload, { bucket: MIMOTO_CONFIG.contratosBucket });
  const result = await query(
    assertMimotoIsolationSql(
      `INSERT INTO module_mimoto_contrato_documento
        (solicitud_id,version,file_name,file_path,mime_type,file_size,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`
    ),
    [solicitudId, version, original, filePath, file.mimetype || null, file.size || null, actorId || null]
  );
  return result.rows[0];
}

export async function uploadMimotoVoucherFile(solicitudId, quotaId, file) {
  const solicitud = await ensureSolicitud(solicitudId);
  const original = safeFileName(file.originalname, 'comprobante');
  const upload = {
    ...file,
    originalname: `mimoto/${solicitudId}/comprobantes/${quotaId}-${solicitud.document_number}-${Date.now()}-${original}`,
  };
  const filePath = await uploadFileToMedia(upload, { bucket: MIMOTO_CONFIG.comprobantesBucket });
  return { fileName: original, filePath };
}

export async function uploadMimotoExpenseVoucherFile(solicitudId, expenseId, file) {
  const solicitud = await ensureSolicitud(solicitudId);
  const original = safeFileName(file.originalname, 'comprobante');
  const upload = {
    ...file,
    originalname: `mimoto/${solicitudId}/otros-gastos/${expenseId}-${solicitud.document_number}-${Date.now()}-${original}`,
  };
  const filePath = await uploadFileToMedia(upload, { bucket: MIMOTO_CONFIG.comprobantesBucket });
  return { fileName: original, filePath };
}

export async function deleteMimotoContract(solicitudId, contractId, actorId) {
  const result = await query(
    assertMimotoIsolationSql(
      `UPDATE module_mimoto_contrato_documento SET deleted_at=CURRENT_TIMESTAMP, deleted_by=$1
       WHERE id=$2 AND solicitud_id=$3 AND deleted_at IS NULL RETURNING id`
    ),
    [actorId || null, contractId, solicitudId]
  );
  return Boolean(result.rows[0]);
}
