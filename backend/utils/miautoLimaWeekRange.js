/**
 * Rango de fechas para API Yango driver/income (Mi Auto).
 * Semana calendario Lima: lunes 00:00:00 → domingo **23:59:59** -05:00 (`date_to` siempre fin de domingo).
 * No usa la TZ del proceso Node en el string ISO (evita desfaces).
 *
 * Ejemplos de `limaWeekStartToIncomeRange(weekStartMondayYmd)` (lunes = inicio del tramo Lun–Dom de **ingresos**):
 * - 2026-03-09 → Yango: **2 mar** 00:00 … **8 mar** 23:59:59 Lima (esa semana Lun–Dom)
 * - 2026-03-16 → Yango: **9 mar** 00:00 … **15 mar** 23:59:59 Lima
 * Mi Auto: `week_start_date` en BD es el **lunes de cuota** (vencimiento), no el lunes del tramo Yango.
 * Para cuota `2026-03-16` usar `limaWeekStartToMiAutoIncomeRange('2026-03-16')` → ingresos Lun **9**–Dom **15** mar (no confundir con `week_start` = 9 mar, que sería otra cuota / otro tramo).
 */

/** Suma días a un YYYY-MM-DD (calendario gregoriano, UTC). */
export function addDaysYmd(yyyyMmDd, deltaDays) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * @param weekStartMondayYmd Lunes de la semana Lun–Dom de viajes Yango (mismo que `week_start_date` en BD).
 * @returns {{ weekStartDate: string, dateFrom: string, dateTo: string }}
 *   dateFrom = lunes 00:00:00-05:00, dateTo = domingo (lunes+6) 23:59:59-05:00
 */
export function limaWeekStartToIncomeRange(weekStartMondayYmd) {
  const weekStartDate = weekStartMondayYmd;
  const sundayYmd = addDaysYmd(weekStartMondayYmd, 6);
  return {
    weekStartDate,
    /** Domingo final de esa semana (YYYY-MM-DD). */
    sundayDate: sundayYmd,
    dateFrom: `${weekStartDate}T00:00:00-05:00`,
    dateTo: `${sundayYmd}T23:59:59-05:00`,
  };
}

/**
 * Mi Auto: `week_start_date` en BD es el **lunes de la cuota** (vencimiento operativo).
 * Los viajes Yango de esa cuota corresponden a la semana Lun–Dom **anterior**: lunes = `cuotaMonday - 7`.
 * Ej.: cuota `2026-03-02` → ingresos `2026-02-23` … `2026-03-01` (sem. 2 producto: 23 feb–1 mar).
 * La semana depósito (`week_start` = lunes de la semana de `fecha_inicio_cobro`) no usa este rango para API (viajes 0).
 */
export function limaWeekStartToMiAutoIncomeRange(weekStartCuotaMondayYmd) {
  const incomeMonday = addDaysYmd(String(weekStartCuotaMondayYmd || '').trim().slice(0, 10), -7);
  return limaWeekStartToIncomeRange(incomeMonday);
}

/**
 * Para una fila de cuota Mi Auto (`week_start_date` = lunes de cuota), ¿ya cerró en Lima la semana Lun–Dom
 * cuyos viajes alimentan esa fila? (Esa semana empieza el lunes `week_start - 7`.)
 * Semana depósito (mismo lunes que `mondayOfWeekContainingYmd(fecha_inicio)`): conserva la lógica anterior en `week_start`.
 */
export function isWeekYangoClosedForMiAutoCuotaMetrics(weekStartCuotaMondayYmd, fechaInicioCobroYmd, now = new Date()) {
  const ws = String(weekStartCuotaMondayYmd || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return false;
  const fi = fechaInicioCobroYmd ? String(fechaInicioCobroYmd).trim().slice(0, 10) : null;
  if (fi && /^\d{4}-\d{2}-\d{2}$/.test(fi)) {
    const monInicio = mondayOfWeekContainingYmd(fi);
    if (ws === monInicio) {
      return isWeekYangoClosedForMetrics(ws, now);
    }
  }
  const incomeMonday = addDaysYmd(ws, -7);
  return isWeekYangoClosedForMetrics(incomeMonday, now);
}

/** YYYY-MM-DD desde un objeto Date (componentes locales del Date). */
export function dateToYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Fecha civil actual en Lima (sin depender de la TZ del proceso Node).
 * @param {Date} [date]
 * @returns {string} YYYY-MM-DD
 */
export function getLimaYmd(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Días transcurridos desde el lunes de esa semana civil (0 = lunes … 6 = domingo).
 * Usa solo el calendario gregoriano (UTC) para el Y-M-D dado.
 */
export function weekdaysSinceMondayMon0(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dowSun0 = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (dowSun0 + 6) % 7;
}

/**
 * Lunes de la semana civil que contiene `yyyyMmDd` (Lima).
 */
export function mondayOfWeekContainingYmd(yyyyMmDd) {
  const sinceMon = weekdaysSinceMondayMon0(yyyyMmDd);
  return addDaysYmd(yyyyMmDd, -sinceMon);
}

/**
 * Rango Yango (Lun 00:00 – Dom 23:59 -05:00) de la semana **anterior** a la semana actual en Lima.
 * Uso: job lunes (madrugada) — se liquida la semana Lun–Dom **ya cerrada** (no la que empieza ese lunes).
 *
 * Ej.: si hoy en Lima es **lunes 23 mar 2026**, la semana “actual” empieza el 23;
 * la anterior es **lun 16 – dom 22 mar** → `weekStartDate` = 2026-03-16 (NUNCA 2026-03-23).
 * `week_start_date` en BD = ese lunes 16, no el día en que corre el job.
 */
export function getPreviousWeekIncomeRangeLima(now = new Date()) {
  const limaToday = getLimaYmd(now);
  const thisWeekMonday = mondayOfWeekContainingYmd(limaToday);
  const previousWeekMonday = addDaysYmd(thisWeekMonday, -7);
  return limaWeekStartToIncomeRange(previousWeekMonday);
}


/**
 * Lunes de la última semana Lun–Dom ya cerrada en Lima (el domingo de esa semana ya pasó).
 * Coincide con `getPreviousWeekIncomeRangeLima(now).weekStartDate` salvo naming.
 */
export function mondayLastCompletedLunDomWeekLima(now = new Date()) {
  const limaToday = getLimaYmd(now);
  const thisMonday = mondayOfWeekContainingYmd(limaToday);
  return addDaysYmd(thisMonday, -7);
}

/**
 * true si `week_start_date` (lunes) corresponde a una semana cuyo domingo ya pasó → puede haber cifra Yango final.
 * false = semana actual sin cerrar o futura → no mostrar viajes/fees reales (evita abril con viajes en marzo).
 */
export function isWeekYangoClosedForMetrics(weekStartMondayYmd, now = new Date()) {
  const ws = String(weekStartMondayYmd || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return false;
  const lastClosed = mondayLastCompletedLunDomWeekLima(now);
  return ws <= lastClosed;
}

/**
 * Vencimiento de la cuota: el mismo **lunes de cuota** que `week_start_date` en BD.
 * Excepción: **semana depósito** — vence en `fecha_inicio_cobro_semanal` (día del depósito, p. ej. 23 feb aunque el lunes civil coincida).
 * El tramo Yango de la fila sigue siendo la semana **anterior** al lunes de cuota (`week_start-7` … domingo).
 *
 * @param {string} weekStartMondayYmd Lunes de cuota (`week_start_date` en BD), no el lunes del tramo Yango.
 * @param {string|null|undefined} fechaInicioCobroYmd `fecha_inicio_cobro_semanal` de la solicitud (YYYY-MM-DD).
 * @param {boolean} [isFirstCuotaSemanal] true si semana depósito (`week_start` = lunes de la semana de `fecha_inicio`).
 * @returns {string} YYYY-MM-DD
 */
export function computeDueDateForMiAutoCuota(weekStartMondayYmd, fechaInicioCobroYmd, isFirstCuotaSemanal = false) {
  const ws = String(weekStartMondayYmd || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return ws;
  const fi = fechaInicioCobroYmd ? String(fechaInicioCobroYmd).trim().slice(0, 10) : null;
  if (fi && /^\d{4}-\d{2}-\d{2}$/.test(fi) && isFirstCuotaSemanal) {
    return fi;
  }
  return ws;
}
