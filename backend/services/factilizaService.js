/**
 * Consultas de identidad y licencia en Perú vía Factiliza.
 * Configurar FACTILIZA_API_TOKEN en el entorno (Bearer token).
 */

const FACTILIZA_DNI_BASE_URL = 'https://api.factiliza.com/pe/v1/dni/info';
const FACTILIZA_LICENSE_BASE_URL = 'https://api.factiliza.com/v1/licencia/info';
const FACTILIZA_SOAT_BASE_URL = 'https://api.factiliza.com/v1/placa/soat';
const configuredFactilizaTimeoutMs = Number(process.env.FACTILIZA_TIMEOUT_MS);
const FACTILIZA_TIMEOUT_MS = Number.isFinite(configuredFactilizaTimeoutMs) && configuredFactilizaTimeoutMs >= 1000
  ? configuredFactilizaTimeoutMs
  : 10000;

function normalizedDni(dni) {
  const value = String(dni).trim();
  if (!/^\d{8}$/.test(value)) throw new Error('DNI debe tener 8 dígitos');
  return value;
}

export function normalizedPlate(plate) {
  const value = String(plate ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{5,8}$/.test(value)) throw new Error('Placa inválida para consultar SOAT');
  return value;
}

async function requestFactiliza(baseUrl, identifier, resourceName, normalizeIdentifier = normalizedDni) {
  const rawToken = process.env.FACTILIZA_API_TOKEN;
  if (!rawToken || !rawToken.trim()) {
    throw new Error('Servicio Factiliza no configurado. Configure FACTILIZA_API_TOKEN en el entorno');
  }
  const authHeader = rawToken.trim().startsWith('Bearer ') ? rawToken.trim() : `Bearer ${rawToken.trim()}`;
  const url = `${baseUrl}/${normalizeIdentifier(identifier)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    signal: AbortSignal.timeout(FACTILIZA_TIMEOUT_MS),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Token de Factiliza inválido o expirado. Verifique FACTILIZA_API_TOKEN en .env');
    }
    const message = body?.message || body?.error || body?.detail || `Error al consultar ${resourceName} (${response.status})`;
    throw new Error(message);
  }

  return body;
}

/**
 * Obtiene información del DNI desde Factiliza.
 * @param {string} dni - DNI de 8 dígitos
 * @returns {Promise<{ fullName: string }>}
 */
export const getDniInfo = async (dni) => {
  const body = await requestFactiliza(FACTILIZA_DNI_BASE_URL, dni, 'DNI');

  // Factiliza puede devolver nombre_completo o nombres + apellidos
  const data = body?.data || body;
  let fullName = data.nombre_completo;
  if (!fullName && (data.nombres || data.apellido_paterno || data.apellido_materno)) {
    const parts = [
      data.nombres,
      data.apellido_paterno,
      data.apellido_materno,
    ].filter(Boolean);
    fullName = parts.join(' ').trim();
  }
  if (!fullName) {
    throw new Error('No se encontró el nombre para este DNI');
  }

  return { fullName };
};

/**
 * Obtiene la licencia de conducir asociada a un DNI peruano.
 * @param {string} dni - DNI de 8 dígitos
 * @returns {Promise<{
 *   documentNumber: string|null,
 *   fullName: string|null,
 *   number: string|null,
 *   category: string|null,
 *   issuedAt: string|null,
 *   expiresAt: string|null,
 *   status: string|null,
 *   restrictions: string|null
 * }>}
 */
export const getLicenseInfo = async (dni) => {
  const body = await requestFactiliza(FACTILIZA_LICENSE_BASE_URL, dni, 'licencia');
  const data = body?.data || body;
  const license = data?.licencia;
  if (!license || typeof license !== 'object') {
    throw new Error('Factiliza no devolvió información de licencia para este DNI');
  }

  const clean = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
  };

  return {
    documentNumber: clean(data.numero_documento),
    fullName: clean(data.nombre_completo),
    number: clean(license.numero),
    category: clean(license.categoria),
    issuedAt: clean(license.fecha_expedicion),
    expiresAt: clean(license.fecha_vencimiento),
    status: clean(license.estado),
    restrictions: clean(license.restricciones),
  };
};

/**
 * Obtiene el SOAT vigente asociado a una placa peruana.
 * @param {string} plate - Placa del vehículo
 * @returns {Promise<{
 *   plate: string,
 *   companyName: string|null,
 *   startsAt: string|null,
 *   expiresAt: string|null,
 *   status: string|null,
 *   policyNumber: string|null,
 *   insurerSbsCode: string|null,
 *   uniquePolicyCode: string|null
 * }>}
 */
export const getSoatInfo = async (plate) => {
  const body = await requestFactiliza(
    FACTILIZA_SOAT_BASE_URL,
    plate,
    'SOAT',
    normalizedPlate,
  );
  const data = body?.data || body;
  if (!data || typeof data !== 'object' || !data.fecha_fin) {
    throw new Error('Factiliza no devolvió información de SOAT para esta placa');
  }

  const clean = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
  };

  return {
    plate: normalizedPlate(data.placa || plate),
    companyName: clean(data.nombre_compania),
    startsAt: clean(data.fecha_inicio),
    expiresAt: clean(data.fecha_fin),
    status: clean(data.estado),
    policyNumber: clean(data.numero_poliza),
    insurerSbsCode: clean(data.codigo_sbs_aseguradora),
    uniquePolicyCode: clean(data.codigo_unico_poliza),
  };
};
