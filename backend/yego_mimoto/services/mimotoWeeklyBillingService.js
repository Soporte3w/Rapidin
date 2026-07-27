import { getClient, query } from '../../config/database.js';
import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';
import {
  assertMimotoIsolationSql,
  applyMimotoFirstWeekRule,
  calculateWeeklyCharge,
  convertMimotoAmount,
  normalizeMimotoCurrency,
  planMimotoMondaySettlement,
  projectQuotaAfterPayment,
  quotaBalances,
  roundMoney,
  selectMimotoRule,
} from './mimotoFinancialEngine.js';

const CURRENT_WEEK_ID = '__current_week__';
const q = (sql, params = []) => query(assertMimotoIsolationSql(sql), params);

function clientExecutor(client) {
  return (sql, params = []) => client.query(assertMimotoIsolationSql(sql), params);
}

function weeklyAmount(rule, vehicleId) {
  const values = rule?.cuotas_por_vehiculo;
  if (Array.isArray(values)) {
    const match = values.find((item) => String(item?.vehiculo_id || item?.id) === String(vehicleId));
    if (match) return Number(match.cuota ?? match.monto ?? 0);
    if (values.length === 1) return Number(values[0]?.cuota ?? values[0]?.monto ?? values[0] ?? 0);
  }
  return values && typeof values === 'object' ? Number(values[vehicleId] ?? 0) : 0;
}

function maximumRule(rules, vehicleId) {
  return [...(rules || [])].sort(
    (left, right) => weeklyAmount(right, vehicleId) - weeklyAmount(left, vehicleId)
  )[0] || null;
}

function maximumWeeklyAmount(rules, vehicleId) {
  return roundMoney(Math.max(0, ...(rules || []).map((rule) => weeklyAmount(rule, vehicleId))));
}

function revenuePoolInQuotaCurrency({ partnerFeesCop, percentage, quotaCurrency, usdToCop }) {
  const poolCop = roundMoney(
    Math.max(0, Number(partnerFeesCop) || 0) * Math.max(0, Number(percentage) || 0) / 100
  );
  return quotaCurrency === 'COP'
    ? poolCop
    : convertMimotoAmount(poolCop, 'COP', quotaCurrency, usdToCop);
}

function applicationTrace(application) {
  return {
    cuota_id: application.cuota_id,
    semana: application.week_number,
    vencimiento: application.due_date,
    monto: application.applied,
    mora_normal: application.lateFee,
    mora_extra: application.extraLateFee,
    capital: application.capital,
  };
}

function buildSettlement({ priorQuotas, output, obligation, revenuePool, fleetBalance = 0 }) {
  return planMimotoMondaySettlement({
    existingQuotas: priorQuotas,
    currentQuota: {
      id: CURRENT_WEEK_ID,
      solicitud_id: output.solicitud_id,
      week_start_date: output.week_start_date,
      due_date: output.due_date,
      week_number: output.week_number,
      amount_due: obligation,
      capital_paid: 0,
      late_fee: 0,
      late_fee_paid: 0,
      mora_extra: 0,
      mora_extra_paid: 0,
      paid_amount: 0,
      status: 'pending',
    },
    revenuePool,
    fleetBalance,
    asOf: output.due_date,
  });
}

function settleCurrentOutput(output, obligation, settlement) {
  const current = settlement.revenue.applications.find(
    (application) => application.cuota_id === CURRENT_WEEK_ID
  );
  const currentApplied = roundMoney(current?.applied || 0);
  return {
    ...output,
    recaudo_aplicado: currentApplied,
    amount_due: roundMoney(obligation - currentApplied),
    recaudo_cascada_destino: settlement.revenue.previous_applications.map(applicationTrace),
    saldo_favor_conductor: settlement.revenue.remaining,
  };
}

async function loadGenerationContext(solicitudId) {
  const result = await q(
    `SELECT s.id, s.cronograma_id, s.cronograma_vehiculo_id,
      COALESCE(NULLIF(s.cronograma_snapshot->>'tasa_interes_mora','')::numeric, c.tasa_interes_mora) AS tasa_interes_mora,
      COALESCE(NULLIF(s.cronograma_snapshot->>'modo_evaluacion',''), c.modo_evaluacion) AS modo_evaluacion,
      COALESCE(NULLIF(s.cronograma_snapshot->'vehicle'->>'moneda',''), v.moneda) AS moneda,
      COALESCE(NULLIF(s.cronograma_snapshot->'vehicle'->>'cuotas_semanales','')::int,
               v.cuotas_semanales) AS cuotas_semanales_plan,
      CASE WHEN jsonb_typeof(s.cronograma_snapshot->'rules')='array'
             AND jsonb_array_length(s.cronograma_snapshot->'rules') > 0
           THEN s.cronograma_snapshot->'rules'
           ELSE COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.orden)
                          FROM module_mimoto_cronograma_rule r
                          WHERE r.cronograma_id=s.cronograma_id),'[]'::jsonb)
      END AS rules,
      COALESCE((SELECT MAX(q.week_number)
                FROM module_mimoto_cuota_semanal q
                WHERE q.solicitud_id=s.id AND q.deleted_at IS NULL),0)::int AS last_week
     FROM module_mimoto_solicitud s
     LEFT JOIN module_mimoto_cronograma c ON c.id=s.cronograma_id
     LEFT JOIN module_mimoto_cronograma_vehiculo v ON v.id=s.cronograma_vehiculo_id
     WHERE s.id=$1 AND s.deleted_at IS NULL AND s.status IN ('aprobado','activo')`,
    [solicitudId]
  );
  return result.rows[0] || null;
}

async function hasOverdueDebt(solicitudId, dueDate) {
  const result = await q(
    `SELECT 1 FROM module_mimoto_cuota_semanal
     WHERE solicitud_id=$1 AND deleted_at IS NULL
       AND week_number > 1
       AND due_date<$2::date
       AND status IN ('partial','overdue')
       AND GREATEST(0,amount_due-capital_paid)+late_fee+mora_extra>0.005
     LIMIT 1`,
    [solicitudId, dueDate]
  );
  return result.rowCount > 0;
}

async function loadOpenQuotas(execute, { solicitudId, weekStart, dueDate, currency, lock = false }) {
  const result = await execute(
    `SELECT * FROM module_mimoto_cuota_semanal
     WHERE solicitud_id=$1 AND deleted_at IS NULL
       AND week_number > 1
       AND week_start_date<>$2::date
       AND due_date<=$3::date
       AND moneda=$4
       AND status IN ('pending','partial','overdue')
       AND GREATEST(0,amount_due-capital_paid)+late_fee+mora_extra>0.005
     ORDER BY due_date,week_start_date,id${lock ? ' FOR UPDATE' : ''}`,
    [solicitudId, weekStart, dueDate, currency]
  );
  return result.rows;
}

async function currentExchangeRate(execute = q) {
  const result = await execute(
    `SELECT valor_usd_a_local FROM module_mimoto_tipo_cambio WHERE country='CO'`
  );
  const rate = Number(result.rows[0]?.valor_usd_a_local) || 0;
  if (rate <= 0) throw new Error('El tipo de cambio USD/COP no está configurado');
  return rate;
}

async function applyRevenueToPreviousQuotas(client, quotas, applications, weekStart, actorId) {
  const byId = new Map(quotas.map((quota) => [String(quota.id), quota]));
  const execute = clientExecutor(client);
  for (const application of applications) {
    const quota = byId.get(String(application.cuota_id));
    if (!quota || application.applied <= 0.005) continue;
    const sourceKey = `mimoto-recaudo:${weekStart}:${quota.id}`;
    const priorChunks = Array.isArray(quota.payment_chunks) ? quota.payment_chunks : [];
    if (priorChunks.some((chunk) => chunk?.source_key === sourceKey)) continue;

    const projected = projectQuotaAfterPayment(quota, application, weekStart);
    const balances = quotaBalances(projected);
    const hasBalance = roundMoney(balances.capital + balances.lateFee + balances.extraLateFee) > 0.005;
    const chunk = {
      source: 'recaudo',
      source_key: sourceKey,
      amount_original: application.applied,
      currency_original: quota.moneda,
      amount_applied: application.applied,
      currency_applied: quota.moneda,
      late_fee: application.lateFee,
      extra_late_fee: application.extraLateFee,
      capital: application.capital,
      unapplied: 0,
      applied_at: `${weekStart}T07:00:00-05:00`,
    };
    await execute(
      `UPDATE module_mimoto_cuota_semanal SET
         capital_paid=$1, late_fee=$2, late_fee_paid=$3,
         mora_extra=$4, mora_extra_paid=$5, paid_amount=$6,
         fecha_ultimo_abono=$7::date, status=$8,
         mora_extra_desde=CASE
           WHEN $9 THEN COALESCE(mora_extra_desde,GREATEST(due_date,$7::date))
           ELSE mora_extra_desde
         END,
         mora_extra_calculated_through=CASE
           WHEN $9 THEN COALESCE(mora_extra_calculated_through,GREATEST(due_date,$7::date))
           ELSE mora_extra_calculated_through
         END,
         payment_chunks=payment_chunks || $10::jsonb,
         updated_at=CURRENT_TIMESTAMP, updated_by=$11
       WHERE id=$12`,
      [projected.capital_paid, projected.late_fee, projected.late_fee_paid,
        projected.mora_extra, projected.mora_extra_paid, projected.paid_amount,
        weekStart, projected.status, hasBalance, JSON.stringify([chunk]), actorId || null, quota.id]
    );
  }
}

function dryRunResponse({ output, settlement, simulatedFleetInput, simulatedFleetCurrency, simulatedFleetBalance }) {
  return {
    dry_run: true,
    cuota: output,
    cascada_recaudo: {
      pool: output.recaudo_pool,
      aplicado_deuda_anterior: roundMoney(
        settlement.revenue.previous_applications.reduce(
          (total, application) => total + application.applied,
          0
        )
      ),
      aplicado_cuota_actual: output.recaudo_aplicado,
      saldo_favor: output.saldo_favor_conductor,
      destinos: output.recaudo_cascada_destino,
    },
    cobro_fleet_simulado: {
      solicitado: roundMoney(simulatedFleetInput),
      moneda_solicitada: simulatedFleetCurrency,
      disponible_en_moneda_cuota: simulatedFleetBalance,
      aplicado: settlement.fleet.applied,
      remanente: settlement.fleet.remaining,
      aplicaciones: settlement.fleet.applications.map(applicationTrace),
    },
  };
}

export async function previewOrGenerateWeeklyQuota(solicitudId, payload, actorId) {
  const weekStart = String(payload.week_start_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error('week_start_date no es válido');
  const dueDate = String(payload.due_date || weekStart).slice(0, 10);
  const trips = Math.max(0, Math.trunc(Number(payload.viajes) || 0));
  const connectedHours = payload.horas_conectadas == null || payload.horas_conectadas === ''
    ? null
    : Number(payload.horas_conectadas);
  const partnerFees = Math.max(0, Number(payload.partner_fees) || 0);
  const isDryRun = payload.dry_run !== false;
  const simulatedFleetInput = isDryRun ? Math.max(0, Number(payload.saldo_fleet_simulado) || 0) : 0;
  const simulatedFleetCurrency = normalizeMimotoCurrency(payload.moneda_saldo_fleet || 'COP');

  const context = await loadGenerationContext(solicitudId);
  if (!context) throw new Error('La solicitud no está lista para generar cuotas');
  if (Number(context.last_week) >= Number(context.cuotas_semanales_plan || 0)) {
    throw new Error('El cronograma ya alcanzó el total de cuotas semanales');
  }

  const forceMaximum = await hasOverdueDebt(solicitudId, dueDate);
  const rule = forceMaximum
    ? maximumRule(context.rules, context.cronograma_vehiculo_id)
    : selectMimotoRule(context.rules, { trips, connectedHours, mode: context.modo_evaluacion });
  if (!rule) throw new Error('No existe una regla de cronograma para los viajes y horas registrados');

  const payable = roundMoney(weeklyAmount(rule, context.cronograma_vehiculo_id));
  const baseWeekly = maximumWeeklyAmount(context.rules, context.cronograma_vehiculo_id);
  if (payable <= 0 || baseWeekly <= 0) throw new Error('La regla no tiene cuota configurada para la moto');
  const terms = calculateWeeklyCharge({
    baseAmount: baseWeekly,
    payableAmount: payable,
    additionalCharge: Number(rule.cobro_saldo) || 0,
  });

  const needsRate = (context.moneda === 'USD' && partnerFees > 0)
    || (simulatedFleetInput > 0 && simulatedFleetCurrency !== context.moneda);
  const usdToCop = needsRate ? await currentExchangeRate() : 1;
  const revenuePool = revenuePoolInQuotaCurrency({
    partnerFeesCop: partnerFees,
    percentage: rule.pct_recaudo,
    quotaCurrency: context.moneda,
    usdToCop,
  });
  const simulatedFleetBalance = simulatedFleetCurrency === context.moneda
    ? roundMoney(simulatedFleetInput)
    : convertMimotoAmount(simulatedFleetInput, simulatedFleetCurrency, context.moneda, usdToCop);

  let output = {
    solicitud_id: solicitudId,
    week_start_date: weekStart,
    due_date: dueDate,
    week_number: Number(context.last_week) + 1,
    viajes: trips,
    horas_conectadas: context.modo_evaluacion === 'viajes_horas' ? connectedHours : null,
    cuota_semanal: terms.weekly,
    bono_moto: terms.bonus,
    cobro_saldo: terms.additionalCharge,
    partner_fees_raw: roundMoney(partnerFees),
    pct_recaudo: Number(rule.pct_recaudo) || 0,
    recaudo_pool: revenuePool,
    recaudo_aplicado: 0,
    recaudo_cascada_destino: [],
    saldo_favor_conductor: 0,
    amount_due: terms.obligation,
    moneda: context.moneda,
    cuota_maxima_por_mora: forceMaximum,
  };
  const previewPrior = await loadOpenQuotas(q, {
    solicitudId,
    weekStart,
    dueDate,
    currency: output.moneda,
  });
  const isFirstWeekPreview = Number(output.week_number) === 1;
  const previewSettlement = buildSettlement({
    priorQuotas: previewPrior,
    output,
    obligation: isFirstWeekPreview ? 0 : terms.obligation,
    revenuePool,
    fleetBalance: simulatedFleetBalance,
  });
  output = settleCurrentOutput(output, terms.obligation, previewSettlement);
  if (isFirstWeekPreview) output = applyMimotoFirstWeekRule(output);
  if (isDryRun) {
    return dryRunResponse({
      output,
      settlement: previewSettlement,
      simulatedFleetInput,
      simulatedFleetCurrency,
      simulatedFleetBalance,
    });
  }
  if (!MIMOTO_CONFIG.enabled) throw new Error('Yego Mi Moto está desactivado; solo se permite dry-run');

  const source = String(payload.generated_by || 'manual').trim() || 'manual';
  const generationContext = {
    source,
    dry_run: false,
    evaluation_mode: context.modo_evaluacion,
    selected_rule_id: rule.id,
    maximum_charge_due_to_overdue_debt: forceMaximum,
    observed_trips: trips,
    observed_hours: output.horas_conectadas,
    metrics_period: payload.metrics_period || null,
  };
  const client = await getClient();
  const execute = clientExecutor(client);
  try {
    await client.query('BEGIN');
    const lockedSolicitud = await execute(
      `SELECT id FROM module_mimoto_solicitud
       WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [solicitudId]
    );
    if (!lockedSolicitud.rows[0]) throw new Error('Solicitud Mi Moto no encontrada');
    const existingWeek = await execute(
      `SELECT id FROM module_mimoto_cuota_semanal
       WHERE solicitud_id=$1 AND week_start_date=$2::date AND deleted_at IS NULL`,
      [solicitudId, weekStart]
    );
    if (existingWeek.rows[0]) throw new Error('La cuota de esa semana ya existe');
    const latestWeek = await execute(
      `SELECT COALESCE(MAX(week_number),0)::int AS last_week
       FROM module_mimoto_cuota_semanal
       WHERE solicitud_id=$1 AND deleted_at IS NULL`,
      [solicitudId]
    );
    output = { ...output, week_number: Number(latestWeek.rows[0]?.last_week || 0) + 1 };
    const isFirstWeek = Number(output.week_number) === 1;
    const priorQuotas = await loadOpenQuotas(execute, {
      solicitudId,
      weekStart,
      dueDate,
      currency: output.moneda,
      lock: true,
    });
    const settlement = buildSettlement({
      priorQuotas,
      output,
      obligation: isFirstWeek ? 0 : terms.obligation,
      revenuePool,
    });
    output = settleCurrentOutput(output, terms.obligation, settlement);
    if (isFirstWeek) output = applyMimotoFirstWeekRule(output);
    generationContext.first_week_covered_by_rule = isFirstWeek;
    generationContext.revenue_cascade = {
      pool: revenuePool,
      destinations: output.recaudo_cascada_destino,
      current_applied: output.recaudo_aplicado,
      driver_credit: output.saldo_favor_conductor,
    };
    await applyRevenueToPreviousQuotas(
      client,
      priorQuotas,
      settlement.revenue.previous_applications,
      weekStart,
      actorId
    );

    const inserted = await execute(
      `INSERT INTO module_mimoto_cuota_semanal
        (solicitud_id,week_start_date,due_date,week_number,viajes,horas_conectadas,
         cuota_semanal,bono_moto,amount_due,moneda,partner_fees_raw,pct_recaudo,
         recaudo_pool,recaudo_aplicado,recaudo_cascada_destino,saldo_favor_conductor,
         cobro_saldo,capital_paid,paid_amount,status,generation_context,tasa_interes_mora_snapshot,rule_snapshot,
         mora_calculated_through,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,
               $17,$18,$19,$20,$21,$22::jsonb,$23,$24::jsonb,$25,$26)
       ON CONFLICT (solicitud_id,week_start_date) DO NOTHING RETURNING *`,
      [solicitudId, weekStart, dueDate, output.week_number, trips,
        output.horas_conectadas, output.cuota_semanal, output.bono_moto, output.amount_due,
        output.moneda, output.partner_fees_raw, output.pct_recaudo, output.recaudo_pool,
        output.recaudo_aplicado, JSON.stringify(output.recaudo_cascada_destino),
        output.saldo_favor_conductor, output.cobro_saldo,
        Number(output.capital_paid || 0), Number(output.paid_amount || 0),
        output.status || (output.amount_due <= 0.005 ? 'paid' : 'pending'), JSON.stringify(generationContext),
        Number(context.tasa_interes_mora) || 0, JSON.stringify(rule), dueDate, actorId || null]
    );
    if (!inserted.rows[0]) throw new Error('La cuota de esa semana ya existe');
    await execute(
      `INSERT INTO module_mimoto_billing_audit_trail
        (cuota_semanal_id,solicitud_id,week_start_date,semana_ordinal,event_type,
         billing_context,generated_by,actor_id)
       VALUES ($1,$2,$3,$4,'quota.generated',$5::jsonb,$6,$7)`,
      [inserted.rows[0].id, solicitudId, weekStart, output.week_number,
        JSON.stringify({ ...generationContext, cuota: output }), source, actorId || null]
    );
    await client.query('COMMIT');
    return { dry_run: false, cuota: inserted.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
