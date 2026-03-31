import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../../services/api';
import {
  Eye,
  FileText,
  DollarSign,
  AlertCircle,
  CheckCircle,
  XCircle,
  Copy,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Loader2,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { writeRapidinLoansStyledExcel } from '../../utils/rapidinLoansExcelExport';
import { DateRangePicker } from '../../components/DateRangePicker';

interface Loan {
  id: string;
  driver_first_name: string;
  driver_last_name: string;
  disbursed_amount: number;
  total_amount: number;
  status: string;
  country: string;
  pending_balance: number;
  created_at: string;
  total_late_fee?: number;
}

export type LoansSearchState = {
  fromLoanDetail?: boolean;
  fromLoansSearch?: boolean;
  driver?: string;
  loan_id?: string;
  driverSearchInput?: string;
  loanIdSearchInput?: string;
  status?: string;
  country?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
};

interface ExportLoanRow {
  id: string;
  country: string;
  status: string;
  disbursed_amount: unknown;
  total_amount: unknown;
  pending_balance: unknown;
  dni: string | null;
  driver_phone: string | null;
  driver_first_name: string | null;
  driver_last_name: string | null;
  driver_total_loans: number;
  total_late_fee: unknown;
  disbursed_date_display: string | null;
  cancellation_date_display: string | null;
}

interface ExportInstallmentRow {
  loan_id: string;
  installment_number: number;
  due_date: unknown;
  installment_amount: unknown;
  paid_amount: unknown;
  late_fee: unknown;
  paid_late_fee: unknown;
  installment_status: string;
  paid_date: unknown;
  driver_first_name: string | null;
  driver_last_name: string | null;
  dni: string | null;
}

function loanStatusLabel(s: string): string {
  const m: Record<string, string> = {
    active: 'Activo',
    cancelled: 'Cancelado',
    defaulted: 'Vencido',
  };
  return m[s] || s;
}

function installmentStatusLabel(s: string): string {
  const m: Record<string, string> = {
    pending: 'Pendiente',
    paid: 'Pagada',
    overdue: 'Vencida',
    cancelled: 'Cancelada',
  };
  return m[s] || s;
}

function numExcel(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatExcelDate(val: unknown): string {
  if (val == null || val === '') return '';
  if (typeof val === 'string') {
    if (val.includes('T')) return val.split('T')[0];
    return val.length >= 10 ? val.slice(0, 10) : val;
  }
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  return String(val);
}

const Loans = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const searchState = location.state as LoansSearchState | null;
  const isReturnFromDetail = Boolean(searchState?.fromLoanDetail);
  const initialDriver = isReturnFromDetail ? (searchState?.driverSearchInput ?? searchState?.driver ?? '') : '';
  const initialLoanId = isReturnFromDetail ? (searchState?.loanIdSearchInput ?? searchState?.loan_id ?? '') : '';

  const [filters, setFilters] = useState({
    status: isReturnFromDetail ? (searchState?.status ?? '') : '',
    country: isReturnFromDetail ? (searchState?.country ?? '') : '',
    driver: isReturnFromDetail ? (searchState?.driver ?? '') : '',
    loan_id: isReturnFromDetail ? (searchState?.loan_id ?? '') : '',
    date_from: isReturnFromDetail ? (searchState?.date_from ?? '') : '',
    date_to: isReturnFromDetail ? (searchState?.date_to ?? '') : '',
  });
  const [driverSearchInput, setDriverSearchInput] = useState(initialDriver);
  const [loanIdSearchInput, setLoanIdSearchInput] = useState(initialLoanId);
  const [pagination, setPagination] = useState({
    page: isReturnFromDetail && searchState?.page != null ? searchState.page : 1,
    limit: isReturnFromDetail && searchState?.limit != null ? searchState.limit : 10,
    total: 0,
    totalPages: 0,
  });
  const [paginationLoading, setPaginationLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportModalFilters, setExportModalFilters] = useState({
    date_from: '',
    date_to: '',
    country: '',
  });
  const PAGE_SIZES = [5, 10, 20, 50];

  // Al volver del detalle: restaurar página (ej. 2) y limpiar state para que un refresh no restaure
  useEffect(() => {
    if (isReturnFromDetail) {
      const page = searchState?.page ?? 1;
      const limit = searchState?.limit ?? 10;
      setPagination((p) => ({ ...p, page, limit }));
      fetchLoans(page, limit, true);
      navigate(location.pathname, { replace: true, state: {} });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isReturnFromDetail) return;
    setPagination((p) => ({ ...p, page: 1 }));
    fetchLoans(1, pagination.limit, true);
  }, [filters]);

  const goToPage = (page: number) => {
    const nextPage = Math.max(1, Math.min(page, pagination.totalPages || 1));
    fetchLoans(nextPage, pagination.limit, true);
  };

  const runDriverSearch = () => {
    setFilters((prev) => ({ ...prev, driver: driverSearchInput.trim(), loan_id: '' }));
  };

  const runLoanIdSearch = () => {
    setFilters((prev) => ({ ...prev, loan_id: loanIdSearchInput.trim(), driver: '' }));
  };

  const fetchLoans = async (page = pagination.page, limit = pagination.limit, isPaginationChange = false) => {
    try {
      if (isPaginationChange) {
        setPaginationLoading(true);
      } else {
        setLoading(true);
      }
      setError('');
      const params = new URLSearchParams();
      params.append('page', String(page));
      params.append('limit', String(limit));
      if (filters.status) params.append('status', filters.status);
      if (filters.country) params.append('country', filters.country);
      if (filters.driver?.trim()) params.append('driver', filters.driver.trim());
      if (filters.loan_id?.trim()) params.append('loan_id', filters.loan_id.trim());
      if (filters.date_from) params.append('date_from', filters.date_from);
      if (filters.date_to) params.append('date_to', filters.date_to);

      const response = await api.get(`/loans?${params.toString()}`);
      let loansData: Loan[] = [];
      let total = 0;
      let totalPages = 0;
      if (response.data) {
        if (response.data.pagination) {
          total = response.data.pagination.total ?? 0;
          totalPages = response.data.pagination.totalPages ?? 0;
        }
        if (Array.isArray(response.data.data)) {
          loansData = response.data.data;
        } else if (response.data.data && Array.isArray(response.data.data)) {
          loansData = response.data.data;
        } else if (Array.isArray(response.data)) {
          loansData = response.data;
        } else if (response.data.rows && Array.isArray(response.data.rows)) {
          loansData = response.data.rows;
        }
      }
      setLoans(loansData);
      setPagination((prev) => ({ ...prev, page, limit, total, totalPages }));
    } catch (error: any) {
      console.error('Error fetching loans:', error);
      setError(error.response?.data?.message || 'Error al cargar los préstamos');
      setLoans([]);
    } finally {
      setLoading(false);
      if (isPaginationChange) setPaginationLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const badges: Record<string, { color: string; icon: any; text: string }> = {
      active: {
        color: 'bg-green-100 text-green-800',
        icon: CheckCircle,
        text: 'Activo'
      },
      cancelled: {
        color: 'bg-gray-100 text-gray-800',
        icon: XCircle,
        text: 'Cancelado'
      },
      defaulted: {
        color: 'bg-red-100 text-red-800',
        icon: AlertCircle,
        text: 'Vencido'
      }
    };
    const badge = badges[status] || badges.active;
    const Icon = badge.icon;
    return (
      <span className={`inline-flex items-center space-x-1 px-3 py-1 rounded-full text-sm font-medium ${badge.color}`}>
        <Icon className="w-4 h-4" />
        <span>{badge.text}</span>
      </span>
    );
  };

  const countryName = user?.country === 'PE' ? 'Perú' : user?.country === 'CO' ? 'Colombia' : '';

  const buildExportQueryParams = (dateCountry: { date_from: string; date_to: string; country: string }) => {
    const params = new URLSearchParams();
    if (filters.status) params.append('status', filters.status);
    if (dateCountry.country) params.append('country', dateCountry.country);
    if (filters.driver?.trim()) params.append('driver', filters.driver.trim());
    if (filters.loan_id?.trim()) params.append('loan_id', filters.loan_id.trim());
    if (dateCountry.date_from) params.append('date_from', dateCountry.date_from);
    if (dateCountry.date_to) params.append('date_to', dateCountry.date_to);
    return params;
  };

  const openExportModal = () => {
    setExportModalFilters({
      date_from: filters.date_from,
      date_to: filters.date_to,
      country: filters.country,
    });
    setExportModalOpen(true);
  };

  const runExportExcel = async (params: URLSearchParams) => {
    if (exportLoading) return;
    const toastId = toast.loading('Generando Excel…');
    setExportLoading(true);
    try {
      const response = await api.get(`/loans/export?${params.toString()}`);
      const payload = response.data?.data ?? response.data;
      const loanRows = (payload?.loans ?? []) as ExportLoanRow[];
      const installmentRows = (payload?.installments ?? []) as ExportInstallmentRow[];

      const loanHeader = [
        'Nombre',
        'DNI',
        'Teléfono',
        'ID préstamo',
        'País',
        'Total préstamos (conductor)',
        'Estado',
        'Fecha desembolso',
        'Fecha cancelación',
        'Monto desembolsado',
        'Monto total crédito',
        'Deuda pendiente',
        'Mora total',
      ];
      const loanData: (string | number)[][] = [];
      for (const row of loanRows) {
        const nombre = [row.driver_first_name, row.driver_last_name].filter(Boolean).join(' ').trim();
        loanData.push([
          nombre,
          row.dni ?? '',
          row.driver_phone ?? '',
          row.id,
          row.country ?? '',
          row.driver_total_loans ?? 0,
          loanStatusLabel(row.status || ''),
          row.disbursed_date_display ?? '',
          row.cancellation_date_display ?? '',
          numExcel(row.disbursed_amount),
          numExcel(row.total_amount),
          numExcel(row.pending_balance),
          numExcel(row.total_late_fee),
        ]);
      }

      const instHeader = [
        'ID préstamo',
        'Nombre',
        'DNI',
        'Número cuota',
        'Fecha vencimiento',
        'Monto cuota',
        'Monto pagado',
        'Mora',
        'Mora pagada',
        'Estado cuota',
        'Fecha pago',
      ];
      const instData: (string | number)[][] = [];
      for (const row of installmentRows) {
        const nombre = [row.driver_first_name, row.driver_last_name].filter(Boolean).join(' ').trim();
        instData.push([
          row.loan_id,
          nombre,
          row.dni ?? '',
          row.installment_number,
          formatExcelDate(row.due_date),
          numExcel(row.installment_amount),
          numExcel(row.paid_amount),
          numExcel(row.late_fee),
          numExcel(row.paid_late_fee),
          installmentStatusLabel(row.installment_status || ''),
          formatExcelDate(row.paid_date),
        ]);
      }

      const fname = `prestamos-yego-rapidin-${format(new Date(), 'yyyy-MM-dd')}.xlsx`;
      writeRapidinLoansStyledExcel(loanHeader, loanData, instHeader, instData, fname);
      toast.success('Excel descargado', { id: toastId });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        'Error al generar el Excel';
      toast.error(msg, { id: toastId });
    } finally {
      setExportLoading(false);
    }
  };

  const confirmExportExcel = async () => {
    setExportModalOpen(false);
    await runExportExcel(buildExportQueryParams(exportModalFilters));
  };

  const handleCopyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      toast.success('ID copiado con éxito');
    } catch (error) {
      // Fallback para navegadores que no soportan clipboard API
      const textArea = document.createElement('textarea');
      textArea.value = id;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      toast.success('ID copiado con éxito');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-red-600 border-t-transparent mx-auto mb-4" />
          <p className="text-gray-600">Cargando préstamos...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="bg-red-50 border-2 border-red-200 rounded-full p-4 mb-4">
          <AlertCircle className="w-12 h-12 text-red-600" />
        </div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Error al cargar los préstamos</h3>
        <p className="text-gray-600 mb-6 text-center max-w-md">{error}</p>
        <button
          onClick={() => fetchLoans(pagination.page, pagination.limit, false)}
          className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-lg font-medium hover:from-red-700 hover:to-red-800 transition-all shadow-md"
        >
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Header */}
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <DollarSign className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
                Préstamos
              </h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                Gestiona todos los préstamos - {countryName || 'Todos los países'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={openExportModal}
            disabled={exportLoading}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white text-[#8B1A1A] font-semibold text-sm hover:bg-white/95 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
            title="Descargar Excel (elegir fecha y país)"
          >
            {exportLoading ? (
              <Loader2 className="w-5 h-5 animate-spin shrink-0" aria-hidden />
            ) : (
              <Download className="w-5 h-5 shrink-0" aria-hidden />
            )}
            <span>{exportLoading ? 'Generando Excel…' : 'Descargar Excel'}</span>
          </button>
        </div>
      </div>

      {exportModalOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-excel-modal-title"
            onClick={() => !exportLoading && setExportModalOpen(false)}
          >
            <div
              className="bg-white rounded-xl shadow-xl max-w-lg w-full overflow-hidden flex flex-col shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gray-50">
                <h3 id="export-excel-modal-title" className="text-lg font-semibold text-gray-900">
                  Exportar a Excel
                </h3>
                <button
                  type="button"
                  onClick={() => !exportLoading && setExportModalOpen(false)}
                  className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 disabled:opacity-50"
                  disabled={exportLoading}
                  aria-label="Cerrar"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-5">
                <div className="flex flex-row flex-wrap items-end gap-3 sm:gap-4">
                  <div className="w-36 flex-shrink-0">
                    <label htmlFor="export-country" className="block text-xs font-semibold text-gray-900 mb-1.5">
                      País
                    </label>
                    <select
                      id="export-country"
                      value={exportModalFilters.country}
                      onChange={(e) => setExportModalFilters((f) => ({ ...f, country: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
                      disabled={exportLoading}
                    >
                      <option value="">Todos</option>
                      <option value="PE">Perú</option>
                      <option value="CO">Colombia</option>
                    </select>
                  </div>
                  <div className="min-w-0 flex-1">
                    <DateRangePicker
                      label="Rango de fechas"
                      value={{ date_from: exportModalFilters.date_from, date_to: exportModalFilters.date_to }}
                      onChange={(r) =>
                        setExportModalFilters((f) => ({ ...f, date_from: r.date_from, date_to: r.date_to }))
                      }
                      placeholder="Fechas"
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
              <div className="flex gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50">
                <button
                  type="button"
                  onClick={() => !exportLoading && setExportModalOpen(false)}
                  disabled={exportLoading}
                  className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-60"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void confirmExportExcel()}
                  disabled={exportLoading}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold text-white bg-[#8B1A1A] hover:bg-[#6B1515] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {exportLoading ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> : <Download className="w-5 h-5 shrink-0" aria-hidden />}
                  {exportLoading ? 'Generando…' : 'Descargar'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Filtros */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex flex-col sm:flex-row gap-4 flex-wrap">
          <div className="flex-1 min-w-0 min-w-[200px]">
            <label htmlFor="loan_id" className="block text-xs font-semibold text-gray-900 mb-1.5">
              Buscar por ID de préstamo
            </label>
            <div className="flex gap-2">
              <input
                id="loan_id"
                type="text"
                value={loanIdSearchInput}
                onChange={(e) => setLoanIdSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runLoanIdSearch()}
                placeholder="ID del préstamo (parcial o completo)"
                className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
              />
              <button
                type="button"
                onClick={runLoanIdSearch}
                className="flex-shrink-0 px-3 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] transition-colors"
                title="Buscar"
              >
                <Search className="w-5 h-5" />
              </button>
            </div>
          </div>
          <div className="flex-1 min-w-0 min-w-[200px]">
            <label htmlFor="driver" className="block text-xs font-semibold text-gray-900 mb-1.5">
              Buscar por conductor
            </label>
            <div className="flex gap-2">
              <input
                id="driver"
                type="text"
                value={driverSearchInput}
                onChange={(e) => setDriverSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runDriverSearch()}
                placeholder="Nombre, apellido o DNI"
                className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
              />
              <button
                type="button"
                onClick={runDriverSearch}
                className="flex-shrink-0 px-3 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] transition-colors"
                title="Buscar"
              >
                <Search className="w-5 h-5" />
              </button>
            </div>
          </div>
          <div className="flex-1 min-w-[150px]">
            <label htmlFor="status" className="block text-xs font-semibold text-gray-900 mb-1.5">
              Estado
            </label>
            <select
              id="status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
            >
              <option value="">Todos</option>
              <option value="active">Activo</option>
              <option value="cancelled">Cancelado</option>
              <option value="defaulted">Vencido</option>
            </select>
          </div>
          <div className="flex-1 min-w-[150px]">
            <label htmlFor="country" className="block text-xs font-semibold text-gray-900 mb-1.5">
              País
            </label>
            <select
              id="country"
              value={filters.country}
              onChange={(e) => setFilters({ ...filters, country: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
            >
              <option value="">Todos</option>
              <option value="PE">Perú</option>
              <option value="CO">Colombia</option>
            </select>
          </div>
          <div className="flex-1 min-w-[200px]">
            <DateRangePicker
              label="Fecha"
              value={{ date_from: filters.date_from, date_to: filters.date_to }}
              onChange={(r) => setFilters((f) => ({ ...f, date_from: r.date_from, date_to: r.date_to }))}
              placeholder="Filtrar por fecha"
            />
          </div>
        </div>
      </div>

      {/* Cantidad total */}
      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{pagination.total.toLocaleString('es-PE')}</span>
        <span className="text-sm text-gray-600">préstamos</span>
      </div>

      {/* Loans table */}
      {loans.length === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 lg:p-12 text-center">
          <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <FileText className="w-10 h-10 text-gray-400" />
          </div>
          <h3 className="text-xl lg:text-2xl font-bold text-gray-900 mb-2">
            No hay préstamos disponibles
          </h3>
          <p className="text-gray-600 mb-6 text-base">
            No se encontraron préstamos con los filtros seleccionados
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden relative">
            {paginationLoading && (
              <div className="absolute inset-0 bg-white/60 z-10 flex items-center justify-center rounded-xl">
                <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Conductor
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Monto Desembolsado
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Monto Total
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Saldo Pendiente
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Mora
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    País
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Estado
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {loans.map((loan) => (
                  <tr key={loan.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-4 whitespace-nowrap">
                      {loan.id ? (
                        <button
                          onClick={() => handleCopyId(loan.id)}
                          className="flex items-center gap-2 text-sm font-medium text-gray-900 hover:text-red-600 transition-colors group"
                          title="Click para copiar ID"
                        >
                          <span>{loan.id.substring(0, 8)}...</span>
                          <Copy className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      ) : (
                        <div className="text-sm font-medium text-gray-900">N/A</div>
                      )}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">
                        {loan.driver_first_name || ''} {loan.driver_last_name || ''}
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className="text-sm font-semibold text-gray-900">
                        {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : ''} {loan.disbursed_amount ? Number(loan.disbursed_amount).toFixed(2) : '0.00'}
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className="text-sm font-semibold text-gray-900">
                        {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : ''} {loan.total_amount ? Number(loan.total_amount).toFixed(2) : '0.00'}
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className="text-sm font-semibold text-red-600">
                        {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : ''} {loan.pending_balance ? Number(loan.pending_balance).toFixed(2) : '0.00'}
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className={`text-sm font-medium ${Number(loan.total_late_fee ?? 0) > 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : ''} {Number(loan.total_late_fee ?? 0).toFixed(2)}
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        {loan.country || 'N/A'}
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      {getStatusBadge(loan.status || 'active')}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <button
                        onClick={() => navigate(`/admin/loans/${loan.id}`, {
                          state: {
                            fromLoansSearch: true,
                            driver: filters.driver,
                            loan_id: filters.loan_id,
                            driverSearchInput,
                            loanIdSearchInput,
                            status: filters.status,
                            country: filters.country,
                            date_from: filters.date_from,
                            date_to: filters.date_to,
                            page: pagination.page,
                            limit: pagination.limit,
                          },
                        })}
                        className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200"
                        title="Ver detalles"
                      >
                        <Eye className="w-5 h-5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>

          {pagination.total > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 pb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-500">Por página:</span>
                <select
                  value={pagination.limit}
                  onChange={(e) => {
                    const newLimit = Number(e.target.value);
                    setPagination((p) => ({ ...p, limit: newLimit, page: 1 }));
                    fetchLoans(1, newLimit, true);
                  }}
                  className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:ring-2 focus:ring-red-500 focus:border-red-600"
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => goToPage(1)}
                  disabled={pagination.page <= 1 || loading || paginationLoading}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Primera página"
                >
                  <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(pagination.page - 1)}
                  disabled={pagination.page <= 1 || loading || paginationLoading}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {pagination.totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                      let pageNum: number;
                      if (pagination.totalPages <= 5) pageNum = i + 1;
                      else if (pagination.page <= 3) pageNum = i + 1;
                      else if (pagination.page >= pagination.totalPages - 2) pageNum = pagination.totalPages - 4 + i;
                      else pageNum = pagination.page - 2 + i;
                      const isActive = pagination.page === pageNum;
                      return (
                        <button
                          key={pageNum}
                          type="button"
                          onClick={() => goToPage(pageNum)}
                          disabled={loading || paginationLoading}
                          className={`min-w-[2.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                            isActive ? 'bg-red-600 text-white border-2 border-red-600' : 'border-2 border-red-600 text-red-600 hover:bg-red-50'
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
                  onClick={() => goToPage(pagination.page + 1)}
                  disabled={pagination.page >= pagination.totalPages || loading || paginationLoading}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Página siguiente"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(pagination.totalPages || 1)}
                  disabled={pagination.page >= pagination.totalPages || loading || paginationLoading}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Última página"
                >
                  <ChevronsRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Loans;







