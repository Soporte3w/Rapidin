import crypto from 'crypto';
import axios from 'axios';
import { getNextProxyConfig, hasProxies, loadProxiesFromUrlIfConfigured } from './proxyLoader.js';
import { logger } from '../utils/logger.js';
import { round2 } from './miautoMoneyUtils.js';

// Lectura en cada request: los scripts pueden cargar .env después del import sin quedar valores vacíos.
const trimCookie = (v) => (v || '').replace(/^["']|["']$/g, '').trim();

/** Base URL Fleet (sin barra final). `YANGO_FLEET_BASE_URL` en .env; por defecto https://fleet.yango.com */
function fleetBaseUrl() {
  const u = String(process.env.YANGO_FLEET_BASE_URL || 'https://fleet.yango.com').trim().replace(/\/$/, '');
  return u || 'https://fleet.yango.com';
}

function fleetCookiePagar() {
  return trimCookie(process.env.YANGO_FLEET_COOKIE);
}
function fleetCookieCobro() {
  return trimCookie(process.env.YANGO_FLEET_COOKIE_COBRO) || fleetCookiePagar();
}
function fleetParkId() {
  return trimCookie(process.env.YANGO_FLEET_PARK_ID);
}

/**
 * Yego Mi Auto — parque Flota para **toda** integración Mi Auto (`driver/income`, saldo, withdraw cuota).
 * Orden: `YANGO_FLEET_PARK_ID_MIAUTO` (.env) → `park_id` del conductor en BD → fallback genérico `YANGO_FLEET_PARK_ID`.
 * En producción Yego Mi Auto conviene fijar siempre `YANGO_FLEET_PARK_ID_MIAUTO` al UUID del parque **Yego Mi Auto**
 * para no mezclar con otro parque por defecto.
 */
export function fleetParkIdForMiAuto(parkIdFromDb) {
  const m = trimCookie(process.env.YANGO_FLEET_PARK_ID_MIAUTO);
  if (m) return m;
  const fromDb = parkIdFromDb && String(parkIdFromDb).trim();
  if (fromDb) return fromDb;
  return fleetParkId();
}

/**
 * Cookie de sesión Flota para Mi Auto (misma flota que `YANGO_FLEET_PARK_ID_MIAUTO`).
 * Prioridad: override explícito → `YANGO_FLEET_COOKIE_COBRO_MIAUTO` → `YANGO_FLEET_COOKIE_COBRO` → `YANGO_FLEET_COOKIE`.
 */
export function fleetCookieCobroForMiAuto(cookieOverride) {
  if (cookieOverride && String(cookieOverride).trim()) return String(cookieOverride).trim();
  const m = trimCookie(process.env.YANGO_FLEET_COOKIE_COBRO_MIAUTO);
  if (m) return m;
  return fleetCookieCobro();
}

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
 * POST con reintento ante 429. Cada intento usa el siguiente proxy si hay lista (getNextProxyConfig).
 */
async function postWithProxyRetry(url, body, headers) {
  await loadProxiesFromUrlIfConfigured();
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
/**
 * @param {string} id - driver_profile_id
 * @param {string|number} amount
 * @param {string} description
 * @param {string|null} cookieOverride
 * @param {string|null} parkIdOverride
 * @param {{ balance_min?: string }} [conditionOverride] - sobreescribe la condición de saldo mínimo tras el retiro
 *   Por defecto `{ balance_min: '2' }`. Pasar `{ balance_min: '0' }` para permitir retiro hasta saldo cero.
 */
export async function withdrawFromContractor(id, amount, description, cookieOverride, parkIdOverride, conditionOverride) {
  const xIdempotencyToken = crypto.randomUUID();
  const condition = conditionOverride ?? { balance_min: '2' };
  const body = {
    driver_profile_id: id,
    category_id: 'partner_service_manual',
    amount: String(amount),
    description: description || '',
    fee: { percent: '1' },
    condition,
  };
  const headers = {
    'Accept-Language': 'es-ES,es',
    'Cookie': (cookieOverride && String(cookieOverride).trim()) ? String(cookieOverride).trim() : fleetCookieCobro(),
    'X-Park-Id': (parkIdOverride && String(parkIdOverride).trim()) ? String(parkIdOverride).trim() : fleetParkId(),
    'X-Idempotency-Token': xIdempotencyToken,
    'Content-Type': 'text/plain'
  };
  try {
    const response = await postWithProxyRetry(`${fleetBaseUrl()}/api/v1/quickbar/transaction/withdraw`, body, headers);
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
    'Cookie': (cookieOverride && String(cookieOverride).trim()) ? String(cookieOverride).trim() : fleetCookiePagar(),
    'X-Park-Id': (parkIdOverride && String(parkIdOverride).trim()) ? String(parkIdOverride).trim() : fleetParkId(),
    'X-Idempotency-Token': xIdempotencyToken,
    'Content-Type': 'text/plain'
  };
  try {
    const response = await postWithProxyRetry(`${fleetBaseUrl()}/api/v1/quickbar/transaction/add`, body, headers);
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
  const url = `${fleetBaseUrl()}/api/fleet/contractor-profiles-manager/v1/contractor-balances/by-pro-id?contractor_profile_id=${encodeURIComponent(id)}`;
  const headers = {
    'Accept-Language': 'es-ES,es',
    'Cookie': (cookieOverride && String(cookieOverride).trim()) ? String(cookieOverride).trim() : fleetCookieCobro(),
    'X-Park-Id': (parkId && String(parkId).trim()) ? String(parkId).trim() : fleetParkId(),
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
 * Tributo Yango usado en Mi Auto para el 83,33% sobre `partner_fees_raw`.
 * En PE/CO el importe de `balances.partner_fees` viene en **moneda local** (PEN/COP); si la cuota del cronograma
 * está en USD, `ensureCuotaSemanalForWeek` lo pasa a USD con el tipo de cambio de la solicitud antes de restarlo.
 * Por defecto: solo **`balances.partner_fees`** en magnitud positiva (`|…|`). Los viajes vienen de
 * **`orders.count_completed`** (aparte). `balances.platform_fees` es otra línea; opcionalmente se puede
 * sumar con modo `platform_plus_partner`.
 *
 * Modo env `YANGO_DRIVER_INCOME_PARTNER_FEES_MODE`:
 * - `partner_line` (default): `|balances.partner_fees|`
 * - `platform_plus_partner`: `|platform_fees| + |partner_fees|`
 * - `price_minus_total`: `max(0, orders.price - balances.total)` si ambos existen
 * - `price_ratio`: `orders.price * YANGO_DRIVER_INCOME_PARTNER_FEES_PRICE_RATIO`
 */
function extractPartnerFeesTributoFromIncomeData(data) {
  const mode = String(process.env.YANGO_DRIVER_INCOME_PARTNER_FEES_MODE || 'partner_line').trim();
  const b = data?.balances || {};
  const o = data?.orders || {};
  const pf = parseFloat(b.partner_fees);
  const plat = parseFloat(b.platform_fees);
  const price = parseFloat(o.price);
  const total = parseFloat(b.total);

  if (mode === 'price_minus_total') {
    if (Number.isFinite(price) && Number.isFinite(total)) return round2(Math.max(0, price - total));
    return 0;
  }
  if (mode === 'price_ratio') {
    const ratio = parseFloat(process.env.YANGO_DRIVER_INCOME_PARTNER_FEES_PRICE_RATIO || '');
    if (Number.isFinite(price) && Number.isFinite(ratio) && ratio > 0) return round2(price * ratio);
    return 0;
  }
  if (mode === 'platform_plus_partner') {
    const a = Number.isFinite(plat) ? Math.abs(plat) : 0;
    const c = Number.isFinite(pf) ? Math.abs(pf) : 0;
    return round2(a + c);
  }
  return round2(Number.isFinite(pf) ? Math.abs(pf) : 0);
}

/**
 * Driver income (Mi Auto): viajes e ingresos por rango de fechas.
 * POST driver/income; base URL desde env `YANGO_FLEET_BASE_URL`.
 * `X-Park-Id` y cookie salen de {@link fleetParkIdForMiAuto} / {@link fleetCookieCobroForMiAuto} — deben ser la flota **Yego Mi Auto**.
 * dateFrom/dateTo: ISO -05:00. Mi Auto: `limaWeekStartToMiAutoIncomeRange(week_start cuota)` en utils/miautoLimaWeekRange.js.
 */
export async function getDriverIncome(dateFrom, dateTo, driverId, parkId = null, cookieOverride = null) {
  const id = String(driverId || '').trim();
  if (!id) return { success: false, error: 'driver_id vacío' };
  const url = `${fleetBaseUrl()}/api/v1/cards/driver/income`;
  const body = {
    date_from: dateFrom || '',
    date_to: dateTo || '',
    driver_id: id
  };
  const resolvedPark = fleetParkIdForMiAuto(parkId);
  const resolvedCookie = fleetCookieCobroForMiAuto(cookieOverride);
  const headers = {
    'Accept-Language': 'es-ES,es',
    Cookie: resolvedCookie,
    'X-Park-Id': resolvedPark,
    'Content-Type': 'application/json'
  };
  const logIncome = process.env.YANGO_LOG_DRIVER_INCOME !== '0';
  if (logIncome) {
    logger.info(
      `[Yango driver/income] POST body: date_from=${body.date_from} date_to=${body.date_to} driver_id=${id} X-Park-Id=${resolvedPark} (Mi Auto env si aplica)`
    );
  }
  try {
    const res = await postWithProxyRetry(url, body, headers);
    const countCompleted = res.data?.orders?.count_completed != null ? Number(res.data.orders.count_completed) : 0;
    const partnerFeesLine = res.data?.balances?.partner_fees != null ? parseFloat(res.data.balances.partner_fees) : 0;
    const platformFeesLine = res.data?.balances?.platform_fees != null ? parseFloat(res.data.balances.platform_fees) : 0;
    const partnerFeesTributo = extractPartnerFeesTributoFromIncomeData(res.data);
    if (logIncome) {
      logger.info(
        `[Yango driver/income] response: count_completed=${countCompleted} platform_fees=${Number.isFinite(platformFeesLine) ? platformFeesLine : 0} partner_fees_line=${Number.isFinite(partnerFeesLine) ? partnerFeesLine : 0} tributo_mi_auto=${partnerFeesTributo} (mode=${String(process.env.YANGO_DRIVER_INCOME_PARTNER_FEES_MODE || 'partner_line')})`
      );
    }
    return {
      success: true,
      count_completed: countCompleted,
      /** Tributo positivo para Mi Auto (83,33% en `miautoCuotaSemanalService`); por defecto `|balances.partner_fees|`. */
      partner_fees: partnerFeesTributo,
      partner_fees_line: Number.isFinite(partnerFeesLine) ? partnerFeesLine : 0,
      platform_fees_line: Number.isFinite(platformFeesLine) ? platformFeesLine : 0,
      request: {
        date_from: body.date_from,
        date_to: body.date_to,
        driver_id: id,
        park_id: resolvedPark,
      },
      raw: res.data
    };
  } catch (error) {
    if (error.response) {
      return { success: false, error: error.response.status === 403 ? '403 cookie expirada' : `Error ${error.response.status}`, message: error.response.data?.message || error.response.data };
    }
    return { success: false, error: error.message };
  }
}
