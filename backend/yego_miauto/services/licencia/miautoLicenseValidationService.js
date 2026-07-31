import { query } from '../../../config/database.js';
import { getLicenseInfo } from '../../../services/factilizaService.js';
import { logger } from '../../../utils/logger.js';
import { isMiautoLicenseCategoryValid } from './miautoLicenseCategory.js';

const ERROR_MAX_LENGTH = 500;

function factilizaDateToIso(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  const [, day, month, year] = match;
  const candidate = `${year}-${month}-${day}`;
  const date = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== candidate ? null : candidate;
}

async function saveSkippedValidation(solicitudId, status, error = null, incrementAttempt = false) {
  await query(
    `UPDATE module_miauto_solicitud
     SET license_validation_status = $2,
         license_validation_checked_at = CURRENT_TIMESTAMP,
         license_validation_error = $3,
         license_validation_attempts = license_validation_attempts + CASE WHEN $4 THEN 1 ELSE 0 END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [solicitudId, status, error, incrementAttempt]
  );
}

/**
 * Consulta Factiliza y persiste el resultado. Nunca lanza por errores del proveedor:
 * la solicitud ya creada conserva un estado reintentable.
 */
export async function validateMiautoLicense({ solicitudId, dni, country = 'PE' }) {
  if (String(country).trim().toUpperCase() !== 'PE') {
    await saveSkippedValidation(solicitudId, 'not_applicable');
    return { status: 'not_applicable' };
  }

  const normalizedDni = String(dni ?? '').trim();
  if (!/^\d{8}$/.test(normalizedDni)) {
    const error = 'DNI inválido para consultar licencia en Perú';
    await saveSkippedValidation(solicitudId, 'error', error, true);
    return { status: 'error', error };
  }

  try {
    const license = await getLicenseInfo(normalizedDni);
    const categoryValid = isMiautoLicenseCategoryValid(license.category);
    const status = categoryValid ? 'valid' : 'invalid';
    await query(
      `UPDATE module_miauto_solicitud
       SET license_number = COALESCE($2, license_number),
           license_category = $3,
           license_factiliza_status = $4,
           license_issued_date = $5,
           license_expiration_date = $6,
           license_restrictions = $7,
           license_validation_status = $8,
           license_validation_attempts = license_validation_attempts + 1,
           license_validation_checked_at = CURRENT_TIMESTAMP,
           license_validation_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        solicitudId,
        license.number,
        license.category,
        license.status,
        factilizaDateToIso(license.issuedAt),
        factilizaDateToIso(license.expiresAt),
        license.restrictions,
        status,
      ]
    );
    return { status, license };
  } catch (error) {
    const message = String(error?.message || 'Error desconocido consultando Factiliza').slice(0, ERROR_MAX_LENGTH);
    let persisted = true;
    try {
      await saveSkippedValidation(solicitudId, 'error', message, true);
    } catch (persistenceError) {
      persisted = false;
      logger.error('No se pudo registrar el error de validación de licencia Mi Auto', {
        solicitudId,
        error: persistenceError.message,
      });
    }
    logger.warn('Validación de licencia Mi Auto finalizó con error', { solicitudId, error: message });
    return { status: 'error', error: message, persisted };
  }
}

/** Ejecuta la consulta fuera del tiempo de respuesta de la creación. */
export function enqueueMiautoLicenseValidation(payload) {
  setImmediate(() => {
    validateMiautoLicense(payload).catch((error) => {
      logger.error('Falló la tarea de validación de licencia Mi Auto', {
        solicitudId: payload.solicitudId,
        error: error.message,
      });
    });
  });
}
