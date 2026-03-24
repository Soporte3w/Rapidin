/**
 * Prueba / regeneración de cuota semanal Mi Auto:
 * 1) Consulta Yango driver/income (viajes + partner_fees) en el rango Lun–Dom Lima (ver miautoLimaWeekRange.js).
 * 2) ensureCuotaSemanalForWeek (misma lógica que el job del lunes).
 * 3) Cobro en Yango solo si pasas --cobrar; por defecto NO retira saldo.
 *
 * Semana: el lunes de la cuota es el que sale de --week-end-sunday (domingo final) o --week-start.
 * Ej.: domingo 22/03/2026 → lunes semana 2026-03-16; Yango usa 16–22 mar inclusive (Lima).
 *      Ese es el mismo tramo que liquida el job del lunes 23/03/2026 (semana ya cerrada).
 *      domingo 15/03/2026 → lunes 2026-03-09; Yango usa 9–15 mar (job lunes 16/03).
 *
 * Uso:
 *   node scripts/generar-cuota-miauto-semana.js --conductor 46850186 --week-end-sunday 2026-03-22
 *   node scripts/generar-cuota-miauto-semana.js --solicitud-id <uuid> --week-end-sunday 2026-03-22
 *   node scripts/generar-cuota-miauto-semana.js ... --cobrar   # opcional: retiro en Yango
 *
 * Si Yango falla (401, etc.): renueva YANGO_FLEET_COOKIE_COBRO y vuelve a ejecutar. No se inventan viajes/fees.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production' ? '.env' : '.env.development';
dotenv.config({ path: path.join(__dirname, '..', envFile) });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { logger } from '../utils/logger.js';
import { loadProxiesFromUrlIfConfigured } from '../services/proxyLoader.js';
import { getDriverIncome } from '../services/yangoService.js';
import {
  ensureCuotaSemanalForWeek,
  persistPaidAmountCapsForSolicitud,
  processCobroCuota,
  updateMoraDiaria,
} from '../services/miautoCuotaSemanalService.js';
import { query } from '../config/database.js';
import { addDaysYmd, limaWeekStartToIncomeRange } from '../utils/miautoLimaWeekRange.js';

/** Lunes de la semana cuyo domingo es weekEndSunday (YYYY-MM-DD). Aritmética civil UTC (no TZ del servidor). */
function mondayFromWeekEndingSunday(yyyyMmDd) {
  return addDaysYmd(yyyyMmDd, -6);
}

function parseArgs(argv) {
  const out = {
    cobrar: false,
    conductor: '46850186',
    solicitudId: null,
    weekStart: null,
    weekEndSunday: '2026-03-22',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cobrar') out.cobrar = true;
    else if ((a === '--conductor' || a === '--external-driver-id') && argv[i + 1])
      out.conductor = String(argv[++i]).trim();
    else if (a === '--solicitud-id' && argv[i + 1]) out.solicitudId = String(argv[++i]).trim();
    else if (a === '--week-start' && argv[i + 1]) out.weekStart = String(argv[++i]).trim();
    else if (a === '--week-end-sunday' && argv[i + 1]) out.weekEndSunday = String(argv[++i]).trim();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function findSolicitud(conductorOrDni, solicitudIdOpt) {
  if (solicitudIdOpt && /^[0-9a-f-]{36}$/i.test(solicitudIdOpt)) {
    const res = await query(
      `SELECT s.id AS solicitud_id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
              s.status, s.pago_estado,
              rd.id AS driver_id, rd.external_driver_id, rd.dni, rd.park_id, rd.first_name, rd.last_name
       FROM module_miauto_solicitud s
       INNER JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
       WHERE s.id = $1::uuid`,
      [solicitudIdOpt]
    );
    return res.rows || [];
  }
  const id = String(conductorOrDni || '').trim();
  const res = await query(
    `SELECT s.id AS solicitud_id, s.cronograma_id, s.cronograma_vehiculo_id, s.fecha_inicio_cobro_semanal,
            s.status, s.pago_estado,
            rd.id AS driver_id, rd.external_driver_id, rd.dni, rd.park_id, rd.first_name, rd.last_name
     FROM module_miauto_solicitud s
     INNER JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE (TRIM(rd.external_driver_id) = $1 OR TRIM(rd.dni) = $1)
     ORDER BY s.updated_at DESC NULLS LAST
     LIMIT 5`,
    [id]
  );
  return res.rows || [];
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`
Genera cuota semanal Mi Auto consultando Yango (misma lógica que el job del lunes).

  --conductor ID            external_driver_id (Yango) o DNI en Rapidín (default 46850186)
  --solicitud-id UUID       Forzar una solicitud concreta
  --week-end-sunday DATE    Domingo final Lun–Dom Lima (default 2026-03-22)
  --week-start DATE         Lunes de inicio (si se indica, ignora week-end-sunday)
  --cobrar                  Tras generar: mora + tope paid_amount + retiro Yango (withdraw)

Los viajes y partner_fees salen siempre de la API Yango (driver/income). Si falla, renueva la cookie.

Rango Yango (Lima -05:00): del lunes 00:00 al domingo 23:59 de esa semana.
  --week-end-sunday 2026-03-22 → week_start en BD 2026-03-16 → income 16 mar … 22 mar
  --week-end-sunday 2026-03-15 → week_start 2026-03-09 → income 9 mar … 15 mar

La semana debe ser >= fecha_inicio_cobro_semanal.

Por defecto NO cobra: no retira saldo en Yango. Solo usa --cobrar si quieres withdraw.
`);
    process.exit(0);
  }

  if (args.cobrar) {
    logger.warn(
      'Modo --cobrar: se ejecutará retiro (withdraw) en Yango después de generar/actualizar la cuota.'
    );
  } else {
    logger.info(
      'Sin --cobrar: no se retirará saldo en Yango (solo cuota/mora en BD y consulta income si aplica).'
    );
  }

  await loadProxiesFromUrlIfConfigured();

  const weekStartDate =
    args.weekStart && /^\d{4}-\d{2}-\d{2}$/.test(args.weekStart)
      ? args.weekStart
      : mondayFromWeekEndingSunday(args.weekEndSunday || '2026-03-22');

  const { dateFrom, dateTo, sundayDate } = limaWeekStartToIncomeRange(weekStartDate);

  const rows = await findSolicitud(args.conductor, args.solicitudId);
  if (rows.length === 0) {
    logger.error(
      `No hay solicitud Mi Auto para conductor=${args.conductor}${args.solicitudId ? ` o solicitud-id=${args.solicitudId}` : ''}`
    );
    process.exit(1);
  }

  const sol = rows.find((r) => r.status === 'aprobado' && r.pago_estado === 'completo') || rows[0];
  if (sol.status !== 'aprobado' || sol.pago_estado !== 'completo') {
    logger.warn(
      `Solicitud ${sol.solicitud_id} estado=${sol.status} pago=${sol.pago_estado} (se intenta igual si hay cronograma)`
    );
  }

  const inicio = sol.fecha_inicio_cobro_semanal
    ? new Date(sol.fecha_inicio_cobro_semanal).toISOString().slice(0, 10)
    : null;
  if (inicio && weekStartDate < inicio) {
    logger.error(
      `week_start ${weekStartDate} es anterior a fecha_inicio_cobro_semanal ${inicio}; el job no generaría esta semana.`
    );
    process.exit(1);
  }

  logger.info(
    `Conductor ${sol.first_name} ${sol.last_name} | solicitud ${sol.solicitud_id} | Lun ${weekStartDate} → Dom ${sundayDate} Lima | week_start_date=${weekStartDate} | Yango ${dateFrom} … ${dateTo}`
  );

  if (!sol.external_driver_id || !String(sol.external_driver_id).trim()) {
    logger.error(
      'El conductor no tiene external_driver_id en BD; no se puede consultar Yango. Actualízalo en Rapidín / drivers.'
    );
    process.exit(1);
  }

  const incomeResult = await getDriverIncome(dateFrom, dateTo, sol.external_driver_id, sol.park_id);
  if (!incomeResult.success) {
    logger.error(
      `Yango income falló: ${incomeResult.error}. Renueva YANGO_FLEET_COOKIE_COBRO (o cookie de cobro) y vuelve a ejecutar; no se genera cuota sin respuesta de Yango.`
    );
    process.exit(1);
  }

  logger.info(
    `Yango respondió: viajes=${incomeResult.count_completed} partner_fees=${incomeResult.partner_fees}`
  );

  const cuotaId = await ensureCuotaSemanalForWeek(
    sol.solicitud_id,
    sol.cronograma_id,
    sol.cronograma_vehiculo_id,
    weekStartDate,
    { count_completed: incomeResult.count_completed, partner_fees: incomeResult.partner_fees }
  );

  if (cuotaId == null) {
    logger.error('ensureCuotaSemanalForWeek no creó/actualizó cuota (revisa cronograma y reglas).');
    process.exit(1);
  }

  await persistPaidAmountCapsForSolicitud(sol.solicitud_id);
  await updateMoraDiaria(sol.solicitud_id);

  const cuRes = await query(
    `SELECT c.id, c.solicitud_id, c.week_start_date, c.due_date, c.amount_due, c.paid_amount, c.late_fee, c.status,
            s.cronograma_id, rd.id AS driver_id, rd.external_driver_id, rd.park_id, rd.first_name, rd.last_name, s.country
     FROM module_miauto_cuota_semanal c
     INNER JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
     INNER JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     WHERE c.solicitud_id = $1 AND c.week_start_date = $2::date`,
    [sol.solicitud_id, weekStartDate]
  );

  const cuotaRow = cuRes.rows[0];
  logger.info(
    `Cuota id=${cuotaRow.id} amount_due=${cuotaRow.amount_due} paid=${cuotaRow.paid_amount} late_fee=${cuotaRow.late_fee} status=${cuotaRow.status}`
  );

  if (args.cobrar) {
    const cobro = await processCobroCuota(cuotaRow);
    logger.info(`Cobro por saldo: ${JSON.stringify(cobro)}`);
  } else {
    logger.info('Sin --cobrar: no se retiró saldo en Yango. Añade --cobrar para probar withdraw.');
  }

  process.exit(0);
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
