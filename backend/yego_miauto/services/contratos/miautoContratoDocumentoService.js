import { query } from '../../../config/database.js';
import { uploadFileToMedia } from '../../../services/voucherService.js';

const MIAUTO_CONTRATOS_BUCKET = process.env.MIAUTO_CONTRATOS_BUCKET || 'miauto-contratos';

function userLabel(row, prefix) {
  const first = row[`${prefix}_first_name`] || '';
  const last = row[`${prefix}_last_name`] || '';
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name || row[`${prefix}_email`] || null;
}

function mapContrato(row) {
  return {
    id: row.id,
    solicitud_id: row.solicitud_id,
    file_name: row.file_name,
    file_path: row.file_path,
    mime_type: row.mime_type,
    file_size: row.file_size != null ? Number(row.file_size) : null,
    created_by: row.created_by,
    created_by_name: userLabel(row, 'created_by_user'),
    created_at: row.created_at,
    deleted_by: row.deleted_by,
    deleted_by_name: userLabel(row, 'deleted_by_user'),
    deleted_at: row.deleted_at,
    activo: !row.deleted_at,
  };
}

export async function listContratosBySolicitud(solicitudId) {
  const res = await query(
    `SELECT c.*,
            cu.first_name AS created_by_user_first_name,
            cu.last_name AS created_by_user_last_name,
            cu.email AS created_by_user_email,
            du.first_name AS deleted_by_user_first_name,
            du.last_name AS deleted_by_user_last_name,
            du.email AS deleted_by_user_email
     FROM module_miauto_contrato_documento c
     LEFT JOIN module_rapidin_users cu ON cu.id = c.created_by
     LEFT JOIN module_rapidin_users du ON du.id = c.deleted_by
     WHERE c.solicitud_id = $1::uuid
     ORDER BY c.deleted_at IS NULL DESC, c.created_at DESC`,
    [solicitudId]
  );
  return res.rows.map(mapContrato);
}

export async function uploadContratoDocumento(solicitudId, file, userId) {
  const sol = await query('SELECT id FROM module_miauto_solicitud WHERE id = $1::uuid AND deleted_at IS NULL', [solicitudId]);
  if (sol.rows.length === 0) throw new Error('Solicitud no encontrada');

  const prefixedName = `${solicitudId}/${Date.now()}-${file.originalname || 'contrato'}`;
  const fileUrl = await uploadFileToMedia(
    { ...file, originalname: prefixedName },
    { bucket: MIAUTO_CONTRATOS_BUCKET }
  );

  const res = await query(
    `INSERT INTO module_miauto_contrato_documento
       (solicitud_id, file_name, file_path, mime_type, file_size, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)
     RETURNING *`,
    [solicitudId, file.originalname || 'contrato', fileUrl, file.mimetype || null, file.size || null, userId || null]
  );
  return mapContrato({
    ...res.rows[0],
    created_by_user_first_name: null,
    created_by_user_last_name: null,
    created_by_user_email: null,
    deleted_by_user_first_name: null,
    deleted_by_user_last_name: null,
    deleted_by_user_email: null,
  });
}

export async function deleteContratoDocumento(solicitudId, contratoId, userId) {
  const res = await query(
    `UPDATE module_miauto_contrato_documento
     SET deleted_at = CURRENT_TIMESTAMP,
         deleted_by = $3
     WHERE id = $1::uuid
       AND solicitud_id = $2::uuid
       AND deleted_at IS NULL
     RETURNING id`,
    [contratoId, solicitudId, userId || null]
  );
  return res.rowCount > 0;
}
