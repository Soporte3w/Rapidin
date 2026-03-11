/**
 * Regla general del sistema: todas las fechas se muestran en hora local del usuario
 * (ej. 10:00 en Perú, no 15:00 UTC). Usar formatDate, formatDateTime, formatDateShort.
 *
 * formatDateUTC / formatDateTimeUTC solo si se necesita explícitamente UTC.
 */
const UTC = 'UTC';

export function formatDateUTC(isoString: string | null | undefined, locale = 'es-ES'): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { timeZone: UTC, day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTimeUTC(isoString: string | null | undefined, locale = 'es-ES'): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, {
    timeZone: UTC,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateLocal(isoString: string | null | undefined, locale = 'es-ES'): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTimeLocal(isoString: string | null | undefined, locale = 'es-ES'): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateShortLocal(isoString: string | null | undefined, locale = 'es-ES'): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { dateStyle: 'short' });
}

export function formatDateShortUTC(isoString: string | null | undefined, locale = 'es-ES'): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { timeZone: UTC, dateStyle: 'short' });
}

/** Por defecto: fecha en hora local (todo el sistema). */
export const formatDate = formatDateLocal;

/** Por defecto: fecha y hora en hora local (todo el sistema). */
export const formatDateTime = formatDateTimeLocal;

/** Por defecto: fecha corta en hora local (todo el sistema). */
export const formatDateShort = formatDateShortLocal;
