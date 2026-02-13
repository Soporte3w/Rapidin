import { useEffect, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Upload,
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  Calendar,
  AlertCircle,
  Eye,
  ArrowLeft,
  X,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../services/api';
import { formatCurrency, getCurrencyLabel } from '../../utils/currency';
import toast from 'react-hot-toast';

interface Voucher {
  id: string;
  loanId: string;
  amount: number;
  paymentDate: string;
  fileName: string;
  observations?: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedAt?: string;
  rejectionReason?: string;
  createdAt: string;
  loanAmount: number;
  installmentsCount: number;
}

interface Installment {
  id: string;
  installmentNumber: number;
  amount: number;
  dueDate: string;
  status: string;
  /** Solo la parte cuota (sin mora). */
  installmentPending?: number;
  /** Total a pagar = installmentPending + lateFee */
  pendingAmount: number;
  lateFee?: number;
}

interface DriverPayment {
  id: string;
  loan_id: string;
  amount: number;
  payment_date: string;
  payment_method?: string;
  created_at: string;
  voucher_id?: string | null;
  installment_numbers?: number[];
  is_pending?: boolean;
}

export default function DriverVouchers() {
  const { loanId: urlLoanId } = useParams();
  const { user } = useAuth();
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [payments, setPayments] = useState<DriverPayment[]>([]);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [loading, setLoading] = useState(true);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [expandedSection, setExpandedSection] = useState<'historial' | 'subir' | null>('historial');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [activeLoanId, setActiveLoanId] = useState<string | null>(null);
  
  const country = user?.country || 'PE';
  const countryName = country === 'PE' ? 'Perú' : country === 'CO' ? 'Colombia' : '';
  
  // Usar loanId de la URL o el préstamo activo
  const loanId = urlLoanId || activeLoanId;

  // Form state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [observations, setObservations] = useState('');
  const [selectedInstallments, setSelectedInstallments] = useState<string[]>([]);
  const [viewFileModal, setViewFileModal] = useState<{ url: string; type: string } | null>(null);
  
  // Refs
  const hasLoadedActiveLoan = useRef(false);
  const hasLoadedInstallments = useRef<string | null>(null);

  // Recargar pagos y vouchers cuando cambia el préstamo (flota) para mostrar solo los de esa flota
  useEffect(() => {
    loadPayments(loanId ?? undefined);
  }, [loanId]);

  useEffect(() => {
    loadVouchers(loanId ?? undefined);
  }, [loanId]);

  const loadPayments = async (filterLoanId?: string) => {
    try {
      setPaymentsLoading(true);
      const params = filterLoanId ? { loan_id: filterLoanId } : {};
      const response = await api.get('/driver/payments', { params });
      const data = response.data?.data ?? response.data;
      if (data && typeof data === 'object' && 'payments' in data) {
        const pending = Array.isArray(data.pending_vouchers) ? data.pending_vouchers : [];
        const paid = Array.isArray(data.payments) ? data.payments : [];
        const combined = [...pending, ...paid].sort((a, b) => {
          const da = new Date(a.payment_date || a.created_at).getTime();
          const db = new Date(b.payment_date || b.created_at).getTime();
          return db - da;
        });
        setPayments(combined);
      } else {
        setPayments(Array.isArray(data) ? data : []);
      }
    } catch (err: any) {
      console.error('Error loading payments:', err);
      setPayments([]);
    } finally {
      setPaymentsLoading(false);
    }
  };

  useEffect(() => {
    // Evitar llamadas duplicadas
    if (hasLoadedActiveLoan.current) return;
    hasLoadedActiveLoan.current = true;
    loadActiveLoan();
  }, []);

  useEffect(() => {
    if (loanId && hasLoadedInstallments.current !== loanId) {
      hasLoadedInstallments.current = loanId;
      setSelectedInstallments([]); // Limpiar selección al cambiar de préstamo (solo cuotas del préstamo actual)
      loadInstallments();
    }
  }, [loanId]);

  // Al abrir el panel "Subir nuevo voucher", prellenar fecha de pago con la fecha actual
  useEffect(() => {
    if (expandedSection === 'subir') {
      const today = new Date();
      setPaymentDate(today.toISOString().slice(0, 10));
    }
  }, [expandedSection]);

  // Rellenar monto pagado con la suma de cuotas + mora de las cuotas seleccionadas
  useEffect(() => {
    if (selectedInstallments.length === 0) {
      setAmount('');
      return;
    }
    const total = installments
      .filter(inst => selectedInstallments.includes(inst.id))
      .reduce((sum, inst) => sum + (inst.pendingAmount ?? inst.amount ?? 0) + (inst.lateFee ?? 0), 0);
    setAmount(total > 0 ? total.toFixed(2) : '');
  }, [selectedInstallments, installments]);

  const loadVouchers = async (filterLoanId?: string) => {
    try {
      setLoading(true);
      const params = filterLoanId ? { loan_id: filterLoanId } : {};
      const response = await api.get('/driver/vouchers', { params });
      setVouchers(response.data.data || []);
    } catch (error: any) {
      console.error('Error loading vouchers:', error);
      const errorMessage = error.response?.data?.message || 'Error al cargar los vouchers';
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const loadActiveLoan = async () => {
    try {
      const response = await api.get('/driver/loans');
      const data = response.data.data;
      const loans = Array.isArray(data) ? data : (data?.loans || []);
      // Buscar el préstamo activo
      const activeLoan = loans.find((loan: any) => loan.status === 'active');
      if (activeLoan?.id) {
        setActiveLoanId(activeLoan.id);
      }
    } catch (error: any) {
      console.error('Error loading active loan:', error);
      // No mostrar toast aquí porque es silencioso
    }
  };

  const loadInstallments = async () => {
    if (!loanId) return;
    try {
      const response = await api.get(`/driver/loans/${loanId}/installments`);
      setInstallments(response.data.data || []);
    } catch (error: any) {
      console.error('Error loading installments:', error);
      toast.error('Error al cargar las cuotas pendientes');
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 5 * 1024 * 1024) {
        setError('El archivo no debe exceder 5MB');
        return;
      }
      setSelectedFile(file);
      setError('');
    }
  };

  // Selección en orden: la siguiente cuota se desbloquea al seleccionar la que vence antes.
  // Solo puede haber un "bloque" consecutivo desde la primera (no saltar ni desmarcar en medio sin quitar las de después).
  const nextSelectableInstallment = installments.find((i) => !selectedInstallments.includes(i.id));
  const selectableInstallmentIds = new Set([
    ...selectedInstallments,
    ...(nextSelectableInstallment ? [nextSelectableInstallment.id] : [])
  ]);

  const handleInstallmentToggle = (installmentId: string) => {
    const isSelected = selectedInstallments.includes(installmentId);
    if (isSelected) {
      const index = installments.findIndex((i) => i.id === installmentId);
      if (index === -1) return;
      setSelectedInstallments(installments.slice(0, index).map((i) => i.id));
      return;
    }
    if (nextSelectableInstallment?.id !== installmentId) return;
    setSelectedInstallments((prev) => [...prev, installmentId]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!selectedFile) {
      toast.error('Debes seleccionar un archivo');
      return;
    }

    if (!amount || !paymentDate) {
      toast.error('Debes completar todos los campos requeridos');
      return;
    }

    if (selectedInstallments.length === 0) {
      toast.error('Debes seleccionar al menos una cuota');
      return;
    }

    // Validar que las cuotas seleccionadas son en orden (desde la que vence primero, consecutivas)
    const selectedOrdered = installments
      .filter((i) => selectedInstallments.includes(i.id))
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
    const expectedPrefix = installments.slice(0, selectedOrdered.length);
    const validOrder = selectedOrdered.length > 0 && selectedOrdered.every((s, idx) => s.id === expectedPrefix[idx].id);
    if (!validOrder) {
      toast.error('Solo puedes pagar cuotas en orden (la que vence primero, luego la siguiente).');
      return;
    }

    try {
      setUploading(true);
      const formData = new FormData();
      formData.append('voucher', selectedFile);
      formData.append('loanId', loanId || '');
      formData.append('amount', amount);
      formData.append('paymentDate', paymentDate);
      formData.append('observations', observations);
      formData.append('installmentIds', JSON.stringify(selectedInstallments));

      await api.post('/driver/vouchers', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });

      toast.success('Voucher subido exitosamente. Está pendiente de validación.');
      setExpandedSection('historial');
      resetForm();
      loadVouchers(loanId ?? undefined);
      loadPayments(loanId ?? undefined);
    } catch (error: any) {
      console.error('Error uploading voucher:', error);
      toast.error(error.response?.data?.message || 'Error al subir el voucher');
    } finally {
      setUploading(false);
    }
  };

  const resetForm = () => {
    setSelectedFile(null);
    setAmount('');
    setPaymentDate('');
    setObservations('');
    setSelectedInstallments([]);
  };

  const getStatusBadge = (status: string) => {
    const badges = {
      pending: {
        color: 'bg-yellow-100 text-yellow-700 border-yellow-200',
        icon: Clock,
        text: 'Por Validar'
      },
      approved: {
        color: 'bg-green-100 text-green-700 border-green-200',
        icon: CheckCircle,
        text: 'Validado'
      },
      rejected: {
        color: 'bg-red-100 text-red-700 border-red-200',
        icon: XCircle,
        text: 'Rechazado'
      }
    };
    const badge = badges[status as keyof typeof badges];
    const Icon = badge.icon;
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${badge.color}`}>
        <Icon className="w-3 h-3" />
        <span>{badge.text}</span>
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-red-600 border-t-transparent mx-auto mb-4" />
          <p className="text-gray-600">Cargando vouchers...</p>
        </div>
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
              <FileText className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
                Mis pagos
              </h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                Gestiona tus comprobantes de pago - {countryName}
              </p>
            </div>
          </div>
          {loanId ? (
            <button
              type="button"
              onClick={() => setExpandedSection('subir')}
              className="inline-flex items-center gap-2 bg-white text-[#8B1A1A] px-4 py-2.5 rounded-lg font-semibold hover:bg-gray-100 transition-colors text-sm whitespace-nowrap"
            >
              <Upload className="w-5 h-5" />
              Subir nuevo voucher
            </button>
          ) : (
            <p className="text-white/80 text-sm">Necesitas un préstamo activo para registrar un voucher.</p>
          )}
        </div>
      </div>

      {/* Volver a Mis préstamos */}
      <div className="mb-2">
        <Link
          to="/driver/loans"
          className="inline-flex items-center gap-2 text-gray-600 hover:text-[#8B1A1A] font-medium text-sm transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
          Volver a Mis préstamos
        </Link>
      </div>

      {/* Lista desplegable: Historial de pagos + Subir nuevo voucher */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        {/* Panel 1: Historial de pagos */}
        <div className="border-b border-gray-200 last:border-b-0">
          <button
            type="button"
            onClick={() => setExpandedSection(expandedSection === 'historial' ? null : 'historial')}
            className="w-full flex items-center justify-between gap-3 px-4 py-3.5 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
          >
            <span className="font-semibold text-gray-900">Historial de pagos</span>
            {expandedSection === 'historial' ? (
              <ChevronUp className="w-5 h-5 text-gray-500 flex-shrink-0" />
            ) : (
              <ChevronDown className="w-5 h-5 text-gray-500 flex-shrink-0" />
            )}
          </button>
          {expandedSection === 'historial' && (
            <div className="px-4 py-3 border-t border-gray-100 bg-white">
              <p className="text-xs text-gray-600 mb-3">
                <strong>Comprobante:</strong> pagos que subiste con foto o PDF. <strong>Oficina / Manual:</strong> pagos en ventanilla.
              </p>
              {paymentsLoading ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-red-600 border-t-transparent" />
                </div>
              ) : payments.length === 0 ? (
                <div className="p-6 text-center text-gray-500 text-sm">
                  Aún no tienes pagos registrados.
                </div>
              ) : (
                <div className="max-h-96 overflow-y-auto rounded-lg border border-gray-200">
                <div className="divide-y divide-gray-100">
                  {payments.map((p) => {
                    const isVoucher = p.payment_method === 'voucher';
                    const isPending = p.is_pending === true;
                    const dateStr = p.payment_date ? new Date(p.payment_date).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
                    const createdStr = p.created_at ? new Date(p.created_at).toLocaleDateString('es-PE') : '—';
                    return (
                      <div key={p.id} className="p-4 sm:p-5">
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                          <div className="flex-1 min-w-0 space-y-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-base font-semibold text-gray-900">
                                {isVoucher ? 'Comprobante' : 'Oficina / Manual'} · {dateStr}
                              </span>
                              {isPending ? (
                                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 border border-yellow-200">
                                  <Clock className="w-3.5 h-3.5" />
                                  Por validar
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                  <CheckCircle className="w-3.5 h-3.5" />
                                  Validado
                                </span>
                              )}
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6">
                              <div>
                                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Monto</p>
                                <p className="mt-0.5 text-sm font-semibold text-gray-900">{formatCurrency(Number(p.amount), country)}</p>
                              </div>
                              <div>
                                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Fecha pago</p>
                                <p className="mt-0.5 text-sm text-gray-900">{p.payment_date ? new Date(p.payment_date).toLocaleDateString('es-PE') : '—'}</p>
                              </div>
                        <div>
                          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Cuotas</p>
                          <p className="mt-0.5 text-sm text-gray-900">
                            {p.installment_numbers && p.installment_numbers.length > 0
                              ? p.installment_numbers.join(', ')
                              : '—'}
                          </p>
                        </div>
                              <div>
                                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Subido</p>
                                <p className="mt-0.5 text-sm text-gray-900">{createdStr}</p>
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                              {isPending ? (
                                <span className="text-yellow-700">Pendiente de validación</span>
                              ) : (
                                <span className="text-green-700">Validado {dateStr}</span>
                              )}
                            </div>
                          </div>
                          {isVoucher && p.voucher_id && (
                            <div className="flex-shrink-0">
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    const { data } = await api.get(`/driver/vouchers/${p.voucher_id}/file`, { responseType: 'blob' });
                                    const url = URL.createObjectURL(data);
                                    setViewFileModal({ url, type: data.type || 'image/png' });
                                  } catch (err) {
                                    toast.error('No se pudo abrir el comprobante');
                                  }
                                }}
                                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-[#8B1A1A] bg-red-50 hover:bg-red-100 rounded-lg transition-colors border border-red-100"
                                title="Ver comprobante"
                              >
                                <Eye className="w-4 h-4" />
                                Ver
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Panel 2: Subir nuevo voucher (solo si hay préstamo activo) */}
        {loanId && (
          <div className="border-b border-gray-200 last:border-b-0">
            <button
              type="button"
              onClick={() => setExpandedSection(expandedSection === 'subir' ? null : 'subir')}
              className="w-full flex items-center justify-between gap-3 px-4 py-3.5 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
            >
              <span className="font-semibold text-gray-900">Subir nuevo voucher</span>
              {expandedSection === 'subir' ? (
                <ChevronUp className="w-5 h-5 text-gray-500 flex-shrink-0" />
              ) : (
                <ChevronDown className="w-5 h-5 text-gray-500 flex-shrink-0" />
              )}
            </button>
            {expandedSection === 'subir' && (
              <div className="px-4 py-4 border-t border-gray-100 bg-white">
                {error && (
                  <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start space-x-3">
                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <p className="text-red-700 text-sm">{error}</p>
                  </div>
                )}
                {success && (
                  <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg flex items-start space-x-3">
                    <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                    <p className="text-green-700 text-sm">{success}</p>
                  </div>
                )}
                <form onSubmit={handleSubmit} className="space-y-4 lg:space-y-5">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">Archivo del Voucher <span className="text-red-600">*</span></label>
                    {selectedFile ? (
                      <div className="mt-1 p-3 border-2 border-gray-300 rounded-lg bg-gray-50">
                        <div className="flex items-center gap-3">
                          <div className="flex-shrink-0">
                            {selectedFile.type.startsWith('image/') ? (
                              <img src={URL.createObjectURL(selectedFile)} alt="Preview" className="w-16 h-16 object-cover rounded border border-gray-200" />
                            ) : (
                              <div className="w-16 h-16 bg-red-100 rounded border border-red-200 flex items-center justify-center">
                                <FileText className="w-8 h-8 text-red-600" />
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{selectedFile.name}</p>
                            <p className="text-xs text-gray-500">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
                          </div>
                          <button type="button" onClick={() => setSelectedFile(null)} className="flex-shrink-0 text-gray-400 hover:text-red-600 transition-colors">
                            <XCircle className="w-5 h-5" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1 flex justify-center px-4 pt-4 pb-4 border-2 border-gray-300 border-dashed rounded-lg hover:border-red-400 transition-colors">
                        <div className="space-y-1 text-center">
                          <Upload className="mx-auto h-10 w-10 text-gray-400" />
                          <div className="flex text-sm text-gray-600">
                            <label className="relative cursor-pointer bg-white rounded-md font-medium text-red-600 hover:text-red-700 focus-within:outline-none">
                              <span>Subir archivo</span>
                              <input type="file" className="sr-only" accept="image/jpeg,image/png,application/pdf" onChange={handleFileChange} />
                            </label>
                            <p className="pl-1">o arrastra y suelta</p>
                          </div>
                          <p className="text-xs text-gray-500">PNG, JPG, PDF hasta 5MB</p>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-2">Total a pagar (incl. mora) <span className="text-red-600">*</span></label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-600 font-semibold text-sm">{getCurrencyLabel(country)}</span>
                        <input type="text" inputMode="decimal" value={amount} readOnly className="w-full pl-12 pr-4 py-3 border border-gray-300 rounded-lg bg-gray-100 cursor-not-allowed font-semibold text-gray-900" placeholder="0.00" required />
                      </div>
                      <p className="text-xs text-gray-500 mt-1">Cuotas seleccionadas + mora si aplica. Este es el monto que debe pagar.</p>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-2">Fecha de Pago <span className="text-red-600">*</span></label>
                      <div className="relative">
                        <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <input type="date" value={paymentDate} readOnly className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg bg-gray-100 cursor-not-allowed" required />
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">Observaciones</label>
                    <input type="text" value={observations} onChange={(e) => setObservations(e.target.value)} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent" placeholder="Notas adicionales" />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">Selecciona la cuota que pagas <span className="text-red-600">*</span></label>
                    <p className="text-xs text-gray-600 mb-3">Selecciona en orden: primero la que vence, luego se desbloquea la siguiente.</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 max-h-64 overflow-y-auto p-3 bg-gray-50 rounded-lg border border-gray-200">
                      {installments.map((installment) => {
                        const isSelectable = selectableInstallmentIds.has(installment.id);
                        return (
                          <label
                            key={installment.id}
                            className={`flex items-center gap-2 p-2.5 rounded-lg border-2 transition-all min-w-0 ${
                              !isSelectable
                                ? 'bg-gray-100 border-gray-200 cursor-not-allowed opacity-75'
                                : selectedInstallments.includes(installment.id)
                                  ? 'bg-red-50 border-red-500 cursor-pointer'
                                  : 'bg-white border-gray-200 hover:border-gray-300 cursor-pointer'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={selectedInstallments.includes(installment.id)}
                              onChange={() => handleInstallmentToggle(installment.id)}
                              disabled={!isSelectable}
                              className="w-4 h-4 flex-shrink-0 text-red-600 border-gray-300 rounded focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-gray-900 text-sm truncate">
                                Cuota {installment.installmentNumber}
                                <span className="font-normal text-gray-500 ml-1">· Vence: {new Date(installment.dueDate).toLocaleDateString('es-PE')}</span>
                              </p>
                              <p className="text-xs text-gray-600 mt-0.5">A pagar: <span className="font-medium text-gray-900">{formatCurrency(installment.installmentPending ?? (installment.pendingAmount - (installment.lateFee ?? 0)), country)}</span></p>
                              <p className={`text-xs ${Number(installment.lateFee ?? 0) > 0 ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                                Mora: {formatCurrency(installment.lateFee ?? 0, country)}
                              </p>
                              <p className="text-xs font-semibold text-gray-900 mt-1 pt-1 border-t border-gray-200">
                                Total: {formatCurrency(installment.pendingAmount ?? 0, country)}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                    {installments.length === 0 && <p className="text-sm text-gray-500 text-center py-4">No hay cuotas pendientes para este préstamo</p>}
                    {selectedInstallments.length > 0 && (() => {
                      const selected = installments.filter(i => selectedInstallments.includes(i.id));
                      const subtotalCuotas = selected.reduce((s, i) => s + (i.installmentPending ?? (i.pendingAmount ?? 0) - (i.lateFee ?? 0)), 0);
                      const totalMora = selected.reduce((s, i) => s + (i.lateFee ?? 0), 0);
                      const totalPagar = subtotalCuotas + totalMora;
                      return (
                        <div className="mt-3 p-3 bg-white border border-gray-200 rounded-lg">
                          <p className="text-xs text-gray-600">Subtotal cuotas: <span className="font-semibold text-gray-900">{formatCurrency(subtotalCuotas, country)}</span></p>
                          {totalMora > 0 && <p className="text-xs text-red-600 mt-0.5">Mora: <span className="font-semibold">{formatCurrency(totalMora, country)}</span></p>}
                          <p className="text-sm font-semibold text-gray-900 mt-1.5 pt-1.5 border-t border-gray-100">Total a pagar: {formatCurrency(totalPagar, country)}</p>
                        </div>
                      );
                    })()}
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3 pt-3 justify-center items-center">
                    <button type="submit" disabled={uploading} className="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-2.5 rounded-lg font-semibold hover:from-red-700 hover:to-red-800 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed text-sm">
                      {uploading ? (<><div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" /><span>Subiendo...</span></>) : (<><Upload className="w-4 h-4" /><span>Subir Voucher</span></>)}
                    </button>
                    <button type="button" onClick={() => { setExpandedSection('historial'); resetForm(); }} className="inline-flex items-center gap-2 px-6 py-2.5 border-2 border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50 transition-all text-sm">
                      <ArrowLeft className="w-4 h-4" />
                      Cerrar
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}
      </div>
      {/* Modal ver comprobante (igual que en admin Pagos) */}
      {viewFileModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-60" onClick={() => { URL.revokeObjectURL(viewFileModal.url); setViewFileModal(null); }}>
          <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center gap-2 p-3 border-b border-gray-200 bg-[#8B1A1A] rounded-t-xl">
              <button
                type="button"
                onClick={() => { URL.revokeObjectURL(viewFileModal.url); setViewFileModal(null); }}
                className="inline-flex items-center gap-2 text-white hover:text-gray-200 transition-colors text-sm font-medium flex-shrink-0"
              >
                <ArrowLeft className="w-5 h-5" />
                Volver atrás
              </button>
              <h2 className="text-lg font-bold text-white flex-1 text-center">Comprobante</h2>
              <button
                type="button"
                onClick={() => { URL.revokeObjectURL(viewFileModal.url); setViewFileModal(null); }}
                className="text-white hover:text-gray-200 transition-colors p-1 flex-shrink-0"
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
}




