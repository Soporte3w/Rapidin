/**
 * Simulador completo de generación de cuotas, cascada y cobros
 * No modifica la BD. Guarda todo en simulation.log para análisis.
 */
import { query } from '../config/database.js';
import { writeFileSync, appendFileSync } from 'fs';
import {
  getSolicitudesParaCobroSemanal,
} from '../yego_miauto/services/cuotas/miautoCuotaSemanalService.js';
import { getCronogramaById } from '../yego_miauto/services/cronograma/miautoCronogramaService.js';
import {
  computeAmountDueSemanal,
  partnerFeesPlusComisionPool,
  resolvePlan,
  resolveMaxCuotaPorVehiculo,
  round2,
} from '../yego_miauto/services/cobros/CuotaCalculator.js';
import { computeLateFee } from '../yego_miauto/services/cobros/LateFeeCalculator.js';
import { applyWaterfallPool } from '../yego_miauto/services/cobros/CascadaPoolManager.js';
import { computeDueDateForMiAutoCuota } from '../utils/miautoLimaWeekRange.js';
import { getPreviousWeekIncomeRangeLima } from '../utils/miautoLimaWeekRange.js';

const LOG = '/tmp/miauto-simulation.log';
writeFileSync(LOG, '');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  appendFileSync(LOG, line + '\n');
}

function ymdFromDb(v) {
  if (v == null) return null;
  if (typeof v === 'string') { const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim()); return m ? m[1] : null; }
  try { const d = v instanceof Date ? v : new Date(v); if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch { return null; }
}

function limaTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function hayCuotaVencidaConSaldo(solicitudId) {
  const res = await query(`SELECT 1 FROM module_miauto_cuota_semanal c WHERE c.solicitud_id = $1::uuid AND c.status = 'overdue' AND c.deleted_at IS NULL LIMIT 1`, [solicitudId]);
  return (res.rows || []).length > 0;
}

async function loadCuotasParaCascada(solicitudId) {
  const res = await query(
    `SELECT id, due_date, week_start_date, amount_due, late_fee, paid_amount, status
     FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND status IN ('pending', 'overdue', 'partial') AND deleted_at IS NULL
     ORDER BY due_date ASC NULLS LAST, id ASC`, [solicitudId]);
  return (res.rows || []).map(r => ({
    ...r,
    pending: round2(round2(Number(r.amount_due)||0) + round2(Number(r.late_fee)||0) - round2(Number(r.paid_amount)||0)),
  }));
}

async function main() {
  const { cuotaWeekMonday } = (() => {
    const prev = getPreviousWeekIncomeRangeLima();
    return { cuotaWeekMonday: prev.weekStartDate };
  })();

  log('═══════════════════════════════════════════════');
  log('  SIMULACIÓN COMPLETA MI AUTO — DRY RUN');
  log('  Semana cuota: ' + cuotaWeekMonday);
  log('  Fecha: ' + new Date().toISOString());
  log('═══════════════════════════════════════════════');
  log('');

  const solicitudes = await getSolicitudesParaCobroSemanal();
  log(`Solicitudes activas para cobro: ${solicitudes.length}`);
  log('');

  // Simular con diferentes escenarios de viajes
  const escenarios = [
    { name: 'Sin viajes (fallo Yango)', trips: 0, pf: 0 },
    { name: 'Bajo (0-119 viajes)', trips: 80, pf: 900 },
    { name: 'Medio (120-239 viajes)', trips: 180, pf: 2100 },
    { name: 'Alto (240-399 viajes)', trips: 300, pf: 3500 },
    { name: 'Muy alto (400+ viajes)', trips: 450, pf: 5200 },
  ];

  // Usar escenario medio para la simulación completa
  const scenario = escenarios[2];
  log(`Escenario: ${scenario.name} (${scenario.trips} viajes, PF ${scenario.pf})`);
  log('');

  let totalGeneradas = 0;
  let totalCascada = 0;
  let totalMontoCascada = 0;
  let totalCuotaUSD = 0;
  let totalCuotaPEN = 0;

  for (const sol of solicitudes.slice(0, 5)) {
    const cronograma = await getCronogramaById(sol.cronograma_id);
    if (!cronograma) continue;

    const fechaInicioYmd = ymdFromDb(sol.fecha_inicio_cobro_semanal);
    const weekYmd = cuotaWeekMonday;
    const isPrimera = false; // ya pasó el depósito

    log('───────────────────────────────────────────────');
    log(`Placa: ${sol.placa_asignada || 'SIN PLACA'} | DNI: ${sol.dni || '?'}`);
    log(`Conductor Yango: ${sol.first_name || '?'} ${sol.last_name || ''}`);
    log(`Cronograma: ${cronograma.name || '?'} | Vehículo: ${sol.cronograma_vehiculo_id}`);
    log('');

    // Resolver plan
    const hayVencida = await hayCuotaVencidaConSaldo(sol.solicitud_id);
    let plan;
    if (hayVencida) {
      plan = resolveMaxCuotaPorVehiculo(cronograma, sol.cronograma_vehiculo_id);
      log(`⚠️  HAY CUOTA VENCIDA → forzando cuota MÁXIMA sin bono`);
    } else {
      plan = resolvePlan(cronograma, sol.cronograma_vehiculo_id, scenario.trips);
    }
    if (!plan || plan.error) { log(`  SKIP: ${plan?.error || 'sin plan'}`); continue; }

    log(`  Regla: ${plan.reglaAplicada?.viajes || '?'} | Cuota bruta: ${plan.cuotaSemanal} ${plan.moneda}`);
    log(`  Bono auto: ${plan.bonoAuto} | Comisión: ${plan.pctComision}% | Cobro saldo: ${plan.cobroSaldo}`);

    // Calcular cuota
    const pfRaw = hayVencida ? 0 : scenario.pf;
    const cuotaCalc = computeAmountDueSemanal({
      cuotaSemanal: plan.cuotaSemanal,
      partnerFeesRaw: pfRaw,
      pctComision: plan.pctComision,
      cobroSaldo: plan.cobroSaldo,
      partnerFeesApplyToCuotaReduction: pfRaw <= 0,
      commissionGoesToWaterfall: pfRaw > 0,
    });

    const poolCascada = pfRaw > 0 ? partnerFeesPlusComisionPool(cuotaCalc.partnerFees83, plan.pctComision) : { pool: 0 };

    log(`  PF83: ${cuotaCalc.partnerFees83} ${plan.moneda} | Pool cascada: ${poolCascada.pool} ${plan.moneda}`);
    log(`  amountDue (base): ${cuotaCalc.amountDue} ${plan.moneda}`);

    // Simular cascada
    let cascadaResult = { applied: 0, remainingPool: poolCascada.pool, allocations: [] };
    if (poolCascada.pool > 0.005) {
      const cuotasDebt = await loadCuotasParaCascada(sol.solicitud_id);
      if (cuotasDebt.length > 0) {
        cascadaResult = applyWaterfallPool({ poolAmount: poolCascada.pool, cuotas: cuotasDebt });
        if (cascadaResult.applied > 0.005) {
          totalCascada++;
          totalMontoCascada += cascadaResult.applied;
          log(`  ✅ CASCADA: ${cascadaResult.applied.toFixed(2)} ${plan.moneda} repartido en ${cascadaResult.allocations.length} cuotas antiguas`);
          for (const a of cascadaResult.allocations) {
            log(`     → Cuota ${a.cuotaId.slice(0,8)} (due ${a.dueDate}): ${a.montoAplicado.toFixed(2)} ${plan.moneda} (pending ${a.pendingAntes.toFixed(2)} → ${a.pendingDespues.toFixed(2)})`);
          }
        }
      }
    }

    // Calcular mora
    const dueDate = computeDueDateForMiAutoCuota(weekYmd, fechaInicioYmd, isPrimera);
    const moraResult = computeLateFee({
      tasaInteresMora: cronograma.tasa_interes_mora || 0,
      dueDateYmd: dueDate,
      todayYmd: limaTodayYmd(),
      capitalMoroso: cuotaCalc.amountDue,
    });

    // Resultado final
    const amountDueFinal = cascadaResult.remainingPool > 0.005 ? Math.max(0, cuotaCalc.amountDue - cascadaResult.remainingPool) : cuotaCalc.amountDue;
    const pendingTotal = round2(amountDueFinal + moraResult.moraTotal);
    
    log(`  amountDue final: ${amountDueFinal.toFixed(2)} ${plan.moneda}`);
    log(`  Mora: ${moraResult.moraTotal.toFixed(2)} ${plan.moneda} (${moraResult.diasAtraso} días)`);
    log(`  PENDIENTE TOTAL: ${pendingTotal.toFixed(2)} ${plan.moneda}`);
    log(`  Status: ${pendingTotal <= 0.005 ? 'pagada' : (moraResult.diasAtraso > 0 ? 'overdue' : 'pending')}`);

    if (plan.moneda === 'USD') totalCuotaUSD += amountDueFinal;
    else totalCuotaPEN += amountDueFinal;
    totalGeneradas++;
    log('');
  }

  log('═══════════════════════════════════════════════');
  log('  RESUMEN FINAL');
  log(`  Cuotas simuladas: ${totalGeneradas}`);
  log(`  Solicitudes con cascada: ${totalCascada}`);
  log(`  Monto total cascada: ${totalMontoCascada.toFixed(2)}`);
  log(`  Total cuota USD: $${totalCuotaUSD.toFixed(2)}`);
  log(`  Total cuota PEN: S/.${totalCuotaPEN.toFixed(2)}`);
  log('═══════════════════════════════════════════════');
  log('');
  log('Log guardado en /tmp/miauto-simulation.log');
}

main().catch(e => { console.error(e); process.exit(1); });
