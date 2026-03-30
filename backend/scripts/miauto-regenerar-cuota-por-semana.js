/**
 * Regenera una cuota Mi Auto para un lunes de cuota (`week_start_date`) concreto (Yango + ensureCuotaSemanalForWeek)
 * y deja esa semana sin pago (`paid_amount = 0`, `late_fee = 0`, estado pending/overdue según vencimiento Lima).
 *
 * Uso:
 *   node scripts/miauto-regenerar-cuota-por-semana.js <solicitud_uuid> [YYYY-MM-DD] [dni_solo_digitos]
 *
 * Ejemplo (30 mar 2026, DNI 18091696):
 *   node scripts/miauto-regenerar-cuota-por-semana.js 6623e817-f3f9-4ef8-965b-753a8b95976a 2026-03-30 18091696
 */
import { query } from '../config/database.js';
import { regenerateMiAutoCuotaForWeekMonday } from '../jobs/miautoWeeklyCharge.js';

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

async function main() {
  const sid = process.argv[2]?.trim();
  const weekArg = process.argv[3]?.trim() || '2026-03-30';
  const dniCheck = process.argv[4]?.trim();

  if (!sid) {
    console.error(
      'Uso: node scripts/miauto-regenerar-cuota-por-semana.js <solicitud_uuid> [YYYY-MM-DD] [dni_opcional]'
    );
    process.exit(1);
  }

  if (dniCheck) {
    const sol = await query(
      `SELECT REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g') AS dni_sol,
              REGEXP_REPLACE(COALESCE(TRIM(rd.dni), ''), '[^0-9]', '', 'g') AS dni_rd
       FROM module_miauto_solicitud s
       LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
       WHERE s.id = $1::uuid`,
      [sid]
    );
    const row = sol.rows[0];
    if (!row) {
      console.error('No existe solicitud', sid);
      process.exit(1);
    }
    const dniBd = String(row.dni_rd || row.dni_sol || '');
    if (dniBd !== digitsOnly(dniCheck)) {
      console.error(`DNI no coincide: BD=${dniBd || '(vacío)'} esperado=${digitsOnly(dniCheck)}`);
      process.exit(1);
    }
  }

  const incomeMaxAttempts = Math.max(1, Math.min(12, Number(process.env.MIAUTO_REGEN_INCOME_ATTEMPTS) || 6));

  const regen = await regenerateMiAutoCuotaForWeekMonday(sid, weekArg, { incomeMaxAttempts });
  console.log(JSON.stringify({ paso: 'regenerar', ...regen }, null, 2));

  if (!regen.ok || !regen.cuotaWeekMonday) {
    process.exit(1);
  }

  const weekMonday = regen.cuotaWeekMonday;

  const upd = await query(
    `UPDATE module_miauto_cuota_semanal
     SET paid_amount = 0,
         late_fee = 0,
         status = CASE
           WHEN due_date::date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date THEN 'overdue'
           ELSE 'pending'
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE solicitud_id = $1::uuid AND week_start_date = $2::date
     RETURNING id, week_start_date, due_date, num_viajes, cuota_semanal, amount_due, paid_amount, late_fee, status`,
    [sid, weekMonday]
  );

  if (upd.rows.length === 0) {
    console.error('No hay fila module_miauto_cuota_semanal para esa solicitud y semana:', weekMonday);
    process.exit(1);
  }

  console.log(JSON.stringify({ paso: 'pago_reseteado', fila: upd.rows[0] }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
