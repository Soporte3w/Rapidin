/**
 * Vuelve a ejecutar `ensureCuotaSemanalForWeek` para un **lunes de cuota** concreto:
 * consulta Yango (Lun–Dom de esa semana de ingresos), recalcula PF, **cascada** a cuotas más viejas y actualiza la fila.
 *
 * No modifica `paid_amount` ni `late_fee` de la fila (a diferencia de `miauto-regenerar-cuota-por-semana.js`, que los pone en 0).
 *
 * Uso (desde carpeta `backend/`, con BD y env como el resto de scripts):
 *   node scripts/miauto-reensure-cuota-semana.js <solicitud_uuid> <YYYY-MM-DD>
 *
 * `<YYYY-MM-DD>`: cualquier fecha de la semana de cuota o el lunes exacto (`week_start_date` en BD).
 *
 * Opcional verificación DNI (solo dígitos):
 *   node scripts/miauto-reensure-cuota-semana.js <uuid> 2026-03-30 43321714
 */
import { query } from '../config/database.js';
import { regenerateMiAutoCuotaForWeekMonday } from '../jobs/miautoWeeklyCharge.js';

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

async function main() {
  const sid = process.argv[2]?.trim();
  const weekArg = process.argv[3]?.trim();
  const dniCheck = process.argv[4]?.trim();

  if (!sid || !weekArg) {
    console.error(
      'Uso: node scripts/miauto-reensure-cuota-semana.js <solicitud_uuid> <YYYY-MM-DD> [dni_solo_digitos]'
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
  console.log(JSON.stringify(regen, null, 2));
  process.exit(regen.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
