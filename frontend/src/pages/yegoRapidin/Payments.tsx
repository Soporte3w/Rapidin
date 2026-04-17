import { useState, useEffect, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import api from '../../services/api';
import { Plus, X, FileText, CreditCard, AlertCircle, Eye, CheckCircle, XCircle, Copy, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate, formatDateTimeLocal } from '../../utils/date';
import { DateRangePicker } from '../../components/DateRangePicker';
import toast from 'react-hot-toast';

interface Payment {
  id: string;
  loan_id: string;
  amount: number;
  payment_date: string;
  reference: string;
  created_at: string;
  payment_method?: string;
  voucher_id?: string;
  voucher_id_resolved?: string;
  country?: string;
  driver_first_name?: string;
  driver_last_name?: string;
}

interface Voucher {
  id: string;
  loanId: string;
  driverId: string;
  amount: number;
  paymentDate: string;
  fileName: string;
  reference?: string;
  observations?: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedAt?: string;
  rejectionReason?: string;
  createdAt: string;
  driverFirstName?: string;
  driverLastName?: string;
  driverPhone?: string;
  loanAmount: number;
  installmentsCount: number;
  installmentNumbers?: number[];
}

interface AutoPaymentLogEntry {
  id: string;
  loan_id?: string;
  installment_id?: string;
  driver_id?: string;
  external_driver_id?: string;
  driver_first_name?: string;
  driver_last_name?: string;
  flota?: string;
  flota_name?: string;
  amount_to_charge: number;
  amount_charged: number;
  installment_number?: number;
  status: 'success' | 'failed';
  reason?: string;
  balance_at_attempt?: number;
  payment_id?: string;
  created_at: string;
}

interface ScheduleInstallment {
  id: string;
  installment_number: number;
  installment_amount: number;
  due_date: string;
  paid_amount?: number;
  paid_late_fee?: number;
  paid_date?: string | null;
  status: string;
  late_fee?: number;
  cumulative_late_fee?: number;
}

const Payments = () => {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<'pagos' | 'comprobantes' | 'pagos-automaticos'>('pagos');

  useEffect(() => {
    const t = searchParams.get('tab');
    if (t === 'pagos' || t === 'comprobantes' || t === 'pagos-automaticos') {
      setTab(t);
    }
  }, [searchParams]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [vouchersLoading, setVouchersLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [confirmApproveModal, setConfirmApproveModal] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<{ voucherId: string; reason: string } | null>(null);
  const [viewFileModal, setViewFileModal] = useState<{ url: string; type: string } | null>(null);
  const [comprobantesFilter, setComprobantesFilter] = useState<'pending' | 'rejected' | 'approved'>('pending');
  const [paymentFilters, setPaymentFilters] = useState({
    loan_id: '',
    country: (user?.country as string) || 'PE',
    date_from: '',
    date_to: '',
  });
  const [loanIdSearchInput, setLoanIdSearchInput] = useState('');
  const [pagination, setPagination] = useState({ page: 1, limit: 5, total: 0, totalPages: 0 });
  const [paginationLoading, setPaginationLoading] = useState(false);
  const [formData, setFormData] = useState({
    loan_id: '',
    amount: '',
    payment_date: new Date().toISOString().split('T')[0],
    reference: '',
  });
  const [loanPreview, setLoanPreview] = useState<{
    driver_first_name?: string;
    driver_last_name?: string;
    next_installment_number?: number;
    next_installment_amount?: number;
    next_installment_late_fee?: number;
    next_installment_id?: string;
    pending_balance?: number;
    status?: string;
    fully_paid?: boolean;
  } | null>(null);
  const [chargeLateFee, setChargeLateFee] = useState(true);
  const [loanPreviewLoading, setLoanPreviewLoading] = useState(false);
  const [loanPreviewFetched, setLoanPreviewFetched] = useState(false);
  const [submittingPayment, setSubmittingPayment] = useState(false);

  const [autoLog, setAutoLog] = useState<AutoPaymentLogEntry[]>([]);
  const [autoLogLoading, setAutoLogLoading] = useState(false);
  const [autoLogPaginationLoading, setAutoLogPaginationLoading] = useState(false);
  const [autoLogFilters, setAutoLogFilters] = useState({ date_from: '', date_to: '', driver: '', status: '' });
  const [autoLogPagination, setAutoLogPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });

  const [loanSchedule, setLoanSchedule] = useState<ScheduleInstallment[]>([]);
  const [loanScheduleLoading, setLoanScheduleLoading] = useState(false);

  const lastPaymentFiltersRef = useRef<string>('');
  useEffect(() => {
    const key = JSON.stringify(paymentFilters);
    if (key === lastPaymentFiltersRef.current) return;
    lastPaymentFiltersRef.current = key;
    setPagination((p) => ({ ...p, page: 1 }));
    fetchPayments(1, pagination.limit, true);
  }, [paymentFilters]);

  const goToPage = (page: number) => {
    const nextPage = Math.max(1, Math.min(page, pagination.totalPages || 1));
    fetchPayments(nextPage, pagination.limit, true);
  };

  const fetchLoanPreview = () => {
    const loanId = formData.loan_id.trim();
    if (loanId.length < 8) return;
    setLoanPreviewLoading(true);
    setLoanPreviewFetched(false);
    api.get(`/loans/${loanId}`)
      .then((res) => {
        const data = res.data?.data ?? res.data;
        const hasLoan = data?.driver_first_name !== undefined || data?.driver_last_name !== undefined;
        if (!hasLoan) {
          setLoanPreview(null);
          setLoanPreviewFetched(true);
          return;
        }
        const sinMora = Number(data.next_installment_amount) || 0;
        const mora = Number(data.next_installment_late_fee) || 0;
        const conMora = Number(data.next_installment_total) > 0
          ? Number(Number(data.next_installment_total).toFixed(2))
          : mora > 0 ? Math.round((sinMora + mora) * 100) / 100 : sinMora;
        const pendingBalance = data.pending_balance != null ? Number(data.pending_balance) : undefined;
        const status = data.status;
        const fullyPaid =
          sinMora === 0 &&
          (pendingBalance === 0 || pendingBalance == null || status === 'cancelled');

        setLoanPreview({
          driver_first_name: data.driver_first_name,
          driver_last_name: data.driver_last_name,
          next_installment_number: data.next_installment_number != null ? Number(data.next_installment_number) : undefined,
          next_installment_amount: sinMora,
          next_installment_late_fee: data.next_installment_late_fee != null ? Number(data.next_installment_late_fee) : undefined,
          next_installment_id: data.next_installment_id ?? undefined,
          pending_balance: pendingBalance,
          status,
          fully_paid: fullyPaid,
        });
        setChargeLateFee(true);
        if (fullyPaid) {
          setFormData((prev) => ({ ...prev, amount: '' }));
        } else if (conMora > 0) {
          setFormData((prev) => ({ ...prev, amount: String(conMora) }));
        } else if (pendingBalance != null && pendingBalance > 0) {
          setFormData((prev) => ({ ...prev, amount: String(Number(pendingBalance).toFixed(2)) }));
        } else {
          setFormData((prev) => ({ ...prev, amount: '' }));
        }
        setLoanPreviewFetched(true);
      })
      .catch(() => {
        setLoanPreview(null);
        setLoanPreviewFetched(true);
      })
      .finally(() => setLoanPreviewLoading(false));
  };

  // Al cambiar el ID del préstamo en el modal, buscar conductor (debounce) o al hacer clic en la lupa
  useEffect(() => {
    if (!open) return;
    const loanId = formData.loan_id.trim();
    if (loanId.length < 8) {
      setLoanPreview(null);
      setLoanPreviewFetched(false);
      return;
    }
    const t = setTimeout(() => fetchLoanPreview(), 400);
    return () => clearTimeout(t);
  }, [open, formData.loan_id]);

  useEffect(() => {
    if (!open) {
      setLoanPreview(null);
      setLoanPreviewFetched(false);
      setFormData({
        loan_id: '',
        amount: '',
        payment_date: new Date().toISOString().split('T')[0],
        reference: '',
      });
    }
  }, [open]);

  // Solo llamar al endpoint de vouchers cuando estés en la vista "Comprobantes por validar"
  useEffect(() => {
    if (tab === 'comprobantes') fetchVouchers();
  }, [tab, comprobantesFilter]);

  const fetchAutoLog = async (page = 1, isPaginationChange = false) => {
    if (isPaginationChange) {
      setAutoLogPaginationLoading(true);
    } else {
      setAutoLogLoading(true);
    }
    try {
      const params = new URLSearchParams();
      params.append('page', String(page));
      params.append('limit', String(autoLogPagination.limit));
      if (autoLogFilters.date_from) params.append('date_from', autoLogFilters.date_from);
      if (autoLogFilters.date_to) params.append('date_to', autoLogFilters.date_to);
      if (autoLogFilters.driver.trim()) params.append('driver', autoLogFilters.driver.trim());
      if (autoLogFilters.status) params.append('status', autoLogFilters.status);
      const res = await api.get(`/payments/automatic-log?${params.toString()}`);
      const data = res.data?.data ?? [];
      const total = res.data?.pagination?.total ?? 0;
      const totalPages = res.data?.pagination?.totalPages ?? 1;
      setAutoLog(Array.isArray(data) ? data : []);
      setAutoLogPagination((p) => ({ ...p, page, total, totalPages }));
    } catch (err) {
      toast.error('Error al cargar log de pagos automáticos');
      setAutoLog([]);
    } finally {
      if (isPaginationChange) {
        setAutoLogPaginationLoading(false);
      } else {
        setAutoLogLoading(false);
      }
    }
  };

  useEffect(() => {
    if (tab === 'pagos-automaticos') fetchAutoLog(1);
  }, [tab]);

  // Filtros de pagos automáticos: buscar al cambiar (sin esperar al botón), con debounce para no disparar en cada tecla
  useEffect(() => {
    if (tab !== 'pagos-automaticos') return;
    const t = setTimeout(() => fetchAutoLog(1), 400);
    return () => clearTimeout(t);
  }, [autoLogFilters.date_from, autoLogFilters.date_to, autoLogFilters.driver, autoLogFilters.status, tab]);

  const runLoanIdSearch = () => {
    const value = loanIdSearchInput.trim();
    setPaymentFilters((prev) => ({ ...prev, loan_id: value }));
  };

  const clearLoanIdFilter = () => {
    setLoanIdSearchInput('');
    setPaymentFilters((prev) => ({ ...prev, loan_id: '' }));
    setLoanSchedule([]);
  };

  const resolvedLoanIdForSchedule = paymentFilters.loan_id.trim()
    ? (payments[0] as Payment | undefined)?.loan_id || (paymentFilters.loan_id.trim().length >= 36 ? paymentFilters.loan_id.trim() : null)
    : null;

  useEffect(() => {
    if (!resolvedLoanIdForSchedule || tab !== 'pagos') {
      setLoanSchedule([]);
      return;
    }
    setLoanScheduleLoading(true);
    api.get(`/loans/${resolvedLoanIdForSchedule}/schedule`)
      .then((res) => {
        const data = res.data?.data ?? res.data;
        setLoanSchedule(Array.isArray(data) ? data : []);
      })
      .catch(() => setLoanSchedule([]))
      .finally(() => setLoanScheduleLoading(false));
  }, [resolvedLoanIdForSchedule, tab]);

  const paymentCountry = paymentFilters.country || 'PE';
  const currencyLabel = paymentCountry === 'PE' ? 'S/.' : paymentCountry === 'CO' ? 'COP' : 'S/.';

  const fetchPayments = async (page = pagination.page, limit = pagination.limit, isPaginationChange = false) => {
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
      if (paymentFilters.country) params.append('country', paymentFilters.country);
      if (paymentFilters.loan_id.trim()) params.append('loan_id', paymentFilters.loan_id.trim());
      if (paymentFilters.date_from) params.append('date_from', paymentFilters.date_from);
      if (paymentFilters.date_to) params.append('date_to', paymentFilters.date_to);
      const response = await api.get(`/payments?${params.toString()}`);
      let paymentsData: Payment[] = [];
      let total = 0;
      let totalPages = 0;
      if (response.data) {
        if (response.data.pagination) {
          total = response.data.pagination.total ?? 0;
          totalPages = response.data.pagination.totalPages ?? 0;
        }
        if (Array.isArray(response.data.data)) {
          paymentsData = response.data.data;
        } else if (Array.isArray(response.data)) {
          paymentsData = response.data;
        }
      }
      setPayments(paymentsData);
      setPagination((prev) => ({ ...prev, page, limit, total, totalPages }));
    } catch (error: any) {
      console.error('Error fetching payments:', error);
      setError(error.response?.data?.message || 'Error al cargar los pagos');
      setPayments([]);
    } finally {
      setLoading(false);
      if (isPaginationChange) setPaginationLoading(false);
    }
  };

  const [pendingVouchersCount, setPendingVouchersCount] = useState(0);

  const fetchVouchers = async () => {
    try {
      setVouchersLoading(true);
      const response = await api.get(`/vouchers?status=${comprobantesFilter}`);
      const data = response.data?.data ?? response.data ?? [];
      const list = Array.isArray(data) ? data : [];
      setVouchers(list);
      if (comprobantesFilter === 'pending') setPendingVouchersCount(list.length);
    } catch (err: any) {
      console.error('Error fetching vouchers:', err);
      toast.error(err.response?.data?.message || 'Error al cargar comprobantes');
      setVouchers([]);
    } finally {
      setVouchersLoading(false);
    }
  };

  const handleReviewVoucher = async (voucherId: string, status: 'approved' | 'rejected', rejectionReason?: string) => {
    try {
      await api.patch(`/vouchers/${voucherId}/review`, { status, rejectionReason: rejectionReason || undefined });
      toast.success(status === 'approved' ? 'Comprobante aprobado. El pago se registró correctamente.' : 'Comprobante rechazado.');
      setConfirmApproveModal(null);
      setRejectModal(null);
      fetchVouchers();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al actualizar comprobante');
    }
  };

  const handleSubmit = async () => {
    if (submittingPayment) return;
    if (!formData.loan_id || !formData.amount) {
      toast.error('Por favor completa todos los campos requeridos');
      return;
    }
    setSubmittingPayment(true);
    try {
      const payload: Record<string, unknown> = {
        ...formData,
        amount: parseFloat(formData.amount),
      };
      if (!chargeLateFee && loanPreview?.next_installment_id && (loanPreview?.next_installment_late_fee ?? 0) > 0) {
        payload.waive_late_fee_installment_ids = [loanPreview.next_installment_id];
      }
      await api.post('/payments', payload);
      toast.success('Pago registrado correctamente');
      setOpen(false);
      setFormData({
        loan_id: '',
        amount: '',
        payment_date: new Date().toISOString().split('T')[0],
        reference: '',
      });
      setChargeLateFee(true);
      fetchPayments(1, pagination.limit);
    } catch (error: any) {
      console.error('Error registering payment:', error);
      toast.error(error.response?.data?.message || 'Error al registrar el pago');
    } finally {
      setSubmittingPayment(false);
    }
  };

  const handleCopyId = async (id: string, message = 'ID copiado') => {
    try {
      await navigator.clipboard.writeText(id);
      toast.success(message);
    } catch {
      toast.error('No se pudo copiar');
    }
  };

  const safePayments = Array.isArray(payments) ? payments : [];
  const safeVouchers = Array.isArray(vouchers) ? vouchers : [];
  const pendingCount = tab === 'comprobantes' && comprobantesFilter === 'pending' ? safeVouchers.length : pendingVouchersCount;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-red-600 border-t-transparent mx-auto mb-4" />
          <p className="text-gray-600">Cargando pagos...</p>
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
        <h3 className="text-xl font-bold text-gray-900 mb-2">Error al cargar los pagos</h3>
        <p className="text-gray-600 mb-6 text-center max-w-md">{error}</p>
        <button
          onClick={() => fetchPayments(pagination.page, pagination.limit)}
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
              <CreditCard className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
                Pagos
              </h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                Registra pagos y valida comprobantes
              </p>
              <Link
                to="/admin/payments-bulk"
                className="inline-block text-xs text-white/85 hover:text-white underline mt-1 font-medium"
              >
                Pagos y cobros masivos →
              </Link>
            </div>
          </div>
          {tab === 'pagos' && (
            <button
              onClick={() => setOpen(true)}
              className="bg-white text-[#8B1A1A] font-semibold py-2.5 px-5 rounded-lg hover:bg-gray-50 transition-all shadow-md flex items-center justify-center gap-2 text-sm whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              Registrar Pago
            </button>
          )}
        </div>
        {/* Tabs */}
        <div className="flex gap-1 mt-4 border-b border-white/20 -mb-px">
          <button
            onClick={() => setTab('pagos')}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === 'pagos' ? 'bg-white/20 text-white' : 'text-white/80 hover:text-white'
            }`}
          >
            Pagos registrados
          </button>
          <button
            onClick={() => setTab('comprobantes')}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors flex items-center gap-1.5 ${
              tab === 'comprobantes' ? 'bg-white/20 text-white' : 'text-white/80 hover:text-white'
            }`}
          >
            Comprobantes por validar
            {pendingCount > 0 && (
              <span className="bg-white/30 text-white text-xs px-1.5 py-0.5 rounded">
                {pendingCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab('pagos-automaticos')}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === 'pagos-automaticos' ? 'bg-white/20 text-white' : 'text-white/80 hover:text-white'
            }`}
          >
            Pagos automáticos
          </button>
        </div>
      </div>

      {/* Tab: Pagos */}
      {tab === 'pagos' && (
      <>
      {/* Filtros: Fecha, País, ID préstamo */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Filtros</h3>
        <div className="flex flex-wrap items-end gap-4">
          <DateRangePicker
            label="Fecha"
            value={{ date_from: paymentFilters.date_from, date_to: paymentFilters.date_to }}
            onChange={(r) => setPaymentFilters((f) => ({ ...f, date_from: r.date_from, date_to: r.date_to }))}
            placeholder="Filtrar por fecha"
          />
          <div className="w-full max-w-md">
            <label htmlFor="loan_id_filter" className="block text-xs font-semibold text-gray-900 mb-1.5">
              Buscar por ID de préstamo
            </label>
            <div className="flex gap-2 flex-wrap">
              <input
                id="loan_id_filter"
                type="text"
                value={loanIdSearchInput}
                onChange={(e) => setLoanIdSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runLoanIdSearch()}
                placeholder="ID completo o primeros caracteres (ej. abc12345)"
                className="flex-1 min-w-[200px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm font-mono"
              />
              <button
                type="button"
                onClick={runLoanIdSearch}
                className="flex-shrink-0 px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] transition-colors flex items-center gap-2"
                title="Buscar"
              >
                <Search className="w-4 h-4" />
                Buscar
              </button>
              {paymentFilters.loan_id && (
                <button
                  type="button"
                  onClick={clearLoanIdFilter}
                  className="flex-shrink-0 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm"
                >
                  Limpiar filtro
                </button>
              )}
            </div>
            {paymentFilters.loan_id && (
              <p className="mt-1.5 text-xs text-gray-600">
                Filtro activo: préstamo <span className="font-mono font-medium">{paymentFilters.loan_id}</span>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Cuotas del préstamo cuando hay filtro por ID */}
      {tab === 'pagos' && paymentFilters.loan_id.trim() && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 mb-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Cuotas de este préstamo</h3>
          {loanScheduleLoading ? (
            <div className="flex items-center gap-2 py-4 text-gray-600 text-sm">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-red-600 border-t-transparent" />
              Cargando cronograma...
            </div>
          ) : loanSchedule.length === 0 ? (
            <p className="text-sm text-gray-500 py-2">
              {resolvedLoanIdForSchedule
                ? 'No se pudo cargar el cronograma. Comprueba el ID o que el préstamo exista.'
                : 'Escribe el ID completo del préstamo o busca primero para ver las cuotas.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">Cuota</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">F. vencimiento</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700">Monto</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700">Mora</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700">Pagado</th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-700">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loanSchedule.map((inst) => {
                    const isPaid = inst.status === 'paid' || (parseFloat(String(inst.paid_amount || 0)) >= parseFloat(String(inst.installment_amount || 0)));
                    const mora = Math.max(0, parseFloat(String(inst.late_fee ?? 0)));
                    return (
                      <tr key={inst.id} className={isPaid ? 'bg-green-50/60' : ''}>
                        <td className="px-3 py-2 font-medium text-gray-900">{inst.installment_number}</td>
                        <td className="px-3 py-2 text-gray-700">
                          {inst.due_date ? formatDate(inst.due_date, 'es-ES') : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-900">{currencyLabel} {Number(inst.installment_amount || 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-right text-amber-700">{currencyLabel} {mora.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right text-gray-900" title={mora > 0 ? `Incluye cuota + mora (por días de atraso)` : undefined}>
                          {currencyLabel} {(Number(inst.paid_amount || 0) + Number(inst.paid_late_fee || 0)).toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            isPaid ? 'bg-green-100 text-green-800' : inst.status === 'overdue' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                          }`}>
                            {isPaid ? 'Pagada' : inst.status === 'overdue' ? 'Vencido' : 'Pendiente'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Lista de pagos con paginación */}
      {safePayments.length === 0 && !loading ? (
        <div className="bg-white rounded-xl shadow border border-gray-200 p-8 text-center">
          <FileText className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-gray-900 mb-2">
            {paymentFilters.loan_id ? 'No hay pagos para este préstamo' : 'No hay pagos disponibles'}
          </h3>
          <p className="text-gray-600 text-sm mb-4">
            {paymentFilters.loan_id
              ? 'No se encontraron pagos con el ID indicado. Revisa el ID o quita el filtro.'
              : 'No se encontraron pagos registrados'}
          </p>
          {paymentFilters.loan_id && (
            <button
              type="button"
              onClick={clearLoanIdFilter}
              className="px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] transition-colors font-medium"
            >
              Quitar filtro y ver todos
            </button>
          )}
        </div>
      ) : (
        <div className={`bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden transition-opacity ${paginationLoading ? 'opacity-60' : ''}`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px]">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Préstamo</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">Monto</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Fecha</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Tipo de pago</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Referencia</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {safePayments.filter(Boolean).map((payment, idx) => {
                  const p = payment as Payment;
                  return (
                    <tr key={p?.id ?? `pay-${idx}`} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm text-gray-600 font-mono">
                        {p?.loan_id != null ? (
                          <button
                            type="button"
                            onClick={() => handleCopyId(String(p.loan_id), 'ID préstamo copiado')}
                            className="flex items-center gap-1.5 group cursor-pointer hover:text-red-600 transition-colors text-left"
                            title="Click para copiar ID"
                          >
                            <span>{String(p.loan_id).slice(0, 8)}…</span>
                            <Copy className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                          </button>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-center tabular-nums font-medium text-gray-900">
                        {currencyLabel} {(p?.amount != null ? Number(p.amount) : 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                        {p?.created_at
                          ? formatDateTimeLocal(p.created_at, 'es-ES')
                          : p?.payment_date
                            ? formatDate(p.payment_date, 'es-ES')
                            : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                          p?.payment_method === 'voucher'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {p?.payment_method === 'voucher' ? 'Comprobante (conductor)' : 'Oficina / Manual'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-[220px]" title={p?.reference || undefined}>
                        {p?.reference ? (String(p.reference).length > 50 ? String(p.reference).slice(0, 50) + '…' : p.reference) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pagination.total > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <span className="text-xs text-gray-500">
                Total: {pagination.total} registro(s)
                {paginationLoading && <span className="ml-2 text-red-600">Cargando...</span>}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => goToPage(pagination.page - 1)}
                  disabled={pagination.page <= 1 || paginationLoading}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50"
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm text-gray-700 px-2">Pág. {pagination.page} de {pagination.totalPages || 1}</span>
                <button
                  type="button"
                  onClick={() => goToPage(pagination.page + 1)}
                  disabled={pagination.page >= pagination.totalPages || paginationLoading}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50"
                  aria-label="Página siguiente"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal de registro */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto border border-gray-200">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-lg font-bold text-white">Registrar Pago</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label htmlFor="loan_id" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  ID del Préstamo
                </label>
                <div className="flex gap-2">
                  <input
                    id="loan_id"
                    type="text"
                    value={formData.loan_id}
                    onChange={(e) => setFormData({ ...formData, loan_id: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && formData.loan_id.trim().length >= 8 && fetchLoanPreview()}
                    required
                    className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                    placeholder="Ingresa el ID del préstamo"
                  />
                  <button
                    type="button"
                    onClick={() => fetchLoanPreview()}
                    disabled={formData.loan_id.trim().length < 8 || loanPreviewLoading}
                    className="flex-shrink-0 px-3 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    title="Buscar préstamo y ver conductor"
                  >
                    <Search className="w-5 h-5" />
                  </button>
                </div>
                {(loanPreviewLoading || loanPreviewFetched) && formData.loan_id.trim().length >= 8 && (
                  <div className="mt-1.5 text-sm space-y-1">
                    {loanPreviewLoading ? (
                      <span className="text-amber-600">Buscando...</span>
                    ) : loanPreviewFetched && loanPreview ? (
                      <>
                        {loanPreview.fully_paid ? (
                          <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-green-800 font-medium">
                            Este préstamo fue pagado en su totalidad. No hay más cuotas por registrar.
                          </div>
                        ) : (
                          <span className="text-green-700 font-medium">
                            Conductor: {[loanPreview.driver_first_name, loanPreview.driver_last_name].filter(Boolean).join(' ') || '—'}
                          </span>
                        )}
                      </>
                    ) : loanPreviewFetched ? (
                      <span className="text-red-600">Préstamo no encontrado</span>
                    ) : null}
                  </div>
                )}
              </div>
              <div>
                <label htmlFor="amount" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Monto
                  {loanPreview?.next_installment_number != null && Number(loanPreview.next_installment_amount) > 0 && (
                    <span className="text-gray-500 font-normal"> (Cuota {loanPreview.next_installment_number})</span>
                  )}
                </label>
                <input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.amount}
                  readOnly
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 cursor-not-allowed text-sm"
                  placeholder="0.00"
                />
                {loanPreview?.next_installment_late_fee != null && Number(loanPreview.next_installment_late_fee) > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200/80 bg-amber-50/80 overflow-hidden">
                      <div className="px-3 py-2 flex items-center justify-between border-b border-amber-200/60">
                        <span className="text-xs font-medium text-amber-800">Mora</span>
                        <span className="text-sm font-semibold tabular-nums text-amber-900">{currencyLabel} {Number(loanPreview.next_installment_late_fee).toFixed(2)}</span>
                      </div>
                      <label className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-amber-100/50">
                        <input
                          type="checkbox"
                          checked={chargeLateFee}
                          onChange={(e) => {
                            const incluir = e.target.checked;
                            setChargeLateFee(incluir);
                            const sinMora = Number(loanPreview?.next_installment_amount) || 0;
                            const mora = Number(loanPreview?.next_installment_late_fee) || 0;
                            setFormData((prev) => ({
                              ...prev,
                              amount: incluir ? String((sinMora + mora).toFixed(2)) : String(sinMora.toFixed(2)),
                            }));
                          }}
                          className="w-3 h-3 rounded border-amber-500 text-red-600 focus:ring-amber-400"
                        />
                        <span className="text-xs text-amber-900/90">Incluir mora en el monto a registrar</span>
                      </label>
                    </div>
                )}
              </div>
              <div>
                <label htmlFor="payment_date" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Fecha de Pago
                </label>
                <input
                  id="payment_date"
                  type="date"
                  value={formData.payment_date}
                  readOnly
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 cursor-not-allowed text-sm"
                />
              </div>
              <div>
                <label htmlFor="reference" className="block text-xs font-semibold text-gray-900 mb-1.5">
                  Referencia
                </label>
                <input
                  id="reference"
                  type="text"
                  value={formData.reference}
                  onChange={(e) => setFormData({ ...formData, reference: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
                  placeholder="Referencia del pago (opcional)"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={submittingPayment}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all font-medium text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submittingPayment || (loanPreview?.fully_paid === true)}
                className="px-6 py-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-lg transition-all font-semibold shadow-md text-sm disabled:opacity-70 disabled:cursor-not-allowed flex items-center gap-2 min-w-[120px] justify-center"
              >
                {submittingPayment ? (
                  <>
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Registrando…
                  </>
                ) : (
                  'Registrar'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      </>
      )}

      {/* Tab: Comprobantes por validar */}
      {tab === 'comprobantes' && (
      <>
        {/* Sub-tabs: Pendientes | Aprobados | Rechazados */}
        <div className="flex gap-1 p-1 bg-gray-100 rounded-lg w-fit mb-4">
          <button
            type="button"
            onClick={() => setComprobantesFilter('pending')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              comprobantesFilter === 'pending' ? 'bg-white text-[#8B1A1A] shadow' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Pendientes
          </button>
          <button
            type="button"
            onClick={() => setComprobantesFilter('approved')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              comprobantesFilter === 'approved' ? 'bg-white text-[#8B1A1A] shadow' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Aprobados
          </button>
          <button
            type="button"
            onClick={() => setComprobantesFilter('rejected')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              comprobantesFilter === 'rejected' ? 'bg-white text-[#8B1A1A] shadow' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Rechazados
          </button>
        </div>

      {vouchersLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-red-600 border-t-transparent mx-auto mb-3" />
            <p className="text-gray-600 text-sm">Cargando comprobantes...</p>
          </div>
        </div>
      ) : safeVouchers.length === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 text-center">
          <FileText className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-gray-900 mb-2">
            {comprobantesFilter === 'approved' ? 'No hay comprobantes aprobados' : comprobantesFilter === 'rejected' ? 'No hay comprobantes rechazados' : 'No hay comprobantes'}
          </h3>
          <p className="text-gray-600 text-sm">
            {comprobantesFilter === 'approved'
              ? 'No se encontraron comprobantes aprobados de conductores.'
              : comprobantesFilter === 'rejected'
                ? 'No se encontraron comprobantes rechazados.'
                : 'No se encontraron comprobantes para validar.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Conductor</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Préstamo</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Cuota(s)</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Monto</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Fecha pago</th>
                  {comprobantesFilter === 'approved' && (
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Fecha aprobación</th>
                  )}
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Estado</th>
                  {comprobantesFilter === 'rejected' && (
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Motivo rechazo</th>
                  )}
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wider">Acciones</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {safeVouchers.filter(Boolean).map((v, idx) => (
                  <tr key={v?.id ?? `voucher-${idx}`} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900">
                        {[v?.driverFirstName, v?.driverLastName].filter(Boolean).join(' ') || '—'}
                      </div>
                      {v?.driverPhone && <div className="text-xs text-gray-500">{v.driverPhone}</div>}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {v?.loanId ? (
                        <span className="inline-flex items-center gap-1">
                          {String(v.loanId).slice(0, 8)}…
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(v.loanId);
                              toast.success('Préstamo copiado');
                            }}
                            className="p-0.5 rounded text-gray-400 hover:text-[#8B1A1A] hover:bg-gray-100"
                            title="Copiar préstamo"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {v?.installmentNumbers?.length ? v.installmentNumbers.join(', ') : (v?.installmentsCount ? `(${v.installmentsCount})` : '—')}
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-green-600">
                      S/. {v?.amount != null ? Number(v.amount).toFixed(2) : '0.00'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {v?.paymentDate ? formatDate(v.paymentDate, 'es-ES') : '—'}
                    </td>
                    {comprobantesFilter === 'approved' && (
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {v?.reviewedAt ? formatDate(v.reviewedAt, 'es-ES') : '—'}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        v?.status === 'pending' ? 'bg-amber-100 text-amber-800' :
                        v?.status === 'approved' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                      }`}>
                        {v?.status === 'pending' ? 'Pendiente' : v?.status === 'approved' ? 'Aprobado' : 'Rechazado'}
                      </span>
                    </td>
                    {comprobantesFilter === 'rejected' && (
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-[200px]" title={v?.rejectionReason || undefined}>
                        {v?.rejectionReason ? (v.rejectionReason.length > 50 ? v.rejectionReason.slice(0, 50) + '…' : v.rejectionReason) : '—'}
                      </td>
                    )}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={async () => {
                            if (!v?.id) return;
                            try {
                              const { data } = await api.get(`/vouchers/${v.id}/file`, { responseType: 'blob' });
                              const url = URL.createObjectURL(data);
                              setViewFileModal({ url, type: data.type || 'image/png' });
                            } catch (err) {
                              toast.error('No se pudo abrir el archivo');
                            }
                          }}
                          className="text-gray-600 hover:text-[#8B1A1A] p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                          title="Ver comprobante"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {v?.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() => v?.id && setConfirmApproveModal(v.id)}
                              className="text-green-600 hover:text-green-700 p-1.5 rounded-lg hover:bg-green-50 transition-colors"
                              title="Aprobar"
                            >
                              <CheckCircle className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => v?.id && setRejectModal({ voucherId: v.id, reason: '' })}
                              className="text-red-600 hover:text-red-700 p-1.5 rounded-lg hover:bg-red-50 transition-colors"
                              title="Rechazar"
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </>
      )}

      {/* Tab: Pagos automáticos — contenedor siempre en DOM, visibilidad por CSS */}
      <div
        style={{ display: tab === 'pagos-automaticos' ? 'block' : 'none' }}
        className="space-y-4 min-h-[320px] bg-gray-50/60 rounded-xl p-4 border border-gray-200"
      >
        <h2 className="text-lg font-bold text-gray-900 border-b border-gray-200 pb-2 mb-4">
          Log de cobros automáticos
        </h2>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Filtros</h3>
          <div className="flex flex-wrap items-end gap-4">
            <DateRangePicker
              label="Fecha"
              value={{ date_from: autoLogFilters.date_from, date_to: autoLogFilters.date_to }}
              onChange={(r) => setAutoLogFilters((f) => ({ ...f, date_from: r.date_from, date_to: r.date_to }))}
              placeholder="Filtrar por fecha"
            />
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Conductor</label>
              <input
                type="text"
                value={autoLogFilters.driver}
                onChange={(e) => setAutoLogFilters((f) => ({ ...f, driver: e.target.value }))}
                placeholder="Nombre"
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-full min-w-[160px]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Estado</label>
              <select
                value={autoLogFilters.status}
                onChange={(e) => setAutoLogFilters((f) => ({ ...f, status: e.target.value }))}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm min-w-[120px]"
              >
                <option value="">Todos</option>
                <option value="success">Cobrado</option>
                <option value="failed">No cobrado</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() => fetchAutoLog(1)}
              className="px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] flex items-center gap-2"
            >
              <Search className="w-4 h-4" />
              Buscar
            </button>
          </div>
        </div>
        {autoLogLoading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-2 border-red-600 border-t-transparent" />
          </div>
        ) : (autoLog || []).length === 0 ? (
          <div className="bg-white rounded-xl shadow border border-gray-200 p-8 text-center">
            <FileText className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-bold text-gray-900 mb-2">No hay registros</h3>
            <p className="text-gray-600 text-sm">El job de cobro automático (15:41) genera el log aquí.</p>
          </div>
        ) : (
          <div className={`bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden transition-opacity ${autoLogPaginationLoading ? 'opacity-60' : ''}`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px]">
                <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Préstamo</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Fecha</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Conductor</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Flota</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-700 uppercase">Monto a cobrar</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-700 uppercase">Monto cobrado</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">Nº cuota</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Estado</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Razón</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(autoLog || []).filter(Boolean).map((row, idx) => (
                    <tr key={row?.id ?? `log-${idx}`} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm text-gray-600 font-mono">
                        {row?.loan_id ? (
                          <button
                            type="button"
                            onClick={() => handleCopyId(String(row.loan_id), 'ID préstamo copiado')}
                            className="flex items-center gap-1.5 group cursor-pointer hover:text-red-600 transition-colors text-left"
                            title="Click para copiar ID del préstamo"
                          >
                            <span>{String(row.loan_id).slice(0, 8)}…</span>
                            <Copy className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                          </button>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                        {row?.created_at ? formatDateTimeLocal(row.created_at, 'es-ES') : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">
                        {[row?.driver_first_name, row?.driver_last_name].filter(Boolean).join(' ') || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{row?.flota_name ?? row?.flota ?? '—'}</td>
                      <td className="px-4 py-3 text-sm text-right tabular-nums">S/ {Number(row?.amount_to_charge ?? 0).toFixed(2)}</td>
                      <td className="px-4 py-3 text-sm text-right tabular-nums text-green-700">S/ {Number(row?.amount_charged ?? 0).toFixed(2)}</td>
                      <td className="px-4 py-3 text-sm text-center">{row?.installment_number ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${row?.status === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                          {row?.status === 'success' ? 'Cobrado' : 'No cobrado'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-[220px]" title={row?.reason ?? undefined}>
                        {row?.reason ? (String(row.reason).length > 60 ? String(row.reason).slice(0, 60) + '…' : row.reason) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(autoLogPagination?.totalPages ?? 0) > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
                <span className="text-xs text-gray-500">
                  Total: {autoLogPagination.total} registro(s)
                  {autoLogPaginationLoading && <span className="ml-2 text-red-600">Cargando...</span>}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => fetchAutoLog(autoLogPagination.page - 1, true)}
                    disabled={autoLogPagination.page <= 1 || autoLogPaginationLoading}
                    className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-sm text-gray-700 px-2">Pág. {autoLogPagination.page} de {autoLogPagination.totalPages}</span>
                  <button
                    type="button"
                    onClick={() => fetchAutoLog(autoLogPagination.page + 1, true)}
                    disabled={autoLogPagination.page >= autoLogPagination.totalPages || autoLogPaginationLoading}
                    className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal confirmar aprobación */}
      {confirmApproveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full border border-gray-200">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-lg font-bold text-white">Confirmar aprobación</h2>
              <button
                onClick={() => setConfirmApproveModal(null)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5">
              <p className="text-gray-700 text-sm">
                ¿Aprobar este comprobante? Se registrará el pago y se actualizarán las cuotas del préstamo.
              </p>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200">
              <button
                onClick={() => setConfirmApproveModal(null)}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleReviewVoucher(confirmApproveModal, 'approved')}
                className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold text-sm flex items-center gap-2"
              >
                <CheckCircle className="w-4 h-4" />
                Aprobar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de rechazo */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full border border-gray-200">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-lg font-bold text-white">Confirmar rechazo</h2>
              <button
                onClick={() => setRejectModal(null)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-gray-700 text-sm">
                ¿Rechazar este comprobante? El conductor podrá subir uno nuevo.
              </p>
              <div>
                <label htmlFor="reject-reason" className="block text-sm font-semibold text-gray-900 mb-2">
                  Motivo del rechazo (opcional)
                </label>
              <input
                id="reject-reason"
                type="text"
                value={rejectModal.reason}
                onChange={(e) => setRejectModal({ ...rejectModal, reason: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
                placeholder="Indica el motivo para el conductor"
              />
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200">
              <button
                onClick={() => setRejectModal(null)}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleReviewVoucher(rejectModal.voucherId, 'rejected', rejectModal.reason)}
                className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold text-sm flex items-center gap-2"
              >
                <XCircle className="w-4 h-4" />
                Confirmar rechazo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal ver comprobante (usado en Pagos registrados y en Comprobantes por validar) */}
      {viewFileModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-60" onClick={() => { URL.revokeObjectURL(viewFileModal.url); setViewFileModal(null); }}>
          <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center p-3 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <h2 className="text-lg font-bold text-white">Comprobante</h2>
              <button
                type="button"
                onClick={() => { URL.revokeObjectURL(viewFileModal.url); setViewFileModal(null); }}
                className="text-white hover:text-gray-200 transition-colors p-1"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-gray-100 flex items-center justify-center min-h-[300px]">
              {viewFileModal.type.startsWith('image/') ? (
                <img src={viewFileModal.url} alt="Comprobante" className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-md" />
              ) : viewFileModal.type === 'application/pdf' ? (
                <iframe src={viewFileModal.url} title="Comprobante" className="w-full min-h-[70vh] rounded-lg border-0" />
              ) : (
                <img src={viewFileModal.url} alt="Comprobante" className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-md" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Payments;







