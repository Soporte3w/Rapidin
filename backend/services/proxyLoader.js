/**
 * Carga proxies para la API de flota (rotación y reintento ante "Too many requests").
 *
 * Opción A - URL (Webshare u otra): descarga al arrancar y guarda en config/proxies.txt.
 *   Variable: YANGO_PROXIES_URL
 *   Formato típico Webshare: una línea por proxy = host:puerto:usuario:contraseña
 *
 * Opción B - Archivo local: YANGO_PROXIES_FILE o backend/config/proxies.txt
 *   Formatos válidos por línea:
 *     host:puerto
 *     host:puerto:usuario:contraseña   (Webshare)
 *     http://usuario:contraseña@host:puerto
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROXIES_FILE = path.join(__dirname, '..', 'config', 'proxies.txt');

let proxyList = [];
let proxyIndex = 0;
let loadAttempted = false;

/** Parsea una línea en formato Webshare: host:port:username:password */
function parseWebshareLine(line) {
  const s = (line || '').trim();
  if (!s || s.startsWith('#')) return null;
  const parts = s.split(':');
  if (parts.length >= 4) {
    const port = parseInt(parts[1], 10);
    if (!Number.isFinite(port)) return null;
    return {
      protocol: 'http',
      host: parts[0],
      port,
      auth: { username: parts[2], password: parts.slice(3).join(':') }
    };
  }
  return null;
}

/** Parsea URL estilo http://user:pass@host:port o host:port */
function parseUrlLine(line) {
  const s = (line || '').trim();
  if (!s || s.startsWith('#')) return null;
  let url = s;
  if (!url.includes('://')) url = 'http://' + url;
  try {
    const u = new URL(url);
    const proxy = {
      protocol: (u.protocol || 'http:').replace(':', ''),
      host: u.hostname,
      port: parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80)
    };
    if (u.username || u.password) {
      proxy.auth = { username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') };
    }
    return proxy;
  } catch {
    return null;
  }
}

function parseProxyLine(line) {
  const s = (line || '').trim();
  if (!s || s.startsWith('#')) return null;
  const parts = s.split(':');
  if (parts.length >= 4) return parseWebshareLine(s);
  return parseUrlLine(s);
}

function loadFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split(/\r?\n/).map(parseProxyLine).filter(Boolean);
  } catch {
    return [];
  }
}

async function downloadProxiesFromUrl(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const text = await res.text();
    const list = text.split(/\r?\n/).map(parseProxyLine).filter(Boolean);
    const filePath = process.env.YANGO_PROXIES_FILE ? path.resolve(process.env.YANGO_PROXIES_FILE) : DEFAULT_PROXIES_FILE;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, text, 'utf8');
    } catch {
      // ignore write errors
    }
    return list;
  } catch (err) {
    console.warn('ProxyLoader: error descargando lista de proxies:', err.message);
    return [];
  }
}

function loadProxiesSync() {
  const filePath = process.env.YANGO_PROXIES_FILE ? path.resolve(process.env.YANGO_PROXIES_FILE) : DEFAULT_PROXIES_FILE;
  return loadFromFile(filePath);
}

async function ensureProxiesLoaded() {
  if (proxyList.length > 0) return true;
  if (loadAttempted) return false;
  loadAttempted = true;

  const url = (process.env.YANGO_PROXIES_URL || '').trim();
  if (url) {
    proxyList = await downloadProxiesFromUrl(url);
    if (proxyList.length > 0) return true;
  }

  proxyList = loadProxiesSync();
  return proxyList.length > 0;
}

/**
 * Carga proxies (primero YANGO_PROXIES_URL si está definida; si falla o viene vacía, archivo local).
 * Debe llamarse al arrancar el backend (await) para que la URL no quede anulada por una carrera.
 */
export async function loadProxiesFromUrlIfConfigured() {
  return ensureProxiesLoaded();
}

/**
 * Devuelve la config de axios para el siguiente proxy (rotación).
 * La lista se rellena con loadProxiesFromUrlIfConfigured (p. ej. al primer POST Fleet en yangoService).
 */
export function getNextProxyConfig() {
  if (proxyList.length === 0) return {};
  const p = proxyList[proxyIndex % proxyList.length];
  proxyIndex += 1;
  return { proxy: p };
}

/** Número de proxies en memoria (tras loadProxiesFromUrlIfConfigured). */
export function getProxyCount() {
  return proxyList.length;
}

export function hasProxies() {
  return getProxyCount() > 0;
}
