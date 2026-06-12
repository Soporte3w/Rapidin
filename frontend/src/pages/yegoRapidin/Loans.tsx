import { useState, useEffect, useCallback, useRef } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { RapidinSearchField } from '../../components/RapidinSearchField';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../../services/api';
import { isAxiosAbortError } from '../../utils/miautoApiUtils';
import {
  Eye,
  FileText,
  DollarSign,
  AlertCircle,
  CheckCircle,
  XCircle,
  Copy,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Loader2,
  X,
  Users,
  Building2,
  Upload,
  Trash2,
  ExternalLink,
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

const PAGE_SIZES = [5, 10, 20, 50];

const Loans = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [tab, setTab] = useState<'conductores' | 'personal'>('conductores');
  const searchState = location.state as LoansSearchState | null;
  const isReturnFromDetail = Boolean(searchState?.fromLoanDetail);
  const initialDriver = isReturnFromDetail ? (searchState?.driverSearchInput ?? searchState?.driver ?? '') : '';
  const initialLoanId = isReturnFromDetail ? (searchState?.loanIdSearchInput ?? searchState?.loan_id ?? '') : '';

  const [loans, setLoans] = useState<Loan[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    status: isReturnFromDetail ? (searchState?.status ?? '') : '',
    country: isReturnFromDetail ? (searchState?.country ?? '') : '',
    date_from: isReturnFromDetail ? (searchState?.date_from ?? '') : '',
    date_to: isReturnFromDetail ? (searchState?.date_to ?? '') : '',
  });
  const [driverSearchInput, setDriverSearchInput] = useState(initialDriver);
  const [loanIdSearchInput, setLoanIdSearchInput] = useState(initialLoanId);
  const debouncedDriver = useDebouncedValue(driverSearchInput, 400);
  const debouncedLoanId = useDebouncedValue(loanIdSearchInput, 400);
  const [page, setPage] = useState(isReturnFromDetail && searchState?.page != null ? searchState.page : 1);
  const [pageSize, setPageSize] = useState(isReturnFromDetail && searchState?.limit != null ? searchState.limit : 10);
  const returnConsumedRef = useRef(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportModalFilters, setExportModalFilters] = useState({
    date_from: '',
    date_to: '',
    country: '',
  });

  const [personalCredits, setPersonalCredits] = useState<any[]>([]);
  const [personalLoading, setPersonalLoading] = useState(false);
  const [personalPage, setPersonalPage] = useState(1);
  const [personalTotal, setPersonalTotal] = useState(0);
  const [personalSearch, setPersonalSearch] = useState('');
  const [personalStatus, setPersonalStatus] = useState('active');
  const debouncedPersonalSearch = useDebouncedValue(personalSearch, 400);
  const personalPageSize = 10;

  const searchKey = `${debouncedDriver}\0${debouncedLoanId}`;
  const prevSearchKeyRef = useRef(searchKey);

  const handleDownloadConstancia = async (loanId: string) => {
    try {
      const response = await api.get(`/constancias/loan/${loanId}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      const disposition = response.headers['content-disposition'];
      let fileName = `constancia_${loanId}.docx`;
      if (disposition) {
        const match = disposition.match(/filename="?(.+?)"?$/);
        if (match) fileName = match[1];
      }
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      toast.success('Constancia descargada');
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al descargar la constancia');
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingUploadLoanId, setPendingUploadLoanId] = useState<string | null>(null);
  const [uploadingConstancia, setUploadingConstancia] = useState(false);
  const [constanciasMap, setConstanciasMap] = useState<Record<string, any[]>>({});
  const [deletingDocIds, setDeletingDocIds] = useState<Set<string>>(new Set());
  const [pendingUploadFile, setPendingUploadFile] = useState<File | null>(null);
  const [showUploadConfirm, setShowUploadConfirm] = useState(false);
  const [docToDelete, setDocToDelete] = useState<{ id: string; name: string; loanId: string } | null>(null);

  const handleUploadConstanciaClick = (loanId: string) => {
    setPendingUploadLoanId(loanId);
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !pendingUploadLoanId) {
      e.target.value = '';
      return;
    }
    setPendingUploadFile(file);
    setShowUploadConfirm(true);
    e.target.value = '';
  };

  const confirmUpload = async () => {
    if (!pendingUploadFile || !pendingUploadLoanId) {
      setShowUploadConfirm(false);
      setPendingUploadFile(null);
      setPendingUploadLoanId(null);
      return;
    }
    setUploadingConstancia(true);
    try {
      const fd = new FormData();
      fd.append('file', pendingUploadFile);
      await api.post(`/constancias/loan/${pendingUploadLoanId}/upload`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Constancia subida exitosamente');
      fetchConstancias();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al subir la constancia');
    } finally {
      setUploadingConstancia(false);
      setShowUploadConfirm(false);
      setPendingUploadLoanId(null);
      setPendingUploadFile(null);
    }
  };

  const cancelUpload = () => {
    if (uploadingConstancia) return;
    setShowUploadConfirm(false);
    setPendingUploadFile(null);
    setPendingUploadLoanId(null);
  };

  const fetchConstancias = async () => {
    if (loans.length === 0) {
      setConstanciasMap({});
      return;
    }
    try {
      const ids = loans.map((l) => l.id);
      const res = await api.post('/constancias/loans/documents', { loan_ids: ids });
      setConstanciasMap((res.data?.data ?? res.data) || {});
    } catch {
      setConstanciasMap({});
    }
  };

  const handleDeleteConstancia = (docId: string, loanId: string, docName: string) => {
    setDocToDelete({ id: docId, loanId, name: docName });
  };

  const confirmDelete = async () => {
    if (!docToDelete) return;
    setDeletingDocIds((prev) => new Set(prev).add(docToDelete.id));
    try {
      await api.delete(`/constancias/documents/${docToDelete.id}`);
      toast.success('Constancia eliminada');
      setConstanciasMap((prev) => {
        const next = { ...prev };
        if (next[docToDelete.loanId]) {
          next[docToDelete.loanId] = next[docToDelete.loanId].filter((d: any) => d.id !== docToDelete.id);
          if (next[docToDelete.loanId].length === 0) delete next[docToDelete.loanId];
        }
        return next;
      });
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al eliminar la constancia');
    } finally {
      setDeletingDocIds((prev) => {
        const next = new Set(prev);
        next.delete(docToDelete.id);
        return next;
      });
      setDocToDelete(null);
    }
  };

  useEffect(() => {
    if (prevSearchKeyRef.current !== searchKey) {
      prevSearchKeyRef.current = searchKey;
      setPage(1);
    }
  }, [searchKey]);

  const totalPages = Math.max(1, Math.ceil(serverTotal / pageSize) || 1);
  const pageClamped = Math.min(Math.max(1, page), totalPages);

  useEffect(() => {
    if (page !== pageClamped) setPage(pageClamped);
  }, [page, pageClamped]);

  const fetchLoansPage = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoading(true);
        setError('');
        const params = new URLSearchParams();
        params.append('page', String(page));
        params.append('limit', String(pageSize));
        if (filters.status) params.append('status', filters.status);
        if (filters.country) params.append('country', filters.country);
        if (filters.date_from) params.append('date_from', filters.date_from);
        if (filters.date_to) params.append('date_to', filters.date_to);
        const dq = debouncedDriver.trim();
        if (dq) params.append('driver', dq);
        const lq = debouncedLoanId.trim();
        if (lq) params.append('loan_id', lq);

        const response = await api.get(`/loans?${params.toString()}`, {
          signal,
          headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        });
        if (signal?.aborted) return;

        const pag = response.data?.pagination;
        const total = typeof pag?.total === 'number' ? pag.total : 0;
        setServerTotal(total);

        let chunk: Loan[] = [];
        const raw = response.data?.data ?? response.data;
        if (Array.isArray(raw)) chunk = raw;
        else if (raw?.data && Array.isArray(raw.data)) chunk = raw.data;
        else if (response.data?.rows && Array.isArray(response.data.rows)) chunk = response.data.rows;
        setLoans(chunk);
      } catch (err: unknown) {
        if (isAxiosAbortError(err)) return;
        console.error('Error fetching loans:', err);
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
          'Error al cargar los préstamos';
        setError(msg);
        setLoans([]);
        setServerTotal(0);
      } finally {
        if (signal?.aborted) return;
        setLoading(false);
      }
    },
    [page, pageSize, filters.status, filters.country, filters.date_from, filters.date_to, debouncedDriver, debouncedLoanId]
  );

  useEffect(() => {
    const ac = new AbortController();
    const st = location.state as LoansSearchState | null;
    if (!returnConsumedRef.current && Boolean(st?.fromLoanDetail)) {
      returnConsumedRef.current = true;
      setPage(st?.page ?? 1);
      setPageSize(st?.limit ?? 10);
      navigate(location.pathname, { replace: true, state: {} });
    }
    // Siempre cargar: antes se hacía return temprano y, si page/pathname no cambiaban,
    // el efecto no se re-ejecutaba y la lista quedaba vacía al volver del detalle.
    void fetchLoansPage(ac.signal);
    return () => ac.abort();
  }, [fetchLoansPage, navigate, location.pathname]);

  useEffect(() => {
    fetchConstancias();
  }, [loans]);

  const fetchPersonalCredits = useCallback(async () => {
    setPersonalLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('page', String(personalPage));
      params.append('limit', String(personalPageSize));
      if (debouncedPersonalSearch.trim()) params.append('q', debouncedPersonalSearch.trim());
      if (personalStatus) params.append('status', personalStatus);
      const res = await api.get(`/creditos-personal-yego?${params.toString()}`);
      const data = res.data?.data || [];
      setPersonalCredits(Array.isArray(data) ? data : []);
      setPersonalTotal(res.data?.pagination?.total || 0);
    } catch {
      setPersonalCredits([]);
      setPersonalTotal(0);
    } finally {
      setPersonalLoading(false);
    }
  }, [personalPage, debouncedPersonalSearch, personalStatus]);

  useEffect(() => {
    if (tab === 'personal') fetchPersonalCredits();
  }, [tab, fetchPersonalCredits]);

  useEffect(() => {
    if (tab === 'personal') setPersonalPage(1);
  }, [debouncedPersonalSearch, personalStatus, tab]);

  const personalTotalPages = Math.max(1, Math.ceil(personalTotal / personalPageSize));

  const [detailModal, setDetailModal] = useState<{ open: boolean; credito: any }>({ open: false, credito: null });
  const [changingStatusId, setChangingStatusId] = useState<string | null>(null);
  const [moraConfirmModal, setMoraConfirmModal] = useState<{ cuotaId: string; diasAtraso: number; mora: number; pendiente: number } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await api.get(`/creditos-personal-yego/${id}`);
      setDetailModal({ open: true, credito: res.data?.data || null });
    } catch {
      toast.error('Error al cargar detalles');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCuotaStatusChange = async (cuotaId: string, newStatus: string) => {
    if (newStatus === 'paid') {
      try {
        const res = await api.get(`/creditos-personal-yego/cuotas/${cuotaId}/mora`);
        const { diasAtraso, mora, pendiente } = res.data?.data || {};
        if (diasAtraso > 0 && mora > 0.01) {
          setMoraConfirmModal({ cuotaId, diasAtraso, mora, pendiente });
          return;
        }
      } catch {
        toast.error('Error al calcular mora');
        return;
      }
    }
    await doStatusChange(cuotaId, newStatus);
  };

  const doStatusChange = async (cuotaId: string, newStatus: string) => {
    setChangingStatusId(cuotaId);
    try {
      await api.put(`/creditos-personal-yego/cuotas/${cuotaId}/estado`, { status: newStatus });
      toast.success('Estado actualizado');
      if (detailModal.credito?.id) {
        const res = await api.get(`/creditos-personal-yego/${detailModal.credito.id}`);
        setDetailModal({ open: true, credito: res.data?.data || null });
      }
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al actualizar estado');
    } finally {
      setChangingStatusId(null);
    }
  };

  const confirmMoraAndPay = async (cuotaId: string) => {
    const moraAmount = moraConfirmModal?.mora || 0;
    setMoraConfirmModal(null);
    setChangingStatusId(cuotaId);
    try {
      await api.put(`/creditos-personal-yego/cuotas/${cuotaId}/estado`, { status: 'paid', mora: moraAmount });
      toast.success('Cuota pagada con mora');
      if (detailModal.credito?.id) {
        const res = await api.get(`/creditos-personal-yego/${detailModal.credito.id}`);
        setDetailModal({ open: true, credito: res.data?.data || null });
      }
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setChangingStatusId(null);
    }
  };

  const confirmPayWithoutMora = async (cuotaId: string) => {
    setMoraConfirmModal(null);
    await doStatusChange(cuotaId, 'paid');
  };

  const handleUploadDoc = async (creditoId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.post(`/creditos-personal-yego/${creditoId}/documentos`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Documento subido. Crédito activado.');
      fetchPersonalCredits();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al subir documento');
    }
  };

  const goToPage = (p: number) => {
    const tp = Math.max(1, Math.ceil(serverTotal / pageSize) || 1);
    setPage(Math.max(1, Math.min(p, tp)));
  };

  const handleLimitChange = (newLimit: number) => {
    setPageSize(newLimit);
    setPage(1);
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
    if (dateCountry.date_from) params.append('date_from', dateCountry.date_from);
    if (dateCountry.date_to) params.append('date_to', dateCountry.date_to);
    return params;
  };

  const openExportModal = () => {
    if (tab === 'personal') {
      exportPersonalExcel();
      return;
    }
    setExportModalFilters({
      date_from: filters.date_from,
      date_to: filters.date_to,
      country: filters.country,
    });
    setExportModalOpen(true);
  };

  const exportPersonalExcel = async () => {
    if (exportLoading) return;
    const toastId = toast.loading('Generando Excel...');
    setExportLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('limit', '1000');
      if (debouncedPersonalSearch.trim()) params.append('q', debouncedPersonalSearch.trim());
      if (personalStatus) params.append('status', personalStatus);
      const res = await api.get(`/creditos-personal-yego?${params.toString()}`);
      const rows = res.data?.data || [];

      const header = ['Trabajador', 'DNI', 'Rol', 'Monto', 'Interes', 'Total', 'Cuotas', 'Banco', 'Cuenta', 'Estado', 'Creado'];
      const data = rows.map((r: any) => [
        `${r.first_name} ${r.last_name}`,
        r.dni,
        r.role || '',
        parseFloat(r.amount).toFixed(2),
        `${r.interest_rate}%`,
        parseFloat(r.total_amount).toFixed(2),
        r.number_of_installments,
        r.bank_name || '',
        r.bank_account || '',
        r.status === 'active' ? 'Activo' : r.status === 'cancelled' ? 'Cancelado' : r.status,
        r.created_at ? r.created_at.slice(0, 10) : '',
      ]);

      writeRapidinLoansStyledExcel(header, data, [], [], `creditos-personal-yego-${format(new Date(), 'yyyy-MM-dd')}.xlsx`);
      toast.success('Excel descargado', { id: toastId });
    } catch {
      toast.error('Error al generar Excel', { id: toastId });
    } finally {
      setExportLoading(false);
    }
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

  const hasServerFilters = Boolean(
    filters.status ||
      filters.country ||
      filters.date_from ||
      filters.date_to ||
      debouncedDriver.trim() ||
      debouncedLoanId.trim()
  );

  if (loading && loans.length === 0) {
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
          type="button"
          onClick={() => void fetchLoansPage()}
          className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-lg font-medium hover:from-red-700 hover:to-red-800 transition-all shadow-md"
        >
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.pdf"
        className="hidden"
        onChange={handleFileSelect}
      />
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
            title={tab === 'personal' ? 'Descargar Excel de Créditos Yego' : 'Descargar Excel (elegir fecha y país)'}
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

      <div className="flex rounded-lg bg-gray-100 p-1 w-fit">
        <button
          type="button"
          onClick={() => setTab('conductores')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === 'conductores' ? 'bg-white text-gray-900 shadow' : 'text-gray-600 hover:text-gray-900'}`}
        >
          <Users className="w-4 h-4" />
          Conductores
        </button>
        <button
          type="button"
          onClick={() => setTab('personal')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === 'personal' ? 'bg-white text-gray-900 shadow' : 'text-gray-600 hover:text-gray-900'}`}
        >
          <Building2 className="w-4 h-4" />
          Crédito Yego
        </button>
      </div>

      {tab === 'personal' ? (
        <>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={personalSearch}
            onChange={(e) => setPersonalSearch(e.target.value)}
            placeholder="Buscar por nombre o DNI..."
            className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 w-full sm:w-72"
          />
          <select
            value={personalStatus}
            onChange={(e) => setPersonalStatus(e.target.value)}
            className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500"
          >
            <option value="">Todos los estados</option>
            <option value="pending">Pendiente</option>
            <option value="active">Activo</option>
            <option value="cancelled">Cancelado</option>
            <option value="paid">Pagado</option>
          </select>
        </div>
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Trabajador</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">DNI</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Monto</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Interés</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Total</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Cuotas</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600">Doc</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Estado</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600"></th>
                </tr>
              </thead>
              <tbody>
                {personalLoading ? (
                  <tr><td colSpan={9} className="text-center py-12 text-gray-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></td></tr>
                ) : personalCredits.length === 0 ? (
                  <tr><td colSpan={9} className="text-center py-12 text-gray-400">Sin créditos registrados</td></tr>
                ) : (
                  personalCredits.map((c: any) => (
                    <tr key={c.id} className="border-b hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">{c.first_name} {c.last_name}</td>
                      <td className="px-4 py-3 text-gray-500">{c.dni}</td>
                      <td className="px-4 py-3">S/ {parseFloat(c.amount).toFixed(2)}</td>
                      <td className="px-4 py-3">{c.interest_rate}%{c.frecuencia_pago === 'semanal' ? ' sem' : ''}</td>
                      <td className="px-4 py-3 font-semibold">S/ {parseFloat(c.total_amount).toFixed(2)}</td>
                      <td className="px-4 py-3">{c.number_of_installments} {c.frecuencia_pago === 'semanal' ? (c.number_of_installments === 1 ? 'semana' : 'semanas') : (c.number_of_installments === 1 ? 'mes' : 'meses')}</td>
                      <td className="px-4 py-3 text-center">
                        {(c.doc_count > 0 && c.doc_file_path) ? (
                          <button onClick={() => window.open(c.doc_file_path, '_blank')} className="text-blue-600 hover:text-blue-800" title="Ver documento">
                            <FileText className="w-5 h-5" />
                          </button>
                        ) : c.doc_count > 0 ? (
                          <FileText className="w-5 h-5 text-green-600" />
                        ) : (
                          <label className="cursor-pointer text-gray-400 hover:text-blue-600" title="Subir compromiso">
                            <Upload className="w-4 h-4" />
                            <input type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden" onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleUploadDoc(c.id, f);
                            }} />
                          </label>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.status === 'active' ? 'bg-green-100 text-green-700' : c.status === 'pending' ? 'bg-yellow-100 text-yellow-700' : c.status === 'cancelled' ? 'bg-gray-100 text-gray-600' : 'bg-red-50 text-red-600'}`}>
                          {c.status === 'active' ? 'Activo' : c.status === 'pending' ? 'Pendiente' : c.status === 'cancelled' ? 'Cancelado' : c.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={async () => {
                              try {
                                const res = await api.get(`/creditos-personal-yego/${c.id}/compromiso-word`, { responseType: 'blob' });
                                const url = window.URL.createObjectURL(new Blob([res.data]));
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = `Compromiso_Pago_${c.first_name}_${c.last_name}_${c.dni}.docx`;
                                a.click();
                                window.URL.revokeObjectURL(url);
                              } catch { toast.error('Error al descargar'); }
                            }}
                            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg"
                            title="Descargar Word"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <button onClick={() => openDetail(c.id)} className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Ver detalles">
                            <Eye className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {personalTotal > personalPageSize && (
            <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
              <span className="text-sm text-gray-500">{personalTotal} resultados</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setPersonalPage(1)} disabled={personalPage === 1} className="p-1.5 rounded hover:bg-gray-200 disabled:opacity-30"><ChevronsLeft className="w-4 h-4" /></button>
                <button onClick={() => setPersonalPage(p => Math.max(1, p - 1))} disabled={personalPage === 1} className="p-1.5 rounded hover:bg-gray-200 disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
                <span className="text-sm px-2">{personalPage} / {personalTotalPages}</span>
                <button onClick={() => setPersonalPage(p => Math.min(personalTotalPages, p + 1))} disabled={personalPage === personalTotalPages} className="p-1.5 rounded hover:bg-gray-200 disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
                <button onClick={() => setPersonalPage(personalTotalPages)} disabled={personalPage === personalTotalPages} className="p-1.5 rounded hover:bg-gray-200 disabled:opacity-30"><ChevronsRight className="w-4 h-4" /></button>
              </div>
            </div>
          )}
        </div>

        {detailModal.open && detailModal.credito && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={() => setDetailModal({ open: false, credito: null })}>
            <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-4 border-b bg-gradient-to-r from-red-700 to-red-600 rounded-t-xl">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-white/20 rounded-lg flex items-center justify-center">
                    <Building2 className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-bold text-white">Crédito Personal Yego</h3>
                    <p className="text-xs text-red-200">{detailModal.credito.frecuencia_pago === 'semanal' ? 'Semanal' : 'Mensual'} · {detailModal.credito.tasa_interes != null ? detailModal.credito.tasa_interes : detailModal.credito.interest_rate}%</p>
                  </div>
                </div>
                <button onClick={() => setDetailModal({ open: false, credito: null })} className="p-2 text-white/70 hover:text-white hover:bg-white/10 rounded-lg transition"><X className="w-5 h-5" /></button>
              </div>
              <div className="p-5 space-y-5 overflow-y-auto">
                {detailLoading ? (
                  <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="bg-gray-50 rounded-xl border border-gray-100 p-4 space-y-2.5">
                        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Trabajador</span>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center text-sm font-bold text-red-700">
                            {detailModal.credito.first_name?.[0]}{detailModal.credito.last_name?.[0]}
                          </div>
                          <div>
                            <p className="font-semibold text-gray-900">{detailModal.credito.first_name} {detailModal.credito.last_name}</p>
                            <p className="text-xs text-gray-500">DNI {detailModal.credito.dni} · {detailModal.credito.role || '—'}</p>
                          </div>
                        </div>
                      </div>

                      <div className="bg-gray-50 rounded-xl border border-gray-100 p-4">
                        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Detalles</span>
                        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                          <div><span className="text-gray-500">Monto:</span> <span className="font-semibold">S/ {parseFloat(detailModal.credito.amount).toFixed(2)}</span></div>
                          <div><span className="text-gray-500">Interés:</span> <span className="font-semibold">{detailModal.credito.tasa_interes != null ? detailModal.credito.tasa_interes : detailModal.credito.interest_rate}%{detailModal.credito.frecuencia_pago === 'semanal' ? ' semanal' : ''}</span></div>
                          <div><span className="text-gray-500">Total:</span> <span className="font-semibold text-red-600">S/ {parseFloat(detailModal.credito.total_amount).toFixed(2)}</span></div>
                          <div><span className="text-gray-500">Cuotas:</span> <span className="font-semibold">{detailModal.credito.number_of_installments} {detailModal.credito.frecuencia_pago === 'semanal' ? (detailModal.credito.number_of_installments === 1 ? 'semana' : 'semanas') : (detailModal.credito.number_of_installments === 1 ? 'mes' : 'meses')}</span></div>
                          <div><span className="text-gray-500">Estado:</span> <span className="font-semibold">{detailModal.credito.status === 'active' ? 'Activo' : detailModal.credito.status === 'pending' ? 'Pendiente' : detailModal.credito.status === 'paid' ? 'Pagado' : detailModal.credito.status}</span></div>
                          <div><span className="text-gray-500">Primer cobro:</span> <span className="font-semibold">{detailModal.credito.fecha_primer_cobro ? new Date(detailModal.credito.fecha_primer_cobro).toLocaleDateString('es-PE') : '—'}</span></div>
                          <div><span className="text-gray-500">Creado:</span> <span className="font-semibold">{detailModal.credito.created_at?.slice(0, 10)}</span></div>
                        </div>
                      </div>
                    </div>

                    {detailModal.credito.cuotas && detailModal.credito.cuotas.length > 0 && (
                      <div>
                        <h4 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2">
                          <span className="w-1.5 h-4 bg-red-600 rounded-full"></span>
                          Cuotas
                        </h4>
                        <div className="border border-gray-200 rounded-lg overflow-hidden">
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50 border-b">
                              <tr>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">#</th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Vencimiento</th>
                                <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Monto</th>
                                <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500">Estado</th>
                                <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Mora</th>
                                <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Pago Final</th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Cambió</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detailModal.credito.cuotas.map((cuota: any) => (
                                <tr key={cuota.id} className="border-b last:border-0 hover:bg-gray-50/50 transition-colors">
                                  <td className="px-4 py-2.5 font-medium">{cuota.installment_number}</td>
                                  <td className="px-4 py-2.5 text-gray-500">{cuota.due_date?.slice(0, 10)}</td>
                                  <td className="px-4 py-2.5 text-right font-semibold">S/ {parseFloat(cuota.installment_amount).toFixed(2)}</td>
                                  <td className="px-4 py-2.5 text-center">
                                    <select
                                      value={cuota.status}
                                      onChange={(e) => handleCuotaStatusChange(cuota.id, e.target.value)}
                                      disabled={changingStatusId === cuota.id}
                                      className={`text-xs border rounded-lg px-2 py-1 font-medium transition-colors ${
                                        changingStatusId === cuota.id ? 'opacity-50 cursor-wait' : 'cursor-pointer'
                                      } ${
                                        cuota.status === 'paid' ? 'bg-green-50 border-green-300 text-green-700' :
                                        cuota.status === 'overdue' ? 'bg-red-50 border-red-300 text-red-600' :
                                        'bg-gray-50 border-gray-300 text-gray-600'
                                      }`}
                                    >
                                      <option value="pending">Pendiente</option>
                                      <option value="paid">Pagada</option>
                                      <option value="overdue">Vencida</option>
                                    </select>
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-xs">
                                    {(() => {
                                      const lateFee = parseFloat(cuota.late_fee || 0);
                                      if (lateFee <= 0.005) return <span className="text-gray-400">—</span>;
                                      if (cuota.status === 'paid') {
                                        const paid = parseFloat(cuota.paid_amount || 0);
                                        const cuotaMonto = parseFloat(cuota.installment_amount);
                                        if (paid >= cuotaMonto + lateFee - 0.02) {
                                          return <span className="text-red-600 font-medium">S/ {lateFee.toFixed(2)}</span>;
                                        }
                                        return <span className="text-gray-400">S/ {lateFee.toFixed(2)} <span className="text-[10px]">(no cobrado)</span></span>;
                                      }
                                      return <span className="text-red-600 font-medium">S/ {lateFee.toFixed(2)}</span>;
                                    })()}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-xs">
                                    {cuota.status === 'paid' ? (
                                      <span className="font-semibold text-gray-900">
                                        S/ {parseFloat(cuota.paid_amount || 0).toFixed(2)}
                                        {(() => {
                                          const lateFee = parseFloat(cuota.late_fee || 0);
                                          if (lateFee <= 0.005) return null;
                                          const paid = parseFloat(cuota.paid_amount || 0);
                                          const cuotaMonto = parseFloat(cuota.installment_amount);
                                          if (paid >= cuotaMonto + lateFee - 0.02) {
                                            return <span className="text-red-500 text-[10px] ml-1">(con mora)</span>;
                                          }
                                          return <span className="text-gray-400 text-[10px] ml-1">(sin mora)</span>;
                                        })()}
                                      </span>
                                    ) : (
                                      <span className="text-gray-400">—</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-2.5 text-gray-400 text-xs">{cuota.updated_by_name || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {detailModal.credito.documentos && detailModal.credito.documentos.length > 0 && (
                      <div>
                        <h4 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2">
                          <span className="w-1.5 h-4 bg-red-600 rounded-full"></span>
                          Documento
                        </h4>
                        {(() => {
                          const docs = detailModal.credito.documentos;
                          const url = docs[0].file_path || '';
                          const fileName = docs[0].file_name || 'Documento';
                          return (
                            <div className="bg-gray-50 rounded-xl border border-gray-100 p-4 flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center">
                                  <ExternalLink className="w-5 h-5 text-red-600" />
                                </div>
                                <div>
                                  <p className="font-medium text-gray-900 text-sm">{fileName}</p>
                                  <p className="text-xs text-gray-400">Compromiso de pago</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <a href={url} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 transition inline-flex items-center gap-1">
                                  <Eye className="w-3.5 h-3.5" /> Ver
                                </a>
                                <a href={url} download={fileName} className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition inline-flex items-center gap-1">
                                  <Download className="w-3.5 h-3.5" /> Descargar
                                </a>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="flex items-center justify-end px-5 py-4 border-t bg-gray-50 rounded-b-xl">
                <button onClick={() => setDetailModal({ open: false, credito: null })} className="px-5 py-2.5 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm font-medium transition">
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        )}

        {moraConfirmModal && createPortal(
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/50" onClick={() => setMoraConfirmModal(null)}>
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-4 border-b bg-red-50">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-red-600" />
                  <h3 className="text-lg font-semibold text-gray-900">¿Cobrar mora?</h3>
                </div>
                <button onClick={() => setMoraConfirmModal(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-5 space-y-3">
                <p className="text-sm text-gray-600">
                  Esta cuota tiene <span className="font-semibold text-red-600">{moraConfirmModal.diasAtraso} día(s)</span> de atraso.
                </p>
                <div className="bg-gray-50 rounded-lg p-3 space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-gray-500">Cuota:</span><span className="font-semibold">S/ {moraConfirmModal.pendiente.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Mora:</span><span className="font-semibold text-red-600">S/ {moraConfirmModal.mora.toFixed(2)}</span></div>
                  <div className="border-t border-gray-200 pt-2 flex justify-between">
                    <span className="text-gray-700 font-semibold">Pago Final:</span>
                    <span className="font-bold text-gray-900">S/ {(moraConfirmModal.pendiente + moraConfirmModal.mora).toFixed(2)}</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <button
                    onClick={() => confirmMoraAndPay(moraConfirmModal.cuotaId)}
                    className="w-full px-4 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium text-sm transition"
                  >
                    Sí, cobrar mora (S/ {(moraConfirmModal.pendiente + moraConfirmModal.mora).toFixed(2)})
                  </button>
                  <button
                    onClick={() => confirmPayWithoutMora(moraConfirmModal.cuotaId)}
                    className="w-full px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium text-sm transition"
                  >
                    No, solo cuota (S/ {moraConfirmModal.pendiente.toFixed(2)})
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

        </>
      ) : (
        <>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <RapidinSearchField
            id="loan_id"
            label="Buscar por ID de préstamo"
            value={loanIdSearchInput}
            onChange={setLoanIdSearchInput}
            placeholder="ID del préstamo (parcial o completo)"
            mono
            className="flex-1 min-w-0 min-w-[200px]"
          />
          <RapidinSearchField
            id="driver"
            label="Buscar por conductor"
            value={driverSearchInput}
            onChange={setDriverSearchInput}
            placeholder="Nombre, apellido o DNI"
            className="flex-1 min-w-0 min-w-[200px]"
          />
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
      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{serverTotal.toLocaleString('es-PE')}</span>
        <span className="text-sm text-gray-600">préstamos</span>
      </div>

      {/* Loans table */}
      {serverTotal === 0 && !loading ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 lg:p-12 text-center">
          <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <FileText className="w-10 h-10 text-gray-400" />
          </div>
          <h3 className="text-xl lg:text-2xl font-bold text-gray-900 mb-2">
            {hasServerFilters ? 'Sin resultados' : 'No hay préstamos disponibles'}
          </h3>
          <p className="text-gray-600 mb-6 text-base">
            {hasServerFilters
              ? 'Prueba otros filtros de estado, país, fechas o búsqueda por conductor o ID.'
              : 'No hay préstamos en el sistema con los criterios actuales.'}
          </p>
        </div>

      ) : (
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden relative">
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
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => navigate(`/admin/loans/${loan.id}`, {
                            state: {
                              fromLoansSearch: true,
                              driverSearchInput,
                              loanIdSearchInput,
                              status: filters.status,
                              country: filters.country,
                              date_from: filters.date_from,
                              date_to: filters.date_to,
                              page: pageClamped,
                              limit: pageSize,
                            },
                          })}
                          className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200"
                          title="Ver detalles"
                        >
                          <Eye className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() => handleDownloadConstancia(loan.id)}
                          className="p-2 text-red-600 hover:text-red-900 hover:bg-red-50 rounded-lg transition-colors border border-gray-200"
                          title="Descargar Constancia"
                        >
                          <Download className="w-5 h-5" />
                        </button>
                        {(() => {
                          const docs = constanciasMap[loan.id];
                          if (!docs || docs.length === 0) {
                            return (
                              <button
                                onClick={() => handleUploadConstanciaClick(loan.id)}
                                disabled={uploadingConstancia}
                                className="p-2 text-green-600 hover:text-green-900 hover:bg-green-50 rounded-lg transition-colors border border-gray-200 disabled:opacity-50"
                                title="Subir Constancia (PDF o imagen)"
                              >
                                <Upload className="w-5 h-5" />
                              </button>
                            );
                          }
                          return docs.map((doc: any) => (
                            <div key={doc.id} className="flex items-center gap-0.5 border border-gray-200 rounded-lg">
                              <a
                                href={doc.file_path}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-2 text-blue-600 hover:text-blue-900 hover:bg-blue-50 rounded-l-lg transition-colors"
                                title={`Ver ${doc.file_name}`}
                              >
                                <ExternalLink className="w-5 h-5" />
                              </a>
                              <button
                                onClick={() => handleDeleteConstancia(doc.id, loan.id, doc.file_name)}
                                disabled={deletingDocIds.has(doc.id)}
                                className="p-2 text-red-600 hover:text-red-900 hover:bg-red-50 rounded-r-lg transition-colors border-l border-gray-200 disabled:opacity-50"
                                title="Eliminar constancia"
                              >
                                {deletingDocIds.has(doc.id) ? (
                                  <span className="inline-block w-5 h-5 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                                ) : (
                                  <Trash2 className="w-5 h-5" />
                                )}
                              </button>
                            </div>
                          ));
                        })()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>

          {serverTotal > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 pb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-500">Por página:</span>
                <select
                  value={pageSize}
                  onChange={(e) => handleLimitChange(Number(e.target.value))}
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
                  disabled={pageClamped <= 1}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Primera página"
                >
                  <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(pageClamped - 1)}
                  disabled={pageClamped <= 1}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum: number;
                      if (totalPages <= 5) pageNum = i + 1;
                      else if (pageClamped <= 3) pageNum = i + 1;
                      else if (pageClamped >= totalPages - 2) pageNum = totalPages - 4 + i;
                      else pageNum = pageClamped - 2 + i;
                      const isActive = pageClamped === pageNum;
                      return (
                        <button
                          key={pageNum}
                          type="button"
                          onClick={() => goToPage(pageNum)}
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
                  onClick={() => goToPage(pageClamped + 1)}
                  disabled={pageClamped >= totalPages}
                  className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Página siguiente"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(totalPages)}
                  disabled={pageClamped >= totalPages}
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
      </>)}
      {/* Modal Eliminar Constancia */}
      {docToDelete && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50" onClick={() => setDocToDelete(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gray-50">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 bg-red-600 rounded-lg flex items-center justify-center">
                  <Trash2 className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900">Eliminar constancia</h3>
              </div>
              <button type="button" onClick={() => setDocToDelete(null)} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600">¿Estás seguro de eliminar esta constancia?</p>
              <div className="bg-red-50 rounded-lg border border-red-200 p-3">
                <p className="text-sm font-medium text-gray-900 truncate">{docToDelete.name}</p>
              </div>
            </div>
            <div className="flex gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={() => setDocToDelete(null)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg font-medium hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deletingDocIds.has(docToDelete.id)}
                className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {deletingDocIds.has(docToDelete.id) ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      , document.body)}

      {/* Modal Confirmación de Subida */}
      {showUploadConfirm && pendingUploadFile && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50" onClick={cancelUpload}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gray-50">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 bg-red-600 rounded-lg flex items-center justify-center">
                  <FileText className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900">Confirmar subida</h3>
              </div>
              <button type="button" onClick={cancelUpload} disabled={uploadingConstancia} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 disabled:opacity-30">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600">¿Deseas subir la siguiente constancia?</p>
              <div className="bg-gray-50 rounded-lg border border-gray-200 p-3">
                <p className="text-sm font-medium text-gray-900 truncate">{pendingUploadFile.name}</p>
                <p className="text-xs text-gray-500 mt-1">{(pendingUploadFile.size / 1024).toFixed(1)} KB</p>
              </div>
            </div>
            <div className="flex gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={cancelUpload}
                disabled={uploadingConstancia}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmUpload}
                disabled={uploadingConstancia}
                className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {uploadingConstancia ? 'Subiendo...' : 'Subir'}
              </button>
            </div>
          </div>
        </div>
      , document.body)}
    </div>
  );
};

export default Loans;







