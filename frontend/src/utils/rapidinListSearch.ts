/** Normaliza para búsqueda insensible a tildes y mayúsculas. */
export function rapidinFoldLower(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/**
 * Coincide si algún campo contiene el texto (plegado) o, con2+ dígitos en la query, si los dígitos aparecen en el campo.
 * Query vacía → siempre true.
 */
export function rapidinMatchParts(rawQuery: string, parts: (string | null | undefined)[]): boolean {
  const qTrim = rawQuery.trim();
  if (!qTrim) return true;
  const qFold = rapidinFoldLower(qTrim);
  const qDigits = qTrim.replace(/\D/g, '');
  for (const p of parts) {
    if (p == null || p === '') continue;
    const s = String(p);
    if (rapidinFoldLower(s).includes(qFold)) return true;
    if (qDigits.length >= 2 && s.replace(/\D/g, '').includes(qDigits)) return true;
  }
  return false;
}
