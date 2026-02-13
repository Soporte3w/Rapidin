/**
 * Servicio para consultar DNI en Perú vía API Factiliza.
 * Configurar FACTILIZA_API_TOKEN en .env (Bearer token).
 */

const FACTILIZA_BASE_URL = 'https://api.factiliza.com/pe/v1/dni/info';

/**
 * Obtiene información del DNI desde Factiliza.
 * @param {string} dni - DNI de 8 dígitos
 * @returns {Promise<{ fullName: string }>}
 * @throws {Error} Si el token no está configurado, la API falla o el DNI no existe
 */
export const getDniInfo = async (dni) => {
  const rawToken = process.env.FACTILIZA_API_TOKEN;
  if (!rawToken || !rawToken.trim()) {
    throw new Error('Servicio de consulta DNI no configurado. Configure FACTILIZA_API_TOKEN en .env');
  }
  const authHeader = rawToken.trim().startsWith('Bearer ') ? rawToken.trim() : `Bearer ${rawToken.trim()}`;

  const trimmedDni = String(dni).trim();
  if (!/^\d{8}$/.test(trimmedDni)) {
    throw new Error('DNI debe tener 8 dígitos');
  }

  const url = `${FACTILIZA_BASE_URL}/${trimmedDni}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,         
    },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Token de Factiliza inválido o expirado. Verifique FACTILIZA_API_TOKEN en .env');
    }
    const message = body?.message || body?.error || body?.detail || `Error al consultar DNI (${response.status})`;
    throw new Error(message);
  }

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
