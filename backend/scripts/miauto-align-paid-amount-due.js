/**
 * Alinea paid_amount con amount_due en module_miauto_cuota_semanal (Pagado = amount_due en BD).
 * Por defecto solo paid / bonificada. --cutoff-date: solo due_date < corte.
 *
 *   node scripts/miauto-align-paid-amount-due.js --dry-run
 *   node scripts/miauto-align-paid-amount-due.js --cutoff-date 2026-03-30
 *   node scripts/miauto-align-paid-amount-due.js --force-all-status --dry-run
 */
import { query } from '../config/database.js';

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const forceAll = argv.includes('--force-all-status');
  let cutoff = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cutoff-date' && argv[i + 1]) {
      const d = String(argv[i + 1]).trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('--cutoff-date invalida: ' + d);
      cutoff = d;
      i++;
    }
  }
  return { dryRun, forceAll, cutoff };
}

async function main() {
  const { dryRun, forceAll, cutoff } = parseArgs(process.argv.slice(2));

  const statusClause = forceAll ? 'TRUE' : "status IN ('paid', 'bonificada')";
  const dateClause = cutoff ? 'AND due_date::date < $1::date' : '';
  const params = cutoff ? [cutoff] : [];

  const countSql =
    'SELECT COUNT(*)::int AS n FROM module_miauto_cuota_semanal WHERE ' +
    statusClause +
    ' ' +
    dateClause +
    ' AND (paid_amount IS DISTINCT FROM amount_due)';

  const cnt = await query(countSql.replace(/\s+/g, ' ').trim(), params);
  const n = cnt.rows[0]?.n ?? 0;

  const out = { ok: true, dryRun, forceAll, cutoff, filas_a_actualizar: n };

  if (dryRun || n === 0) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const updSql =
    'UPDATE module_miauto_cuota_semanal SET paid_amount = amount_due, updated_at = CURRENT_TIMESTAMP WHERE ' +
    statusClause +
    ' ' +
    dateClause +
    ' AND (paid_amount IS DISTINCT FROM amount_due) RETURNING id, solicitud_id';

  const upd = await query(updSql.replace(/\s+/g, ' ').trim(), params);
  const rows = upd.rows || [];
  const sids = [...new Set(rows.map((r) => String(r.solicitud_id)).filter(Boolean))];

  const persistErrors = [];
  const { persistPaidAmountCapsForSolicitud } = await import('../services/miautoCuotaSemanalService.js');
  for (const sid of sids) {
    try {
      await persistPaidAmountCapsForSolicitud(sid);
    } catch (e) {
      persistErrors.push({ solicitud_id: sid, msg: String(e.message || e) });
    }
  }

  out.actualizadas = rows.length;
  out.solicitudes_caps = sids.length;
  out.persist_errors = persistErrors;
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
