import { query } from '../../../config/database.js';

export const MIN_VIAJES_BONO_TIEMPO = 120;
export const CUOTAS_POR_BONO_TIEMPO = 4;

const LIMA_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Lima',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function ymd(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return LIMA_DATE_FORMATTER.format(value);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || '').trim());
  return match ? match[1] : null;
}

function mondayOfYmd(value) {
  const source = ymd(value);
  if (!source) return null;
  const date = new Date(`${source}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function isEligibleRow(row) {
  const status = String(row.status || '').toLowerCase();
  return (status === 'paid' || status === 'bonificada')
    && row.pago_puntual === true
    && Number(row.num_viajes || 0) >= MIN_VIAJES_BONO_TIEMPO;
}

function limaTodayYmd() {
  return LIMA_DATE_FORMATTER.format(new Date());
}

function rowDate(row) {
  return ymd(row?.due_date) || ymd(row?.week_start_date);
}

/**
 * Las cuotas futuras todavía no exigibles no rompen la racha. Una cuota ya
 * pagada, vencida o alcanzada por la fecha de corte sí forma parte de la
 * secuencia y, si no cumple, reinicia el progreso.
 */
function shouldEvaluateRow(row, cutoffYmd) {
  if (row?.pago_puntual === true) return true;
  const status = String(row?.status || '').toLowerCase();
  if (status === 'paid' || status === 'bonificada' || status === 'overdue') return true;
  const date = rowDate(row);
  return Boolean(date && date <= cutoffYmd);
}

/**
 * Fuente única para analizar bloques consolidados y la racha vigente.
 * Tras completar cuatro cuotas comienza un nuevo bloque desde cero.
 */
export function analizarRachaBonoTiempo(rows, depositWeek, options = {}) {
  const cutoffYmd = ymd(options.cutoffYmd) || limaTodayYmd();
  const excludedCuotaIds = new Set(
    [...(options.excludedCuotaIds || [])].map((id) => String(id))
  );
  const blocks = [];
  let current = [];
  const orderedRows = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const aDate = rowDate(a) || '9999-12-31';
    const bDate = rowDate(b) || '9999-12-31';
    return aDate.localeCompare(bDate) || String(a?.id || '').localeCompare(String(b?.id || ''));
  });
  for (const row of orderedRows) {
    if (ymd(row.week_start_date) === depositWeek) continue;
    if (excludedCuotaIds.has(String(row?.id))) {
      current = [];
      continue;
    }
    if (!shouldEvaluateRow(row, cutoffYmd)) continue;
    if (!isEligibleRow(row)) {
      current = [];
      continue;
    }
    current.push(row);
    if (current.length === CUOTAS_POR_BONO_TIEMPO) {
      blocks.push(current);
      current = [];
    }
  }
  return { blocks, progress: current.length };
}

async function loadContext(solicitudId) {
  const result = await query(
    `SELECT s.id, s.cronograma_id, s.fecha_inicio_cobro_semanal,
            COALESCE(s.cuotas_semanales_bonificadas, 0)::int AS legacy_bonus_count,
            c.bono_tiempo_activo,
            v.cuotas_semanales
     FROM module_miauto_solicitud s
     LEFT JOIN module_miauto_cronograma c ON c.id = s.cronograma_id
     LEFT JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id
     WHERE s.id = $1`,
    [solicitudId]
  );
  return result.rows[0] || null;
}

async function loadRows(solicitudId) {
  const result = await query(
    `SELECT id, week_start_date, due_date, status, pago_puntual, num_viajes
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1 AND deleted_at IS NULL
     ORDER BY week_start_date ASC NULLS LAST, due_date ASC NULLS LAST, id ASC`,
    [solicitudId]
  );
  return result.rows || [];
}

async function loadBonos(solicitudId) {
  const result = await query(
    `SELECT id, source_key, source_cuota_ids, target_week_number,
            target_cuota_semanal_id, status, created_at, applied_at
     FROM module_miauto_bono_tiempo
     WHERE solicitud_id = $1
     ORDER BY created_at ASC`,
    [solicitudId]
  );
  return result.rows || [];
}

export async function listBonosTiempo(solicitudId) {
  return loadBonos(solicitudId);
}

function sourceCuotaIds(bonos) {
  return (bonos || []).flatMap((bono) => (
    Array.isArray(bono.source_cuota_ids)
      ? bono.source_cuota_ids.map((id) => String(id))
      : []
  ));
}

function sourceKeyForBlock(block) {
  return block.map((row) => String(row.id)).join(':');
}

async function aplicarReservas(solicitudId, context) {
  const totalWeeks = Number(context.cuotas_semanales || 0);
  const firstWeek = mondayOfYmd(context.fecha_inicio_cobro_semanal);
  if (!firstWeek || totalWeeks <= 0) return;
  const reservas = await query(
    `SELECT id, target_week_number
     FROM module_miauto_bono_tiempo
     WHERE solicitud_id = $1 AND status = 'reservado'
     ORDER BY created_at ASC`,
    [solicitudId]
  );
  for (const bono of reservas.rows || []) {
    const target = await query(
      `SELECT id, status FROM module_miauto_cuota_semanal
       WHERE solicitud_id = $1
         AND week_start_date::date = ($2::date + (($3 - 1) * INTERVAL '7 days'))::date
         AND deleted_at IS NULL
       LIMIT 1`,
      [solicitudId, firstWeek, bono.target_week_number]
    );
    const cuota = target.rows[0];
    if (!cuota) continue;
    const applied = await query(
      `UPDATE module_miauto_cuota_semanal
       SET paid_amount = amount_due,
           late_fee = 0,
           mora_extra = 0,
           mora_extra_total = 0,
           mora_extra_desde = NULL,
           status = 'bonificada',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND solicitud_id = $2 AND status NOT IN ('paid', 'bonificada')`,
      [cuota.id, solicitudId]
    );
    if (applied.rowCount === 0 && String(cuota.status || '').toLowerCase() !== 'bonificada') continue;
    await query(
      `UPDATE module_miauto_bono_tiempo
       SET target_cuota_semanal_id = $1, status = 'aplicado', applied_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [cuota.id, bono.id]
    );
  }
}

/**
 * Sincroniza las reservas con los bloques vigentes. Una reserva todavía no
 * aplicada se revoca si se rompe su bloque; un bono aplicado es histórico.
 */
export async function reconciliarBonosTiempo(solicitudId) {
  const context = await loadContext(solicitudId);
  if (!context?.bono_tiempo_activo) return { enabled: false, granted: 0 };
  const [rows, existingBonos] = await Promise.all([
    loadRows(solicitudId),
    loadBonos(solicitudId),
  ]);
  const depositWeek = mondayOfYmd(context.fecha_inicio_cobro_semanal);
  const appliedBonos = existingBonos.filter((bono) => bono.status === 'aplicado');
  const { blocks } = analizarRachaBonoTiempo(rows, depositWeek, {
    excludedCuotaIds: sourceCuotaIds(appliedBonos),
  });
  const desiredKeys = new Set(blocks.map(sourceKeyForBlock));
  const obsoleteReserved = existingBonos.filter(
    (bono) => bono.status === 'reservado' && !desiredKeys.has(bono.source_key)
  );
  for (const bono of obsoleteReserved) {
    await query(
      `DELETE FROM module_miauto_bono_tiempo
       WHERE id = $1 AND solicitud_id = $2 AND status = 'reservado'`,
      [bono.id, solicitudId]
    );
  }

  const obsoleteIds = new Set(obsoleteReserved.map((bono) => bono.id));
  const retainedBonos = existingBonos.filter(
    (bono) => !obsoleteIds.has(bono.id)
  );
  const existingKeys = new Set(retainedBonos.map((bono) => bono.source_key));
  let granted = 0;
  let claimed = Math.max(Number(context.legacy_bonus_count || 0) - obsoleteReserved.length, retainedBonos.length);
  for (const block of blocks) {
    const sourceKey = sourceKeyForBlock(block);
    if (existingKeys.has(sourceKey)) continue;
    const ids = block.map((row) => String(row.id));
    const targetWeek = Number(context.cuotas_semanales || 0) - claimed;
    if (targetWeek <= 0) break;
    const inserted = await query(
      `INSERT INTO module_miauto_bono_tiempo
       (solicitud_id, source_key, source_cuota_ids, target_week_number)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (solicitud_id, source_key) DO NOTHING
       RETURNING id`,
      [solicitudId, sourceKey, JSON.stringify(ids), targetWeek]
    );
    if (inserted.rowCount === 0) continue;
    existingKeys.add(sourceKey);
    claimed += 1;
    granted += 1;
  }
  const totalBonos = retainedBonos.length + granted;
  await query(
    `UPDATE module_miauto_solicitud
     SET cuotas_semanales_bonificadas = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [totalBonos, solicitudId]
  );
  context.legacy_bonus_count = totalBonos;
  await aplicarReservas(solicitudId, context);
  return { enabled: true, granted, revoked: obsoleteReserved.length };
}

export function buildResumenBonoTiempo(context, rows, bonos) {
  if (!context?.bono_tiempo_activo) return { enabled: false, racha: 0, bonos: [] };
  const depositWeek = mondayOfYmd(context.fecha_inicio_cobro_semanal);
  const appliedBonos = bonos.filter((bono) => bono.status === 'aplicado');
  const analysis = analizarRachaBonoTiempo(rows, depositWeek, {
    excludedCuotaIds: sourceCuotaIds(appliedBonos),
  });
  const desiredKeys = new Set(analysis.blocks.map(sourceKeyForBlock));
  const visibleBonos = bonos.filter(
    (bono) => bono.status === 'aplicado' || desiredKeys.has(bono.source_key)
  );
  return {
    enabled: true,
    racha: analysis.progress,
    bonos: visibleBonos,
  };
}

export async function getResumenBonoTiempo(solicitudId) {
  const context = await loadContext(solicitudId);
  if (!context?.bono_tiempo_activo) return { enabled: false, racha: 0, bonos: [] };
  const [rows, bonos] = await Promise.all([
    loadRows(solicitudId),
    loadBonos(solicitudId),
  ]);
  return buildResumenBonoTiempo(context, rows, bonos);
}

/** Se llama al generar una cuota para materializar reservas cuyo objetivo ya existe. */
export async function aplicarBonoTiempoReservado(solicitudId) {
  const context = await loadContext(solicitudId);
  if (!context?.bono_tiempo_activo) return;
  await aplicarReservas(solicitudId, context);
}
