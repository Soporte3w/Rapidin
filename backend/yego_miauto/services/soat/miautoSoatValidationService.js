import { query } from '../../../config/database.js';
import { getSoatInfo, normalizedPlate } from '../../../services/factilizaService.js';
import { logger } from '../../../utils/logger.js';

const ERROR_MAX_LENGTH = 500;

export function factilizaDateToIso(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  const [, day, month, year] = match;
  const candidate = `${year}-${month}-${day}`;
  const date = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== candidate ? null : candidate;
}

async function saveFailedValidation(solicitudId, plate, error) {
  await query(
    `UPDATE module_miauto_solicitud
     SET soat_validation_status = 'error',
         soat_validation_checked_at = CURRENT_TIMESTAMP,
         soat_validation_error = $3,
         soat_validation_attempts = soat_validation_attempts + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(placa_asignada, '')), '[^A-Z0-9]', '', 'g')) = $2`,
    [solicitudId, plate, error]
  );
}

/** Consulta Factiliza y guarda el SOAT solo si la placa sigue asignada al contrato. */
export async function validateMiautoSoat({ solicitudId, placa }) {
  let plate;
  try {
    plate = normalizedPlate(placa);
  } catch (error) {
    const message = String(error.message).slice(0, ERROR_MAX_LENGTH);
    await query(
      `UPDATE module_miauto_solicitud
       SET soat_validation_status = 'error',
           soat_validation_checked_at = CURRENT_TIMESTAMP,
           soat_validation_error = $2,
           soat_validation_attempts = soat_validation_attempts + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [solicitudId, message]
    );
    return { status: 'error', error: message };
  }

  try {
    const soat = await getSoatInfo(plate);
    const startsAt = factilizaDateToIso(soat.startsAt);
    const expiresAt = factilizaDateToIso(soat.expiresAt);
    if (!expiresAt) throw new Error('Factiliza devolvió una fecha de vencimiento SOAT inválida');

    await query(
      `UPDATE module_miauto_solicitud
       SET soat_fecha_inicio = $3,
           soat_fecha_vencimiento = $4,
           soat_compania = $5,
           soat_estado = $6,
           soat_numero_poliza = $7,
           soat_codigo_sbs_aseguradora = $8,
           soat_codigo_unico_poliza = $9,
           soat_validation_status = 'valid',
           soat_validation_attempts = soat_validation_attempts + 1,
           soat_validation_checked_at = CURRENT_TIMESTAMP,
           soat_validation_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(placa_asignada, '')), '[^A-Z0-9]', '', 'g')) = $2`,
      [
        solicitudId,
        plate,
        startsAt,
        expiresAt,
        soat.companyName,
        soat.status,
        soat.policyNumber,
        soat.insurerSbsCode,
        soat.uniquePolicyCode,
      ]
    );
    return { status: 'valid', soat: { ...soat, startsAt, expiresAt } };
  } catch (error) {
    const message = String(error?.message || 'Error desconocido consultando SOAT en Factiliza')
      .slice(0, ERROR_MAX_LENGTH);
    let persisted = true;
    try {
      await saveFailedValidation(solicitudId, plate, message);
    } catch (persistenceError) {
      persisted = false;
      logger.error('No se pudo registrar el error de validación SOAT Mi Auto', {
        solicitudId,
        plate,
        error: persistenceError.message,
      });
    }
    logger.warn('Validación SOAT Mi Auto finalizó con error', { solicitudId, plate, error: message });
    return { status: 'error', error: message, persisted };
  }
}

/** Ejecuta la consulta fuera del tiempo de respuesta de la creación o cambio de placa. */
export function enqueueMiautoSoatValidation(payload) {
  if (!String(payload?.placa || '').trim()) return;
  setImmediate(() => {
    validateMiautoSoat(payload).catch((error) => {
      logger.error('Falló la tarea de validación SOAT Mi Auto', {
        solicitudId: payload.solicitudId,
        error: error.message,
      });
    });
  });
}
