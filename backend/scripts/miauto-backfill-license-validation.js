/**
 * Completa la validación Factiliza de licencias históricas de Mi Auto.
 *
 * Diagnóstico (no consulta Factiliza ni modifica datos):
 *   npm run miauto:backfill-license-validation
 *
 * Aplicar, con pausa entre llamadas y límite opcional:
 *   npm run miauto:backfill-license-validation -- --apply --delay-ms=400 --limit=100
 *
 * Los estados error no se reintentan salvo que se use --retry-errors.
 */
import pool, { query } from '../config/database.js';
import { validateMiautoLicense } from '../yego_miauto/services/licencia/miautoLicenseValidationService.js';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const RETRY_ERRORS = args.has('--retry-errors');

function integerArgument(name, fallback, minimum = 0) {
  const prefix = `--${name}=`;
  const raw = [...args].find((arg) => arg.startsWith(prefix));
  if (!raw) return fallback;
  const value = Number(raw.slice(prefix.length));
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`--${name} debe ser un entero mayor o igual a ${minimum}`);
  }
  return value;
}

const LIMIT = integerArgument('limit', 0, 0);
const DELAY_MS = integerArgument('delay-ms', 400, 0);

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function main() {
  const statuses = RETRY_ERRORS ? ['pending', 'error'] : ['pending'];
  const params = [statuses];
  const limitSql = LIMIT > 0 ? ' LIMIT $2' : '';
  if (LIMIT > 0) params.push(LIMIT);
  const result = await query(
    `SELECT id, dni, country
     FROM module_miauto_solicitud
     WHERE country = 'PE'
       AND license_validation_status = ANY($1::text[])
       AND dni ~ '^\\d{8}$'
     ORDER BY created_at ASC, id ASC${limitSql}`,
    params
  );

  console.log(`Modo: ${APPLY ? 'APLICAR' : 'DIAGNÓSTICO'}`);
  console.log(`Solicitudes elegibles: ${result.rows.length}`);
  if (!APPLY) {
    console.log('No se consultó Factiliza ni se modificó la base. Use --apply para ejecutar el backfill.');
    return;
  }

  const stats = { valid: 0, invalid: 0, error: 0, not_applicable: 0 };
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index];
    const validation = await validateMiautoLicense({
      solicitudId: row.id,
      dni: row.dni,
      country: row.country,
    });
    stats[validation.status] = (stats[validation.status] || 0) + 1;
    console.log(`[${index + 1}/${result.rows.length}] ${row.id}: ${validation.status}`);
    if (index + 1 < result.rows.length) await delay(DELAY_MS);
  }

  console.log(`Resultado: válidas=${stats.valid}, no válidas=${stats.invalid}, errores=${stats.error}`);
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(`Backfill de licencias falló: ${error.message}`);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
