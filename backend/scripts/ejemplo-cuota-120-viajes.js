/**
 * Ejemplo: monto a pagar cuando el conductor tiene 120 viajes, para una solicitud con cronograma asignado.
 * Uso: node scripts/ejemplo-cuota-120-viajes.js [solicitud_id]
 * Si no pasas solicitud_id, usa la primera solicitud que tenga cronograma_id y cronograma_vehiculo_id.
 */

import 'dotenv/config';
import { query } from '../config/database.js';
import { getCronogramaById, getRuleForTripCount } from '../services/miautoCronogramaService.js';

const NUM_VIAJES_EJEMPLO = 120;

function round2(n) {
  const x = Number(n);
  return Number.isNaN(x) ? 0 : Math.round(x * 100) / 100;
}

async function main() {
  const solicitudId = process.argv[2]?.trim();
  let row;
  if (solicitudId) {
    const res = await query(
      'SELECT id, cronograma_id, cronograma_vehiculo_id FROM module_miauto_solicitud WHERE id = $1 AND cronograma_id IS NOT NULL AND cronograma_vehiculo_id IS NOT NULL',
      [solicitudId]
    );
    if (res.rows.length === 0) {
      console.error('Solicitud no encontrada o sin cronograma/vehículo asignado:', solicitudId);
      process.exit(1);
    }
    row = res.rows[0];
  } else {
    const res = await query(
      `SELECT id, cronograma_id, cronograma_vehiculo_id FROM module_miauto_solicitud
       WHERE cronograma_id IS NOT NULL AND cronograma_vehiculo_id IS NOT NULL
       ORDER BY created_at DESC NULLS LAST LIMIT 1`
    );
    if (res.rows.length === 0) {
      console.error('No hay ninguna solicitud con cronograma y vehículo asignados.');
      process.exit(1);
    }
    row = res.rows[0];
    console.log('Usando la solicitud más reciente con cronograma asignado.\n');
  }

  const { id: sid, cronograma_id: cronogramaId, cronograma_vehiculo_id: cronogramaVehiculoId } = row;
  console.log('Solicitud ID:', sid);
  console.log('Cronograma ID:', cronogramaId);
  console.log('Vehículo (cronograma_vehiculo_id):', cronogramaVehiculoId);
  console.log('Viajes de ejemplo:', NUM_VIAJES_EJEMPLO);
  console.log('');

  const cronograma = await getCronogramaById(cronogramaId);
  if (!cronograma || !cronograma.rules || cronograma.rules.length === 0) {
    console.error('Cronograma sin reglas.');
  }

  const rule = getRuleForTripCount(cronograma.rules, NUM_VIAJES_EJEMPLO);
  if (!rule) {
    console.error('No hay regla que aplique para', NUM_VIAJES_EJEMPLO, 'viajes. Revisa las filas "Viajes" del cronograma.');
    process.exit(1);
  }

  const vehicles = cronograma.vehicles || [];
  const vehicleIndex = vehicles.findIndex((v) => v.id === cronogramaVehiculoId);
  const cuotasPorVehiculo = rule.cuotas_por_vehiculo || [];
  const cuotaSemanal = vehicleIndex >= 0 && cuotasPorVehiculo[vehicleIndex] != null
    ? round2(parseFloat(cuotasPorVehiculo[vehicleIndex]) || 0)
    : 0;
  const monedasPorVehiculo = rule.cuota_moneda_por_vehiculo || [];
  const moneda = vehicleIndex >= 0 && monedasPorVehiculo[vehicleIndex] === 'USD' ? 'USD' : 'PEN';
  const bonoAuto = round2(parseFloat(rule.bono_auto) || 0);
  const amountDue = round2(Math.max(0, cuotaSemanal - bonoAuto));

  const sym = moneda === 'USD' ? '$' : 'S/.';
  console.log('--- Regla que aplica para', NUM_VIAJES_EJEMPLO, 'viajes ---');
  console.log('Viajes (fila):', rule.viajes);
  console.log('Cuota semanal (del cronograma para este carro):', sym, cuotaSemanal);
  console.log('Bono mi auto:', sym, bonoAuto);
  console.log('Monto a pagar (cuota - bono):', sym, amountDue);
  console.log('');
  console.log('→ Con', NUM_VIAJES_EJEMPLO, 'viajes, el conductor debe pagar:', sym, amountDue, '(sin mora).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
