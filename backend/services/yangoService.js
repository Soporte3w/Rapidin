import crypto from 'crypto';
import axios from 'axios';
import { getNextProxyConfig, hasProxies, loadProxiesFromUrlIfConfigured } from './proxyLoader.js';
import { logger } from '../utils/logger.js';
import { round2 } from '../yego_miauto/services/utils/miautoMoneyUtils.js';

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
const SUPPLY_SUMMARY_CACHE_TTL_MS = 2 * 60 * 1000;
const SUPPLY_HEATMAP_CACHE_TTL_MS = 5 * 60 * 1000;
const SUPPLY_SUMMARY_PAGE_SIZE = 50;
const MAX_SUPPLY_SUMMARY_PAGES = 100;
const SUPPLY_HEATMAP_CONCURRENCY = 2;
const MIAUTO_SUPPLY_DEFAULT_WORK_RULE_ID = String(
  process.env.MIAUTO_SUPPLY_DEFAULT_WORK_RULE_ID || '0e935ec639324568a0f5ac66583f8bfe'
).trim();
const miAutoSupplySummaryCache = new Map();
const miAutoSupplyHeatmapCache = new Map();

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

/** Cookie de Fleet caducada, revocada o de otro contexto → Yango suele responder 401/403. */
function fleetSessionRejectedMessage(status, rawSnippet) {
  const base =
    status === 401 || status === 403
      ? `Sesión Yango Fleet no válida (${status}). Renueva en el servidor la cookie (p. ej. YANGO_FLEET_COOKIE_COBRO_YEGO o YANGO_FLEET_COOKIE_COBRO) copiándola desde el navegador con sesión abierta en Fleet y el parque correcto (X-Park-Id).`
      : null;
  if (!base) return null;
  const extra = rawSnippet ? ` Detalle API: ${String(rawSnippet).slice(0, 280)}` : '';
  return base + extra;
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
      const st = error.response.status;
      const raw = normalizeApiMessage(error.response.data) || error.message;
      const hint = fleetSessionRejectedMessage(st, raw);
      return { success: false, status: st, message: hint || raw };
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
      const st = error.response.status;
      const raw = normalizeApiMessage(error.response.data) || error.message;
      const hint = fleetSessionRejectedMessage(st, raw);
      return { success: false, status: st, message: hint || raw };
    }
    return { success: false, message: error.message };
  }
}

/** Consulta saldo del conductor (Mi Auto). Usa cookie y parque de Mi Auto. cookieOverride opcional. */
export async function getContractorBalance(contractorProfileId, parkId = null, cookieOverride = null) {
  const id = String(contractorProfileId || '').trim();
  if (!id) return { success: false, error: 'external_driver_id vacío' };
  const url = `${fleetBaseUrl()}/api/fleet/contractor-profiles-manager/v1/contractor-balances/by-pro-id?contractor_profile_id=${encodeURIComponent(id)}`;
  const resolvedPark = fleetParkIdForMiAuto(parkId);
  const resolvedCookie = fleetCookieCobroForMiAuto(cookieOverride);
  const headers = {
    'Accept-Language': 'es-ES,es',
    'Cookie': resolvedCookie,
    'X-Park-Id': resolvedPark,
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
    if (error.response) {
      const st = error.response.status;
      const raw = normalizeApiMessage(error.response.data);
      const hint = fleetSessionRejectedMessage(st, raw);
      if (hint) return { success: false, error: hint };
      return { success: false, error: `Error ${st}` };
    }
    return { success: false, error: error.message };
  }
}

/** Consulta saldo del conductor para Rapidin: usa parque del conductor (fallback YANGO_FLEET_PARK_ID) y cookie general de cobro (YANGO_FLEET_COOKIE_COBRO). Sin dependencia de Mi Auto. */
export async function getContractorBalanceForRapidin(contractorProfileId, parkId = null, cookieOverride = null) {
  const id = String(contractorProfileId || '').trim();
  if (!id) return { success: false, error: 'external_driver_id vacío' };
  const url = `${fleetBaseUrl()}/api/fleet/contractor-profiles-manager/v1/contractor-balances/by-pro-id?contractor_profile_id=${encodeURIComponent(id)}`;
  const resolvedPark = parkId && String(parkId).trim() ? String(parkId).trim() : fleetParkId();
  const resolvedCookie = cookieOverride && String(cookieOverride).trim() ? String(cookieOverride).trim() : fleetCookieCobro();
  const headers = {
    'Accept-Language': 'es-ES,es',
    'Cookie': resolvedCookie,
    'X-Park-Id': resolvedPark,
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
    if (error.response) {
      const st = error.response.status;
      const raw = normalizeApiMessage(error.response.data);
      const hint = fleetSessionRejectedMessage(st, raw);
      if (hint) return { success: false, error: hint };
      return { success: false, error: `Error ${st}` };
    }
    return { success: false, error: error.message };
  }
}

/**
 * Cuerpo útil del JSON de `driver/income` (a veces envuelto en `payload` / `data` / `result`).
 */
function incomeApiBody(payload) {
  if (!payload || typeof payload !== 'object') return payload || {};
  for (const k of ['payload', 'data', 'result']) {
    const inner = payload[k];
    if (inner && typeof inner === 'object' && (inner.orders !== undefined || inner.balances !== undefined))
      return inner;
  }
  return payload;
}

function parseIncomeTripNumber(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(String(v).replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * Viajes completados en el rango. Por defecto `orders.count_completed`; alternativas camelCase / raíz / env.
 * Opcional `YANGO_DRIVER_INCOME_TRIPS_JSON_PATH=dotted.path.to.field` si el Fleet devuelve otra forma.
 */
function extractTripCountFromIncomeRoot(root) {
  const data = root && typeof root === 'object' ? root : {};
  const customPath = String(process.env.YANGO_DRIVER_INCOME_TRIPS_JSON_PATH || '').trim();
  if (customPath) {
    const parts = customPath.split('.').filter(Boolean);
    let cur = data;
    for (const p of parts) {
      cur = cur?.[p];
      if (cur === undefined) break;
    }
    const n = parseIncomeTripNumber(cur);
    if (n != null) return n;
  }
  const orders = data.orders || {};
  const seq = [
    orders.count_completed,
    orders.countCompleted,
    orders.completed_count,
    orders.completedCount,
    orders.total_completed,
    orders.totalCompleted,
    data.count_completed,
    data.countCompleted,
    data.orders_count,
    data.ordersCount,
  ];
  for (const v of seq) {
    const n = parseIncomeTripNumber(v);
    if (n != null) return n;
  }
  return 0;
}

/**
 * Tributo Yango usado en Mi Auto para el 83,33% sobre `partner_fees_raw`.
 * En PE/CO el importe de `balances.partner_fees` viene en **moneda local** (PEN/COP); si la cuota del cronograma
 * está en USD, la generación Mi Auto lo pasa a USD con el tipo de cambio de la solicitud antes de restarlo.
 * Por defecto: solo **`balances.partner_fees`** en magnitud positiva (`|…|`). Los viajes vienen de
 * **`orders.count_completed`** (u homólogos; ver `extractTripCountFromIncomeRoot`). `balances.platform_fees` es otra línea; opcionalmente se puede
 * sumar con modo `platform_plus_partner`.
 *
 * Modo env `YANGO_DRIVER_INCOME_PARTNER_FEES_MODE`:
 * - `partner_line` (default): `|balances.partner_fees|`
 * - `platform_plus_partner`: `|platform_fees| + |partner_fees|`
 * - `price_minus_total`: `max(0, orders.price - balances.total)` si ambos existen
 * - `price_ratio`: `orders.price * YANGO_DRIVER_INCOME_PARTNER_FEES_PRICE_RATIO`
 */
function extractPartnerFeesTributoFromIncomeData(payload) {
  const data = incomeApiBody(payload);
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
 * Opcional env `YANGO_DRIVER_INCOME_TRIPS_JSON_PATH`: ruta punteada al campo numérico de viajes si la API cambia la forma del JSON.
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
    const root = incomeApiBody(res.data);
    const countCompleted = extractTripCountFromIncomeRoot(root);
    const partnerFeesLine =
      root?.balances?.partner_fees != null ? parseFloat(root.balances.partner_fees) : 0;
    const platformFeesLine =
      root?.balances?.platform_fees != null ? parseFloat(root.balances.platform_fees) : 0;
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
    return { success: false, error: error.response ? `Error ${error.response.status}` : error.message };
  }
}

function normalizeSupplyDriver(item) {
  const driver = item?.driver || {};
  const cars = Array.isArray(item?.cars) ? item.cars : [];
  const firstCar = cars[0] || {};
  const name = [driver.first_name, driver.last_name].filter(Boolean).join(' ').trim() || 'Sin nombre';

  return {
    driver_id: String(driver.id || ''),
    name,
    license_number: driver.license_number || null,
    plate: item?.car?.callsign || firstCar.number || null,
    completed_trips: Math.max(0, Number(item?.count_orders_completed) || 0),
    supply_hours: round2(Math.max(0, Number(item?.work_time_seconds) || 0) / 3600),
  };
}

async function fetchSupplyDrivers({ endpoint, requestedPeriod, headers }) {
  const driversById = new Map();
  let firstPayload = null;
  let expectedDrivers = null;

  for (let page = 1; page <= MAX_SUPPLY_SUMMARY_PAGES; page += 1) {
    const res = await postWithProxyRetry(endpoint, {
      ...requestedPeriod,
      page,
      limit: SUPPLY_SUMMARY_PAGE_SIZE,
    }, headers);
    const payload = res.data || {};
    const pageItems = Array.isArray(payload.items) ? payload.items : [];

    if (!firstPayload) {
      firstPayload = payload;
      expectedDrivers = Number(payload.total?.count_drivers) || null;
    }

    pageItems.forEach((item) => {
      const driver = normalizeSupplyDriver(item);
      if (driver.driver_id) driversById.set(driver.driver_id, driver);
    });

    if (pageItems.length < SUPPLY_SUMMARY_PAGE_SIZE || (expectedDrivers !== null && driversById.size >= expectedDrivers)) break;
  }

  return { firstPayload, drivers: [...driversById.values()] };
}

/** Resumen Fleet de Supply por conductor para el dashboard de Yego Mi Auto. */
export async function getMiAutoSupplySummary({ dateFrom, dateTo, parkId = null, cookieOverride = null } = {}) {
  const resolvedCookie = fleetCookieCobroForMiAuto(cookieOverride);
  const resolvedPark = fleetParkIdForMiAuto(parkId);
  if (!resolvedCookie || !resolvedPark) {
    return { success: false, error: 'Falta configurar la sesión o flota Yango de Mi Auto' };
  }

  const requestedPeriod = {
    date_from: String(dateFrom || '').slice(0, 10),
    date_to: String(dateTo || '').slice(0, 10),
    work_rule_id: MIAUTO_SUPPLY_DEFAULT_WORK_RULE_ID,
    sort: { field: 'driver_id', direction: 'asc' },
  };
  const cacheKey = `${resolvedPark}:${requestedPeriod.date_from}:${requestedPeriod.date_to}:${MIAUTO_SUPPLY_DEFAULT_WORK_RULE_ID}`;
  const cached = miAutoSupplySummaryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const headers = {
    'Accept-Language': 'es-ES,es',
    Cookie: resolvedCookie,
    'X-Park-Id': resolvedPark,
    'Content-Type': 'application/json',
  };

  try {
    const endpoint = `${fleetBaseUrl()}/api/reports-api/v2/summary/drivers/list`;
    const { firstPayload, drivers } = await fetchSupplyDrivers({ endpoint, requestedPeriod, headers });
    const total = firstPayload?.total || {};
    const result = {
      success: true,
      requested_period: requestedPeriod,
      reported_period: {
        date_from: firstPayload?.date_from || requestedPeriod.date_from,
        date_to: firstPayload?.date_to || requestedPeriod.date_to,
      },
      drivers,
      totals: {
        drivers: Math.max(0, Number(total.count_drivers) || drivers.length),
        active_drivers: Math.max(0, Number(total.count_active_drivers) || 0),
        completed_trips: Math.max(0, Number(total.count_orders_completed ?? total.sum_orders_completed) || 0),
        supply_hours: round2(Math.max(0, Number(total.sum_work_time_seconds) || 0) / 3600),
      },
    };
    miAutoSupplySummaryCache.set(cacheKey, { value: result, expiresAt: Date.now() + SUPPLY_SUMMARY_CACHE_TTL_MS });
    return result;
  } catch (error) {
    const status = error.response?.status;
    const detail = normalizeApiMessage(error.response?.data) || error.message;
    logger.error('Yango Mi Auto supply summary error', { status, detail });
    return { success: false, status, error: `Fleet no pudo obtener las horas Supply${status ? ` (${status})` : ''}` };
  }
}

function listYmdDates(dateFrom, dateTo) {
  const dates = [];
  const current = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/** Supply diario por conductor, listo para una matriz de calor sin persistir datos locales. */
export async function getMiAutoSupplyHeatmap({ dateFrom, dateTo, parkId = null, cookieOverride = null } = {}) {
  const dates = listYmdDates(dateFrom, dateTo);
  const cacheKey = `${parkId || 'default'}:${dateFrom}:${dateTo}:${MIAUTO_SUPPLY_DEFAULT_WORK_RULE_ID}`;
  const cached = miAutoSupplyHeatmapCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const dailySummaries = [];
  for (let start = 0; start < dates.length; start += SUPPLY_HEATMAP_CONCURRENCY) {
    const batch = dates.slice(start, start + SUPPLY_HEATMAP_CONCURRENCY);
    const results = await Promise.all(batch.map((date) => getMiAutoSupplySummary({
      dateFrom: date,
      dateTo: date,
      parkId,
      cookieOverride,
    })));
    const failed = results.find((result) => !result.success);
    if (failed) return failed;
    dailySummaries.push(...results);
  }

  const driversById = new Map();
  dailySummaries.forEach((summary, index) => {
    const date = dates[index];
    summary.drivers.forEach((driver) => {
      if (!driversById.has(driver.driver_id)) {
        driversById.set(driver.driver_id, {
          driver_id: driver.driver_id,
          name: driver.name,
          license_number: driver.license_number,
          plate: driver.plate,
          supply_by_date: {},
        });
      }
      driversById.get(driver.driver_id).supply_by_date[date] = {
        hours: driver.supply_hours,
        trips: driver.completed_trips,
      };
    });
  });

  const drivers = [...driversById.values()]
    .map((driver) => ({
      ...driver,
      total_supply_hours: round2(Object.values(driver.supply_by_date).reduce((sum, value) => sum + value.hours, 0)),
      total_completed_trips: Object.values(driver.supply_by_date).reduce((sum, value) => sum + value.trips, 0),
    }))
    .sort((left, right) => right.total_supply_hours - left.total_supply_hours);
  const result = { success: true, dates, drivers };
  miAutoSupplyHeatmapCache.set(cacheKey, { value: result, expiresAt: Date.now() + SUPPLY_HEATMAP_CACHE_TTL_MS });
  return result;
}

/**
 * Busca un contractor en Yango Fleet por DNI, nombre o teléfono.
 * POST /api/fleet/contractor-profiles-manager/v1/suggestions/list
 */
export async function searchFleetContractor(queryText, cookieOverride = null) {
  const text = String(queryText || '').trim();
  if (!text) return { success: false, error: 'query vacío' };
  const cookie = cookieOverride || fleetCookieCobroForMiAuto();
  if (!cookie) return { success: false, error: 'cookie de Fleet no configurada' };
  const url = `${fleetBaseUrl()}/api/fleet/contractor-profiles-manager/v1/suggestions/list`;
  const body = { query: { text } };
  const headers = { 'Content-Type': 'application/json', 'Accept-Language': 'es-ES,es', Cookie: cookie, 'X-Park-Id': fleetParkIdForMiAuto() };
  try {
    const res = await axios.post(url, body, { headers, timeout: 15000 });
    const suggestions = res.data?.suggestions;
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      return { success: false, error: 'sin resultados' };
    }
    const c = suggestions[0].contractor;
    return {
      success: true,
      contractor_id: c.contractor_id,
      name: { first: c.name?.first, last: c.name?.last },
      phone: c.phone,
    };
  } catch (error) {
    return { success: false, error: error.response?.status ? `HTTP ${error.response.status}` : (error.message || 'error de red') };
  }
}

/**
 * Obtiene el perfil de un contractor desde Yango Fleet.
 * GET /api/fleet/contractor-profiles-manager/v1/contractor-profile/contractor-data
 */
/**
 * Busca contractors en Yango Fleet y retorna datos completos incluyendo vehículo.
 * POST /api/fleet/contractor-profiles-manager/v1/suggestions/list
 */
export async function searchFleetContractorFull(queryText, cookieOverride = null) {
  const text = String(queryText || '').trim();
  if (!text) return { success: false, error: 'query vacío' };
  const cookie = cookieOverride || fleetCookieCobroForMiAuto();
  if (!cookie) return { success: false, error: 'cookie de Fleet no configurada' };
  const url = `${fleetBaseUrl()}/api/fleet/contractor-profiles-manager/v1/suggestions/list`;
  const body = { query: { text } };
  const headers = { 'Content-Type': 'application/json', 'Accept-Language': 'es-ES,es', Cookie: cookie, 'X-Park-Id': fleetParkIdForMiAuto() };
  try {
    const res = await axios.post(url, body, { headers, timeout: 15000 });
    const suggestions = res.data?.suggestions;
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      return { success: true, suggestions: [] };
    }
    const list = suggestions.map((s) => ({
      contractor_id: s.contractor?.contractor_id || '',
      name: { first: s.contractor?.name?.first || '', last: s.contractor?.name?.last || '' },
      phone: s.contractor?.phone || '',
      balance: s.contractor?.balance || '0',
      vehicle: s.vehicle ? {
        brand: s.vehicle.brand || '',
        model: s.vehicle.model || '',
        year: s.vehicle.year || null,
        plate: s.vehicle.number || '',
      } : null,
    }));
    return { success: true, suggestions: list };
  } catch (error) {
    return { success: false, error: error.response?.status ? `HTTP ${error.response.status}` : (error.message || 'error de red') };
  }
}

export async function getContractorProfile(contractorId) {
  const id = String(contractorId || '').trim();
  if (!id) return { success: false, error: 'contractor_id vacío' };
  const cookie = fleetCookieCobroForMiAuto();
  if (!cookie) return { success: false, error: 'cookie de Fleet no configurada' };
  const url = `${fleetBaseUrl()}/api/fleet/contractor-profiles-manager/v1/contractor-profile/contractor-data?contractor_profile_id=${encodeURIComponent(id)}`;
  const headers = { 'Accept-Language': 'es-ES,es', Cookie: cookie, 'X-Park-Id': fleetParkIdForMiAuto() };
  try {
    const res = await axios.get(url, { headers, timeout: 15000 });
    return { success: true, license_number: res.data?.license_number || null, phone: res.data?.phone || null };
  } catch (error) {
    return { success: false, error: error.response?.status ? `HTTP ${error.response.status}` : error.message };
  }
}

export async function getDriverGoals(driverProfileId) {
  const id = String(driverProfileId || '').trim();
  if (!id) return { success: false, error: 'driver_profile_id vacío' };
  const cookie = fleetCookieCobroForMiAuto();
  if (!cookie) return { success: false, error: 'cookie de Fleet no configurada' };
  const url = `${fleetBaseUrl()}/api/fleet/v1/subvention-view/v1/goals?driver_profile_id=${encodeURIComponent(id)}`;
  const headers = { 'Accept-Language': 'es-ES,es', Cookie: cookie, 'X-Park-Id': fleetParkIdForMiAuto() };
  try {
    const res = await axios.get(url, { headers, timeout: 15000 });
    return {
      success: true,
      driver_tz: res.data?.driver_tz || null,
      active_goals: res.data?.active_goals || [],
      previous_goals: res.data?.previous_goals || [],
    };
  } catch (error) {
    return { success: false, error: error.response?.status ? `HTTP ${error.response.status}` : error.message };
  }
}
