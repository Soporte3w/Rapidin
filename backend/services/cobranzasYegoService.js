/**
 * Servicio de cobros masivos — Cobranzas YEGO
 *
 * Flujo:
 *   1. Cliente parsea Excel y envía filas.
 *   2. POST /process → consulta saldo Fleet y retira por driver_id directo. Sin Rapidín.
 */

import { query } from '../config/database.js';
import { withdrawFromContractor, getContractorBalance } from './yangoService.js';
import { logger } from '../utils/logger.js';

const YEGO_LIMA_PARK_ID = '08e20910d81d42658d4334d3f6d10ac0';

/**
 * Cookie de sesión Fleet para Cobranzas YEGO.
 * Prioridad: YANGO_FLEET_COOKIE_COBRO_YEGO → YANGO_FLEET_COOKIE_COBRO → YANGO_FLEET_COOKIE
 */
function yegoCobroCookie() {
  const v = (k) => (process.env[k] || '').replace(/^["']|["']$/g, '').trim();
  return v('YANGO_FLEET_COOKIE_COBRO_YEGO') || v('YANGO_FLEET_COOKIE_COBRO') || v('YANGO_FLEET_COOKIE') || null;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const DRIVER_ID_RE = /^[0-9a-f]{32}$/i;

const round2 = (n) => Math.round(n * 100) / 100;

const normalizeDriverId = (raw) =>
  String(raw ?? '').trim().toLowerCase().replace(/-/g, '');

// ── Log ───────────────────────────────────────────────────────────────────────

async function writeLog(batchId, fields) {
  try {
    await query(
      `INSERT INTO module_rapidin_cobranzas_yego_log
         (batch_id, external_driver_id, conductor, sheet_name, row_in_sheet,
          amount, amount_charged, payment_date, balance_fleet,
          status, error_detail, observations, registered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        batchId,
        fields.external_driver_id ?? null,
        fields.conductor ?? null,
        fields.sheet_name ?? null,
        fields.row_in_sheet ?? null,
        fields.amount ?? null,
        fields.amount_charged ?? null,
        fields.payment_date ?? null,
        fields.balance_fleet ?? null,
        fields.status,
        fields.error_detail ?? null,
        fields.observations ?? null,
        fields.registered_by ?? null,
      ]
    );
  } catch (err) {
    logger.warn(`Cobranzas YEGO writeLog: ${err.message}`);
  }
}

// ── Consultas ─────────────────────────────────────────────────────────────────

export const getCobranzasBatchLog = async (batchId) => {
  const r = await query(
    `SELECT * FROM module_rapidin_cobranzas_yego_log
     WHERE batch_id = $1::uuid
     ORDER BY sheet_name, row_in_sheet NULLS LAST, created_at`,
    [batchId]
  );
  return r.rows;
};

export const getCobranzasHistory = async ({ limit = 10, offset = 0 } = {}) => {
  const { rows: [{ total }] } = await query(
    `SELECT COUNT(DISTINCT batch_id)::int AS total FROM module_rapidin_cobranzas_yego_log`
  );
  const { rows } = await query(
    `SELECT
       batch_id,
       MIN(created_at)                                              AS created_at,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT sheet_name), NULL)          AS sheet_names,
       COUNT(*)::int                                                AS total,
       COUNT(*) FILTER (WHERE status IN ('cobrado','cobrado_parcial'))::int AS ok,
       COUNT(*) FILTER (WHERE status NOT IN ('cobrado','cobrado_parcial'))::int AS fail,
       COALESCE(SUM(amount_charged) FILTER (WHERE status IN ('cobrado','cobrado_parcial')), 0) AS total_charged
     FROM module_rapidin_cobranzas_yego_log
     GROUP BY batch_id
     ORDER BY MIN(created_at) DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return { rows, total };
};

// ── Proceso de cobro ──────────────────────────────────────────────────────────

/**
 * Cobra masivamente desde Excel Cobranzas YEGO.
 * Por cada fila: consulta saldo Fleet → retira por driver_id → guarda log.
 * Sin ninguna consulta a Rapidín.
 *
 * @param {Array} rows
 * @param {string|null} userId
 * @param {{ maxItems?: number, description?: string, parkId?: string }} [options]
 */
export const processCobranzas = async (rows, userId, options = {}) => {
  const maxItems = Math.min(800, Math.max(1, options.maxItems ?? 500));
  const description = options.description || 'Cobranza Yego';
  const parkId = options.parkId || YEGO_LIMA_PARK_ID;
  const cookie = options.cookie || yegoCobroCookie();
  // balance_min: '0' → Fleet descuenta hasta saldo 0, sin retener mínimo
  const WITHDRAW_CONDITION = { balance_min: '0' };
  const data = Array.isArray(rows) ? rows.slice(0, maxItems) : [];
  const results = [];
  let ok = 0;
  let fail = 0;

  const cookieLabel = cookie ? `...${cookie.slice(-20)}` : '(ninguna)';
  logger.info(`Cobranzas YEGO: iniciando batch — parkId=${parkId} cookie_suffix=${cookieLabel} filas=${data.length}`);

  const { rows: [{ id: batchId }] } = await query('SELECT gen_random_uuid() AS id');

  for (let i = 0; i < data.length; i++) {
    const raw = data[i] ?? {};
    const external_driver_id = normalizeDriverId(raw.external_driver_id);
    const amount = raw.amount != null ? round2(Number(raw.amount)) : NaN;
    const payment_date = String(raw.payment_date ?? '').trim().slice(0, 10);
    const observations = raw.observations ? String(raw.observations).trim().slice(0, 2000) : null;
    const conductor = raw.conductor ?? null;
    const sheet_name = raw.sheet_name ?? null;
    const row_in_sheet = raw.row_in_sheet ?? null;

    const logBase = { external_driver_id, conductor, sheet_name, row_in_sheet, amount, payment_date, observations, registered_by: userId };

    // ── Validación ───────────────────────────────────────────────────────
    if (!external_driver_id || !DRIVER_ID_RE.test(external_driver_id)) {
      const error = 'external_driver_id inválido';
      results.push({ index: i, ok: false, external_driver_id: raw.external_driver_id, conductor, error, status: 'dato_invalido' });
      await writeLog(batchId, { ...logBase, external_driver_id: raw.external_driver_id, status: 'dato_invalido', error_detail: error });
      fail++; continue;
    }
    if (!YMD_RE.test(payment_date)) {
      const error = 'Fecha inválida (YYYY-MM-DD)';
      results.push({ index: i, ok: false, external_driver_id, conductor, error, status: 'dato_invalido' });
      await writeLog(batchId, { ...logBase, status: 'dato_invalido', error_detail: error });
      fail++; continue;
    }
    if (!Number.isFinite(amount) || amount < 0.01) {
      const error = 'Monto inválido (mínimo 0.01)';
      results.push({ index: i, ok: false, external_driver_id, conductor, error, status: 'dato_invalido' });
      await writeLog(batchId, { ...logBase, amount: raw.amount, status: 'dato_invalido', error_detail: error });
      fail++; continue;
    }

    // ── Saldo Fleet ──────────────────────────────────────────────────────
    const balanceResult = await getContractorBalance(external_driver_id, parkId, cookie);
    if (!balanceResult.success) {
      const error = `Error al consultar saldo Fleet: ${balanceResult.error}`;
      logger.warn(`Cobranzas YEGO: ${error} (${external_driver_id})`);
      results.push({ index: i, ok: false, external_driver_id, conductor, error, status: 'error_fleet' });
      await writeLog(batchId, { ...logBase, status: 'error_fleet', error_detail: error });
      fail++; continue;
    }

    const balance = round2(Math.max(0, Number(balanceResult.balance) || 0));

    // Si no tiene nada que cobrar, registrar como saldo_insuficiente y seguir
    if (balance <= 0) {
      const error = `Sin saldo disponible (saldo: 0.00, a cobrar: ${amount.toFixed(2)})`;
      results.push({ index: i, ok: false, external_driver_id, conductor, balance_fleet: 0, error, status: 'saldo_insuficiente' });
      await writeLog(batchId, { ...logBase, balance_fleet: 0, status: 'saldo_insuficiente', error_detail: error });
      fail++; continue;
    }

    // Cobro parcial: si tiene menos de lo solicitado, cobra lo que tiene
    const amountToCharge = balance < amount ? balance : amount;
    const isParcial = amountToCharge < amount;

    // ── Retiro Fleet ─────────────────────────────────────────────────────
    const withdraw = await withdrawFromContractor(external_driver_id, amountToCharge.toFixed(2), description, cookie, parkId, WITHDRAW_CONDITION);
    if (!withdraw.success) {
      const error = `Error Fleet: ${withdraw.message || 'sin detalle'}`;
      logger.error(`Cobranzas YEGO: ${error} (${external_driver_id})`);
      results.push({ index: i, ok: false, external_driver_id, conductor, balance_fleet: balance, error, status: 'error_fleet' });
      await writeLog(batchId, { ...logBase, balance_fleet: balance, status: 'error_fleet', error_detail: error });
      fail++; continue;
    }

    // ── Éxito (total o parcial) ───────────────────────────────────────────
    const status = isParcial ? 'cobrado_parcial' : 'cobrado';
    const errorDetail = isParcial ? `Cobro parcial: solicitado ${amount.toFixed(2)}, cobrado ${amountToCharge.toFixed(2)}` : null;
    results.push({ index: i, ok: true, external_driver_id, conductor, balance_fleet: balance, amount_charged: amountToCharge, status });
    await writeLog(batchId, { ...logBase, amount_charged: amountToCharge, balance_fleet: balance, status, error_detail: errorDetail });
    ok++;
    logger.info(`Cobranzas YEGO: ${status} ${external_driver_id} S/ ${amountToCharge.toFixed(2)}${isParcial ? ` (parcial de ${amount.toFixed(2)})` : ''}`);
  }

  return { batch_id: batchId, results, summary: { total: data.length, ok, fail } };
};
