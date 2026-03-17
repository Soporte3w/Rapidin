import { query } from '../config/database.js';
import { uploadFileToMedia } from './voucherService.js';

const TIPOS_ALLOWED = ['licencia', 'comprobante_viajes'];

const ADJUNTO_COLUMNS = 'id, solicitud_id, tipo, file_name, file_path, created_at';

export async function listBySolicitud(solicitudId) {
  const result = await query(
    `SELECT ${ADJUNTO_COLUMNS} FROM module_miauto_adjunto WHERE solicitud_id = $1 ORDER BY tipo, created_at`,
    [solicitudId]
  );
  return result.rows;
}

export async function createAdjunto(solicitudId, tipo, file) {
  if (!TIPOS_ALLOWED.includes(tipo)) {
    throw new Error(`tipo debe ser uno de: ${TIPOS_ALLOWED.join(', ')}`);
  }
  const filePath = await uploadFileToMedia(file);
  const fileName = file.originalname || `miauto_${tipo}_${Date.now()}.jpg`;

  const insertResult = await query(
    `INSERT INTO module_miauto_adjunto (solicitud_id, tipo, file_name, file_path)
     SELECT $1, $2, $3, $4 FROM module_miauto_solicitud WHERE id = $1`,
    [solicitudId, tipo, fileName, filePath]
  );

  if (insertResult.rowCount === 0) {
    throw new Error('Solicitud no encontrada');
  }
  return listBySolicitud(solicitudId);
}
