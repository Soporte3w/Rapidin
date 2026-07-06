/**
 * Yego Rapidín 4.0 — CobroEngine
 *
 * Orquestador central de toda la lógica de cobro semanal Mi Auto.
 * Punto ÚNICO de entrada para generar, actualizar o consultar cobros.
 *
 * Principios:
 *   1. Cálculos puros delegados a CuotaCalculator, LateFeeCalculator, CascadaPoolManager
 *   2. Persistencia solo en este módulo (no dispersa en otros servicios)
 *   3. Cada operación deja trazabilidad completa en module_miauto_billing_audit_trail
 *   4. Transaccionalidad: operaciones de escritura en BEGIN/COMMIT
 *
 * Flujo completo:
 *   generateWeeklyCharge(solicitudId, weekStartDate)
 *   ├── 1. Cargar contexto (cronograma, vehículo, fechaInicio)
 *   ├── 2. Obtener ingresos Yango (viajes, partner_fees)
 *   ├── 3. Resolver plan (CuotaCalculator.resolvePlan)
 *   ├── 4. Calcular cuota base (CuotaCalculator.computeAmountDueSemanal)
 *   ├── 5. Aplicar cascada PF (CascadaPoolManager.applyWaterfallPool)
 *   ├── 6. Calcular mora (LateFeeCalculator.computeLateFee)
 *   ├── 7. Consolidar resultado
 *   ├── 8. Persistir en BD (INSERT/UPDATE cuota_semanal)
 *   └── 9. Registrar auditoría (CobroAuditTrail.persistCobroAudit)
 */

import { query } from '../../../config/database.js';
import { logger } from '../../../utils/logger.js';
import crypto from 'crypto';
import {
  computeAmountDueSemanal,
  partnerFeesPlusComisionPool,
  resolvePlan,
  resolveMaxCuotaPorVehiculo,
  debeAplicarMaxCuotaSinBonoPorMora,
  round2,
} from './CuotaCalculator.js';
import { computeLateFee } from './LateFeeCalculator.js';
import { applyWaterfallPool, snapshotOrigenTrasCascada, mergeCascadaAllocations } from './CascadaPoolManager.js';
import { getCronogramaById } from '../cronograma/miautoCronogramaService.js';
import {
  buildCobroAuditContext,
  persistCobroAudit,
} from './CobroAuditTrail.js';
import { isSemanaDepositoMiAuto } from '../cuotas/miautoCuotaSemanalService.js';
import { computeDueDateForMiAutoCuota, isWeekYangoClosedForMiAutoCuotaMetrics } from '../../../utils/miautoLimaWeekRange.js';
import { partnerFeesYangoAMonedaCuota } from '../utils/miautoMoneyUtils.js';

function limaTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function ymdFromDb(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    return m ? m[1] : null;
  }
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return null;
  }
}

/**
 * Carga el contexto completo necesario para generar una cuota.
 *
 * @param {string} solicitudId
 * @returns {BillingContext}
 */
async function loadBillingContext(solicitudId) {
  const solRes = await query(
    `SELECT s.id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
            s.status, s.placa_asignada, s.country
     FROM module_miauto_solicitud s WHERE s.id = $1`,
    [solicitudId]
  );
  const sol = solRes.rows[0];
  if (!sol) return { error: 'solicitud_no_encontrada' };

  const cronograma = sol.cronograma_id ? await getCronogramaById(sol.cronograma_id) : null;
  if (!cronograma) return { error: 'cronograma_no_encontrado' };

  return {
    solicitudId: sol.id,
    cronogramaId: sol.cronograma_id,
    cronogramaVehiculoId: sol.cronograma_vehiculo_id,
    fechaInicioCobroSemanal: sol.fecha_inicio_cobro_semanal,
    cronograma,
    soloContexto: true,
  };
}

/**
 * Determina si hay cuota vencida con saldo pendiente (para forzar cuota máxima).
 */
async function hayCuotaVencidaConSaldo(solicitudId) {
  const res = await query(
    `SELECT 1 FROM (
       SELECT LOWER(TRIM(COALESCE(c.status, ''))) AS st,
              COALESCE(c.due_date, c.week_start_date) AS ref_d,
              COALESCE(c.paid_amount, 0)::numeric AS p,
              COALESCE(c.amount_due, 0)::numeric AS ad,
              COALESCE(c.late_fee, 0)::numeric AS lf
       FROM module_miauto_cuota_semanal c
       WHERE c.solicitud_id = $1::uuid
     ) x
     WHERE x.st NOT IN ('paid', 'bonificada')
       AND (
         x.st = 'overdue'
         OR (
           x.ref_d IS NOT NULL
           AND x.ref_d::date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date
           AND x.p < x.ad + x.lf - 0.02
         )
       )
     LIMIT 1`,
    [solicitudId]
  );
  return (res.rows || []).length > 0;
}

/**
 * Carga las cuotas pendientes de una solicitud para la cascada.
 */
async function loadCuotasParaCascada(solicitudId, excludeCuotaId = null) {
  const ctx = await loadBillingContext(solicitudId);
  if (ctx.error) return [];

  let sql = `SELECT id, due_date, week_start_date, amount_due, late_fee, paid_amount, status
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1
       AND status IN ('pending', 'overdue', 'partial', 'paid')
       AND deleted_at IS NULL`;
  const params = [solicitudId];
  if (excludeCuotaId) {
    params.push(excludeCuotaId);
    sql += ` AND id <> $${params.length}`;
  }
  sql += ` ORDER BY due_date ASC NULLS LAST, id ASC`;
  const res = await query(sql, params);
  const todayYmd = limaTodayYmd();
  const out = [];

  for (const r of res.rows || []) {
    const weekYmd = ymdFromDb(r.week_start_date);
    const storedDueYmd = ymdFromDb(r.due_date);
    const isPrimera = weekYmd ? isSemanaDepositoMiAuto(weekYmd, ctx.fechaInicioCobroSemanal) : false;
    const dueYmd = weekYmd
      ? computeDueDateForMiAutoCuota(weekYmd, ymdFromDb(ctx.fechaInicioCobroSemanal), !!isPrimera)
      : storedDueYmd;
    const amountDue = round2(Number(r.amount_due) || 0);
    const paid = round2(Number(r.paid_amount) || 0);
    const lateFeeFresh = isPrimera
      ? 0
      : computeLateFee({
          tasaInteresMora: ctx.cronograma?.tasa_interes_mora || 0,
          dueDateYmd: dueYmd,
          todayYmd,
          capitalMoroso: amountDue,
        }).moraTotal;
    const pending = round2(Math.max(0, amountDue + lateFeeFresh - paid));
    const statusFresh = pending <= 0.005
      ? 'paid'
      : paid > 0.005
        ? 'partial'
        : (dueYmd && dueYmd < todayYmd ? 'overdue' : 'pending');

    if (
      Math.abs(round2(Number(r.late_fee) || 0) - lateFeeFresh) > 0.005 ||
      String(r.status || '').toLowerCase() !== statusFresh
    ) {
      await query(
        `UPDATE module_miauto_cuota_semanal
         SET late_fee = $1, status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3::uuid`,
        [lateFeeFresh, statusFresh, r.id]
      );
      logger.info('miauto.cascada.pre_mora_refresh', {
        solicitudId,
        cuotaId: r.id,
        dueDate: dueYmd,
        amountDue,
        paidAmount: paid,
        lateFeeAntes: round2(Number(r.late_fee) || 0),
        lateFeeDespues: lateFeeFresh,
        statusAntes: r.status,
        statusDespues: statusFresh,
        pending,
      });
    }

    if (pending > 0.005) {
      out.push({
        ...r,
        due_date: dueYmd || r.due_date,
        late_fee: lateFeeFresh,
        status: statusFresh,
        pending,
      });
    }
  }

  return out;
}

/**
 * GENERAR cuota semanal para una solicitud y semana.
 *
 * @param {object} params
 * @param {string} params.solicitudId
 * @param {string} params.weekStartDate - YYYY-MM-DD (lunes de la semana)
 * @param {object} params.incomeResult - { count_completed, partner_fees } desde Yango
 * @param {object} [params.options]
 * @param {boolean} [params.options.skipUpdateIfExists]
 * @param {string} [params.options.generatedBy] - 'cron_lunes' (default) | 'manual_regeneration' | 'excel_import'
 * @param {string} [params.options.actorId] - UUID del usuario que ejecuta
 * @param {string} [params.options.correlationId]
 * @returns {BillingResult}
 */
export async function generateWeeklyCharge({
  solicitudId,
  weekStartDate,
  incomeResult,
  options = {},
}) {
  const skipUpdateIfExists = !!options.skipUpdateIfExists;
  const generatedBy = options.generatedBy || 'cron_lunes';
  const actorId = options.actorId || null;
  const correlationId = options.correlationId || null;

  const weekYmd = String(weekStartDate).trim().slice(0,10);

  // --- IDEMPOTENCIA: verificar si ya se ejecutó esta generación exacta ---
  const rawExecutionKey = [
    solicitudId,
    weekYmd,
    Number(incomeResult?.count_completed) || 0,
    round2(Number(incomeResult?.partner_fees) || 0),
    generatedBy,
  ].join('|');
  const executionHash = crypto.createHash('sha256').update(rawExecutionKey).digest('hex');

  const existingExec = await query(
    `SELECT cuota_semanal_id, billing_context FROM module_miauto_billing_audit_trail
     WHERE solicitud_id = $1::uuid AND week_start_date = $2::date
       AND event_type = 'generated' AND execution_hash = $3
     LIMIT 1`,
    [solicitudId, weekYmd, executionHash]
  );

  if (existingExec.rows.length > 0) {
    logger.debug('miauto.cuota.idempotent_skip', {
      solicitudId,
      weekStartDate: weekYmd,
      executionHash: executionHash.slice(0, 12),
      generatedBy,
    });
    return {
      cuotaId: existingExec.rows[0].cuota_semanal_id,
      weekStartDate: weekYmd,
      idempotent: true,
      skipped: true,
      executionHash,
    };
  }
  // --- FIN IDEMPOTENCIA ---

  const auditSteps = {
    inputs: {},
    planResolution: {},
    cuotaCalculation: {},
    cascada: {},
    mora: {},
    resultado: {},
  };

  // --- 1. Cargar contexto ---
  const ctx = await loadBillingContext(solicitudId);
  if (ctx.error) return ctx;

  const { cronograma, cronogramaVehiculoId, fechaInicioCobroSemanal } = ctx;
  const fechaInicioYmd = ymdFromDb(fechaInicioCobroSemanal);

  const isPrimera = isSemanaDepositoMiAuto(weekYmd, fechaInicioCobroSemanal);
  const weekCerradaYango = isWeekYangoClosedForMiAutoCuotaMetrics(weekYmd, fechaInicioCobroSemanal);
  const forzarDatosYango = !!options.forceUseYangoData;

  let numViajes = Number(incomeResult?.count_completed) || 0;
  let partnerFeesRaw = round2(Number(incomeResult?.partner_fees) || 0);

  if (isPrimera) {
    numViajes = 0;
    partnerFeesRaw = 0;
  } else if (!weekCerradaYango && !forzarDatosYango) {
    numViajes = 0;
    partnerFeesRaw = 0;
  }

  auditSteps.inputs = {
    solicitudId,
    cronogramaId: ctx.cronogramaId,
    cronogramaVehiculoId,
    weekStartDate: weekYmd,
    semanaOrdinal: null, // se calculará al persistir
    isPrimera,
    weekCerradaYango,
    fechaInicioCobroSemanal: fechaInicioYmd,
    yango: { numViajes, partnerFeesRaw, source: isPrimera ? 'deposito' : (weekCerradaYango ? 'yango' : 'semana_no_cerrada') },
  };

  // --- 2. Resolver plan ---
  let plan;
  let forzarMaxCuota = false;

  if (!isPrimera) {
    const hayVencida = await hayCuotaVencidaConSaldo(solicitudId);
    if (hayVencida) {
      forzarMaxCuota = true;
      plan = resolveMaxCuotaPorVehiculo(cronograma, cronogramaVehiculoId);
      if (plan?.error) return { error: plan.error };
      logger.info('miauto.cuota.maxima_por_mora', {
        solicitudId,
        weekStartDate: weekYmd,
        cronogramaVehiculoId,
      });
    }
  }

  if (!plan) {
    plan = resolvePlan(cronograma, cronogramaVehiculoId, numViajes);
  }
  if (plan?.error) return { error: plan.error };
  if (!plan) return { error: 'sin_plan_para_viajes', numViajes };

  const cuotaSemanal = plan.cuotaSemanal;
  const bonoAuto = isPrimera ? 0 : (forzarMaxCuota ? 0 : plan.bonoAuto);
  const pctComision = plan.pctComision;
  const cobroSaldo = plan.cobroSaldo;
  const moneda = plan.moneda;

  auditSteps.planResolution = {
    ...plan,
    bonoAuto,
    forzarMaxCuotaSinBono: forzarMaxCuota,
    isPrimera,
  };

  // --- 3. Convertir moneda PF si es necesario ---
  if (partnerFeesRaw > 0.005) {
    partnerFeesRaw = await partnerFeesYangoAMonedaCuota(solicitudId, partnerFeesRaw, moneda);
  }

  // --- 4. Calcular cuota base ---
  const usarCascada = !isPrimera && partnerFeesRaw > 0;
  const cuotaCalc = computeAmountDueSemanal({
    cuotaSemanal,
    partnerFeesRaw,
    pctComision,
    cobroSaldo,
    partnerFeesApplyToCuotaReduction: !usarCascada,
    commissionGoesToWaterfall: usarCascada,
  });

  const poolCascada = usarCascada
    ? partnerFeesPlusComisionPool(cuotaCalc.partnerFees83, pctComision)
    : { pool: 0, breakdown: {} };

  auditSteps.cuotaCalculation = cuotaCalc;

  const existingForWeek = await query(
    `SELECT id, paid_amount, late_fee, status
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1 AND week_start_date = $2 AND deleted_at IS NULL`,
    [solicitudId, weekYmd]
  );
  const cuotaOrigenId = existingForWeek.rows[0]?.id || null;

  // --- 5. Aplicar cascada ---
  let cascadaResult = { applied: 0, remainingPool: poolCascada.pool, allocations: [] };
  let cascadeHash = null;
  if (usarCascada && poolCascada.pool > 0.005) {
    const rawCascadeKey = `${solicitudId}|${weekYmd}|${poolCascada.pool}|cascada`;
    cascadeHash = crypto.createHash('sha256').update(rawCascadeKey).digest('hex');

    // IDEMPOTENCIA de cascada: verificar si ya se aplicó este pool exacto
    const existingCascade = await query(
      `SELECT 1 FROM module_miauto_billing_audit_trail
       WHERE solicitud_id = $1::uuid AND event_type = 'cascaded' AND execution_hash = $2
       LIMIT 1`,
      [solicitudId, cascadeHash]
    );

    if (existingCascade.rows.length > 0) {
      logger.debug('miauto.cascada.idempotent_skip', {
        solicitudId,
        weekStartDate: weekYmd,
        poolTotal: poolCascada.pool,
        executionHash: cascadeHash.slice(0, 12),
      });
    } else {
      const cuotasDebt = await loadCuotasParaCascada(solicitudId, cuotaOrigenId);
      cascadaResult = applyWaterfallPool({
        poolAmount: poolCascada.pool,
        cuotas: cuotasDebt,
        excludeCuotaId: cuotaOrigenId,
      });

      for (const alloc of cascadaResult.allocations) {
        await query(
          `UPDATE module_miauto_cuota_semanal
           SET paid_amount = $1,
               status = $2,
               fecha_ultimo_abono = CASE
                 WHEN $1::numeric > COALESCE(paid_amount, 0)::numeric + 0.005 THEN $4::date
                 ELSE fecha_ultimo_abono
               END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [alloc.paidDespues, alloc.statusDespues, alloc.cuotaId, limaTodayYmd()]
        );
      }
      logger.info('miauto.cascada.applied', {
        solicitudId,
        weekStartDate: weekYmd,
        poolTotal: poolCascada.pool,
        poolAplicado: cascadaResult.applied,
        remanente: cascadaResult.remainingPool,
        cuotasAfectadas: cascadaResult.allocations.length,
        cuotaOrigenId,
      });
    }
  }

  auditSteps.cascada = {
    poolTotal: poolCascada.pool,
    poolDistribuido: cascadaResult.applied,
    remanente: cascadaResult.remainingPool,
    imputaciones: cascadaResult.allocations,
  };

  // --- 6. Snap fila origen ---
  let amountDueInsert;
  let partnerFeesRawStored;
  let partnerFees83Stored;
  let partnerFeesYangoStored;
  let saldoFavorInsert = 0;
  let cascadaJson = null;

  if (usarCascada && poolCascada.pool > 0.005) {
    const snap = snapshotOrigenTrasCascada({
      remainingPool: cascadaResult.remainingPool,
      pctComision,
      cuotaSemanal,
      cobroSaldo,
    });
    if (cascadaResult.remainingPool <= 0.005) {
      partnerFeesRawStored = 0;
      partnerFees83Stored = 0;
      partnerFeesYangoStored = null;
    } else {
      partnerFeesRawStored = snap.partnerFeesRaw;
      partnerFees83Stored = snap.partnerFees83;
      partnerFeesYangoStored = partnerFeesRaw > 0.005 ? partnerFeesRaw : null;
    }
    amountDueInsert = snap.amountDue;
    saldoFavorInsert = snap.saldoFavorConductor;
  } else {
    partnerFeesRawStored = partnerFeesRaw;
    partnerFees83Stored = cuotaCalc.partnerFees83;
    partnerFeesYangoStored = partnerFeesRaw > 0.005 ? partnerFeesRaw : null;
    amountDueInsert = cuotaCalc.amountDue;
  }

  if (cascadaResult.allocations.length > 0) {
    const merged = mergeCascadaAllocations([cascadaResult.allocations]);
    cascadaJson = merged.length > 0 ? JSON.stringify(merged) : null;
  }

  // --- 7. Calcular mora y due_date ---
  const dueDate = computeDueDateForMiAutoCuota(weekYmd, fechaInicioYmd, isPrimera);
  const moraResult = isPrimera
    ? { moraTotal: 0, tasaDiaria: 0, diasAtraso: 0, moraDiaria: 0, breakdown: { motivo: 'primera_cuota_sin_mora' } }
    : computeLateFee({
        tasaInteresMora: cronograma.tasa_interes_mora || 0,
        dueDateYmd: dueDate,
        todayYmd: limaTodayYmd(),
        capitalMoroso: amountDueInsert,
      });

  auditSteps.mora = moraResult;

  // --- 8. Determinar status inicial ---
  let statusInsert = 'pending';
  let paidAmountInsert = 0;

  // Verificar bonificación
  const solVeh = await query(
    `SELECT s.fecha_inicio_cobro_semanal, s.cuotas_semanales_bonificadas, v.cuotas_semanales
     FROM module_miauto_solicitud s
     JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id
     WHERE s.id = $1`,
    [solicitudId]
  );
  if (solVeh.rows.length > 0) {
    const f = solVeh.rows[0].fecha_inicio_cobro_semanal;
    const total = parseInt(solVeh.rows[0].cuotas_semanales, 10) || 0;
    const bonif = parseInt(solVeh.rows[0].cuotas_semanales_bonificadas, 10) || 0;
    if (f && total > 0 && bonif >= 1) {
      const fYmd = ymdFromDb(f);
      const wYmd = weekYmd;
      const daysDiff = fYmd && wYmd
        ? Math.round((new Date(wYmd).getTime() - new Date(fYmd).getTime()) / (24 * 60 * 60 * 1000))
        : 0;
      const weekIndex = Math.floor(daysDiff / 7);
      if (weekIndex >= total - bonif && weekIndex < total) {
        statusInsert = 'bonificada';
        paidAmountInsert = amountDueInsert;
      }
    }
  }

  // --- 9. Persistir ---
  let cuotaId;
  const existing = existingForWeek;

  if (existing.rows.length > 0 && skipUpdateIfExists) {
    return { cuotaId: existing.rows[0].id, audited: false };
  }

  if (existing.rows.length > 0) {
    cuotaId = existing.rows[0].id;
    await query(
      `UPDATE module_miauto_cuota_semanal
       SET num_viajes = $1, partner_fees_raw = $2, partner_fees_83 = $3, partner_fees_yango_raw = $4,
           partner_fees_cascada_destino = $5::jsonb, bono_auto = $6, cuota_semanal = $7,
           amount_due = $8, moneda = $9, pct_comision = $10, cobro_saldo = $11,
           due_date = $12, saldo_favor_conductor = $13, montos_fuente = 'sistema',
           updated_at = CURRENT_TIMESTAMP, updated_by = $14
       WHERE id = $15`,
      [
        numViajes, partnerFeesRawStored, partnerFees83Stored, partnerFeesYangoStored,
        cascadaJson, bonoAuto, cuotaSemanal, amountDueInsert,
        moneda, pctComision, cobroSaldo, dueDate, saldoFavorInsert,
        actorId, cuotaId,
      ]
    );
  } else {
    const ins = await query(
      `INSERT INTO module_miauto_cuota_semanal
       (solicitud_id, week_start_date, due_date, num_viajes, partner_fees_raw, partner_fees_83,
        partner_fees_yango_raw, partner_fees_cascada_destino, bono_auto, cuota_semanal,
        amount_due, paid_amount, status, moneda, pct_comision, cobro_saldo,
        saldo_favor_conductor, montos_fuente, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,'sistema',$18)
       RETURNING id`,
      [
        solicitudId, weekYmd, dueDate, numViajes,
        partnerFeesRawStored, partnerFees83Stored, partnerFeesYangoStored,
        cascadaJson, bonoAuto, cuotaSemanal, amountDueInsert,
        paidAmountInsert, statusInsert, moneda, pctComision, cobroSaldo,
        saldoFavorInsert, actorId,
      ]
    );
    cuotaId = ins.rows[0]?.id;
  }

  // --- 10. Calcular semana ordinal ---
  const semanaOrdinal = fechaInicioYmd
    ? Math.floor(
        Math.round((new Date(weekYmd).getTime() - new Date(fechaInicioYmd).getTime()) / (24 * 60 * 60 * 1000)) / 7
      ) + 1
    : null;

  // --- 11. Consolidar resultado ---
  auditSteps.resultado = {
    cuotaId,
    amountDue: amountDueInsert,
    paidAmount: paidAmountInsert,
    lateFee: moraResult.moraTotal,
    pendingTotal: round2(amountDueInsert + moraResult.moraTotal - paidAmountInsert),
    status: statusInsert,
    moneda,
  };

  // --- 12. Registrar auditoría ---
  const auditContext = buildCobroAuditContext({
    solicitudId,
    weekStartDate: weekYmd,
    semanaOrdinal,
    eventType: existing.rows.length > 0 ? 'updated' : 'generated',
    generatedBy,
    inputs: auditSteps.inputs,
    planResolution: auditSteps.planResolution,
    cuotaCalculation: {
      amountDue: cuotaCalc.amountDue,
      partnerFees83: cuotaCalc.partnerFees83,
      cuotaNeta: cuotaCalc.cuotaNeta,
      comisionSobrePF: cuotaCalc.comisionSobrePF,
      formula: cuotaCalc.formula,
      inputs: cuotaCalc.inputs,
    },
    cascada: {
      ...auditSteps.cascada,
      cascade_hash: cascadeHash,
      idempotent_skip: cascadaResult.applied === 0 && poolCascada.pool > 0.005,
    },
    mora: auditSteps.mora.breakdown ? {
      moraTotal: auditSteps.mora.moraTotal,
      diasAtraso: auditSteps.mora.diasAtraso,
      tasaDiaria: auditSteps.mora.tasaDiaria,
      capitalMoroso: cuotaSemanal,
      breakdown: auditSteps.mora.breakdown,
    } : auditSteps.mora,
    resultado: auditSteps.resultado,
    actor: { userId: actorId, correlationId },
  });

  await persistCobroAudit({
    cuotaSemanalId: cuotaId,
    solicitudId,
    weekStartDate: weekYmd,
    semanaOrdinal,
    eventType: existing.rows.length > 0 ? 'updated' : 'generated',
    billingContext: auditContext,
    generatedBy,
    actorId,
    correlationId,
    executionHash,
  });

  logger.info('miauto.cuota.generated', {
    solicitudId,
    cuotaId,
    weekStartDate: weekYmd,
    dueDate,
    generatedBy,
    action: existing.rows.length > 0 ? 'updated' : 'created',
    moneda,
    numViajes,
    partnerFeesRaw: partnerFeesRawStored,
    amountDue: amountDueInsert,
    lateFee: moraResult.moraTotal,
    pendingTotal: auditSteps.resultado.pendingTotal,
    status: statusInsert,
    isPrimera,
    forzarMaxCuota,
    cascadaAplicada: cascadaResult.applied,
    saldoFavorConductor: saldoFavorInsert,
  });

  // Si hubo cascada, registrar evento de cascada con su propio hash
  if (cascadeHash && cascadaResult.applied > 0.005) {
    await persistCobroAudit({
      cuotaSemanalId: null,
      solicitudId,
      weekStartDate: weekYmd,
      semanaOrdinal,
      eventType: 'cascaded',
      billingContext: {
        pool_total: poolCascada.pool,
        pool_aplicado: cascadaResult.applied,
        imputaciones: cascadaResult.allocations.map(a => ({
          cuota_id: a.cuotaId,
          monto: a.montoAplicado,
          pending_antes: a.pendingAntes,
          pending_despues: a.pendingDespues,
        })),
      },
      generatedBy,
      actorId,
      correlationId,
      executionHash: cascadeHash,
    });
  }

  return {
    cuotaId,
    weekStartDate: weekYmd,
    dueDate,
    amountDue: amountDueInsert,
    amountDueSched: cuotaCalc.amountDue,
    paidAmount: paidAmountInsert,
    lateFee: moraResult.moraTotal,
    pendingTotal: auditSteps.resultado.pendingTotal,
    status: statusInsert,
    moneda,
    cuotaSemanal,
    bonoAuto,
    pctComision,
    cobroSaldo,
    isPrimera,
    forzarMaxCuota,
    audited: true,
  };
}
