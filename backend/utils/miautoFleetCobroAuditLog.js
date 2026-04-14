/**
 * Auditoría de cobros Fleet → cuota Mi Auto: un JSON por línea (JSONL) para trazabilidad y posibles devoluciones.
 * Archivo: `backend/logs/miauto-fleet-cobros.jsonl` (carpeta `logs/` suele estar en .gitignore).
 * Desactivar: `MIAUTO_FLEET_COBRO_AUDIT_LOG=0`.
 */
import { mkdir, appendFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mondayOfWeekContainingYmd } from './miautoLimaWeekRange.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', 'logs');
const LOG_FILE = join(LOG_DIR, 'miauto-fleet-cobros.jsonl');

async function writeAuditJsonlLine(record) {
  const line = `${JSON.stringify(record)}\n`;
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(LOG_FILE, line, 'utf8');
}

function diffDaysYmdUtc(a, b) {
  const [ya, ma, da] = String(a).slice(0, 10).split('-').map(Number);
  const [yb, mb, db] = String(b).slice(0, 10).split('-').map(Number);
  const ta = Date.UTC(ya, ma - 1, da);
  const tb = Date.UTC(yb, mb - 1, db);
  return Math.round((tb - ta) / (24 * 60 * 60 * 1000));
}

/** Número de semana del plan (1 = semana depósito / inicio cobro). */
export function semanaOrdinalCuotaMiAuto(weekStartYmd, fechaInicioCobroSemanal) {
  if (!weekStartYmd || !fechaInicioCobroSemanal) return null;
  const ws = String(weekStartYmd).trim().slice(0, 10);
  const fi = String(fechaInicioCobroSemanal).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws) || !/^\d{4}-\d{2}-\d{2}$/.test(fi)) return null;
  try {
    const mWs = mondayOfWeekContainingYmd(ws);
    const mFi = mondayOfWeekContainingYmd(fi);
    const d = diffDaysYmdUtc(mFi, mWs);
    if (d < 0) return null;
    return Math.floor(d / 7) + 1;
  } catch {
    return null;
  }
}

function ymdFromDb(v) {
  if (v == null) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * @param {object} p
 * @param {number} p.monto_retiro_fleet_local
 * @param {string} p.moneda_fleet_local
 * @param {number} p.monto_acreditado_cuota
 * @param {string} p.moneda_cuota
 * @param {number} p.paid_amount_antes
 * @param {number} p.paid_amount_despues
 * @param {number} p.pending_total_antes
 * @param {boolean} p.partial
 * @param {object} [p.cuotaRow]
 * @param {object} [p.fleet_withdraw_response] — respuesta API Yango (sin cookies)
 */
export async function appendMiautoFleetCobroAuditLog(p) {
  if (process.env.MIAUTO_FLEET_COBRO_AUDIT_LOG === '0') return;
  const cuotaRow = p.cuotaRow || {};
  const ws = ymdFromDb(cuotaRow.week_start_date);
  const fi = ymdFromDb(cuotaRow.fecha_inicio_cobro_semanal);
  const record = {
    ts: new Date().toISOString(),
    tipo: 'fleet_withdraw_mi_auto',
    solicitud_id: cuotaRow.solicitud_id != null ? String(cuotaRow.solicitud_id) : null,
    cuota_semanal_id: cuotaRow.id != null ? String(cuotaRow.id) : null,
    rapidin_driver_id: cuotaRow.driver_id != null ? String(cuotaRow.driver_id) : null,
    external_driver_id_yango:
      cuotaRow.external_driver_id != null ? String(cuotaRow.external_driver_id).trim() : null,
    park_id: cuotaRow.park_id != null ? String(cuotaRow.park_id).trim() : null,
    country: cuotaRow.country != null ? String(cuotaRow.country) : null,
    conductor_nombre: [cuotaRow.first_name, cuotaRow.last_name].filter(Boolean).join(' ').trim() || null,
    week_start_date: ws,
    due_date: ymdFromDb(cuotaRow.due_date),
    semana_ordinal: semanaOrdinalCuotaMiAuto(ws, fi),
    monto_retiro_fleet_local: p.monto_retiro_fleet_local,
    moneda_fleet_local: p.moneda_fleet_local,
    monto_acreditado_cuota: p.monto_acreditado_cuota,
    moneda_cuota: p.moneda_cuota,
    paid_amount_antes: p.paid_amount_antes,
    paid_amount_despues: p.paid_amount_despues,
    pending_total_antes: p.pending_total_antes,
    cobro_parcial: !!p.partial,
    fleet_api_response: sanitizeFleetResponse(p.fleet_withdraw_response),
  };
  try {
    await writeAuditJsonlLine(record);
  } catch (e) {
    logger.warn(
      { err: e?.message || String(e), path: LOG_FILE },
      'Mi Auto: no se pudo escribir auditoría de cobro Fleet (no afecta el cobro)'
    );
  }
}

/**
 * Eventos de **arranque / fin / error** del job de cobro (mismo JSONL que los retiros).
 * `tipo`: `cobro_job_inicio` | `cobro_job_fin` | `cobro_job_error`
 * `job`: `lunes_7_10_lima` | `solo_solicitud` | `weekly_charge_solicitud`
 */
export async function appendMiautoFleetCobroJobAuditEvent(fields) {
  if (process.env.MIAUTO_FLEET_COBRO_AUDIT_LOG === '0') return;
  const record = { ts: new Date().toISOString(), ...fields };
  try {
    await writeAuditJsonlLine(record);
  } catch (e) {
    logger.warn(
      { err: e?.message || String(e), path: LOG_FILE },
      'Mi Auto: no se pudo escribir auditoría de job cobro Fleet'
    );
  }
}

function sanitizeFleetResponse(data) {
  if (data == null) return null;
  try {
    const s = JSON.parse(JSON.stringify(data));
    return s;
  } catch {
    return { _raw: String(data).slice(0, 500) };
  }
}

export function getMiautoFleetCobroAuditLogPath() {
  return LOG_FILE;
}
