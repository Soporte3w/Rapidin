import { ChevronLeft, ChevronRight } from 'lucide-react';

interface MobilePaginationProps {
  page: number;
  setPage: (n: number) => void;
  totalPages: number;
}

export default function MobilePagination({ page, setPage, totalPages }: MobilePaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="lg:hidden flex items-center justify-center gap-3 py-3">
      <button
        type="button"
        onClick={() => setPage(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="w-8 h-8 flex items-center justify-center rounded-full border border-[#8B1A1A] text-[#8B1A1A] hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        aria-label="Página anterior"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <span className="text-xs font-semibold text-gray-700 tabular-nums">
        Página {page} de {totalPages}
      </span>
      <button
        type="button"
        onClick={() => setPage(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="w-8 h-8 flex items-center justify-center rounded-full border border-[#8B1A1A] text-[#8B1A1A] hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        aria-label="Página siguiente"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}
