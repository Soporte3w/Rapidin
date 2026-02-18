/**
 * Formatea fechas que vienen del API en UTC (ej. 2025-11-12T00:00:00.000Z)
 * usando timeZone: 'UTC' para que el día no cambie en zonas horarias como PE (UTC-5).
 * Sin esto, medianoche UTC se mostraría como el día anterior en local.
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

export function formatDateShortUTC(isoString: string | null | undefined, locale = 'es-ES'): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { timeZone: UTC, dateStyle: 'short', timeStyle: 'short' });
}
