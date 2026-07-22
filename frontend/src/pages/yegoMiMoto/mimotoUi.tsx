import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function MimotoPageHeader({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <header className="rounded-lg bg-[#8B1A1A] p-4 lg:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#6B1515]">
            <Icon className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold leading-tight text-white lg:text-xl">{title}</h1>
            <p className="mt-0.5 text-xs text-white/90 lg:text-sm">{subtitle}</p>
          </div>
        </div>
        {action}
      </div>
    </header>
  );
}

const STATUS_CLASS: Record<string, string> = {
  pendiente: 'bg-amber-100 text-amber-800',
  pending: 'bg-amber-100 text-amber-800',
  citado: 'bg-blue-100 text-blue-800',
  en_revision: 'bg-violet-100 text-violet-800',
  aprobado: 'bg-cyan-100 text-cyan-800',
  activo: 'bg-green-100 text-green-800',
  paid: 'bg-green-100 text-green-800',
  validado: 'bg-green-100 text-green-800',
  partial: 'bg-orange-100 text-orange-800',
  overdue: 'bg-red-100 text-red-800',
  rechazado: 'bg-red-100 text-red-800',
  retirado: 'bg-gray-200 text-gray-700',
  cancelado: 'bg-gray-200 text-gray-700',
};

export function MimotoStatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`inline-flex rounded px-2 py-1 text-xs font-semibold ${STATUS_CLASS[status] || 'bg-gray-100 text-gray-700'}`}>{label || status}</span>;
}

export function MimotoLoading({ label = 'Cargando información...' }: { label?: string }) {
  return <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-gray-200 bg-white py-14"><div className="h-9 w-9 animate-spin rounded-full border-2 border-red-600 border-t-transparent" /><p className="text-sm text-gray-500">{label}</p></div>;
}

export function MimotoEmpty({ title, description, icon: Icon }: { title: string; description: string; icon: LucideIcon }) {
  return <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm"><Icon className="mx-auto h-10 w-10 text-gray-300" /><h3 className="mt-3 text-lg font-bold text-gray-900">{title}</h3><p className="mx-auto mt-1 max-w-md text-sm text-gray-500">{description}</p></div>;
}

const PAGINATION_BUTTON = 'flex h-9 w-9 items-center justify-center rounded-full border-2 border-red-600 text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-30';

function visiblePages(page: number, totalPages: number) {
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (page <= 3) return [1, 2, 3, 4, 5];
  if (page >= totalPages - 2) return Array.from({ length: 5 }, (_, index) => totalPages - 4 + index);
  return [page - 2, page - 1, page, page + 1, page + 2];
}

export function MimotoPagination({
  page,
  pageSize,
  total,
  loading = false,
  pageSizes = [10, 20, 50],
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  loading?: boolean;
  pageSizes?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const changePage = (nextPage: number) => onPageChange(Math.min(Math.max(1, nextPage), totalPages));

  return (
    <div className="flex flex-col items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-4 py-4 sm:flex-row">
      <label className="flex items-center gap-2 text-sm font-medium text-gray-600">
        Por página:
        <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-red-600 focus:ring-2 focus:ring-red-500">
          {pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => changePage(1)} disabled={safePage <= 1 || loading} className={PAGINATION_BUTTON} aria-label="Primera página"><ChevronsLeft className="h-4 w-4" /></button>
        <button type="button" onClick={() => changePage(safePage - 1)} disabled={safePage <= 1 || loading} className={PAGINATION_BUTTON} aria-label="Página anterior"><ChevronLeft className="h-4 w-4" /></button>
        {visiblePages(safePage, totalPages).map((pageNumber) => (
          <button key={pageNumber} type="button" onClick={() => changePage(pageNumber)} disabled={loading} className={`flex h-9 min-w-9 items-center justify-center rounded-full border-2 px-2 text-sm font-semibold transition-colors ${safePage === pageNumber ? 'border-red-600 bg-red-600 text-white' : 'border-red-600 text-red-600 hover:bg-red-50'}`}>{pageNumber}</button>
        ))}
        <button type="button" onClick={() => changePage(safePage + 1)} disabled={safePage >= totalPages || loading} className={PAGINATION_BUTTON} aria-label="Página siguiente"><ChevronRight className="h-4 w-4" /></button>
        <button type="button" onClick={() => changePage(totalPages)} disabled={safePage >= totalPages || loading} className={PAGINATION_BUTTON} aria-label="Última página"><ChevronsRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
