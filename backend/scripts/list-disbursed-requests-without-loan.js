/**
 * Lista solicitudes desembolsadas sin préstamo y, con --insert, inserta el préstamo que corresponde.
 *
 * Si tienes el Excel con la hoja Cronograma (cuotas, fechas, montos), es mejor usar el import
 * con --fix-missing-loans para que cree los préstamos con los datos reales del Cronograma:
 *   node excel/importExcelRptasPE.js --fix-missing-loans
 * (mismo archivo Excel; solo crea préstamos para solicitudes que aún no tienen).
 *
 * Este script con --insert crea préstamos con 4 cuotas genéricas (útil si no tienes el Excel).
 *
 * Uso (desde backend/):
 *   node scripts/list-disbursed-requests-without-loan.js
 *   node scripts/list-disbursed-requests-without-loan.js --insert
 *   node scripts/list-disbursed-requests-without-loan.js --country=PE --insert
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

const { query } = await import('../config/database.js');
const { getNextMondayFrom } = await import('../utils/helpers.js');
const { generateInstallmentSchedule } = await import('../services/calculationsService.js');

/** Misma lógica que en import: candidatos para coincidencia (mismo número con/sin ceros). No normaliza. */
function getDniLookupCandidates(dni) {
  const s = (dni || '').toString().trim();
  if (!s) return [];
  const digits = s.replace(/\D/g, '');
  if (digits === '') return [s];
  const withoutLeadingZeros = digits.replace(/^0+/, '') || '0';
  const padded8 = withoutLeadingZeros.padStart(8, '0');
  return [...new Set([s, digits, withoutLeadingZeros, padded8])];
}

function toDateStr(d) {
  if (!d) return null;
  const x = new Date(d);
  if (isNaN(x.getTime())) return null;
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  const countryArg = process.argv.find((a) => a.startsWith('--country='));
  const country = countryArg ? (String(countryArg.split('=')[1]).toUpperCase() === 'CO' ? 'CO' : 'PE') : null;
  const doInsert = process.argv.includes('--insert');

  const sql = `
    SELECT r.id AS request_id, r.driver_id, r.country, r.requested_amount, r.status, r.created_at,
           r.disbursed_at, r.cycle,
           d.dni, d.first_name, d.last_name
    FROM module_rapidin_loan_requests r
    LEFT JOIN module_rapidin_loans l ON l.request_id = r.id
    LEFT JOIN module_rapidin_drivers d ON d.id = r.driver_id
    WHERE l.id IS NULL
      AND r.status IN ('disbursed', 'desembolsado', 'Desembolsado')
      ${country ? 'AND r.country = $1' : ''}
    ORDER BY r.country, r.created_at DESC
  `;
  const params = country ? [country] : [];
  const res = await query(sql, params);

  console.log('Solicitudes desembolsadas sin préstamo asociado:', res.rows.length);
  if (res.rows.length === 0) {
    process.exit(0);
    return;
  }

  if (!doInsert) {
    for (const row of res.rows) {
      const coincidencias = getDniLookupCandidates(row.dni);
      console.log({
        request_id: row.request_id,
        country: row.country,
        dni: row.dni,
        formas_que_coinciden: coincidencias.length > 1 ? coincidencias : coincidencias[0],
        requested_amount: row.requested_amount,
        driver: row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : row.driver_id,
      });
    }
    console.log('\nPara insertar los préstamos que corresponden a cada solicitud, ejecuta con --insert');
    process.exit(0);
    return;
  }

  const defaultWeeks = 4;
  const defaultInterestRate = 5;
  let inserted = 0;
  let errors = 0;

  for (const row of res.rows) {
    const amount = parseFloat(row.requested_amount);
    if (!row.driver_id || amount <= 0) {
      console.error('Omitido (sin driver o monto inválido):', row.request_id);
      errors++;
      continue;
    }
    const disbursedAt = row.disbursed_at || row.created_at;
    const firstPaymentDate = getNextMondayFrom(disbursedAt);
    const firstPaymentDateStr = toDateStr(firstPaymentDate);

    let loanId = null;
    try {
      const loanRes = await query(
        `INSERT INTO module_rapidin_loans
         (request_id, driver_id, country, disbursed_amount, total_amount, interest_rate, number_of_installments, disbursed_at, first_payment_date, status, pending_balance, cycle)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $5, $10)
         RETURNING id`,
        [
          row.request_id,
          row.driver_id,
          row.country,
          amount,
          amount,
          defaultInterestRate,
          defaultWeeks,
          disbursedAt || new Date(),
          firstPaymentDateStr,
          row.cycle != null ? row.cycle : 1,
        ]
      );
      loanId = loanRes.rows[0].id;
      await generateInstallmentSchedule(loanId, amount, defaultInterestRate, defaultWeeks, firstPaymentDateStr);
      inserted++;
      console.log('Préstamo creado:', loanId, '→ request', row.request_id, 'DNI', row.dni, 'monto', amount);
    } catch (err) {
      if (loanId) {
        await query('DELETE FROM module_rapidin_installments WHERE loan_id = $1', [loanId]).catch(() => {});
        await query('DELETE FROM module_rapidin_loans WHERE id = $1', [loanId]).catch(() => {});
      }
      console.error('Error creando préstamo para request', row.request_id, err.message);
      errors++;
    }
  }

  console.log('\nPréstamos insertados:', inserted);
  if (errors > 0) console.log('Errores:', errors);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
