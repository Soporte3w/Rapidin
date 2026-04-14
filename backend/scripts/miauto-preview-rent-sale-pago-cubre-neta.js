/**
 * Rent-sale: lista cuotas donde `paid_amount` ya cubre la cuota **neta programada** (cuota bruta − PF83 + cobro saldo…)
 * igual que `paidIgualProgramadaIgnoraMoraDerivada` en el servicio. Útil para dry-run antes de aplicar mora/estado.
 *
 * Uso:
 *   cd backend && node scripts/miauto-preview-rent-sale-pago-cubre-neta.js <solicitud_uuid>
 *   cd backend && node scripts/miauto-preview-rent-sale-pago-cubre-neta.js <solicitud_uuid> --apply
 *
 * `--apply`: ejecuta `updateMoraDiaria` + `persistPaidAmountCapsForSolicitud` para esa solicitud (alinea BD con la nueva regla).
 */
import 'dotenv/config';
import { query } from '../config/database.js';
import { getCronogramaById } from '../services/miautoCronogramaService.js';
import {
  resolveMontosPlanCuotaSemanalCore,
  paidIgualProgramadaIgnoraMoraDerivada,
  resolvedAmountDueSchedForOpenRow,
  updateMoraDiaria,
  persistPaidAmountCapsForSolicitud,
  isSemanaDepositoMiAuto,
} from '../services/miautoCuotaSemanalService.js';
import { isWeekYangoClosedForMiAutoCuotaMetrics } from '../utils/miautoLimaWeekRange.js';
import { round2 } from '../services/miautoMoneyUtils.js';

function ymdFromDbDate(v) {
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

const args = process.argv.slice(2).filter((a) => a !== '--apply');
const apply = process.argv.includes('--apply');
const sid = args[0]?.trim();

if (!sid) {
  console.error(
    'Uso: node scripts/miauto-preview-rent-sale-pago-cubre-neta.js <solicitud_uuid> [--apply]'
  );
  process.exit(1);
}

function rowEval(row, cronograma, vehId, fi) {
  const wsYmd = ymdFromDbDate(row.week_start_date);
  const isPrimera = wsYmd ? isSemanaDepositoMiAuto(wsYmd, fi) : false;
  const yangoSemanaCerrada = wsYmd ? isWeekYangoClosedForMiAutoCuotaMetrics(wsYmd, fi) : false;
  const sinViajesYango = isPrimera || !yangoSemanaCerrada;
  const m = resolveMontosPlanCuotaSemanalCore(row, cronograma, vehId, fi, isPrimera, sinViajesYango);
  const sched = round2(
    resolvedAmountDueSchedForOpenRow(row, m.cuota_semanal, m.bono_auto, m.pct_comision, m.cobro_saldo, isPrimera)
  );
  const paid = round2(parseFloat(row.paid_amount) || 0);
  const ignora = paidIgualProgramadaIgnoraMoraDerivada(
    row,
    m.cuota_semanal,
    m.bono_auto,
    m.pct_comision,
    m.cobro_saldo,
    isPrimera
  );
  return {
    cuota_id: row.id,
    week_start_date: row.week_start_date,
    status_bd: row.status,
    paid_amount: paid,
    cuota_programada_neta: sched,
    diff: round2(paid - sched),
    ignora_mora_derivada: ignora,
  };
}

try {
  const solRes = await query(
    `SELECT id, cronograma_id, cronograma_vehiculo_id, fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1::uuid`,
    [sid]
  );
  const sol = solRes.rows[0];
  if (!sol) {
    console.error('Solicitud no encontrada:', sid);
    process.exit(1);
  }
  const cronograma = await getCronogramaById(sol.cronograma_id);
  const vehId = sol.cronograma_vehiculo_id;
  const fi = sol.fecha_inicio_cobro_semanal;

  const cuotasRes = await query(
    `SELECT * FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid ORDER BY week_start_date ASC NULLS LAST`,
    [sid]
  );
  const rows = cuotasRes.rows || [];
  const out = rows.map((row) => rowEval(row, cronograma, vehId, fi));
  const st = (s) => String(s || '').toLowerCase();
  const candidatas = out.filter(
    (o) =>
      o.ignora_mora_derivada &&
      st(o.status_bd) !== 'bonificada' &&
      st(o.status_bd) !== 'paid'
  );

  if (apply) {
    await updateMoraDiaria(sid, { includePartial: true });
    const n = await persistPaidAmountCapsForSolicitud(sid);
    const cuotasPost = await query(
      `SELECT * FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid ORDER BY week_start_date ASC NULLS LAST`,
      [sid]
    );
    const filasPost = (cuotasPost.rows || []).map((row) => rowEval(row, cronograma, vehId, fi));
    console.log(
      JSON.stringify(
        {
          solicitud_id: sid,
          dry_run: false,
          apply: true,
          persistPaidAmountCaps_ajustes: n,
          filas_tras_apply: filasPost,
        },
        null,
        2
      )
    );
  } else {
    console.log(
      JSON.stringify(
        {
          solicitud_id: sid,
          dry_run: true,
          filas: out,
          candidatas_solo_no_pagadas: candidatas,
        },
        null,
        2
      )
    );
  }

  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
