import { useState, useMemo, useEffect, useCallback } from 'react';

/** Tamaños de página usados en cronogramas Mi Auto y listas similares */
export const DEFAULT_TABLE_PAGE_SIZES = [5, 10, 20, 50] as const;

type Options = {
  initialLimit?: number;
  pageSizes?: readonly number[];
};

/**
 * Paginación cliente para tablas (slice + clamp de página).
 */
export function useTablePagination<T>(items: readonly T[], options?: Options) {
  const pageSizes = options?.pageSizes ?? DEFAULT_TABLE_PAGE_SIZES;
  const [page, setPage] = useState(1);
  const [limit, setLimitState] = useState(options?.initialLimit ?? 10);

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
  }, []);

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
