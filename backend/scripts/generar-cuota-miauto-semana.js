/**
 * Prueba / regeneración de cuota semanal Mi Auto:
 * 1) Consulta Yango driver/income (viajes + partner_fees) en el rango Lun–Dom Lima (ver miautoLimaWeekRange.js).
 * 2) ensureCuotaSemanalForWeek (misma lógica que el job del lunes).
 * 3) No retira saldo en Yango (solo genera/actualiza cuota y mora en BD).
 *
 * week_start_date en BD = **lunes** de la semana de viajes (Lun 00:00 – Dom 23:59 Lima en Yango).
 * due_date (vence en UI) = **lunes siguiente** a ese cierre (salvo semana 1 depósito = fecha_inicio_cobro).
 *
 * Numeración operativa típica (ej. plan Mi Auto desde cobro inicial):
 *   Semana 1: cobro inicial / depósito — no se usan viajes de Yango.
 *   Semana 2: lun 23 feb – dom 1 mar 2026  →  week_start 2026-02-23
 *   Semana 3: lun 2 – dom 8 mar           →  week_start 2026-03-02
 *   Semana 4: lun 9 – dom 15 mar          →  week_start 2026-03-09
 *   Semana 5: lun 16 – dom 22 mar         →  week_start 2026-03-16  (NO 23–29 mar; ese sería otra semana)
 *
 * Para regenerar **una semana concreta** (Yango pisa la fila si ya existe): `--week-end-sunday` o `--week-start`.
 * Ej.: lun 16–dom 22 mar → `--week-end-sunday 2026-03-22` → `week_start` 2026-03-16.
 *
 * Para **liquidar la última semana cerrada** (igual que el job del lunes): `--siguiente-semana`
 *   → Yango consulta **solo** la semana Lun–Dom **anterior** a la semana actual en Lima (nunca futuros).
 *   Ej.: si hoy en Lima es lun 23 mar, se liquida **16–22 mar** (`week_start` 2026-03-16), **no** 23–29 mar.
 *
 * Uso:
 *   node scripts/generar-cuota-miauto-semana.js --conductor 46850186 --siguiente-semana
 *   node scripts/generar-cuota-miauto-semana.js --conductor 46850186 --week-end-sunday 2026-03-22
 *   node scripts/generar-cuota-miauto-semana.js --conductor 46850186 --week-start 2026-03-16 --solo-esta-semana
 *   node scripts/generar-cuota-miauto-semana.js --conductor 46850186 --week-start 2026-03-16 --no-actualizar-si-existe
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
import { getDriverIncome } from '../services/yangoService.js';
import {
  ensureCuotaSemanalForWeek,
  persistPaidAmountCapsForSolicitud,
  updateMoraDiaria,
} from '../services/miautoCuotaSemanalService.js';
import { query } from '../config/database.js';
import { addDaysYmd, getPreviousWeekIncomeRangeLima, limaWeekStartToIncomeRange } from '../utils/miautoLimaWeekRange.js';

/** Lunes de la semana cuyo domingo es weekEndSunday (YYYY-MM-DD). Aritmética civil UTC (no TZ del servidor). */
function mondayFromWeekEndingSunday(yyyyMmDd) {
  return addDaysYmd(yyyyMmDd, -6);
}

function parseArgs(argv) {
  const out = {
    conductor: '46850186',
    solicitudId: null,
    weekStart: null,
    weekEndSunday: '2026-03-22',
    siguienteSemana: false,
    noActualizarSiExiste: false,
    soloEstaSemana: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--conductor' || a === '--external-driver-id') && argv[i + 1])
      out.conductor = String(argv[++i]).trim();
    else if (a === '--solicitud-id' && argv[i + 1]) out.solicitudId = String(argv[++i]).trim();
    else if (a === '--week-start' && argv[i + 1]) out.weekStart = String(argv[++i]).trim();
    else if (a === '--week-end-sunday' && argv[i + 1]) out.weekEndSunday = String(argv[++i]).trim();
    else if (a === '--siguiente-semana' || a === '--liquidar-semana-anterior-lima') out.siguienteSemana = true;
    else if (a === '--no-actualizar-si-existe') out.noActualizarSiExiste = true;
    else if (a === '--solo-esta-semana') out.soloEstaSemana = true;
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
  --siguiente-semana        Liquida la semana Lun–Dom **ya cerrada** en Lima (mismo criterio que job lunes; no consulta futuro)
  --liquidar-semana-anterior-lima  Igual que --siguiente-semana
  --no-actualizar-si-existe No pisa la fila si ya hay cuota para ese lunes (solo con fecha explícita)
  --solo-esta-semana     No recalcula mora ni paid_amount en otras cuotas de la solicitud (solo la fila de esta semana)

Este script no ejecuta retiro (withdraw) en Yango; solo consulta income y persiste en BD.

Los viajes y partner_fees salen siempre de la API Yango (driver/income). Si falla, renueva la cookie.

Rango Yango (Lima -05:00): del lunes 00:00 al domingo 23:59 de esa semana.
  Si ya existe fila para ese lunes, se ACTUALIZA salvo --no-actualizar-si-existe.
  --siguiente-semana NO usa MAX(week_start)+7; usa la semana anterior cerrada (ver miautoLimaWeekRange getPreviousWeekIncomeRangeLima).

La semana debe ser >= fecha_inicio_cobro_semanal.
`);
    process.exit(0);
  }

  if (process.argv.includes('--cobrar')) {
    logger.warn('--cobrar ignorado: este script no hace withdraw en Fleet.');
  }

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

  let weekStartDate;
  let dateFrom;
  let dateTo;
  let sundayDate;

  if (args.siguienteSemana) {
    const prev = getPreviousWeekIncomeRangeLima();
    weekStartDate = prev.weekStartDate;
    sundayDate = prev.sundayDate;
    dateFrom = prev.dateFrom;
    dateTo = prev.dateTo;
    logger.info(
      `--siguiente-semana: semana YA CERRADA (Lima, como job lunes) Lun ${weekStartDate} → Dom ${sundayDate} | Yango ${dateFrom} … ${dateTo}`
    );
  } else {
    weekStartDate =
      args.weekStart && /^\d{4}-\d{2}-\d{2}$/.test(args.weekStart)
        ? args.weekStart
        : mondayFromWeekEndingSunday(args.weekEndSunday || '2026-03-22');
    if (inicio && weekStartDate < inicio) {
      logger.error(
        `week_start ${weekStartDate} es anterior a fecha_inicio_cobro_semanal ${inicio}; el job no generaría esta semana.`
      );
      process.exit(1);
    }
    const r = limaWeekStartToIncomeRange(weekStartDate);
    dateFrom = r.dateFrom;
    dateTo = r.dateTo;
    sundayDate = r.sundayDate;
  }

  if (args.siguienteSemana && inicio && weekStartDate < inicio) {
    logger.error(
      `week_start ${weekStartDate} (semana anterior cerrada) es anterior a fecha_inicio_cobro_semanal ${inicio}.`
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
    { count_completed: incomeResult.count_completed, partner_fees: incomeResult.partner_fees },
    { skipUpdateIfExists: args.noActualizarSiExiste }
  );

  if (cuotaId == null) {
    logger.error('ensureCuotaSemanalForWeek no creó/actualizó cuota (revisa cronograma y reglas).');
    process.exit(1);
  }

  if (args.soloEstaSemana) {
    await updateMoraDiaria(sol.solicitud_id, { singleCuotaId: cuotaId });
    logger.info(
      '--solo-esta-semana: no se tocó mora/paid_amount de otras filas; solo esta cuota (mora si aplica).'
    );
  } else {
    await persistPaidAmountCapsForSolicitud(sol.solicitud_id);
    await updateMoraDiaria(sol.solicitud_id);
  }

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

  process.exit(0);
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
