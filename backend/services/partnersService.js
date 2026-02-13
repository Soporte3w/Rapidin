/**
 * API de flotas (mismo uso que Java):
 *   POST http://162.55.214.109:6000/v2/partners (body null)
 *   Respuesta: { partners: [ { id, name, city, specifications } ] }
 * Usamos http.request (no fetch) porque fetch en Node bloquea el puerto 6000 ("bad port").
 */

import http from 'http';
import https from 'https';
import { logger } from '../utils/logger.js';

const PARTNERS_API_URL = process.env.PARTNERS_API_URL || 'http://162.55.214.109:6000/v2/partners';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

let partnersCache = null;
let cacheExpiry = 0;

function normalizePartnerId(id) {
  if (id == null) return '';
  return String(id).trim().toLowerCase().replace(/-/g, '');
}

/** POST a la API y devuelve el body como JSON. */
function postJson(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Partners API: ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Obtiene todas las flotas desde la API (como restTemplate.postForObject(url, null, Map.class)). */
export async function fetchPartners() {
  if (partnersCache && Date.now() < cacheExpiry) return partnersCache;
  try {
    const data = await postJson(PARTNERS_API_URL);
    const list = data?.partners || [];
    partnersCache = list;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return list;
  } catch (err) {
    if (partnersCache) return partnersCache;
    logger.warn('Partners API falló:', { message: err.message, url: PARTNERS_API_URL });
    throw err;
  }
}

/**
 * Orden: 1) Obtener valores de la API y guardarlos. 2) Comparar park_id con esa lista.
 * partnerId = park_id del conductor (consulta por teléfono en loanRequests).
 */
export async function getPartnerNameById(partnerId) {
  const parkIdNorm = normalizePartnerId(partnerId);
  if (!parkIdNorm) return null;
  try {
    // 1) Primero: obtener y guardar la lista de la API (o usar caché)
    const partners = await fetchPartners();
    if (!partners?.length) return null;

    // 2) Luego: comparar park_id con esa lista
    const idNorm = (p) => normalizePartnerId(p?.id);
    let partner = partners.find((p) => idNorm(p) === parkIdNorm);
    if (!partner) {
      partner = partners.find((p) => idNorm(p).includes(parkIdNorm) || parkIdNorm.includes(idNorm(p)));
    }
    return partner?.name ?? null;
  } catch {
    return null;
  }
}
