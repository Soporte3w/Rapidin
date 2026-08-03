import { useState, useMemo, useEffect, useCallback } from 'react';

/** Tamaños de página usados en cronogramas Mi Auto y listas similares */
export const DEFAULT_TABLE_PAGE_SIZES = [5, 10, 20, 50] as const;

type Options = {
  initialLimit?: number;
  pageSizes?: readonly number[];
  storageKey?: string;
};

/**
 * Paginación cliente para tablas (slice + clamp de página).
 */
export function useTablePagination<T>(items: readonly T[], options?: Options) {
  const pageSizes = options?.pageSizes ?? DEFAULT_TABLE_PAGE_SIZES;
  const [page, setPage] = useState(1);
  const [limit, setLimitState] = useState(() => {
    const fallback = options?.initialLimit ?? 10;
    if (!options?.storageKey || typeof window === 'undefined') return fallback;
    try {
      const stored = Number(window.localStorage.getItem(options.storageKey));
      return pageSizes.includes(stored) ? stored : fallback;
    } catch {
      return fallback;
    }
  });

  const totalPages = Math.max(1, Math.ceil(items.length / limit));
  const paginatedItems = useMemo(() => {
    const start = (page - 1) * limit;
    return items.slice(start, start + limit);
  }, [items, page, limit]);

  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const setLimit = useCallback((n: number) => {
    setLimitState(n);
    setPage(1);
    if (options?.storageKey && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(options.storageKey, String(n));
      } catch {
        // La paginación sigue funcionando aunque el navegador bloquee el almacenamiento.
      }
    }
  }, [options?.storageKey]);

  return {
    page,
    setPage,
    limit,
    setLimit,
    totalPages,
    paginatedItems,
    pageSizes,
  };
}
