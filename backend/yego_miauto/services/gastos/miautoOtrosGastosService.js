import { getClient, query } from '../../../config/database.js';
import { logger } from '../../../utils/logger.js';
import {
  buildGpsInstallments,
  buildSoatInstallments,
  buildVehicleTaxInstallments,
  buildWeeklyInstallments,
  contractEndDate,
  installmentsWithinRange,
  isVehicleTaxYearEligible,
  nextMonday,
  nextMonthEnd,
  recurringReferenceDate,
  replaceYearClamped,
} from './miautoGastoRules.js';
import {
  amountChanged,
  configuredExpenseAmount,
  parseExpenseRequirements,
} from './miautoGastoConfigSync.js';

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

function positiveNumber(value) {
  const number = numberOrNull(value);
  return number != null && number > 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
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
    pending_fleet_application_id: row.pending_fleet_application_id || null,
    pending_fleet_original_amount: row.pending_fleet_application_id
      ? Number(row.pending_fleet_original_amount) || 0
      : null,
    pending_fleet_original_currency: row.pending_fleet_original_currency || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const EXPENSE_SELECT = `
  SELECT og.id, og.solicitud_id, og.ciclo_id, og.tipo, og.week_index,
         og.numero_cuota, og.total_cuotas, og.periodo_anio, og.due_date,
         og.amount_due, og.paid_amount, og.status, og.moneda, og.origen,
         og.created_at, og.updated_at,
         c.ciclo_numero, c.origen AS ciclo_origen,
         pending_fleet_payment.id AS pending_fleet_application_id,
         pending_fleet_payment.monto_original AS pending_fleet_original_amount,
         pending_fleet_payment.moneda_original AS pending_fleet_original_currency
  FROM module_miauto_otros_gastos og
  LEFT JOIN module_miauto_gasto_ciclo c ON c.id = og.ciclo_id
  LEFT JOIN LATERAL (
    SELECT pa.id, pa.monto_original, pa.moneda_original
    FROM module_miauto_gasto_pago_aplicacion pa
    WHERE pa.otros_gastos_id = og.id
      AND pa.origen = 'fleet'
      AND pa.reversed_at IS NULL
      AND pa.comprobante_id IS NULL
    ORDER BY pa.applied_at, pa.id
    LIMIT 1
  ) pending_fleet_payment ON true
`;

/** Consulta pura. No genera ni modifica cuotas. */
export async function listBySolicitud(solicitudId) {
  const result = await query(
    `${EXPENSE_SELECT}
     WHERE og.solicitud_id = $1::uuid AND og.deleted_at IS NULL
     ORDER BY
       CASE
         WHEN COALESCE(og.periodo_anio, EXTRACT(YEAR FROM og.due_date)) =
              EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')) THEN 0
         WHEN COALESCE(og.periodo_anio, EXTRACT(YEAR FROM og.due_date)) >
              EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')) THEN 1
         ELSE 2
       END,
       CASE
         WHEN COALESCE(og.periodo_anio, EXTRACT(YEAR FROM og.due_date)) >=
              EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima'))
         THEN COALESCE(og.periodo_anio, EXTRACT(YEAR FROM og.due_date))
       END ASC,
       CASE
         WHEN COALESCE(og.periodo_anio, EXTRACT(YEAR FROM og.due_date)) <
              EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima'))
         THEN COALESCE(og.periodo_anio, EXTRACT(YEAR FROM og.due_date))
       END DESC,
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
            cv.name AS vehiculo_name, cv.cuotas_semanales, cv.requisitos_gastos
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
    cuotas_semanales: row.cuotas_semanales != null ? Number(row.cuotas_semanales) : null,
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

/**
 * Propaga cambios de monto del cronograma solo a cuotas sin movimientos.
 * Pagos, comprobantes y cobros Fleet en curso conservan su importe historico.
 */
export async function syncUnpaidExpenseAmountsForCronogramaVehicles(vehicleIds, userId = null) {
  const ids = [...new Set((vehicleIds || []).filter(Boolean).map(String))];
  if (ids.length === 0) return { scanned: 0, updated: 0, cycles: 0 };

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT og.id, og.ciclo_id, og.tipo, og.numero_cuota, og.total_cuotas,
              og.amount_due, cv.requisitos_gastos
       FROM module_miauto_otros_gastos og
       INNER JOIN module_miauto_solicitud s
         ON s.id = og.solicitud_id AND s.deleted_at IS NULL
       INNER JOIN module_miauto_cronograma_vehiculo cv
         ON cv.id = s.cronograma_vehiculo_id
       WHERE s.cronograma_vehiculo_id = ANY($1::uuid[])
         AND og.deleted_at IS NULL
         AND og.origen = 'sistema'
         AND LOWER(COALESCE(og.status, 'pending')) <> 'paid'
         AND COALESCE(og.paid_amount, 0) <= 0.005
         AND NOT EXISTS (
           SELECT 1 FROM module_miauto_gasto_pago_aplicacion pa
           WHERE pa.otros_gastos_id = og.id AND pa.reversed_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM module_miauto_comprobante_otros_gastos cp
           WHERE cp.otros_gastos_id = og.id AND cp.estado <> 'rechazado'
         )
         AND NOT EXISTS (
           SELECT 1 FROM module_miauto_gasto_cobro_fleet_intento fi
           WHERE fi.otros_gastos_id = og.id AND fi.estado IN ('processing', 'reconcile')
         )
       FOR UPDATE OF og`,
      [ids]
    );

    const changes = result.rows.flatMap((row) => {
      const amount = configuredExpenseAmount(row.requisitos_gastos, row);
      return amountChanged(row.amount_due, amount) ? [{ id: row.id, amount }] : [];
    });

    let changedCycles = [];
    if (changes.length > 0) {
      const updateResult = await client.query(
        `UPDATE module_miauto_otros_gastos og
         SET amount_due = change.amount,
             updated_by = $2,
             updated_at = CURRENT_TIMESTAMP
         FROM jsonb_to_recordset($1::jsonb) AS change(id uuid, amount numeric)
         WHERE og.id = change.id
         RETURNING og.ciclo_id`,
        [JSON.stringify(changes), userId]
      );
      changedCycles = [...new Set(updateResult.rows.map((row) => row.ciclo_id).filter(Boolean))];

      if (changedCycles.length > 0) {
        await client.query(
          `UPDATE module_miauto_gasto_ciclo c
           SET monto_total = totals.monto_total,
               estado = CASE WHEN totals.pending_count = 0 THEN 'completado' ELSE 'activo' END,
               updated_by = $2,
               updated_at = CURRENT_TIMESTAMP
           FROM (
             SELECT ciclo_id, SUM(amount_due) AS monto_total,
                    COUNT(*) FILTER (
                      WHERE COALESCE(paid_amount, 0) < COALESCE(amount_due, 0) - 0.005
                    ) AS pending_count
             FROM module_miauto_otros_gastos
             WHERE ciclo_id = ANY($1::uuid[]) AND deleted_at IS NULL
             GROUP BY ciclo_id
           ) totals
           WHERE c.id = totals.ciclo_id`,
          [changedCycles, userId]
        );
      }
    }

    await client.query('COMMIT');
    const summary = { scanned: result.rows.length, updated: changes.length, cycles: changedCycles.length };
    logger.info('miauto.gastos.cronograma_amounts_synced', { vehicleIds: ids, ...summary });
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

  const created = Boolean(cycleResult.rows[0]?.id);
  let cycleId = cycleResult.rows[0]?.id;
  let existingOrigin = null;
  if (!created) {
    const existing = await client.query(
      `SELECT id, origen FROM module_miauto_gasto_ciclo
       WHERE solicitud_id = $1::uuid AND concepto = $2 AND periodo_anio = $3 AND ciclo_numero = $4`,
      [solicitudId, concept, periodYear, cycleNumber]
    );
    cycleId = existing.rows[0]?.id;
    existingOrigin = existing.rows[0]?.origen || null;
    if (concept !== 'gps') {
      return { created: false, cycleId, concept, periodYear, installments: 0, origin: existingOrigin };
    }
  }

  if (!cycleId) throw new Error(`No se pudo resolver el ciclo ${concept} ${periodYear}`);

  const currentRows = await client.query(
    `SELECT id, numero_cuota, due_date::text
     FROM module_miauto_otros_gastos
     WHERE solicitud_id = $1::uuid AND tipo = $2 AND deleted_at IS NULL
       AND EXTRACT(YEAR FROM due_date)::int = $3
     ORDER BY due_date, id`,
    [solicitudId, concept, periodYear]
  );
  const occupiedMonths = new Set(currentRows.rows.map((row) => String(row.due_date).slice(0, 7)));
  const usedNumbers = new Set(currentRows.rows
    .filter((row) => row.numero_cuota != null)
    .map((row) => Number(row.numero_cuota)));
  let nextNumber = usedNumbers.size ? Math.max(...usedNumbers) + 1 : 1;
  let inserted = 0;

  for (const installment of installments) {
    if (concept === 'gps' && occupiedMonths.has(installment.dueDate.slice(0, 7))) continue;
    let installmentNumber = installment.number;
    if (usedNumbers.has(installmentNumber)) installmentNumber = nextNumber++;
    usedNumbers.add(installmentNumber);
    const sourceKey = `${solicitudId}:${concept}:${periodYear}:${cycleNumber}:${installment.dueDate}`;
    const result = await client.query(
      `INSERT INTO module_miauto_otros_gastos
         (solicitud_id, ciclo_id, tipo, week_index, numero_cuota, total_cuotas,
          periodo_anio, due_date, amount_due, paid_amount, status, moneda, source_key, origen)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7::date, $8, 0,
               CASE WHEN $7::date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date THEN 'overdue' ELSE 'pending' END,
               $9, $10, $11)
       ON CONFLICT (source_key) WHERE source_key IS NOT NULL AND deleted_at IS NULL DO NOTHING`,
      [solicitudId, cycleId, concept, installmentNumber, installments.length, periodYear,
        installment.dueDate, installment.amount, currency, sourceKey, origin]
    );
    inserted += result.rowCount;
    occupiedMonths.add(installment.dueDate.slice(0, 7));
  }

  await client.query(
    `UPDATE module_miauto_gasto_ciclo c
     SET monto_total = totals.monto_total,
         fecha_inicio = totals.fecha_inicio,
         fecha_fin = totals.fecha_fin,
         numero_cuotas = totals.numero_cuotas,
         updated_at = CURRENT_TIMESTAMP
     FROM (
       SELECT ciclo_id, SUM(amount_due) AS monto_total, MIN(due_date) AS fecha_inicio,
              MAX(due_date) AS fecha_fin, COUNT(*)::int AS numero_cuotas
       FROM module_miauto_otros_gastos
       WHERE ciclo_id = $1::uuid AND deleted_at IS NULL
       GROUP BY ciclo_id
     ) totals
     WHERE c.id = totals.ciclo_id`,
    [cycleId]
  );
  await client.query(
    `UPDATE module_miauto_otros_gastos og
     SET total_cuotas = c.numero_cuotas,
         updated_at = CURRENT_TIMESTAMP
     FROM module_miauto_gasto_ciclo c
     WHERE c.id = $1::uuid AND og.ciclo_id = c.id AND og.deleted_at IS NULL
       AND og.total_cuotas IS DISTINCT FROM c.numero_cuotas`,
    [cycleId]
  );
  return { created, cycleId, concept, periodYear, installments: inserted, origin: existingOrigin || origin };
}

/** Generacion explicita e idempotente. Completa solo periodos que aun no existen. */
export async function generateExpenseCycles(solicitudId, options = {}) {
  const config = await getExpenseConfiguration(solicitudId);
  if (!config.gastos_automaticos_activos && !options.forceManual) {
    return { skipped: true, reason: 'gastos_automaticos_inactivos', cycles: [] };
  }

  const todayYear = Number((options.todayYmd || limaTodayYmd()).slice(0, 4));
  const periodYear = Number(options.periodYear || todayYear);
  const deliveryDate = config.fecha_entrega_vehiculo;
  if (!deliveryDate) throw new Error('Registra la fecha de entrega del vehiculo antes de generar gastos');
  const endDate = contractEndDate(deliveryDate, config.cuotas_semanales);
  if (endDate && periodYear > yearOf(endDate)) {
    return { skipped: true, reason: 'contrato_finalizado', periodYear, contractEndDate: endDate, cycles: [] };
  }

  const requirements = parseExpenseRequirements(config.requisitos_gastos);
  const gpsRule = requirements.gps || {};
  const soatRule = requirements.soat || {};
  const taxRule = requirements.impuesto_vehicular || {};
  const strRule = requirements.todo_riesgo_mas_gps_agrupado || {};
  const initialPartialRule = requirements.inicial_parcial || {};
  const configuredStrAmount = positiveNumber(config.str_gps_monto_semanal)
    ?? positiveNumber(strRule.monto);
  const configuredStrCurrency = normalizeCurrency(
    config.str_gps_moneda || strRule.moneda,
    'USD'
  );
  const configuredStrWeeks = positiveInteger(strRule.cobro?.semanas);

  const client = await getClient();
  const cycles = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`miauto-gastos:${solicitudId}`]);

    const gpsAmount = positiveNumber(gpsRule.monto);
    const separatedGps = requirements.todo_riesgo_y_gps_modo !== 'agrupado';
    if (separatedGps && gpsAmount != null) {
      const gpsInstallments = installmentsWithinRange(
        buildGpsInstallments(periodYear, gpsAmount),
        nextMonthEnd(deliveryDate),
        endDate
      );
      cycles.push(await upsertCycle(client, {
        solicitudId, concept: 'gps', periodYear,
        currency: normalizeCurrency(gpsRule.moneda), installments: gpsInstallments,
        origin: 'sistema', config: { monthly_amount: gpsAmount, schedule: 'month_end', contract_end: endDate }, userId: options.userId,
      }));
    }

    if (config.soat_fecha_vencimiento) {
      const soatInstallmentAmount = positiveNumber(soatRule.monto);
      const soatInstallmentCount = positiveInteger(soatRule.cobro?.cuotas);
      const soatMonthsBefore = positiveInteger(soatRule.cobro?.meses_anticipo);
      if (!soatInstallmentAmount || !soatInstallmentCount || !soatMonthsBefore) {
        throw new Error('Configura monto, cuotas y meses de anticipacion del SOAT en el cronograma');
      }
      const soatReferenceDate = recurringReferenceDate(config.soat_fecha_vencimiento, periodYear);
      const soatPeriodYear = yearOf(soatReferenceDate);
      cycles.push(await upsertCycle(client, {
        solicitudId, concept: 'soat', periodYear: soatPeriodYear,
        currency: normalizeCurrency(soatRule.moneda),
        installments: installmentsWithinRange(
          buildSoatInstallments(
            soatReferenceDate,
            soatInstallmentAmount,
            soatInstallmentCount,
            soatMonthsBefore
          ),
          deliveryDate,
          endDate
        ),
        referenceDate: soatReferenceDate, origin: 'sistema',
        config: {
          installment_amount: soatInstallmentAmount,
          installments: soatInstallmentCount,
          months_before_expiration: soatMonthsBefore,
        },
        userId: options.userId,
      }));
    }

    const taxTotal = numberOrNull(options.vehicleTaxTotal) ?? positiveNumber(taxRule.monto);
    if (taxTotal != null) {
      if (taxTotal <= 0) throw new Error('El impuesto vehicular debe ser mayor a cero');
      if (!config.vehiculo_anio) throw new Error('Registra el ano del vehiculo antes del impuesto vehicular');
      const taxInstallmentCount = positiveInteger(taxRule.cobro?.cuotas);
      const taxStartMonth = positiveInteger(taxRule.cobro?.mes_inicio);
      const taxEligibleYears = positiveInteger(taxRule.cobro?.anios_vigencia_tras_modelo);
      if (!taxInstallmentCount || !taxStartMonth || !taxEligibleYears) {
        throw new Error('Configura cuotas, mes inicial y vigencia del impuesto vehicular en el cronograma');
      }
      if (!isVehicleTaxYearEligible(config.vehiculo_anio, periodYear, taxEligibleYears)) {
        throw new Error(`El impuesto ${periodYear} no corresponde al vehiculo ${config.vehiculo_anio}`);
      }
      cycles.push(await upsertCycle(client, {
        solicitudId, concept: 'impuesto_vehicular', periodYear,
        currency: normalizeCurrency(taxRule.moneda),
        installments: installmentsWithinRange(
          buildVehicleTaxInstallments(periodYear, taxTotal, taxStartMonth, taxInstallmentCount),
          deliveryDate,
          endDate
        ), origin: 'sistema',
        config: {
          annual_total: taxTotal,
          installments: taxInstallmentCount,
          start_month: taxStartMonth,
          eligible_years: taxEligibleYears,
          rule: 'second_monday',
        },
        userId: options.userId,
      }));
    }

    if (configuredStrAmount != null) {
      if (!configuredStrWeeks) {
        throw new Error('Configura la cantidad de semanas de STR + GPS en el cronograma');
      }
      const deliveryYear = yearOf(deliveryDate);
      const anniversary = replaceYearClamped(deliveryDate, periodYear);
      const cycleStart = nextMonday(periodYear === deliveryYear ? deliveryDate : anniversary);
      cycles.push(await upsertCycle(client, {
        solicitudId, concept: 'str_gps', periodYear, currency: configuredStrCurrency,
        installments: installmentsWithinRange(
          buildWeeklyInstallments(cycleStart, configuredStrWeeks, configuredStrAmount),
          deliveryDate,
          endDate
        ),
        origin: 'sistema',
        config: { weekly_amount: configuredStrAmount, weeks: configuredStrWeeks, contract_end: endDate },
        userId: options.userId,
      }));
    }

    if (config.inicial_parcial_activa && periodYear === yearOf(deliveryDate)) {
      const initialPartialAmount = positiveNumber(initialPartialRule.monto);
      const initialPartialWeeks = positiveInteger(initialPartialRule.cobro?.semanas);
      if (!initialPartialAmount || !initialPartialWeeks) {
        throw new Error('Configura el monto y las semanas de inicial parcial en el cronograma');
      }
      cycles.push(await upsertCycle(client, {
        solicitudId, concept: 'inicial_parcial', periodYear,
        currency: normalizeCurrency(initialPartialRule.moneda, 'USD'),
        installments: installmentsWithinRange(
          buildWeeklyInstallments(nextMonday(deliveryDate), initialPartialWeeks, initialPartialAmount),
          deliveryDate,
          endDate
        ),
        origin: 'sistema',
        config: { weekly_amount: initialPartialAmount, weeks: initialPartialWeeks },
        userId: options.userId,
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
  return { skipped: false, periodYear, contractEndDate: endDate, cycles, expenses: await listBySolicitud(solicitudId) };
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
