/**
 * Cobro Fleet Yango para una sola solicitud Mi Auto (mismo flujo que cron lunes 7:10 Lima, cola filtrada).
 * No regenera cuotas ni consulta income.
 *
 * Uso: node scripts/miauto-cobro-fleet-solicitud.js <solicitud_uuid> [dni_solo_digitos]
 */
import { query } from '../config/database.js';
import { runFleetCobroSoloSolicitud } from '../jobs/miautoWeeklyCharge.js';

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

const sid = process.argv[2]?.trim();
const dniCheck = process.argv[3]?.trim();
if (!sid) {
  console.error('Uso: node scripts/miauto-cobro-fleet-solicitud.js <solicitud_uuid> [dni_opcional]');
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

try {
  const r = await runFleetCobroSoloSolicitud(sid);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
