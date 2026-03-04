import pool from '../database/connection.js';
import { logger } from '../utils/logger.js';

const MIN_TRIPS_PER_MONTH = 400;

/** Normaliza conductor_id para comparar: en trips puede ser igual a driver_id o "driver-"+driver_id */
function conductorIdParam(conductorId) {
  const id = conductorId == null ? '' : String(conductorId).trim();
  return id;
}

/**
 * Cuenta viajes completados para un conductor en un mes/año.
 * Tablas: trips_2026 (año 2026), trips_all (2025 y anteriores).
 * Columnas reales: conductor_id, condicion, fecha_inicio_viaje, fecha_finalizacion.
 * Viajes completados: condicion = 'Completado', filtro por fecha_finalizacion (o fecha_inicio_viaje) en el mes.
 */
export async function getCompletedTripsCount(conductorId, year, month) {
  if (!conductorId) return 0;
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const table = year === 2026 ? 'trips_2026' : 'trips_all';
  const idStr = conductorIdParam(conductorId);

  const queries = [
    {
      sql: `SELECT COUNT(*)::int AS total FROM ${table}
            WHERE conductor_id = $1
              AND condicion = 'Completado'
              AND (fecha_finalizacion::date >= $2::date AND fecha_finalizacion::date <= $3::date)`,
      params: [idStr, startDate, endDate]
    },
    {
      sql: `SELECT COUNT(*)::int AS total FROM ${table}
            WHERE conductor_id = $1
              AND condicion = 'Completado'
              AND (fecha_inicio_viaje::date >= $2::date AND fecha_inicio_viaje::date <= $3::date)`,
      params: [idStr, startDate, endDate]
    }
  ];

  for (const { sql, params } of queries) {
    try {
      const result = await pool.query(sql, params);
      return result.rows[0]?.total ?? 0;
    } catch (e) {
      continue;
    }
  }

  logger.warn(`tripsValidation: ${table} conductor_id=${idStr} ${year}-${month} - todas las consultas fallaron`);
  return 0;
}

/** Validación activa: se exige mínimo de 400 viajes en cada uno de los dos meses anteriores para oferta de préstamo. */
const TRIPS_REQUIREMENT_ENABLED = true;

/**
 * Comprueba si el conductor cumple el mínimo de viajes (400) en el mes anterior y en el mes pasado.
 * Ej: si hoy es febrero 2026, comprueba enero 2026 y diciembre 2025.
 * @param {string} conductorId - ID del conductor (conductor_id en trips_all y trips_2026)
 * @returns {Promise<{ allowed: boolean, message?: string, previousMonth?: { year, month, count }, pastMonth?: { year, month, count } }>}
 */
export async function checkMinimumTripsForLoanOffer(conductorId) {
  if (!TRIPS_REQUIREMENT_ENABLED) {
    return { allowed: true };
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  let prevYear = currentYear;
  let prevMonth = currentMonth - 1;
  if (prevMonth < 1) {
    prevMonth += 12;
    prevYear -= 1;
  }

  let pastYear = prevYear;
  let pastMonth = prevMonth - 1;
  if (pastMonth < 1) {
    pastMonth += 12;
    pastYear -= 1;
  }

  const countPrev = await getCompletedTripsCount(conductorId, prevYear, prevMonth);
  const countPast = await getCompletedTripsCount(conductorId, pastYear, pastMonth);

  const allowed = countPrev >= MIN_TRIPS_PER_MONTH && countPast >= MIN_TRIPS_PER_MONTH;
  const monthNames = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  if (!allowed) {
    // Siempre mostrar los dos meses que se validan (anteriores al actual) y sus conteos, para que el conductor vea ambos.
    const msg = `Para solicitar un préstamo necesitas al menos ${MIN_TRIPS_PER_MONTH} viajes completados en cada uno de los dos meses anteriores al actual. En ${monthNames[pastMonth]} ${pastYear} tienes ${countPast} y en ${monthNames[prevMonth]} ${prevYear} tienes ${countPrev}.`;
    return {
      allowed: false,
      message: msg,
      previousMonth: { year: prevYear, month: prevMonth, count: countPrev },
      pastMonth: { year: pastYear, month: pastMonth, count: countPast }
    };
  }

  return {
    allowed: true,
    previousMonth: { year: prevYear, month: prevMonth, count: countPrev },
    pastMonth: { year: pastYear, month: pastMonth, count: countPast }
  };
}
