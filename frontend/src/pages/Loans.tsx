import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../services/api';
import { Eye, FileText, DollarSign, AlertCircle, CheckCircle, XCircle, Copy, Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';
import { DateRangePicker } from '../components/DateRangePicker';

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
  driver?: string;
  loan_id?: string;
  driverSearchInput?: string;
  loanIdSearchInput?: string;
};

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
    status: '',
    country: '',
    driver: isReturnFromDetail ? (searchState?.driver ?? '') : '',
    loan_id: isReturnFromDetail ? (searchState?.loan_id ?? '') : '',
    date_from: '',
    date_to: '',
  });
  const [driverSearchInput, setDriverSearchInput] = useState(initialDriver);
  const [loanIdSearchInput, setLoanIdSearchInput] = useState(initialLoanId);
  const [pagination, setPagination] = useState({ page: 1, limit: 5, total: 0, totalPages: 0 });
  const [paginationLoading, setPaginationLoading] = useState(false);
  const PAGE_SIZES = [5, 10, 20, 50];

  // Limpiar state de navegación al volver del detalle para que un refresh no restaure
  useEffect(() => {
    if (isReturnFromDetail) {
      window.history.replaceState({}, document.title, location.pathname);
    }
  }, [isReturnFromDetail, location.pathname]);

  useEffect(() => {
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
        </div>
      </div>

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







