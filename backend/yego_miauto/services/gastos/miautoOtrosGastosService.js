import { getClient, query } from '../../../config/database.js';
import { logger } from '../../../utils/logger.js';
import {
  buildGpsInstallments,
  buildSoatInstallments,
  buildVehicleTaxInstallments,
  buildWeeklyInstallments,
  isVehicleTaxYearEligible,
  nextMonday,
  replaceYearClamped,
} from './miautoGastoRules.js';

const GPS_MONTHLY_AMOUNT = 47.2;
const SOAT_INSTALLMENT_AMOUNT = 50;
const INITIAL_PARTIAL_WEEKLY_AMOUNT = 19.23;
const WEEKLY_INSTALLMENTS = 26;

function limaTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function ymd(value) {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return match?.[1] || null;
}

function yearOf(value) {
  const date = ymd(value);
  return date ? Number(date.slice(0, 4)) : null;
}

function normalizeCurrency(value, fallback = 'PEN') {
  const currency = String(value || fallback).toUpperCase();
  return ['PEN', 'USD', 'COP'].includes(currency) ? currency : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapExpenseRow(row) {
  const amountDue = Number(row.amount_due) || 0;
  const paidAmount = Number(row.paid_amount) || 0;
  return {
    id: row.id,
    solicitud_id: row.solicitud_id,
    ciclo_id: row.ciclo_id || null,
    tipo: row.tipo || row.concepto || 'generico',
    periodo_anio: row.periodo_anio != null ? Number(row.periodo_anio) : yearOf(row.due_date),
    ciclo_numero: row.ciclo_numero != null ? Number(row.ciclo_numero) : 1,
    numero_cuota: row.numero_cuota != null ? Number(row.numero_cuota) : Number(row.week_index),
    total_cuotas: row.total_cuotas != null ? Number(row.total_cuotas) : null,
    week_index: Number(row.week_index),
    due_date: row.due_date,
    amount_due: amountDue,
    paid_amount: paidAmount,
    pending_amount: Math.max(0, Number((amountDue - paidAmount).toFixed(2))),
    status: row.status,
    moneda: normalizeCurrency(row.moneda),
    origen: row.origen || row.ciclo_origen || 'legacy',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const EXPENSE_SELECT = `
  SELECT og.id, og.solicitud_id, og.ciclo_id, og.tipo, og.week_index,
         og.numero_cuota, og.total_cuotas, og.periodo_anio, og.due_date,
         og.amount_due, og.paid_amount, og.status, og.moneda, og.origen,
         og.created_at, og.updated_at,
         c.ciclo_numero, c.origen AS ciclo_origen
  FROM module_miauto_otros_gastos og
  LEFT JOIN module_miauto_gasto_ciclo c ON c.id = og.ciclo_id
`;

/** Consulta pura. No genera ni modifica cuotas. */
export async function listBySolicitud(solicitudId) {
  const result = await query(
    `${EXPENSE_SELECT}
     WHERE og.solicitud_id = $1::uuid AND og.deleted_at IS NULL
     ORDER BY COALESCE(og.periodo_anio, EXTRACT(YEAR FROM og.due_date)) DESC,
              og.tipo, c.ciclo_numero, COALESCE(og.numero_cuota, og.week_index), og.due_date, og.id`,
    [solicitudId]
  );
  return result.rows.map(mapExpenseRow);
}

/** Consulta pura para listados de varios contratos. */
export async function listBySolicitudIds(solicitudIds) {
  if (!Array.isArray(solicitudIds) || solicitudIds.length === 0) return {};
  const result = await query(
    `${EXPENSE_SELECT}
     WHERE og.solicitud_id = ANY($1::uuid[]) AND og.deleted_at IS NULL
     ORDER BY og.solicitud_id, og.due_date, COALESCE(og.numero_cuota, og.week_index), og.id`,
    [solicitudIds]
  );
  return result.rows.reduce((grouped, row) => {
    const key = String(row.solicitud_id);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(mapExpenseRow(row));
    return grouped;
  }, {});
}

export async function getExpenseConfiguration(solicitudId) {
  const result = await query(
    `SELECT s.id, s.fecha_inicio_cobro_semanal, s.fecha_entrega_vehiculo,
            s.vehiculo_anio, s.soat_fecha_vencimiento,
            s.str_gps_monto_semanal, s.str_gps_moneda,
            s.inicial_parcial_activa, s.gastos_automaticos_activos,
            cv.name AS vehiculo_name, cv.requisitos_gastos
     FROM module_miauto_solicitud s
     LEFT JOIN module_miauto_cronograma_vehiculo cv ON cv.id = s.cronograma_vehiculo_id
     WHERE s.id = $1::uuid AND s.deleted_at IS NULL`,
    [solicitudId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Solicitud Mi Auto no encontrada');
  return {
    ...row,
    fecha_entrega_vehiculo: ymd(row.fecha_entrega_vehiculo) || ymd(row.fecha_inicio_cobro_semanal),
    vehiculo_anio: row.vehiculo_anio != null ? Number(row.vehiculo_anio) : null,
    str_gps_monto_semanal: numberOrNull(row.str_gps_monto_semanal),
    str_gps_moneda: normalizeCurrency(row.str_gps_moneda, 'USD'),
  };
}

export async function updateExpenseConfiguration(solicitudId, data, userId = null) {
  const fields = [];
  const values = [];
  const allowed = {
    fecha_entrega_vehiculo: (v) => v ? ymd(v) : null,
    vehiculo_anio: (v) => v === '' || v == null ? null : Number(v),
    soat_fecha_vencimiento: (v) => v ? ymd(v) : null,
    str_gps_monto_semanal: numberOrNull,
    str_gps_moneda: (v) => normalizeCurrency(v, 'USD'),
    inicial_parcial_activa: (v) => Boolean(v),
    gastos_automaticos_activos: (v) => Boolean(v),
  };

  for (const [key, normalize] of Object.entries(allowed)) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      values.push(normalize(data[key]));
      fields.push(`${key} = $${values.length}`);
    }
  }
  if (fields.length === 0) throw new Error('No se enviaron campos de configuracion validos');
  if (values.some((value, index) => fields[index].startsWith('vehiculo_anio') && value != null && (value < 1990 || value > 2100))) {
    throw new Error('El ano del vehiculo no es valido');
  }
  const strAmountIndex = fields.findIndex((field) => field.startsWith('str_gps_monto_semanal'));
  if (strAmountIndex >= 0 && values[strAmountIndex] != null && values[strAmountIndex] <= 0) {
    throw new Error('El monto semanal STR + GPS debe ser mayor a cero');
  }

  values.push(userId, solicitudId);
  await query(
    `UPDATE module_miauto_solicitud
     SET ${fields.join(', ')}, updated_by = $${values.length - 1}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $${values.length}::uuid AND deleted_at IS NULL`,
    values
  );
  return getExpenseConfiguration(solicitudId);
}

async function upsertCycle(client, {
  solicitudId,
  concept,
  periodYear,
  cycleNumber = 1,
  currency,
  installments,
  referenceDate = null,
  origin = 'sistema',
  config = {},
  userId = null,
}) {
  if (!installments.length) return { created: false, concept, periodYear, installments: 0 };
  const total = installments.reduce((sum, item) => sum + Number(item.amount), 0);
  const firstDate = installments[0].dueDate;
  const lastDate = installments[installments.length - 1].dueDate;
  const cycleResult = await client.query(
    `INSERT INTO module_miauto_gasto_ciclo
       (solicitud_id, concepto, periodo_anio, ciclo_numero, moneda, monto_total,
        fecha_inicio, fecha_fin, fecha_vencimiento_referencia, numero_cuotas,
        estado, origen, config_snapshot, created_by, updated_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::date, $8::date, $9::date, $10,
             'activo', $11, $12::jsonb, $13, $13)
     ON CONFLICT (solicitud_id, concepto, periodo_anio, ciclo_numero) DO NOTHING
     RETURNING id`,
    [solicitudId, concept, periodYear, cycleNumber, currency, total, firstDate, lastDate,
      referenceDate, installments.length, origin, JSON.stringify(config), userId]
  );

  let cycleId = cycleResult.rows[0]?.id;
  if (!cycleId) {
    const existing = await client.query(
      `SELECT id FROM module_miauto_gasto_ciclo
       WHERE solicitud_id = $1::uuid AND concepto = $2 AND periodo_anio = $3 AND ciclo_numero = $4`,
      [solicitudId, concept, periodYear, cycleNumber]
    );
    cycleId = existing.rows[0]?.id;
    return { created: false, cycleId, concept, periodYear, installments: 0 };
  }

  for (const installment of installments) {
    const sourceKey = `${solicitudId}:${concept}:${periodYear}:${cycleNumber}:${installment.number}`;
    await client.query(
      `INSERT INTO module_miauto_otros_gastos
         (solicitud_id, ciclo_id, tipo, week_index, numero_cuota, total_cuotas,
          periodo_anio, due_date, amount_due, paid_amount, status, moneda, source_key, origen)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7::date, $8, 0,
               CASE WHEN $7::date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date THEN 'overdue' ELSE 'pending' END,
               $9, $10, $11)
       ON CONFLICT (source_key) WHERE source_key IS NOT NULL AND deleted_at IS NULL DO NOTHING`,
      [solicitudId, cycleId, concept, installment.number, installments.length, periodYear,
        installment.dueDate, installment.amount, currency, sourceKey, origin]
    );
  }
  return { created: true, cycleId, concept, periodYear, installments: installments.length };
}

function requirementsObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

/** Generacion explicita e idempotente. Nunca modifica ciclos ya creados. */
export async function generateExpenseCycles(solicitudId, options = {}) {
  const config = await getExpenseConfiguration(solicitudId);
  if (!config.gastos_automaticos_activos && !options.forceManual) {
    return { skipped: true, reason: 'gastos_automaticos_inactivos', cycles: [] };
  }

  const todayYear = Number((options.todayYmd || limaTodayYmd()).slice(0, 4));
  const periodYear = Number(options.periodYear || todayYear);
  const deliveryDate = config.fecha_entrega_vehiculo;
  if (!deliveryDate) throw new Error('Registra la fecha de entrega del vehiculo antes de generar gastos');

  const requirements = requirementsObject(config.requisitos_gastos);
  const configuredStrAmount = numberOrNull(config.str_gps_monto_semanal)
    ?? numberOrNull(requirements.todo_riesgo_mas_gps_agrupado?.monto);
  const configuredStrCurrency = normalizeCurrency(
    config.str_gps_moneda || requirements.todo_riesgo_mas_gps_agrupado?.moneda,
    'USD'
  );

  const client = await getClient();
  const cycles = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`miauto-gastos:${solicitudId}`]);

    const gpsInstallments = buildGpsInstallments(periodYear, GPS_MONTHLY_AMOUNT)
      .filter((item) => item.dueDate >= deliveryDate);
    cycles.push(await upsertCycle(client, {
      solicitudId, concept: 'gps', periodYear, currency: 'PEN', installments: gpsInstallments,
      origin: 'sistema', config: { monthly_amount: GPS_MONTHLY_AMOUNT, schedule: 'month_end' }, userId: options.userId,
    }));

    if (config.soat_fecha_vencimiento) {
      const soatPeriodYear = yearOf(config.soat_fecha_vencimiento);
      cycles.push(await upsertCycle(client, {
        solicitudId, concept: 'soat', periodYear: soatPeriodYear, currency: 'PEN',
        installments: buildSoatInstallments(config.soat_fecha_vencimiento, SOAT_INSTALLMENT_AMOUNT),
        referenceDate: ymd(config.soat_fecha_vencimiento), origin: 'sistema',
        config: { installment_amount: SOAT_INSTALLMENT_AMOUNT, months_before_expiration: 4 }, userId: options.userId,
      }));
    }

    const taxTotal = numberOrNull(options.vehicleTaxTotal);
    if (taxTotal != null) {
      if (taxTotal <= 0) throw new Error('El impuesto vehicular debe ser mayor a cero');
      if (!config.vehiculo_anio) throw new Error('Registra el ano del vehiculo antes del impuesto vehicular');
      if (!isVehicleTaxYearEligible(config.vehiculo_anio, periodYear)) {
        throw new Error(`El impuesto ${periodYear} no corresponde al vehiculo ${config.vehiculo_anio}`);
      }
      cycles.push(await upsertCycle(client, {
        solicitudId, concept: 'impuesto_vehicular', periodYear, currency: 'PEN',
        installments: buildVehicleTaxInstallments(periodYear, taxTotal), origin: 'sistema',
        config: { annual_total: taxTotal, months: [2, 5, 8, 11], rule: 'second_monday' }, userId: options.userId,
      }));
    }

    if (configuredStrAmount != null && configuredStrAmount > 0) {
      const deliveryYear = yearOf(deliveryDate);
      const anniversary = replaceYearClamped(deliveryDate, periodYear);
      const cycleStart = nextMonday(periodYear === deliveryYear ? deliveryDate : anniversary);
      cycles.push(await upsertCycle(client, {
        solicitudId, concept: 'str_gps', periodYear, currency: configuredStrCurrency,
        installments: buildWeeklyInstallments(cycleStart, WEEKLY_INSTALLMENTS, configuredStrAmount),
        origin: 'sistema', config: { weekly_amount: configuredStrAmount, weeks: WEEKLY_INSTALLMENTS }, userId: options.userId,
      }));
    }

    if (config.inicial_parcial_activa && periodYear === yearOf(deliveryDate)) {
      cycles.push(await upsertCycle(client, {
        solicitudId, concept: 'inicial_parcial', periodYear, currency: 'USD',
        installments: buildWeeklyInstallments(nextMonday(deliveryDate), WEEKLY_INSTALLMENTS, INITIAL_PARTIAL_WEEKLY_AMOUNT),
        origin: 'sistema', config: { weekly_amount: INITIAL_PARTIAL_WEEKLY_AMOUNT, weeks: WEEKLY_INSTALLMENTS }, userId: options.userId,
      }));
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  logger.info('miauto.gastos.cycles_generated', { solicitudId, periodYear, cycles });
  return { skipped: false, periodYear, cycles, expenses: await listBySolicitud(solicitudId) };
}

export async function generateExpenseCyclesForActiveContracts(options = {}) {
  const result = await query(
    `SELECT id FROM module_miauto_solicitud
     WHERE status = 'aprobado' AND deleted_at IS NULL
       AND gastos_automaticos_activos = TRUE
       AND COALESCE(fecha_entrega_vehiculo, fecha_inicio_cobro_semanal) IS NOT NULL
     ORDER BY id`,
    []
  );
  const summary = { total: result.rows.length, generated: 0, failed: 0, errors: [] };
  for (const row of result.rows) {
    try {
      await generateExpenseCycles(row.id, options);
      summary.generated += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({ solicitudId: row.id, error: error.message });
      logger.error('miauto.gastos.contract_generation_failed', { solicitudId: row.id, error: error.message });
    }
  }
  return summary;
}

/** Actualiza solo estados derivados. Otros gastos nunca generan mora. */
export async function refreshAdditionalExpenseStatuses(solicitudId = null) {
  const params = [];
  const filter = solicitudId ? 'AND solicitud_id = $1::uuid' : '';
  if (solicitudId) params.push(solicitudId);
  const result = await query(
    `UPDATE module_miauto_otros_gastos
     SET status = CASE
       WHEN COALESCE(paid_amount, 0) >= COALESCE(amount_due, 0) - 0.005 THEN 'paid'
       WHEN due_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date THEN 'overdue'
       WHEN COALESCE(paid_amount, 0) > 0.005 THEN 'partial'
       ELSE 'pending'
     END,
     updated_at = CURRENT_TIMESTAMP
     WHERE deleted_at IS NULL ${filter}
       AND status IS DISTINCT FROM CASE
         WHEN COALESCE(paid_amount, 0) >= COALESCE(amount_due, 0) - 0.005 THEN 'paid'
         WHEN due_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date THEN 'overdue'
         WHEN COALESCE(paid_amount, 0) > 0.005 THEN 'partial'
         ELSE 'pending'
       END
     RETURNING id`,
    params
  );
  return { updated: result.rowCount };
}
