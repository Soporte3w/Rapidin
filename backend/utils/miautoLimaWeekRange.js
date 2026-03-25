/**
 * Rango de fechas para API Yango driver/income (Mi Auto).
 * Semana calendario Lima: lunes 00:00:00 → domingo 23:59:59 (offset fijo -05:00).
 * No usa la TZ del proceso Node en el string ISO (evita desfaces).
 *
 * Ejemplos (week_start_date en BD = ese lunes):
 * - weekStartMondayYmd = 2026-03-09 → Yango: 9 mar 00:00 … 15 mar 23:59 Lima
 * - weekStartMondayYmd = 2026-03-16 → Yango: 16 mar 00:00 … 22 mar 23:59 Lima
 * El lunes siguiente (ej. 23 mar) ya es inicio de otra semana, no entra en el tramo anterior.
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
    /** Domingo final de esa semana (YYYY-MM-DD); mismo tramo que date_to. */
    sundayDate: sundayYmd,
    dateFrom: `${weekStartDate}T00:00:00-05:00`,
    dateTo: `${sundayYmd}T23:59:59-05:00`,
  };
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
 * Vencimiento de la cuota: **lunes siguiente** al cierre Lun–Dom de los viajes (`week_start_date + 7`),
 * salvo la **primera cuota** (depósito / sin viajes Yango): vence en `fecha_inicio_cobro_semanal`
 * (día de entrega; suele ser el lunes de esa semana en Lima).
 *
 * @param {string} weekStartMondayYmd Lunes de la semana de ingresos (Yango Lun 00:00 – Dom 23:59).
 * @param {string|null|undefined} fechaInicioCobroYmd `fecha_inicio_cobro_semanal` de la solicitud (YYYY-MM-DD).
 * @returns {string} YYYY-MM-DD
 */
export function computeDueDateForMiAutoCuota(weekStartMondayYmd, fechaInicioCobroYmd) {
  const ws = String(weekStartMondayYmd || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return ws;
  const fi = fechaInicioCobroYmd ? String(fechaInicioCobroYmd).trim().slice(0, 10) : null;
  if (fi && /^\d{4}-\d{2}-\d{2}$/.test(fi)) {
    const mondayInicio = mondayOfWeekContainingYmd(fi);
    if (ws === mondayInicio) return fi;
  }
  return addDaysYmd(ws, 7);
}
