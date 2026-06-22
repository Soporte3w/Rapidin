import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { Eye, FileText, Calendar, AlertCircle, CheckCircle, Clock, XCircle, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Users, Building2, Loader2, Upload, Trash2, Download } from 'lucide-react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { RapidinSearchField } from '../../components/RapidinSearchField';
import { formatCurrency } from '../../utils/currency';
import { formatDateLocal } from '../../utils/date';
import { DateRangePicker } from '../../components/DateRangePicker';
import { isAxiosAbortError } from '../../utils/miautoApiUtils';

interface LoanRequest {
  id: string;
  dni: string;
  driver_first_name: string;
  driver_last_name: string;
  requested_amount: number;
  disbursed_amount?: number | null;
  cycle?: number | null;
  driver_cycle?: number | null;
  status: string;
  country: string;
  created_at: string;
  approved_at?: string | null;
  disbursed_at?: string | null;
  disbursed_at_display?: string | null;
}

export type LoanRequestsSearchState = {
  fromRequestDetail?: boolean;
  driver?: string;
  driverSearchInput?: string;
  status?: string;
  country?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
};

const PAGE_SIZES = [5, 10, 20, 50];

const LoanRequests = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [tab, setTab] = useState<'conductores' | 'personal'>('conductores');
  const searchState = location.state as LoanRequestsSearchState | null;
  const isReturnFromDetail = Boolean(searchState?.fromRequestDetail);
  const initialDriverInput = isReturnFromDetail ? (searchState?.driverSearchInput ?? searchState?.driver ?? '') : '';

  const [requests, setRequests] = useState<LoanRequest[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    status: isReturnFromDetail ? (searchState?.status ?? '') : '',
    country: isReturnFromDetail ? (searchState?.country ?? '') : '',
    date_from: isReturnFromDetail ? (searchState?.date_from ?? '') : '',
    date_to: isReturnFromDetail ? (searchState?.date_to ?? '') : '',
  });
  const [driverSearchInput, setDriverSearchInput] = useState(initialDriverInput);
  const debouncedDriver = useDebouncedValue(driverSearchInput, 400);
  const [page, setPage] = useState(isReturnFromDetail && searchState?.page != null ? searchState.page : 1);
  const [pageSize, setPageSize] = useState(isReturnFromDetail && searchState?.limit != null ? searchState.limit : 10);
  const returnConsumedRef = useRef(false);
  const prevDebouncedDriverRef = useRef(debouncedDriver);

  const totalPages = Math.max(1, Math.ceil(serverTotal / pageSize) || 1);
  const pageClamped = Math.min(Math.max(1, page), totalPages);

  useEffect(() => {
    if (page !== pageClamped) setPage(pageClamped);
  }, [page, pageClamped]);

  const driverQueryActive = debouncedDriver.trim().length >= 2;
  const hasServerFilters = Boolean(filters.status || filters.country || filters.date_from);

  const fetchRequestsPage = useCallback(
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

        const response = await api.get(`/loan-requests?${params.toString()}`, { signal });
        if (signal?.aborted) return;
        const pag = response.data?.pagination;
        const total = typeof pag?.total === 'number' ? pag.total : 0;
        setServerTotal(total);
        let chunk: LoanRequest[] = [];
        const raw = response.data?.data ?? response.data;
        if (Array.isArray(raw)) chunk = raw;
        else if (raw?.data && Array.isArray(raw.data)) chunk = raw.data;
        setRequests(chunk);
      } catch (err: unknown) {
        if (isAxiosAbortError(err)) return;
        console.error('Error fetching requests:', err);
        setError((err as any)?.response?.data?.message || 'Error al cargar solicitudes');
        setRequests([]);
        setServerTotal(0);
      } finally {
        if (signal?.aborted) return;
        setLoading(false);
      }
    },
    [page, pageSize, filters.status, filters.country, filters.date_from, filters.date_to, debouncedDriver]
  );

  useEffect(() => {
    const ac = new AbortController();
    const st = location.state as LoanRequestsSearchState | null;
    if (!returnConsumedRef.current && Boolean(st?.fromRequestDetail)) {
      returnConsumedRef.current = true;
      setPage(st?.page ?? 1);
      setPageSize(st?.limit ?? 10);
      navigate(location.pathname, { replace: true, state: {} });
    }
    void fetchRequestsPage(ac.signal);
    return () => ac.abort();
  }, [fetchRequestsPage, navigate, location.pathname]);

  useEffect(() => {
    if (prevDebouncedDriverRef.current !== debouncedDriver) {
      prevDebouncedDriverRef.current = debouncedDriver;
      setPage(1);
    }
  }, [debouncedDriver]);

  const goToPage = (p: number) => setPage(Math.max(1, Math.min(p, totalPages)));
  const handleLimitChange = (newLimit: number) => { setPageSize(newLimit); setPage(1); };

  const getStatusBadge = (status: string) => {
    const badges: Record<string, { color: string; icon: any; text: string }> = {
      pending: { color: 'bg-yellow-100 text-yellow-800', icon: Clock, text: 'Pendiente' },
      approved: { color: 'bg-blue-100 text-blue-800', icon: CheckCircle, text: 'Aprobado' },
      rejected: { color: 'bg-red-100 text-red-800', icon: XCircle, text: 'Rechazado' },
      signed: { color: 'bg-purple-100 text-purple-800', icon: CheckCircle, text: 'Firmado' },
      cancelled: { color: 'bg-gray-100 text-gray-800', icon: XCircle, text: 'Cancelado' },
      disbursed: { color: 'bg-green-100 text-green-800', icon: CheckCircle, text: 'Desembolsado' },
    };
    const badge = badges[status] || { color: 'bg-gray-100 text-gray-800', icon: AlertCircle, text: status };
    const Icon = badge.icon;
    return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.color}`}><Icon className="w-3 h-3" />{badge.text}</span>;
  };

  const countryName = !filters.country ? '' : filters.country === 'PE' ? 'Perú' : 'Colombia';

  // Personal credits state
  const [personalCredits, setPersonalCredits] = useState<any[]>([]);
  const [personalLoading, setPersonalLoading] = useState(false);
  const [personalPage, setPersonalPage] = useState(1);
  const [personalTotal, setPersonalTotal] = useState(0);
  const personalPageSize = 10;
  const [validateModal, setValidateModal] = useState<{ open: boolean; credito: any }>({ open: false, credito: null });
  const [approving, setApproving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; credito: any }>({ open: false, credito: null });
  const [deleting, setDeleting] = useState(false);
  const [deleteDocConfirm, setDeleteDocConfirm] = useState<{ open: boolean; credito: any }>({ open: false, credito: null });
  const [deletingDoc, setDeletingDoc] = useState(false);

  const fetchPersonalCredits = useCallback(async () => {
    setPersonalLoading(true);
    try {
      const res = await api.get(`/creditos-personal-yego?page=${personalPage}&limit=${personalPageSize}`);
      const data = res.data?.data || [];
      setPersonalCredits(Array.isArray(data) ? data : []);
      setPersonalTotal(res.data?.pagination?.total || 0);
    } catch { setPersonalCredits([]); setPersonalTotal(0); }
    finally { setPersonalLoading(false); }
  }, [personalPage]);

  useEffect(() => { if (tab === 'personal') fetchPersonalCredits(); }, [tab, fetchPersonalCredits]);
  const personalTotalPages = Math.max(1, Math.ceil(personalTotal / personalPageSize));

  const handleUploadDoc = async (creditoId: string, file: File) => {
    const fd = new FormData(); fd.append('file', file);
    try {
      await api.post(`/creditos-personal-yego/${creditoId}/documentos`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setPersonalCredits(prev => prev.map(c => c.id === creditoId ? { ...c, doc_count: 1, doc_file_path: '#' } : c));
      toast.success('Documento subido');
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error al subir'); }
  };

  const handleApprove = async () => {
    if (!validateModal.credito) return;
    setApproving(true);
    try {
      await api.post(`/creditos-personal-yego/${validateModal.credito.id}/aprobar`);
      setPersonalCredits(prev => prev.map(c => c.id === validateModal.credito.id ? { ...c, status: 'active' } : c));
      toast.success('Crédito aprobado');
      setValidateModal({ open: false, credito: null });
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setApproving(false); }
  };

  const handleDelete = async () => {
    if (!deleteConfirm.credito) return;
    setDeleting(true);
    try {
      await api.delete(`/creditos-personal-yego/${deleteConfirm.credito.id}`);
      setPersonalCredits(prev => prev.filter(c => c.id !== deleteConfirm.credito.id));
      setPersonalTotal(t => Math.max(0, t - 1));
      toast.success('Crédito eliminado');
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setDeleting(false); }
  };

  const handleDeleteDoc = async () => {
    if (!deleteDocConfirm.credito) return;
    setDeletingDoc(true);
    try {
      await api.delete(`/creditos-personal-yego/${deleteDocConfirm.credito.id}/documentos/all`);
      setPersonalCredits(prev => prev.map(c => c.id === deleteDocConfirm.credito.id ? { ...c, doc_count: 0, doc_file_path: null } : c));
      toast.success('Documento eliminado');
      setDeleteDocConfirm({ open: false, credito: null });
    } catch { toast.error('Error al eliminar documento'); }
    finally { setDeletingDoc(false); }
  };

  if (loading && requests.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-16 w-16 border-4 border-red-600 border-t-transparent mx-auto mb-4" />
        <p className="text-gray-600">Cargando solicitudes...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="bg-red-50 border-2 border-red-200 rounded-full p-4 mb-4"><AlertCircle className="w-12 h-12 text-red-600" /></div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Error al cargar</h3>
        <p className="text-gray-600 mb-4">{error}</p>
        <button onClick={() => { setPage(1); void fetchRequestsPage(); }} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700">Reintentar</button>
      </div>
    );
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center"><FileText className="w-5 h-5 text-white" /></div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white">Solicitudes de Préstamo</h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">Gestiona todas las solicitudes - {countryName || 'Todos los países'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex rounded-lg bg-gray-100 p-1 w-fit">
        <button onClick={() => setTab('conductores')} className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === 'conductores' ? 'bg-white text-gray-900 shadow' : 'text-gray-600 hover:text-gray-900'}`}><Users className="w-4 h-4" />Conductores</button>
        <button onClick={() => setTab('personal')} className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === 'personal' ? 'bg-white text-gray-900 shadow' : 'text-gray-600 hover:text-gray-900'}`}><Building2 className="w-4 h-4" />Crédito Yego</button>
      </div>

      {tab === 'personal' ? (
        <>
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
                  <th className="text-left px-4 py-3 font-semibold text-gray-600"></th>
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
                      <td className="px-4 py-3">{c.interest_rate}%{c.frecuencia_pago === 'semanal' ? ' sem' : c.frecuencia_pago === 'quincenal' ? ' quinc' : ''}</td>
                      <td className="px-4 py-3 font-semibold">S/ {parseFloat(c.total_amount).toFixed(2)}</td>
                      <td className="px-4 py-3">{c.number_of_installments} {c.frecuencia_pago === 'semanal' ? (c.number_of_installments === 1 ? 'semana' : 'semanas') : c.frecuencia_pago === 'quincenal' ? (c.number_of_installments === 1 ? 'quincena' : 'quincenas') : (c.number_of_installments === 1 ? 'mes' : 'meses')}</td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center gap-2 justify-center">
                          {c.doc_count > 0 ? (<>
                            <button onClick={() => window.open(c.doc_file_path, '_blank')} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg" title="Ver documento"><FileText className="w-4 h-4" /></button>
                            <button onClick={() => setDeleteDocConfirm({ open: true, credito: c })} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Eliminar documento"><XCircle className="w-4 h-4" /></button>
                          </>) : (
                            <label className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg cursor-pointer" title="Subir documento">
                              <Upload className="w-4 h-4" />
                              <input type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadDoc(c.id, f); }} />
                            </label>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.status === 'active' ? 'bg-green-100 text-green-700' : c.status === 'pending' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>
                          {c.status === 'active' ? 'Activo' : c.status === 'pending' ? 'Pendiente' : c.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button onClick={async () => {
                            try {
                              const res = await api.get(`/creditos-personal-yego/${c.id}/compromiso-word`, { responseType: 'blob' });
                              const url = window.URL.createObjectURL(new Blob([res.data]));
                              const a = document.createElement('a'); a.href = url;
                              a.download = `Compromiso_Pago_${c.first_name}_${c.last_name}_${c.dni}.docx`;
                              a.click(); window.URL.revokeObjectURL(url);
                            } catch { toast.error('Error al descargar'); }
                          }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg" title="Descargar Word"><Download className="w-4 h-4" /></button>
                          {c.status === 'pending' && c.doc_count > 0 && (
                            <button onClick={() => setValidateModal({ open: true, credito: c })} className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700">Validar</button>
                          )}
                          <button onClick={() => setDeleteConfirm({ open: true, credito: c })} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Eliminar"><Trash2 className="w-4 h-4" /></button>
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

        {validateModal.open && validateModal.credito && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={() => setValidateModal({ open: false, credito: null })}>
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-4 border-b"><h3 className="font-bold text-gray-900">Confirmar aprobación</h3></div>
              <div className="p-5 space-y-3 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Trabajador:</span><span className="font-semibold">{validateModal.credito.first_name} {validateModal.credito.last_name}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">DNI:</span><span className="font-semibold">{validateModal.credito.dni}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Monto:</span><span className="font-semibold">S/ {parseFloat(validateModal.credito.amount).toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Interés:</span><span className="font-semibold">{validateModal.credito.tasa_interes != null ? validateModal.credito.tasa_interes : validateModal.credito.interest_rate}%{validateModal.credito.frecuencia_pago === 'semanal' ? ' semanal' : validateModal.credito.frecuencia_pago === 'quincenal' ? ' quincenal' : ''}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Total:</span><span className="font-semibold">S/ {parseFloat(validateModal.credito.total_amount).toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Cuotas:</span><span className="font-semibold">{validateModal.credito.number_of_installments} {validateModal.credito.frecuencia_pago === 'semanal' ? (validateModal.credito.number_of_installments === 1 ? 'semana' : 'semanas') : validateModal.credito.frecuencia_pago === 'quincenal' ? (validateModal.credito.number_of_installments === 1 ? 'quincena' : 'quincenas') : (validateModal.credito.number_of_installments === 1 ? 'mes' : 'meses')}</span></div>
                <p className="text-xs text-gray-400 pt-2 text-center">Al aprobar, el crédito pasará a Activo y aparecerá en Préstamos</p>
              </div>
              <div className="flex border-t">
                <button onClick={() => !approving && setValidateModal({ open: false, credito: null })} disabled={approving} className="flex-1 px-4 py-3 text-gray-600 hover:bg-gray-50 rounded-bl-xl font-medium text-sm disabled:opacity-50">Cancelar</button>
                <button onClick={handleApprove} disabled={approving} className="flex-1 px-4 py-3 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 rounded-br-xl font-medium text-sm">
                  {approving ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : null}
                  {approving ? 'Aprobando...' : 'Aprobar'}
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteConfirm.open && deleteConfirm.credito && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" onClick={() => setDeleteConfirm({ open: false, credito: null })}>
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full" onClick={e => e.stopPropagation()}>
              <div className="p-6 text-center">
                <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-600" /></div>
                <h3 className="text-lg font-bold text-gray-900 mb-2">Eliminar crédito</h3>
                <p className="text-sm text-gray-500 mb-1">¿Estás seguro de eliminar el crédito de</p>
                <p className="font-semibold text-gray-900">{deleteConfirm.credito.first_name} {deleteConfirm.credito.last_name}</p>
                <p className="text-xs text-gray-400 mt-1">DNI {deleteConfirm.credito.dni} · S/ {parseFloat(deleteConfirm.credito.amount).toFixed(2)}</p>
                <p className="text-xs text-red-500 mt-3">Esta acción no se puede deshacer</p>
              </div>
              <div className="flex border-t">
                <button onClick={() => !deleting && setDeleteConfirm({ open: false, credito: null })} disabled={deleting} className="flex-1 px-4 py-3 text-gray-600 hover:bg-gray-50 rounded-bl-xl font-medium text-sm disabled:opacity-50">Cancelar</button>
                <button onClick={handleDelete} disabled={deleting} className="flex-1 px-4 py-3 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 rounded-br-xl font-medium text-sm">{deleting ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : null}{deleting ? 'Eliminando...' : 'Eliminar'}</button>
              </div>
            </div>
          </div>
        )}

        {deleteDocConfirm.open && deleteDocConfirm.credito && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" onClick={() => setDeleteDocConfirm({ open: false, credito: null })}>
            <div className="bg-white rounded-xl shadow-xl max-w-sm w-full" onClick={e => e.stopPropagation()}>
              <div className="p-6 text-center">
                <div className="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4"><FileText className="w-7 h-7 text-amber-600" /></div>
                <h3 className="text-lg font-bold text-gray-900 mb-2">Eliminar documento</h3>
                <p className="text-sm text-gray-500">¿Eliminar el compromiso de pago de</p>
                <p className="font-semibold text-gray-900 mt-1">{deleteDocConfirm.credito.first_name} {deleteDocConfirm.credito.last_name}</p>
                <p className="text-xs text-gray-400 mt-2">Podrás subir otro documento después</p>
              </div>
              <div className="flex border-t">
                <button onClick={() => !deletingDoc && setDeleteDocConfirm({ open: false, credito: null })} className="flex-1 px-4 py-3 text-gray-600 hover:bg-gray-50 rounded-bl-xl font-medium text-sm disabled:opacity-50" disabled={deletingDoc}>Cancelar</button>
                <button onClick={handleDeleteDoc} disabled={deletingDoc} className="flex-1 px-4 py-3 bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 rounded-br-xl font-medium text-sm">
                  {deletingDoc ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : null}
                  {deletingDoc ? 'Eliminando...' : 'Eliminar'}
                </button>
              </div>
            </div>
          </div>
        )}

        </>
      ) : (
        <div className="space-y-4 lg:space-y-6">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex flex-col sm:flex-row gap-4 flex-wrap">
          <RapidinSearchField id="driver" label="Buscar por conductor" value={driverSearchInput} onChange={setDriverSearchInput} placeholder="Nombre, apellido o DNI" className="flex-1 min-w-0 min-w-[200px]" />
          <div className="flex-1 min-w-[150px]"><label htmlFor="status" className="block text-xs font-semibold text-gray-900 mb-1.5">Estado</label>
            <select id="status" value={filters.status} onChange={e => { setFilters({ ...filters, status: e.target.value }); setPage(1); }} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm">
              <option value="">Todos</option><option value="pending">Pendiente</option><option value="approved">Aprobado</option><option value="rejected">Rechazado</option><option value="disbursed">Desembolsado</option><option value="cancelled">Cancelado</option>
            </select></div>
          <div className="flex-1 min-w-[150px]"><label htmlFor="country" className="block text-xs font-semibold text-gray-900 mb-1.5">País</label>
            <select id="country" value={filters.country} onChange={e => { setFilters({ ...filters, country: e.target.value }); setPage(1); }} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm">
              <option value="">Todos</option><option value="PE">Perú</option><option value="CO">Colombia</option>
            </select></div>
          <div className="flex-1 min-w-[200px]"><DateRangePicker label="Fecha" value={{ date_from: filters.date_from, date_to: filters.date_to }} onChange={r => { setFilters(f => ({ ...f, date_from: r.date_from, date_to: r.date_to })); setPage(1); }} placeholder="Filtrar por fecha" /></div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-gray-700">Total:</span>
        <span className="text-lg font-bold text-[#8B1A1A]">{serverTotal.toLocaleString('es-PE')}</span>
        <span className="text-sm text-gray-600">solicitudes</span>
      </div>

      {!loading && serverTotal === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 lg:p-12 text-center">
          <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6"><FileText className="w-10 h-10 text-gray-400" /></div>
          <h3 className="text-xl lg:text-2xl font-bold text-gray-900 mb-2">{driverQueryActive ? 'Sin coincidencias' : hasServerFilters ? 'Sin resultados' : 'No hay solicitudes disponibles'}</h3>
          <p className="text-gray-600 mb-6 text-base">{driverQueryActive ? `Ninguna solicitud coincide con «${debouncedDriver.trim()}».` : hasServerFilters ? 'Prueba otros filtros de estado, país o fechas.' : 'No hay solicitudes en el sistema con los criterios actuales.'}</p>
        </div>
      ) : (
        <div className={`space-y-4 ${loading ? 'opacity-70 pointer-events-none' : ''}`}>
          <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden relative">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Conductor</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">DNI</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Monto</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">País</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Estado</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Fecha</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Acciones</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {requests.map(request => (
                    <tr key={request.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-4 whitespace-nowrap"><div className="text-sm font-medium text-gray-900">{request.driver_first_name || ''} {request.driver_last_name || ''}</div></td>
                      <td className="px-4 py-4 whitespace-nowrap"><div className="text-sm text-gray-900">{request.dni || 'N/A'}</div></td>
                      <td className="px-4 py-4 whitespace-nowrap"><div className="text-sm font-semibold text-gray-900">{formatCurrency(request.disbursed_amount != null && Number(request.disbursed_amount) > 0 ? Number(request.disbursed_amount) : request.requested_amount ? Number(request.requested_amount) : 0, request.country || 'PE')}</div></td>
                      <td className="px-4 py-4 whitespace-nowrap"><div className="text-sm text-gray-900">{request.country || 'N/A'}</div></td>
                      <td className="px-4 py-4 whitespace-nowrap">{getStatusBadge(request.status || 'pending')}</td>
                      <td className="px-4 py-4 whitespace-nowrap"><div className="flex items-center space-x-2 text-sm text-gray-600"><Calendar className="w-4 h-4 text-gray-400" /><span>{(() => { if (request.status === 'disbursed' && (request.disbursed_at_display || request.disbursed_at)) return request.disbursed_at_display ? formatDateLocal(request.disbursed_at_display + 'T12:00:00', 'es-PE') : formatDateLocal(request.disbursed_at!, 'es-PE'); const date = (request.status === 'approved' || request.status === 'signed') && request.approved_at ? request.approved_at : request.created_at; return date ? formatDateLocal(date, 'es-PE') : 'N/A'; })()}</span></div></td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <button onClick={() => navigate(`/admin/loan-requests/${request.id}`, { state: { fromLoanRequestsSearch: true, driverSearchInput, status: filters.status, country: filters.country, date_from: filters.date_from, date_to: filters.date_to, page: pageClamped, limit: pageSize } })} className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200" title="Ver detalles"><Eye className="w-5 h-5" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {serverTotal > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 pb-2">
              <div className="flex items-center gap-2"><span className="text-xs font-medium text-gray-500">Por página:</span>
                <select value={pageSize} onChange={e => handleLimitChange(Number(e.target.value))} className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:ring-2 focus:ring-red-500 focus:border-red-600">{PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}</select>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => goToPage(1)} disabled={pageClamped <= 1 || loading} className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"><ChevronsLeft className="w-4 h-4" /></button>
                <button onClick={() => goToPage(pageClamped - 1)} disabled={pageClamped <= 1 || loading} className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"><ChevronLeft className="w-4 h-4" /></button>
                {totalPages > 1 && <div className="flex items-center gap-1">{Array.from({ length: Math.min(5, totalPages) }, (_, i) => { let pageNum; if (totalPages <= 5) pageNum = i + 1; else if (pageClamped <= 3) pageNum = i + 1; else if (pageClamped >= totalPages - 2) pageNum = totalPages - 4 + i; else pageNum = pageClamped - 2 + i; const isActive = pageClamped === pageNum; return <button key={pageNum} onClick={() => goToPage(pageNum)} disabled={loading} className={`min-w-[2.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold ${isActive ? 'bg-red-600 text-white border-2 border-red-600' : 'border-2 border-red-600 text-red-600 hover:bg-red-50'}`}>{pageNum}</button>; })}</div>}
                <button onClick={() => goToPage(pageClamped + 1)} disabled={pageClamped >= totalPages || loading} className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"><ChevronRight className="w-4 h-4" /></button>
                <button onClick={() => goToPage(totalPages)} disabled={pageClamped >= totalPages || loading} className="w-9 h-9 flex items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"><ChevronsRight className="w-4 h-4" /></button>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
      )}
    </div>
  );
};

export default LoanRequests;
