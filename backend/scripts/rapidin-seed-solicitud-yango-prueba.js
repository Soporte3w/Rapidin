/**
 * Crea (o reutiliza) una solicitud **aprobada** con recepción Yango Pro para probar el modal
 * de confirmación de desembolso (texto "cobro automático a las 15:31", recarga Fleet, etc.).
 * **No ejecuta desembolso** ni llama a APIs de Yango.
 *
 * Uso:
 *   cd backend && node scripts/rapidin-seed-solicitud-yango-prueba.js
 *   cd backend && node scripts/rapidin-seed-solicitud-yango-prueba.js --dni=77221246 --country=PE --amount=500
 */
import 'dotenv/config';
import { query } from '../config/database.js';
import { createLoanRequest } from '../services/loanService.js';
import { simulateLoanOptions } from '../services/calculationsService.js';

function parseArgs(argv) {
  const out = { dni: '77221246', country: 'PE', amount: 500 };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--dni=')) out.dni = a.slice(6).trim();
    else if (a.startsWith('--country=')) out.country = a.slice(10).trim().toUpperCase();
    else if (a.startsWith('--amount=')) out.amount = parseFloat(a.slice(9)) || out.amount;
  }
  return out;
}

async function ensureDriver(dni, country) {
  const existing = await query(
    'SELECT * FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 LIMIT 1',
    [dni, country]
  );
  if (existing.rows.length > 0) return existing.rows[0];
  const ins = await query(
    `INSERT INTO module_rapidin_drivers (dni, country, first_name, last_name, phone, cycle, credit_line)
     VALUES ($1, $2, $3, $4, $5, 1, 5000)
     RETURNING *`,
    [dni, country, 'Prueba', 'Yango UI', '999000000']
  );
  return ins.rows[0];
}

async function findReusableOpenRequest(driverId) {
  const r = await query(
    `SELECT r.id
     FROM module_rapidin_loan_requests r
     LEFT JOIN module_rapidin_loans l ON l.request_id = r.id
     WHERE r.driver_id = $1
       AND r.status IN ('approved', 'signed')
       AND r.disbursed_at IS NULL
       AND l.id IS NULL
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [driverId]
  );
  return r.rows[0]?.id || null;
}

async function main() {
  const { dni, country, amount } = parseArgs(process.argv);
  const driver = await ensureDriver(dni, country);
  const cycle = Math.max(1, parseInt(driver.cycle, 10) || 1);

  const conditionsResult = await query(
    'SELECT * FROM module_rapidin_loan_conditions WHERE country = $1 AND active = true ORDER BY version DESC LIMIT 1',
    [country]
  );
  if (conditionsResult.rows.length === 0) {
    console.error('No hay module_rapidin_loan_conditions activas para', country);
    process.exit(1);
  }
  const conditions = conditionsResult.rows[0];
  const sim = await simulateLoanOptions(amount, country, cycle, conditions, null);
  if (!sim?.option) {
    console.error('No se pudo simular la opción de préstamo.');
    process.exit(1);
  }

  const option = sim.option;
  const observations = {
    purpose: 'Prueba UI — modal Yango (sin desembolso real)',
    deposit_type: 'yango',
    createdByAdmin: true,
    approvedOption: option,
    admin_selected_option: option,
  };

  let requestId = await findReusableOpenRequest(driver.id);

  if (requestId) {
    await query(
      `UPDATE module_rapidin_loan_requests
       SET status = 'approved',
           observations = $2::text,
           approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [requestId, JSON.stringify(observations)]
    );
    console.log('Solicitud existente reutilizada y actualizada a Yango Pro (aprobada, sin desembolso).');
  } else {
    const row = await createLoanRequest(
      {
        driver_id: driver.id,
        country,
        requested_amount: amount,
        observations: JSON.stringify(observations),
      },
      null,
      { createdByAdmin: true }
    );
    requestId = row.id;
    await query(
      `UPDATE module_rapidin_loan_requests
       SET status = 'approved',
           approved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [requestId]
    );
    console.log('Nueva solicitud creada y aprobada (sin desembolso).');
  }

  console.log('');
  console.log('driver_id:', driver.id);
  console.log('request_id:', requestId);
  console.log('Abre en Yego Rapidín → Solicitudes → detalle de esta solicitud → Desembolsar → verás el modal Yango.');
  console.log('Cierra con Cancelar para no desembolsar.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
