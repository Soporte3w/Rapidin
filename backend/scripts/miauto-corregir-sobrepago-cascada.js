/**
 * Corrige cuotas donde la cascada PF aplicó más paid_amount del que corresponde
 * según la obligación derivada (amount_due_sched + mora sobre amount_due_sched completo).
 *
 * El exceso se devuelve al paid_amount de la cuota que originó la cascada
 * (identificada por partner_fees_cascada_destino apuntando a la cuota sobrepagada).
 *
 * Uso:
 *   cd backend && node scripts/miauto-corregir-sobrepago-cascada.js --dry-run
 *   cd backend && node scripts/miauto-corregir-sobrepago-cascada.js --apply
 */
import { query, getClient } from '../config/database.js';
import {
  isSemanaDepositoMiAuto,
  parsePartnerFeesCascadaDestinoDb,
  updateMoraDiaria,
  persistPaidAmountCapsForSolicitud,
} from '../services/miautoCuotaSemanalService.js';
import { getCronogramaById } from '../services/miautoCronogramaService.js';

const PARTNER_FEES_PCT = 0.8333;
function round2(n) { return Math.round(n * 100) / 100; }
function ymd(d) {
  if (!d) return null;
  const s = typeof d === 'string' ? d : d.toISOString();
  return s.slice(0, 10);
}

function calendarDaysLateLima(dueDateStr) {
  if (!dueDateStr) return 0;
  const now = new Date();
  const nowLima = new Date(now.toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const dueStr = ymd(dueDateStr);
  const due = new Date(dueStr + 'T00:00:00');
  const todayStr = nowLima.toISOString().slice(0, 10);
  const today = new Date(todayStr + 'T00:00:00');
  const diff = Math.floor((today - due) / 86400000);
  return diff > 0 ? diff : 0;
}

function computeMoraSobreBase(tasa, dueDateStr, baseCuota) {
  if (!dueDateStr || baseCuota <= 0 || tasa <= 0) return 0;
  const days = calendarDaysLateLima(dueDateStr);
  if (days <= 0) return 0;
  const factorDia = tasa / 7;
  let saldo = round2(baseCuota);
  let moraAcum = 0;
  for (let d = 0; d < days; d++) {
    const moraDia = round2(saldo * factorDia);
    moraAcum = round2(moraAcum + moraDia);
    saldo = round2(saldo + moraDia);
  }
  return round2(moraAcum);
}

function pf83FromRow(row) {
  const pf83 = round2(parseFloat(row.partner_fees_83) || 0);
  if (pf83 > 0) return pf83;
  return round2((parseFloat(row.partner_fees_raw) || 0) * PARTNER_FEES_PCT);
}

function derivedAmountDueSched(row, isPrimera) {
  const pfRaw = round2(parseFloat(row.partner_fees_raw) || 0);
  const cs = round2(parseFloat(row.cuota_semanal) || 0);
  const cobro = round2(parseFloat(row.cobro_saldo) || 0);
  if (!isPrimera && pfRaw > 0.005) {
    return round2(Math.max(0, cs - pf83FromRow(row) + cobro));
  }
  return round2(parseFloat(row.amount_due) || 0);
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const dry = argv.includes('--dry-run');

if (!apply && !dry) {
  console.error('Indique --dry-run o --apply');
  process.exit(1);
}

async function main() {
  const solRes = await query(`
    SELECT DISTINCT c.solicitud_id::text AS sid,
           s.cronograma_id::text, s.cronograma_vehiculo_id::text,
           s.fecha_inicio_cobro_semanal
    FROM module_miauto_cuota_semanal c
    INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
  `);

  const corrections = [];

  for (const sol of solRes.rows) {
    const cron = sol.cronograma_id ? await getCronogramaById(sol.cronograma_id) : null;
    const tasa = parseFloat(cron?.tasa_interes_mora) || 0;

    const cRes = await query(`
      SELECT id::text, week_start_date, due_date, amount_due::numeric, late_fee::numeric,
             paid_amount::numeric, status, cuota_semanal::numeric, bono_auto::numeric,
             partner_fees_raw::numeric, partner_fees_83::numeric, pct_comision::numeric,
             cobro_saldo::numeric, partner_fees_cascada_destino::text AS cascada
      FROM module_miauto_cuota_semanal
      WHERE solicitud_id = $1::uuid
      ORDER BY week_start_date ASC
    `, [sol.sid]);

    const rows = cRes.rows || [];

    for (const row of rows) {
      const paid = round2(parseFloat(row.paid_amount) || 0);
      if (paid <= 0.005) continue;

      const ws = ymd(row.week_start_date);
      const isPrimera = ws ? isSemanaDepositoMiAuto(ws, sol.fecha_inicio_cobro_semanal) : false;
      const amountDueSched = derivedAmountDueSched(row, isPrimera);
      const mora = computeMoraSobreBase(tasa, ymd(row.due_date), amountDueSched);
      const obligReal = round2(amountDueSched + mora);

      if (paid <= obligReal + 0.02) continue;

      const exceso = round2(paid - obligReal);

      const sourceRow = rows.find((r) => {
        if (!r.cascada) return false;
        const entries = parsePartnerFeesCascadaDestinoDb(r.cascada);
        return entries.some((e) => String(e.cuota_semanal_id) === row.id);
      });

      corrections.push({
        solicitud_id: sol.sid,
        cuota_vieja_id: row.id,
        cuota_vieja_week: ws,
        amountDueSched,
        mora,
        obligReal,
        paid_actual: paid,
        exceso,
        paid_nuevo_vieja: obligReal,
        cuota_nueva_id: sourceRow?.id || null,
        cuota_nueva_week: sourceRow ? ymd(sourceRow.week_start_date) : null,
        cuota_nueva_paid_actual: sourceRow ? round2(parseFloat(sourceRow.paid_amount) || 0) : null,
        cuota_nueva_paid_nuevo: sourceRow ? round2((parseFloat(sourceRow.paid_amount) || 0) + exceso) : null,
        cascada_original: sourceRow?.cascada || null,
      });
    }
  }

  if (corrections.length === 0) {
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', correcciones: 0, msg: 'Sin sobrepagos detectados.' }, null, 2));
    process.exit(0);
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    correcciones: corrections.length,
    exceso_total: round2(corrections.reduce((s, c) => s + c.exceso, 0)),
    detalle: corrections.map((c) => ({
      solicitud_id: c.solicitud_id,
      cuota_vieja: {
        id: c.cuota_vieja_id,
        week: c.cuota_vieja_week,
        amountDueSched: c.amountDueSched,
        mora: c.mora,
        obligReal: c.obligReal,
        paid_antes: c.paid_actual,
        paid_despues: c.paid_nuevo_vieja,
        exceso: c.exceso,
      },
      cuota_nueva: c.cuota_nueva_id ? {
        id: c.cuota_nueva_id,
        week: c.cuota_nueva_week,
        paid_antes: c.cuota_nueva_paid_actual,
        paid_despues: c.cuota_nueva_paid_nuevo,
      } : null,
    })),
  };

  if (dry) {
    console.log(JSON.stringify(report, null, 2));
    console.log('Dry-run: use --apply para ejecutar.');
    process.exit(0);
  }

  const client = await getClient();
  const affectedSolicitudes = new Set();
  try {
    await client.query('BEGIN');

    for (const c of corrections) {
      await client.query(
        `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid`,
        [c.paid_nuevo_vieja, c.cuota_vieja_id]
      );

      if (c.cuota_nueva_id) {
        await client.query(
          `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid`,
          [c.cuota_nueva_paid_nuevo, c.cuota_nueva_id]
        );

        const entries = parsePartnerFeesCascadaDestinoDb(c.cascada_original);
        const updated = entries.map((e) => {
          if (String(e.cuota_semanal_id) === c.cuota_vieja_id) {
            return { ...e, monto: round2(e.monto - c.exceso) };
          }
          return e;
        }).filter((e) => e.monto > 0.005);

        const cascadaJson = updated.length > 0 ? JSON.stringify(updated) : null;
        await client.query(
          `UPDATE module_miauto_cuota_semanal SET partner_fees_cascada_destino = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid`,
          [cascadaJson, c.cuota_nueva_id]
        );
      }

      affectedSolicitudes.add(c.solicitud_id);
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
  }

  for (const sid of affectedSolicitudes) {
    await updateMoraDiaria(sid, { includePartial: true });
    await persistPaidAmountCapsForSolicitud(sid);
  }

  report.mora_y_caps_actualizados = [...affectedSolicitudes];
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
