/**
 * Deja solo la «Semana 1» pagada (primera cuota por vencimiento `due_date` ASC, igual que la UI)
 * y el resto sin abono (`paid_amount = 0`), con estado `pending` o `overdue` según hoy Lima.
 * Recalcula mora y caps al final.
 *
 *   node scripts/miauto-solo-primera-semana-pagada.js <solicitud_uuid> --dry-run
 *   node scripts/miauto-solo-primera-semana-pagada.js <solicitud_uuid>
 */
import 'dotenv/config';
import { query } from '../config/database.js';
import { getLimaYmd } from '../utils/miautoLimaWeekRange.js';
import { round2 } from '../services/miautoMoneyUtils.js';
import { persistPaidAmountCapsForSolicitud, updateMoraDiaria } from '../services/miautoCuotaSemanalService.js';

function ymd(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

function statusSinPago(dueRaw, limaToday) {
  const d = ymd(dueRaw);
  if (!d) return 'pending';
  return d < limaToday ? 'overdue' : 'pending';
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const sid = args.find((a) => !a.startsWith('-'));
  if (!sid) {
    console.error('Uso: node scripts/miauto-solo-primera-semana-pagada.js <solicitud_uuid> [--dry-run]');
    process.exit(1);
  }

  const res = await query(
    `SELECT id, due_date, week_start_date, amount_due, late_fee, paid_amount, status
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1::uuid
     ORDER BY due_date ASC NULLS LAST, week_start_date ASC NULLS LAST, id ASC`,
    [sid]
  );
  const rows = res.rows || [];
  if (rows.length === 0) {
    console.error('No hay cuotas para esta solicitud');
    process.exit(1);
  }

  const limaToday = getLimaYmd(new Date());
  const primero = rows[0];
  const ad0 = parseFloat(primero.amount_due) || 0;
  const lf0 = parseFloat(primero.late_fee) || 0;
  const totalPrimera = round2(ad0 + lf0);
  const paidPrimera = totalPrimera;

  console.log(
    JSON.stringify(
      {
        solicitud_id: sid,
        dry_run: dry,
        hoy_lima: limaToday,
        semana1_cuota_id: primero.id,
        semana1_due: ymd(primero.due_date),
        semana1_paid_amount_sera: paidPrimera,
        status_sera: 'paid',
        restantes: rows.length - 1,
      },
      null,
      2
    )
  );

  if (dry) {
    console.log('\nDry-run: no se escribió BD.');
    process.exit(0);
  }

  await query(
    `UPDATE module_miauto_cuota_semanal
     SET paid_amount = $1, status = 'paid', updated_at = CURRENT_TIMESTAMP
     WHERE id = $2::uuid`,
    [paidPrimera, primero.id]
  );
  console.log('OK primera fila → paid, paid_amount=', paidPrimera);

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const st = statusSinPago(r.due_date, limaToday);
    await query(
      `UPDATE module_miauto_cuota_semanal
       SET paid_amount = 0, status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid`,
      [st, r.id]
    );
    console.log(`OK resto #${i + 1} id=${r.id} due=${ymd(r.due_date)} → ${st}, paid_amount=0`);
  }

  await updateMoraDiaria(sid, { includePartial: true });
  await persistPaidAmountCapsForSolicitud(sid);
  console.log('\nListo: mora y caps recalculados. Revisa comprobantes en UI si quedaron datos viejos.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
