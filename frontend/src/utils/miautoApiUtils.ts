/** Cabeceras para GET Mi Auto: evita 304/caché raro en desarrollo. */
export const MIAUTO_NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const;

export function isAxiosAbortError(e: unknown): boolean {
  const x = e as { code?: string; name?: string } | undefined;
  return x?.code === 'ERR_CANCELED' || x?.name === 'CanceledError';
}

/** Para .catch en listados de comprobantes: vacío si falla, re-lanza si abort. */
export function emptyListIfNotAbort(err: unknown): { data: unknown[] } {
  if (isAxiosAbortError(err)) throw err;
  return { data: [] };
}

/**
 * `res.data.data` (successResponse) o `res.data` si el cuerpo ya es el payload.
 * Equivale a `res.data?.data ?? res.data`.
 */
export function unwrapApiData<T = unknown>(res: { data?: { data?: T } | T }): T | undefined {
  const d = res.data;
  if (d === undefined || d === null) return undefined;
  if (typeof d === 'object' && !Array.isArray(d) && 'data' in d) {
    const inner = (d as { data?: T }).data;
    if (inner !== undefined) return inner;
  }
  return d as T;
}
