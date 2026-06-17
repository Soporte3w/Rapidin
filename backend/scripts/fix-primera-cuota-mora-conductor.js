/*
 * Corrige mora en la primera cuota de un conductor específico.
 * Uso: node scripts/fix-primera-cuota-mora-conductor.js <driver_id_fleet>
 * Ejemplo: node scripts/fix-primera-cuota-mora-conductor.js 32262853
 */
import { query } from '../config/database.js';
import { updateMoraDiaria } from '../yego_miauto/services/cuotas/miautoCuotaSemanalService.js';

const driverId = process.argv[2];
if (!driverId) {
  console.error('Uso: node scripts/fix-primera-cuota-mora-conductor.js <driver_id_fleet>');
  process.exit(1);
}

async function main() {
  const solRes = await query(
    `SELECT id FROM module_miauto_solicitud
     WHERE driver_id_fleet = $1 AND status = 'aprobado' AND fecha_inicio_cobro_semanal IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [driverId]
  );

  if (solRes.rows.length === 0) {
    console.log(`No se encontró solicitud aprobada para el conductor ${driverId}`);
    process.exit(0);
  }

  const solicitudId = solRes.rows[0].id;

  const cuotaRes = await query(
    `SELECT c.id, c.week_start_date, c.due_date, c.late_fee, c.mora_extra, c.status, c.amount_due,
            s.fecha_inicio_cobro_semanal
     FROM module_miauto_cuota_semanal c
     JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     WHERE c.solicitud_id = $1
     ORDER BY c.week_start_date ASC
     LIMIT 1`,
    [solicitudId]
  );

  const cuota = cuotaRes.rows[0];
  console.log('Solicitud:', solicitudId);
  console.log('Primera cuota:', cuota.id);
  console.log('  week_start_date:', cuota.week_start_date);
  console.log('  due_date:', cuota.due_date);
  console.log('  amount_due:', cuota.amount_due);
  console.log('  late_fee (antes):', cuota.late_fee);
  console.log('  mora_extra (antes):', cuota.mora_extra);
  console.log('  status (antes):', cuota.status);
  console.log('  fecha_inicio_cobro:', cuota.fecha_inicio_cobro_semanal);

  const updated = await updateMoraDiaria(solicitudId);
  console.log(`\nMora actualizada en ${updated} cuota(s).`);

  const verify = await query(
    `SELECT late_fee, mora_extra, status FROM module_miauto_cuota_semanal WHERE id = $1`,
    [cuota.id]
  );
  const v = verify.rows[0];
  console.log('  late_fee (después):', v.late_fee);
  console.log('  mora_extra (después):', v.mora_extra);
  console.log('  status (después):', v.status);

  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
