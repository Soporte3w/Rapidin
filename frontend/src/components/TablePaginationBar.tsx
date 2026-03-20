import type { Dispatch, SetStateAction } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

const BTN =
  'w-9 h-9 flex items-center justify-center rounded-full border-2 border-[#8B1A1A] text-[#8B1A1A] hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

type Props = {
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  totalPages: number;
  limit: number;
  setLimit: (n: number) => void;
  pageSizes: readonly number[];
  /** Clases del contenedor (padding/márgenes según la tabla) */
  containerClassName?: string;
};

const DEFAULT_CONTAINER =
  'flex flex-col sm:flex-row items-center justify-between gap-4 px-2 py-3 border-t border-gray-200 mt-2';

export function TablePaginationBar({
  page,
  setPage,
  totalPages,
  limit,
  setLimit,
  pageSizes,
  containerClassName = DEFAULT_CONTAINER,
}: Props) {
  const sizes = pageSizes.length > 0 ? pageSizes : [5, 10, 20, 50];

  return (
    <div className={containerClassName}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Por página:</span>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A]"
        >
          {sizes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setPage(1)}
          disabled={page <= 1}
          className={BTN}
          aria-label="Primera página"
        >
          <ChevronsLeft className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className={BTN}
          aria-label="Página anterior"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pageNum: number;
              if (totalPages <= 5) pageNum = i + 1;
              else if (page <= 3) pageNum = i + 1;
              else if (page >= totalPages - 2) pageNum = totalPages - 4 + i;
              else pageNum = page - 2 + i;
              const isActive = page === pageNum;
              return (
                <button
                  key={pageNum}
                  type="button"
                  onClick={() => setPage(pageNum)}
                  className={`min-w-[2.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                    isActive
                      ? 'bg-[#8B1A1A] text-white border-2 border-[#8B1A1A]'
                      : 'border-2 border-[#8B1A1A] text-[#8B1A1A] hover:bg-red-50'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
          </div>
        )}
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className={BTN}
          aria-label="Página siguiente"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setPage(totalPages)}
          disabled={page >= totalPages}
          className={BTN}
          aria-label="Última página"
        >
          <ChevronsRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
