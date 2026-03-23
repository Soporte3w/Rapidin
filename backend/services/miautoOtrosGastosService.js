/**
 * Otros gastos: 26 cuotas del saldo pendiente de la cuota inicial (pago parcial).
 * Primera cuota (semana 2 del plan): siguiente lunes tras fecha_inicio (primer lunes en o después de fecha_inicio + 1 día).
 * Siguientes 25 cuotas: lunes consecutivos (+7 cada una).
 */
import { query } from '../config/database.js';
import { getFirstMonday } from '../utils/helpers.js';
import { round2 } from './miautoMoneyUtils.js';

/** Parse YYYY-MM-DD como mediodía local (evita desface UTC con toISOString). */
function parseLocalYmd(ymd) {
  const s = String(ymd || '').trim().slice(0, 10);
  const parts = s.split('-');
  if (parts.length !== 3) return new Date(ymd);
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return new Date(ymd);
  return new Date(y, m, d, 12, 0, 0, 0);
}

function toLocalYmd(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const da = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** Lista las cuotas de otros gastos de varias solicitudes; retorna Map<solicitudId, array>. */
export async function listBySolicitudIds(solicitudIds) {
  if (!Array.isArray(solicitudIds) || solicitudIds.length === 0) return {};
  const res = await query(
    `SELECT id, solicitud_id, week_index, due_date, amount_due, paid_amount, status, moneda, created_at, updated_at
     FROM module_miauto_otros_gastos
     WHERE solicitud_id = ANY($1::uuid[])
     ORDER BY solicitud_id, week_index ASC`,
    [solicitudIds]
  );
  const byId = {};
  for (const r of res.rows || []) {
    if (!byId[r.solicitud_id]) byId[r.solicitud_id] = [];
    byId[r.solicitud_id].push({
      id: r.id,
      solicitud_id: r.solicitud_id,
      week_index: r.week_index,
      due_date: r.due_date,
      amount_due: parseFloat(r.amount_due) || 0,
      paid_amount: parseFloat(r.paid_amount) || 0,
      status: r.status,
      moneda: r.moneda === 'USD' ? 'USD' : 'PEN',
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  }
  return byId;
}

/**
 * Devuelve el week_index actual para "otros gastos": primera cuota = semana 2 del plan, luego 3, 4, ...
 * Ancla = primer lunes desde fecha_inicio; ese lunes es semana 2.
 */
function getCurrentOtrosGastosWeekIndex(fechaInicioYmd) {
  if (!fechaInicioYmd) return 0;
  const startLocal = parseLocalYmd(fechaInicioYmd);
  const anchorMonday = getFirstMonday(startLocal, 1);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const anchorTime = anchorMonday.getTime();
  const todayTime = today.getTime();
  if (todayTime < anchorTime) return 0;
  const diffDays = Math.floor((todayTime - anchorTime) / (24 * 60 * 60 * 1000));
  return 2 + Math.floor(diffDays / 7);
}

/**
 * Asegura que exista la fila de otros_gastos para la semana week_index (creación lazy).
 * Solo aplica si la solicitud tiene otros_gastos_saldo_total y otros_gastos_num_cuotas (flujo nuevo).
 * Si la fila ya existe, la devuelve. Si no, la crea con due_date y amount_due calculados.
 */
export async function ensureOtroGastoForWeek(solicitudId, weekIndex) {
  const sol = await query(
    `SELECT fecha_inicio_cobro_semanal, otros_gastos_saldo_total, otros_gastos_num_cuotas
     FROM module_miauto_solicitud WHERE id = $1`,
    [solicitudId]
  );
  if (sol.rows.length === 0) return null;
  const row = sol.rows[0];
  const saldo = row.otros_gastos_saldo_total != null ? parseFloat(row.otros_gastos_saldo_total) : null;
  const numCuotas = row.otros_gastos_num_cuotas != null ? parseInt(row.otros_gastos_num_cuotas, 10) : null;
  // week_index 2 = primera cuota (semana 2 del plan), hasta 1+numCuotas (ej. 27 para 26 cuotas)
  if (saldo == null || numCuotas == null || numCuotas < 1 || weekIndex < 2 || weekIndex > 1 + numCuotas) {
    return null;
  }

  const existing = await query(
    'SELECT id, solicitud_id, week_index, due_date, amount_due, paid_amount, status, moneda, created_at, updated_at FROM module_miauto_otros_gastos WHERE solicitud_id = $1 AND week_index = $2',
    [solicitudId, weekIndex]
  );
  if (existing.rows.length > 0) {
    const r = existing.rows[0];
    return {
      id: r.id,
      solicitud_id: r.solicitud_id,
      week_index: r.week_index,
      due_date: r.due_date,
      amount_due: parseFloat(r.amount_due) || 0,
      paid_amount: parseFloat(r.paid_amount) || 0,
      status: r.status,
      moneda: r.moneda === 'USD' ? 'USD' : 'PEN',
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  const monedaRes = await query(
    `SELECT cv.inicial_moneda FROM module_miauto_solicitud s
     LEFT JOIN module_miauto_cronograma_vehiculo cv ON cv.id = s.cronograma_vehiculo_id
     WHERE s.id = $1`,
    [solicitudId]
  );
  const moneda = monedaRes.rows[0]?.inicial_moneda === 'USD' ? 'USD' : 'PEN';

  const fechaInicio = row.fecha_inicio_cobro_semanal;
  const startLocal = parseLocalYmd(fechaInicio);
  const anchorMonday = getFirstMonday(startLocal, 1);
  const y0 = anchorMonday.getFullYear();
  const m0 = anchorMonday.getMonth();
  const d0 = anchorMonday.getDate();
  const dueDate = new Date(y0, m0, d0 + (weekIndex - 2) * 7, 12, 0, 0, 0);
  const dueStr = toLocalYmd(dueDate);
  const base = round2(saldo / numCuotas);
  const remainder = round2(saldo - base * (numCuotas - 1));
  const amountDue = weekIndex === 1 + numCuotas ? remainder : base;

  await query(
    `INSERT INTO module_miauto_otros_gastos (solicitud_id, week_index, due_date, amount_due, paid_amount, status, moneda)
     VALUES ($1, $2, $3, $4, 0, 'pending', $5)
     ON CONFLICT (solicitud_id, week_index) DO NOTHING`,
    [solicitudId, weekIndex, dueStr, amountDue, moneda]
  );
  const after = await query(
    'SELECT id, solicitud_id, week_index, due_date, amount_due, paid_amount, status, moneda, created_at, updated_at FROM module_miauto_otros_gastos WHERE solicitud_id = $1 AND week_index = $2',
    [solicitudId, weekIndex]
  );
  if (after.rows.length === 0) return null;
  const r = after.rows[0];
  return {
    id: r.id,
    solicitud_id: r.solicitud_id,
    week_index: r.week_index,
    due_date: r.due_date,
    amount_due: parseFloat(r.amount_due) || 0,
    paid_amount: parseFloat(r.paid_amount) || 0,
    status: r.status,
    moneda: r.moneda === 'USD' ? 'USD' : 'PEN',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Lista las cuotas de otros gastos de una solicitud, ordenadas por week_index. Crea filas bajo demanda (lazy) hasta la semana actual si la solicitud tiene otros_gastos_num_cuotas. */
export async function listBySolicitud(solicitudId) {
  const sol = await query(
    `SELECT fecha_inicio_cobro_semanal, otros_gastos_saldo_total, otros_gastos_num_cuotas
     FROM module_miauto_solicitud WHERE id = $1`,
    [solicitudId]
  );
  if (sol.rows.length > 0) {
    const row = sol.rows[0];
    const numCuotas = row.otros_gastos_num_cuotas != null ? parseInt(row.otros_gastos_num_cuotas, 10) : null;
    if (numCuotas != null && numCuotas >= 1) {
      const currentWeek = getCurrentOtrosGastosWeekIndex(row.fecha_inicio_cobro_semanal);
      const upTo = Math.min(Math.max(2, currentWeek), 1 + numCuotas);
      for (let k = 2; k <= upTo; k++) {
        await ensureOtroGastoForWeek(solicitudId, k);
      }
    }
  }

  const res = await query(
    `SELECT id, solicitud_id, week_index, due_date, amount_due, paid_amount, status, moneda, created_at, updated_at
     FROM module_miauto_otros_gastos
     WHERE solicitud_id = $1
     ORDER BY week_index ASC`,
    [solicitudId]
  );
  return (res.rows || []).map((r) => ({
    id: r.id,
    solicitud_id: r.solicitud_id,
    week_index: r.week_index,
    due_date: r.due_date,
    amount_due: parseFloat(r.amount_due) || 0,
    paid_amount: parseFloat(r.paid_amount) || 0,
    status: r.status,
    moneda: r.moneda === 'USD' ? 'USD' : 'PEN',
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}
