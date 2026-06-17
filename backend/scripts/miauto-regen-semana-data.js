/**
 * Regenera cuota para una solicitud y semana, forzando datos Yango reales
 * sin importar si es semana de depósito.
 * Uso: node scripts/miauto-regen-semana-data.js <solicitud_uuid> [YYYY-MM-DD]
 */
import { query } from '../config/database.js';
import { getDriverIncome } from '../services/yangoService.js';
import { generateWeeklyCharge } from '../yego_miauto/services/cobros/CobroEngine.js';
import { MIAUTO_PARK_ID } from '../yego_miauto/services/utils/miautoDriverLookup.js';
import { addDaysYmd } from '../utils/miautoLimaWeekRange.js';

const sid = process.argv[2]?.trim();
let weekYmd = (process.argv[3] || '2026-06-08').trim();

if (!sid) {
  console.error('Uso: node scripts/miauto-regen-semana-data.js <solicitud_uuid> [YYYY-MM-DD]');
  process.exit(1);
}

// Asegurar que sea lunes
const dateObj = new Date(weekYmd + 'T12:00:00');
const dayOfWeek = dateObj.getUTCDay();
const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
const monday = new Date(dateObj.getTime() - daysSinceMonday * 86400000);
weekYmd = monday.toISOString().slice(0, 10);

// Income: semana anterior Lun-Dom
const incomeMonday = addDaysYmd(weekYmd, -7);
const dateFrom = `${incomeMonday}T05:00:00.000Z`;
const dateTo = new Date(new Date(weekYmd).getTime() - 1).toISOString().replace(/T.*$/, 'T04:59:59.999Z');

async function main() {
  // Cargar solicitud
  const solRes = await query('SELECT placa_asignada, driver_id_fleet FROM module_miauto_solicitud WHERE id = $1::uuid', [sid]);
  if (solRes.rows.length === 0) { console.error('Solicitud no encontrada'); process.exit(1); }
  const sol = solRes.rows[0];
  const placa = String(sol.placa_asignada || '').trim();

  console.log(`Solicitud: ${sid} | Semana cuota: ${weekYmd} | Ingresos: ${incomeMonday} → ${dateTo.slice(0,10)}`);

  // Buscar driver Yango por placa
  let driverId = sol.driver_id_fleet;
  let parkId = MIAUTO_PARK_ID;

  if (!driverId && placa) {
    const placaNorm = placa.toUpperCase().replace(/\s+/g, '');
    const drvRes = await query(
      `SELECT d.driver_id, d.park_id FROM drivers d
       WHERE TRIM(COALESCE(d.park_id::text, '')) = $1
         AND d.work_status = 'working'
         AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(d.car_number, '')), '\\\\s', '', 'g')) = $2
       LIMIT 1`,
      [MIAUTO_PARK_ID, placaNorm]
    );
    if (drvRes.rows.length > 0) {
      driverId = drvRes.rows[0].driver_id;
      parkId = drvRes.rows[0].park_id || MIAUTO_PARK_ID;
    }
  }

  console.log(`Driver Yango: ${driverId || 'NO ENCONTRADO'} | Park: ${parkId}`);

  // Obtener ingresos Yango
  let incomeResult = { count_completed: 0, partner_fees: 0 };
  if (driverId) {
    const income = await getDriverIncome(dateFrom, dateTo, driverId, parkId);
    if (income.success) {
      incomeResult = { count_completed: income.count_completed || 0, partner_fees: income.partner_fees || 0 };
      console.log(`Ingresos Yango: ${incomeResult.count_completed} viajes, PF: ${incomeResult.partner_fees}`);
    } else {
      console.log(`Yango income falló: ${income.error}, usando 0`);
    }
  }

  // Borrar cuota existente
  await query('DELETE FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid AND week_start_date = $2::date', [sid, weekYmd]);
  console.log('Cuota anterior eliminada');

  // Generar nueva cuota
  const result = await generateWeeklyCharge({
    solicitudId: sid,
    weekStartDate: weekYmd,
    incomeResult,
    options: { generatedBy: 'manual_script', forceUseYangoData: true },
  });

  console.log('Resultado:', JSON.stringify(result, null, 2));

  // Verificar
  const cuota = await query(
    `SELECT id, week_start_date, due_date, num_viajes, cuota_semanal, amount_due,
            partner_fees_raw, partner_fees_83, paid_amount, late_fee, status, montos_fuente
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1::uuid AND week_start_date = $2::date`,
    [sid, weekYmd]
  );
  if (cuota.rows.length > 0) {
    console.log('Cuota:', JSON.stringify(cuota.rows[0], null, 2));
    process.exit(0);
  } else {
    console.error('No se generó la cuota');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
