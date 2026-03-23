import crypto from 'crypto';
import axios from 'axios';
import { getNextProxyConfig, hasProxies } from './proxyLoader.js';

// Cookie y Park ID. Dos cookies: cobro automático (Jhajaira) y pagar/recarga (carmenvargas).
const trimCookie = (v) => (v || '').replace(/^["']|["']$/g, '').trim();
const COOKIE_PAGAR = trimCookie(process.env.YANGO_FLEET_COOKIE);           // pagar / recarga (add)
const COOKIE_COBRO = trimCookie(process.env.YANGO_FLEET_COOKIE_COBRO) || COOKIE_PAGAR; // cobro automático (withdraw + balance en job)
const PARK_ID = trimCookie(process.env.YANGO_FLEET_PARK_ID) || '08e20910d81d42658d4334d3f6d10ac0';

/** Reintentos ante 429 / Too many requests (con o sin proxies). */
const MAX_RATE_LIMIT_RETRIES = Number(process.env.YANGO_RATE_LIMIT_MAX_RETRIES || 8);

function normalizeApiMessage(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    const m = data.message ?? data.error ?? data.detail;
    if (typeof m === 'string') return m;
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

function isRateLimitError(error) {
  if (error.response && error.response.status === 429) return true;
  const msg = normalizeApiMessage(error.response?.data) + ' ' + (error.message || '');
  return /too many requests|rate limit|429/i.test(msg);
}

function rateLimitBackoffMs(attempt) {
  // Sin proxy: la API necesita más tiempo entre intentos (mismo IP).
  const base = hasProxies() ? 600 * (attempt + 1) : 1200 * Math.pow(2, Math.min(attempt, 5));
  const jitter = Math.floor(Math.random() * 500);
  const cap = 25000;
  return Math.min(base + jitter, cap);
}

/**
 * POST con reintento ante rate limit (429 / Too many requests).
 * Siempre reintenta con backoff exponencial (antes solo si había proxies).
 */
async function postWithProxyRetry(url, body, headers) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
    const config = { headers, ...getNextProxyConfig() };
    try {
      const res = await axios.post(url, body || {}, config);
      return res;
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error)) throw error;
      if (attempt >= MAX_RATE_LIMIT_RETRIES - 1) throw error;
      const waitMs = rateLimitBackoffMs(attempt);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

/**
 * Withdraw (cobro) — body + headers, X-Idempotency-Token. Usa proxy y reintenta con otro si hay rate limit.
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
    const response = await postWithProxyRetry('https://fleet.yango.com/api/v1/quickbar/transaction/withdraw', body, headers);
    return { success: true, data: response.data };
  } catch (error) {
    if (error.response) {
      const msg = normalizeApiMessage(error.response.data) || error.message;
      return { success: false, status: error.response.status, message: msg };
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
    const response = await postWithProxyRetry('https://fleet.yango.com/api/v1/quickbar/transaction/add', body, headers);
    return { success: true, data: response.data };
  } catch (error) {
    if (error.response) {
      const msg = normalizeApiMessage(error.response.data) || error.message;
      return { success: false, status: error.response.status, message: msg };
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
    const res = await postWithProxyRetry(url, {}, headers);
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

/**
 * Driver income (Mi Auto): viajes e ingresos por rango de fechas.
 * POST fleet.yango.com/api/v1/cards/driver/income con date_from, date_to, driver_id.
 * dateFrom/dateTo: ISO con timezone -05:00 (ej. 2026-03-02T00:00:00-05:00, 2026-03-08T23:00:00-05:00).
 */
export async function getDriverIncome(dateFrom, dateTo, driverId, parkId = null, cookieOverride = null) {
  const id = String(driverId || '').trim();
  if (!id) return { success: false, error: 'driver_id vacío' };
  const url = 'https://fleet.yango.com/api/v1/cards/driver/income';
  const body = {
    date_from: dateFrom || '',
    date_to: dateTo || '',
    driver_id: id
  };
  const headers = {
    'Accept-Language': 'es-ES,es',
    'Cookie': (cookieOverride && String(cookieOverride).trim()) ? String(cookieOverride).trim() : COOKIE_COBRO,
    'X-Park-Id': (parkId && String(parkId).trim()) ? String(parkId).trim() : PARK_ID,
    'Content-Type': 'application/json'
  };
  try {
    const res = await postWithProxyRetry(url, body, headers);
    const countCompleted = res.data?.orders?.count_completed != null ? Number(res.data.orders.count_completed) : 0;
    const partnerFees = res.data?.balances?.partner_fees != null ? parseFloat(res.data.balances.partner_fees) : 0;
    return {
      success: true,
      count_completed: countCompleted,
      partner_fees: Number.isFinite(partnerFees) ? partnerFees : 0,
      raw: res.data
    };
  } catch (error) {
    if (error.response) {
      return { success: false, error: error.response.status === 403 ? '403 cookie expirada' : `Error ${error.response.status}`, message: error.response.data?.message || error.response.data };
    }
    return { success: false, error: error.message };
  }
}
