import crypto from 'crypto';
import axios from 'axios';

// Cookie y Park ID. Dos cookies: cobro automático (Jhajaira) y pagar/recarga (carmenvargas).
const trimCookie = (v) => (v || '').replace(/^["']|["']$/g, '').trim();
const COOKIE_PAGAR = trimCookie(process.env.YANGO_FLEET_COOKIE);           // pagar / recarga (add)
const COOKIE_COBRO = trimCookie(process.env.YANGO_FLEET_COOKIE_COBRO) || COOKIE_PAGAR; // cobro automático (withdraw + balance en job)
const PARK_ID = trimCookie(process.env.YANGO_FLEET_PARK_ID) || '08e20910d81d42658d4334d3f6d10ac0';

/**
 * Withdraw (cobro) — igual que tu proxy: body + headers, X-Idempotency-Token aleatorio (UUID, misma longitud).
 * cookieOverride y parkIdOverride opcionales (si no se pasan, se usan COOKIE y PARK_ID).
 */
export async function withdrawFromContractor(id, amount, description, cookieOverride, parkIdOverride) {
  const xIdempotencyToken = crypto.randomUUID();
  const body = {
    driver_profile_id: id,
    category_id: 'partner_service_manual',
    amount: String(amount),
    description: description || '',
    fee: { percent: '1' },
    condition: { balance_min: '2' }
  };
  const headers = {
    'Accept-Language': 'es-ES,es',
    'Cookie': (cookieOverride && String(cookieOverride).trim()) ? String(cookieOverride).trim() : COOKIE_COBRO,
    'X-Park-Id': (parkIdOverride && String(parkIdOverride).trim()) ? String(parkIdOverride).trim() : PARK_ID,
    'X-Idempotency-Token': xIdempotencyToken,
    'Content-Type': 'text/plain'
  };
  try {
    const response = await axios.post('https://fleet.yango.com/api/v1/quickbar/transaction/withdraw', body, { headers });
    return { success: true, data: response.data };
  } catch (error) {
    if (error.response) {
      return { success: false, status: error.response.status, message: error.response.data?.message || error.response.data };
    }
    return { success: false, message: error.message };
  }
}

/**
 * Add (recarga) — acreditar saldo al conductor en Yango Pro.
 * Mismo cuerpo que withdraw pero endpoint /add. category_id partner_service_manual, fee 1%.
 */
export async function addToContractor(id, amount, description, cookieOverride, parkIdOverride) {
  const xIdempotencyToken = crypto.randomUUID();
  const body = {
    driver_profile_id: id,
    category_id: 'partner_service_manual',
    amount: String(amount),
    description: description || '',
    fee: { percent: '1' },
    condition: { balance_min: '0' }
  };
  const headers = {
    'Accept-Language': 'es-ES,es',
    'Cookie': (cookieOverride && String(cookieOverride).trim()) ? String(cookieOverride).trim() : COOKIE_PAGAR,
    'X-Park-Id': (parkIdOverride && String(parkIdOverride).trim()) ? String(parkIdOverride).trim() : PARK_ID,
    'X-Idempotency-Token': xIdempotencyToken,
    'Content-Type': 'text/plain'
  };
  try {
    const response = await axios.post('https://fleet.yango.com/api/v1/quickbar/transaction/add', body, { headers });
    return { success: true, data: response.data };
  } catch (error) {
    if (error.response) {
      return { success: false, status: error.response.status, message: error.response.data?.message || error.response.data };
    }
    return { success: false, message: error.message };
  }
}

/** Consulta saldo del conductor. Por defecto usa cookie de cobro (job). cookieOverride opcional. */
export async function getContractorBalance(contractorProfileId, parkId = null, cookieOverride = null) {
  const id = String(contractorProfileId || '').trim();
  if (!id) return { success: false, error: 'external_driver_id vacío' };
  const url = `https://fleet.yango.com/api/fleet/contractor-profiles-manager/v1/contractor-balances/by-pro-id?contractor_profile_id=${encodeURIComponent(id)}`;
  const headers = {
    'Accept-Language': 'es-ES,es',
    'Cookie': (cookieOverride && String(cookieOverride).trim()) ? String(cookieOverride).trim() : COOKIE_COBRO,
    'X-Park-Id': (parkId && String(parkId).trim()) ? String(parkId).trim() : PARK_ID,
    'Content-Type': 'application/json'
  };
  try {
    const res = await axios.post(url, {}, { headers });
    const contractors = res.data?.contractors || [];
    const c = contractors.find(x => x?.contractor_profile_id === id) || contractors[0];
    if (!c) return { success: false, error: 'Conductor no encontrado' };
    const balance = parseFloat(c.balance);
    return { success: true, balance: Number.isFinite(balance) ? balance : 0, full_name: c.full_name };
  } catch (error) {
    if (error.response) return { success: false, error: error.response.status === 403 ? '403 cookie expirada' : `Error ${error.response.status}` };
    return { success: false, error: error.message };
  }
}
