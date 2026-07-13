import { query } from '../../../config/database.js';

export const MIN_VIAJES_BONO_TIEMPO = 120;

function ymd(value) {
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

function isEligibleRow(row, depositWeek) {
  if (ymd(row.week_start_date) === depositWeek) return false;
  const status = String(row.status || '').toLowerCase();
  return (status === 'paid' || status === 'bonificada')
    && row.pago_puntual === true
    && Number(row.num_viajes || 0) >= MIN_VIAJES_BONO_TIEMPO;
}

function completedBlocks(rows, depositWeek) {
  const blocks = [];
  let current = [];
  for (const row of rows) {
    if (ymd(row.week_start_date) === depositWeek) continue;
    if (!isEligibleRow(row, depositWeek)) {
      current = [];
      continue;
    }
    current.push(row);
    if (current.length === 4) {
      blocks.push(current);
      current = [];
    }
  }
  return blocks;
}

function currentProgress(rows, depositWeek) {
  let progress = 0;
  for (const row of rows) {
    if (ymd(row.week_start_date) === depositWeek) continue;
    if (!isEligibleRow(row, depositWeek)) {
      progress = 0;
      continue;
    }
    progress = (progress + 1) % 4;
  }
  return progress;
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

/** Consolida bloques nuevos; nunca revoca un bono registrado previamente. */
export async function reconciliarBonosTiempo(solicitudId) {
  const context = await loadContext(solicitudId);
  if (!context?.bono_tiempo_activo) return { enabled: false, granted: 0 };
  const rows = await loadRows(solicitudId);
  const depositWeek = mondayOfYmd(context.fecha_inicio_cobro_semanal);
  const blocks = completedBlocks(rows, depositWeek);
  const existing = await query(
    `SELECT source_key FROM module_miauto_bono_tiempo WHERE solicitud_id = $1`,
    [solicitudId]
  );
  const existingKeys = new Set((existing.rows || []).map((row) => row.source_key));
  let granted = 0;
  let claimed = Number(context.legacy_bonus_count || 0);
  for (const block of blocks) {
    const ids = block.map((row) => String(row.id));
    const sourceKey = ids.join(':');
    if (existingKeys.has(sourceKey)) continue;
    const targetWeek = Number(context.cuotas_semanales || 0) - claimed;
    if (targetWeek <= 0) break;
    await query(
      `INSERT INTO module_miauto_bono_tiempo
       (solicitud_id, source_key, source_cuota_ids, target_week_number)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [solicitudId, sourceKey, JSON.stringify(ids), targetWeek]
    );
    existingKeys.add(sourceKey);
    claimed += 1;
    granted += 1;
  }
  if (granted > 0) {
    await query(
      `UPDATE module_miauto_solicitud
       SET cuotas_semanales_bonificadas = COALESCE(cuotas_semanales_bonificadas, 0) + $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [granted, solicitudId]
    );
    context.legacy_bonus_count = claimed;
  }
  await aplicarReservas(solicitudId, context);
  return { enabled: true, granted };
}

export async function getResumenBonoTiempo(solicitudId) {
  const context = await loadContext(solicitudId);
  if (!context?.bono_tiempo_activo) return { enabled: false, racha: 0, bonos: [] };
  const rows = await loadRows(solicitudId);
  const depositWeek = mondayOfYmd(context.fecha_inicio_cobro_semanal);
  const bonos = await query(
    `SELECT id, source_cuota_ids, target_week_number, target_cuota_semanal_id, status, created_at, applied_at
     FROM module_miauto_bono_tiempo WHERE solicitud_id = $1 ORDER BY created_at ASC`,
    [solicitudId]
  );
  return {
    enabled: true,
    racha: currentProgress(rows, depositWeek),
    bonos: bonos.rows || [],
  };
}

/** Se llama al generar una cuota para materializar reservas cuyo objetivo ya existe. */
export async function aplicarBonoTiempoReservado(solicitudId) {
  const context = await loadContext(solicitudId);
  if (!context?.bono_tiempo_activo) return;
  await aplicarReservas(solicitudId, context);
}
