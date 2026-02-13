import crypto from 'crypto';
import axios from 'axios';

// Cookie y Park ID globales: se envían en el header de cada request a Yango (la API usa sesión por cookie).
const COOKIE = 'i=x5tkbBS7C7HE+NXGcad3ZssQ3gf1F0rq356OWQvEx3ZB8N6sRw3Cgl6OxfwzvxG4EEjzwDu2xiGfC575M7+qz6ox3wc=; yandexuid=196877061764616562; yashr=2270601791764616562; yuidss=196877061764616562; ymex=2079976564.yrts.1764616564; receive-cookie-deprecation=1; gdpr=0; _ym_uid=1764616564116282218; _ym_d=1764616565; _qw_uid=1766084220529711702; _qw_d=1766084220; park_id=3c19c431aa6a4c5f9f7154273aa51822; Session_id=3:1770214431.5.0.1764616812843:WbD9Jg:9933.1.2:1|2223153146.0.2.0:3.3:1764616812|2220343194.-1.0.0:15.2:1467462.3:1766084274|60:11686106.964043.gC5FrbxsPT1hiVgsB3g4V8NxA7U; sessar=1.1615350.CiBOaCoQ6hx6dMN0hvtztDLkRqbrv9EMLiEyk8BmmjLgRA.HdF01kroXWosrW45oVwtkJCvA4DOEGwR4FRqyjfXj-c; sessionid2=3:1770214431.5.0.1764616812843:WbD9Jg:9933.1.2:1|2223153146.0.2.0:3.3:1764616812|2220343194.-1.0.0:15.2:1467462.3:1766084274|60:11686106.964043.fakesign0000000000000000000; yp=2085574431.udn.cDpnaW9tYXJvcnRlZ2E%3D#2081444274.multib.1; L=clF8RF5FUWJZUWYCZ0IJWmZzBVJxVwBWMR0tBA0cIBgaJykW.1770214431.1680357.349774.da9d41917796d20b7b38f5d694aaeb8e; yandex_login=giomarortega; _ym_isad=2; _ym_visorc=b; _yasc=2z1VOOd4RvyFxLC+28/TSsHT2xBhcko/dwXhYyCGMtk0lJ7+vh8diwboZ6NV8G+evFyC; bh=EjgiTm90KEE6QnJhbmQiO3Y9IjgiLCAiQ2hyb21pdW0iO3Y9IjE0NCIsICJCcmF2ZSI7dj0iMTQ0IhoDeDg2IgkxNDQuMC4wLjAqAj8wOgciTGludXgiSgI2NFJIIk5vdChBOkJyYW5kIjt2PSI4LjAuMC4wIiwiQ2hyb21pdW0iO3Y9IjE0NC4wLjAuMCIsIkJyYXZlIjt2PSIxNDQuMC4wLjAiYIOgsswGahncyumIDvKst6UL+/rw5w3r//32D573zYcI';
const PARK_ID = '08e20910d81d42658d4334d3f6d10ac0';

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
    'Cookie': (cookieOverride && String(cookieOverride).trim()) ? String(cookieOverride).trim() : COOKIE.trim(),
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
    'Cookie': (cookieOverride && String(cookieOverride).trim()) ? String(cookieOverride).trim() : COOKIE.trim(),
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

/** Consulta saldo del conductor. Cookie y X-Park-Id van en headers (Yango exige Cookie para la sesión). */
export async function getContractorBalance(contractorProfileId, parkId = null) {
  const id = String(contractorProfileId || '').trim();
  if (!id) return { success: false, error: 'external_driver_id vacío' };
  const url = `https://fleet.yango.com/api/fleet/contractor-profiles-manager/v1/contractor-balances/by-pro-id?contractor_profile_id=${encodeURIComponent(id)}`;
  const headers = {
    'Accept-Language': 'es-ES,es',
    'Cookie': COOKIE.trim(),       // global: sesión Yango
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
