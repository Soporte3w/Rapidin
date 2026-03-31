/**
 * Suma un abono en moneda local (PEN/COP) a `paid_amount` de una cuota, convirtiendo a USD si la fila es `moneda = USD`.
 *
 * Destino:
 * - **Ordinal N** (1 = primera fila por `week_start_date` ASC), o
 * - **`antigua`** — la cuota con **saldo pendiente** más antigua (mismo criterio que la cascada PF: `due_date` ASC, `week_start_date` ASC, `id` ASC).
 *
 * Uso (desde `backend/`):
 *   node scripts/miauto-abonar-pen-cuota-semana-ordinal.js <solicitud_uuid> <N|antigua> <monto> [usd] [dni_opcional]
 *
 * - Sin `usd`: el monto es **PEN/COP** y se convierte a USD si la cuota es USD.
 * - Con **`usd`**: el monto ya está en **dólares** (solo cuotas `moneda = USD`).
 *
 * Ejemplos:
 *   node scripts/... <uuid> antigua 154.90
 *   node scripts/... <uuid> antigua 56.76 usd
 *   node scripts/... <uuid> 28 30
 */
import { query } from '../config/database.js';
import {
  convertirMontoEntreMonedas,
  round2,
  tipoCambioUsdALocalEfectivo,
} from '../services/miautoMoneyUtils.js';
import {
  persistPaidAmountCapsForSolicitud,
  updateMoraDiaria,
} from '../services/miautoCuotaSemanalService.js';

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function limaTodayYmd() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function dueYmdOnly(d) {
  if (d == null) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).trim().slice(0, 10);
}

function statusTrasAbono(dueDateRaw, amountDue, lateFee, newPaid) {
  const totalDue = round2(Number(amountDue) + Number(lateFee || 0));
  const pend = round2(totalDue - newPaid);
  if (pend <= 0.02) return 'paid';
  if (newPaid <= 0.02) return 'pending';
  const dueYmd = dueYmdOnly(dueDateRaw);
  const today = limaTodayYmd();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueYmd) && dueYmd < today) return 'overdue';
  return 'partial';
}

const sid = process.argv[2]?.trim();
const destinoRaw = process.argv[3]?.trim() || '';
const useAntigua = /^(antigua|mas-antigua|masantigua|vieja)$/i.test(destinoRaw);
const nOrdinal = useAntigua ? null : Math.max(1, parseInt(String(destinoRaw || ''), 10) || 0);

let argi = 4;
const montoIngresado = parseFloat(String(process.argv[argi++] || '').replace(',', '.'));
let abonoUsdDirecto = false;
let dniCheck = null;
const maybeUsd = process.argv[argi]?.trim();
if (maybeUsd && /^usd$/i.test(maybeUsd)) {
  abonoUsdDirecto = true;
  argi += 1;
}
const maybeDni = process.argv[argi]?.trim();
if (maybeDni && digitsOnly(maybeDni).length >= 7) {
  dniCheck = maybeDni;
}

if (!sid || (!useAntigua && !nOrdinal) || Number.isNaN(montoIngresado) || montoIngresado <= 0) {
  console.error(
    'Uso: node scripts/miauto-abonar-pen-cuota-semana-ordinal.js <solicitud_uuid> <N|antigua> <monto> [usd] [dni]'
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

/** Misma idea que filas elegibles en `applyPartnerFeesWaterfallToSolicitud`: saldo en columnas, orden antigüedad por vencimiento. */
const SQL_CUOTA_MAS_ANTIGUA_CON_SALDO = `
  SELECT c.id, c.week_start_date, c.due_date, c.moneda, c.amount_due, c.late_fee, c.paid_amount, c.status
  FROM module_miauto_cuota_semanal c
  WHERE c.solicitud_id = $1::uuid
    AND LOWER(COALESCE(c.status::text, '')) <> 'bonificada'
    AND (
      c.status IN ('pending', 'overdue', 'partial')
      OR (
        LOWER(COALESCE(c.status::text, '')) = 'paid'
        AND COALESCE(c.amount_due, 0)::numeric + COALESCE(c.late_fee, 0)::numeric
            > COALESCE(c.paid_amount, 0)::numeric + 0.02
      )
    )
    AND COALESCE(c.amount_due, 0)::numeric + COALESCE(c.late_fee, 0)::numeric
        - COALESCE(c.paid_amount, 0)::numeric > 0.02
  ORDER BY c.due_date ASC NULLS LAST, c.week_start_date ASC NULLS LAST, c.id ASC
  LIMIT 1
`;

let r;
let semanaOrdinalUi;
let destinoEtiqueta;

if (useAntigua) {
  const cuOld = await query(SQL_CUOTA_MAS_ANTIGUA_CON_SALDO, [sid]);
  r = cuOld.rows[0];
  if (!r) {
    console.error('No hay cuota con saldo pendiente en esta solicitud (nada que abonar como “antigua”).');
    process.exit(1);
  }
  const ordRes = await query(
    `SELECT n FROM (
       SELECT id, ROW_NUMBER() OVER (ORDER BY week_start_date ASC NULLS LAST) AS n
       FROM module_miauto_cuota_semanal WHERE solicitud_id = $1::uuid
     ) z WHERE id = $2::uuid`,
    [sid, r.id]
  );
  semanaOrdinalUi = ordRes.rows[0]?.n != null ? Number(ordRes.rows[0].n) : null;
  destinoEtiqueta = 'mas_antigua_con_saldo';
} else {
  const cu = await query(
    `SELECT id, week_start_date, due_date, moneda, amount_due, late_fee, paid_amount, status
     FROM (
       SELECT c.*, ROW_NUMBER() OVER (ORDER BY c.week_start_date ASC NULLS LAST) AS n
       FROM module_miauto_cuota_semanal c
       WHERE c.solicitud_id = $1::uuid
     ) x
     WHERE n = $2`,
    [sid, nOrdinal]
  );
  r = cu.rows[0];
  if (!r) {
    console.error(`No hay cuota con ordinal ${nOrdinal} para la solicitud`);
    process.exit(1);
  }
  semanaOrdinalUi = nOrdinal;
  destinoEtiqueta = `ordinal_${nOrdinal}`;
}

const monedaFila = String(r.moneda || 'PEN').toUpperCase();
let deltaEnMonedaCuota;
let detalleConversion = null;

if (abonoUsdDirecto) {
  if (monedaFila !== 'USD') {
    console.error('La palabra clave `usd` solo aplica cuando la cuota está en USD.');
    process.exit(1);
  }
  deltaEnMonedaCuota = round2(montoIngresado);
  detalleConversion = {
    abono_usd_directo: deltaEnMonedaCuota,
    delta_moneda_cuota_sobre_paid: deltaEnMonedaCuota,
  };
} else if (monedaFila === 'USD') {
  const solC = await query('SELECT country FROM module_miauto_solicitud WHERE id = $1::uuid', [sid]);
  const country = String(solC.rows[0]?.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
  const { valorUsdALocal, monedaLocal, fromFallback } = await tipoCambioUsdALocalEfectivo(country);
  const usd = convertirMontoEntreMonedas(montoIngresado, monedaLocal, 'USD', valorUsdALocal);
  if (usd == null || Number.isNaN(usd)) {
    console.error('No se pudo convertir monto local a USD (revisar tipo de cambio)');
    process.exit(1);
  }
  deltaEnMonedaCuota = round2(usd);
  detalleConversion = {
    monto_ingresado_moneda_local: round2(montoIngresado),
    moneda_local: monedaLocal,
    valor_usd_a_local: valorUsdALocal,
    tipo_cambio_fallback: fromFallback,
    delta_moneda_cuota_sobre_paid: deltaEnMonedaCuota,
  };
} else {
  deltaEnMonedaCuota = round2(montoIngresado);
}

const paidPrev = round2(parseFloat(r.paid_amount) || 0);
const totalDue = round2(parseFloat(r.amount_due) + parseFloat(r.late_fee || 0));
let newPaid = round2(paidPrev + deltaEnMonedaCuota);
newPaid = round2(Math.min(newPaid, totalDue));
const newStatus = statusTrasAbono(r.due_date, r.amount_due, r.late_fee, newPaid);

await query(
  `UPDATE module_miauto_cuota_semanal
   SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP
   WHERE id = $3::uuid`,
  [newPaid, newStatus, r.id]
);

await updateMoraDiaria(sid, { includePartial: true });
await persistPaidAmountCapsForSolicitud(sid);

console.log(
  JSON.stringify(
    {
      ok: true,
      solicitud_id: sid,
      destino: destinoEtiqueta,
      semana_ordinal_ui: semanaOrdinalUi,
      cuota_id: r.id,
      week_start_date: r.week_start_date,
      moneda_cuota: monedaFila,
      paid_amount_antes: paidPrev,
      paid_amount_despues: newPaid,
      incremento_aplicado_moneda_cuota: round2(newPaid - paidPrev),
      status: newStatus,
      amount_due: round2(parseFloat(r.amount_due)),
      late_fee: round2(parseFloat(r.late_fee || 0)),
      total_obligacion_columnas: totalDue,
      ...(detalleConversion || {}),
    },
    null,
    2
  )
);
