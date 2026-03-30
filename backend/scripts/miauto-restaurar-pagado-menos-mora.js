/**
 * Restaura paid_amount como (paid_amount - late_fee), sin negativos, y pone late_fee = 0.
 * Solo filas con due_date < --cutoff-date (default 2026-03-30). Alinea Pagado al neto tipo Excel.
 *
 *   node scripts/miauto-restaurar-pagado-menos-mora.js --dry-run
 *   node scripts/miauto-restaurar-pagado-menos-mora.js [--cutoff-date YYYY-MM-DD]
 */
import { query } from '../config/database.js';
import { round2 } from '../services/miautoMoneyUtils.js';
import { persistPaidAmountCapsForSolicitud } from '../services/miautoCuotaSemanalService.js';

const DEFAULT_CUTOFF = '2026-03-30';

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  let cutoff = DEFAULT_CUTOFF;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cutoff-date' && argv[i + 1]) {
      cutoff = String(argv[i + 1]).trim().slice(0, 10);
      i++;
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error('cutoff invalida');
  return { dryRun, cutoff };
}

async function main() {
  const { dryRun, cutoff } = parseArgs(process.argv.slice(2));

  const sel = await query(
    `SELECT id, solicitud_id, paid_amount, late_fee, due_date::text AS due
     FROM module_miauto_cuota_semanal
     WHERE due_date < $1::date`,
    [cutoff]
  );

  const rows = sel.rows || [];
  const touched = new Set();
  let updated = 0;

  for (const r of rows) {
    const paid = round2(Number(r.paid_amount) || 0);
    const late = round2(Number(r.late_fee) || 0);
    const newPaid = round2(Math.max(0, paid - late));
    if (Math.abs(newPaid - paid) < 0.005 && late < 0.005) continue;

    console.log(
      'id=' + r.id + ' due=' + r.due + ' paid ' + paid + ' - mora ' + late + ' => paid ' + newPaid
    );

    if (dryRun) {
      updated++;
      continue;
    }

    await query(
      `UPDATE module_miauto_cuota_semanal
       SET paid_amount = $1, late_fee = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid AND due_date < $3::date`,
      [newPaid, r.id, cutoff]
    );
    updated++;
    touched.add(String(r.solicitud_id));
  }

  if (!dryRun) {
    for (const sid of touched) {
      try {
        await persistPaidAmountCapsForSolicitud(sid);
      } catch (e) {
        console.warn('persistPaidAmountCaps', sid, e.message);
      }
    }
  }

  console.log(
    JSON.stringify({ ok: true, dryRun, cutoff, filas_consideradas: rows.length, filas_actualizadas: updated, solicitudes: touched.size }, null, 2)
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
