/**
 * Cuota en USD: el abono quedó guardado como si fueran dólares pero el retiro Fleet fue en PEN/COP.
 * Reemplaza paid_amount por (monto_pen / tipo_cambio) en USD.
 *
 * Uso:
 *   node scripts/miauto-corregir-paid-pen-a-usd.js <solicitud_uuid> <YYYY-MM-DD week_start> <monto_pen> [dni_solo_digitos]
 *
 * La fila se identifica por solicitud + `week_start_date` (lunes de la semana de cuota), no por id de cuota.
 *
 * Ejemplo (63.40 PEN → USD con TC efectivo; DNI opcional para no tocar otra solicitud):
 *   node scripts/miauto-corregir-paid-pen-a-usd.js 4178b659-ad03-4be4-8a9d-ef3dd368e514 2026-03-30 63.40 08889181
 */
import { query } from '../config/database.js';
import {
  convertirMontoEntreMonedas,
  round2,
  tipoCambioUsdALocalEfectivo,
} from '../services/miautoMoneyUtils.js';
import { updateMoraDiaria } from '../services/miautoCuotaSemanalService.js';

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

const sid = process.argv[2]?.trim();
const week = process.argv[3]?.trim();
const pen = parseFloat(String(process.argv[4] || '').replace(',', '.'));
const dniCheck = process.argv[5]?.trim();

if (!sid || !week || Number.isNaN(pen) || pen <= 0) {
  console.error(
    'Uso: node scripts/miauto-corregir-paid-pen-a-usd.js <solicitud_uuid> <YYYY-MM-DD> <monto_pen> [dni_opcional]'
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
    console.error('Solicitud no encontrada');
    process.exit(1);
  }
  const dniBd = String(row.dni_rd || row.dni_sol || '');
  if (dniBd !== digitsOnly(dniCheck)) {
    console.error(`DNI no coincide: BD=${dniBd || '(vacío)'} esperado=${digitsOnly(dniCheck)}`);
    process.exit(1);
  }
}

const sol = await query('SELECT country FROM module_miauto_solicitud WHERE id = $1::uuid', [sid]);
if (!sol.rows[0]) {
  console.error('Solicitud no encontrada');
  process.exit(1);
}
const country = String(sol.rows[0].country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
const { valorUsdALocal, monedaLocal, fromFallback } = await tipoCambioUsdALocalEfectivo(country);
const usd = convertirMontoEntreMonedas(pen, monedaLocal, 'USD', valorUsdALocal);
const paidUsd = usd != null ? round2(usd) : 0;

const row = await query(
  `SELECT id, moneda, amount_due, late_fee, paid_amount, status
   FROM module_miauto_cuota_semanal
   WHERE solicitud_id = $1::uuid AND week_start_date = $2::date`,
  [sid, week]
);
if (!row.rows[0]) {
  console.error('No hay cuota para esa solicitud y semana');
  process.exit(1);
}
const r = row.rows[0];
if (String(r.moneda || '').toUpperCase() !== 'USD') {
  console.error('La fila no es moneda USD; no se aplica esta corrección.');
  process.exit(1);
}

const totalDue = round2(parseFloat(r.amount_due) + parseFloat(r.late_fee || 0));
const paidCapped = round2(Math.min(paidUsd, totalDue));
let st = r.status;
if (paidCapped >= totalDue - 0.005) st = 'paid';
else if (paidCapped > 0.005) st = 'partial';
else st = r.status === 'overdue' ? 'overdue' : 'pending';

await query(
  `UPDATE module_miauto_cuota_semanal
   SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP
   WHERE id = $3::uuid`,
  [paidCapped, st, r.id]
);

await updateMoraDiaria(sid, { includePartial: true });

console.log(
  JSON.stringify(
    {
      ok: true,
      solicitud_id: sid,
      week_start_date: week,
      monto_pen_abonado: pen,
      moneda_local: monedaLocal,
      valor_usd_a_local: valorUsdALocal,
      tipo_cambio_fallback: fromFallback,
      paid_amount_usd_corregido: paidCapped,
      status: st,
    },
    null,
    2
  )
);
