import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, User, Banknote, Calendar, AlertCircle, FileText, CheckCircle, Clock, XCircle, X } from 'lucide-react';
import { FaWhatsapp } from 'react-icons/fa';
import api from '../../services/api';
import { formatDate } from '../../utils/date';
import toast from 'react-hot-toast';

/** Cuentas bancarias autorizadas para envío por WhatsApp (cobros / instrucciones de pago). */
export const CUENTAS_BANCARIAS_WHATSAPP = `✅ Cuentas bancarias autorizadas – a nombre AJHLA SAC

💚 INTERBANK
🔹 Cuenta Corriente - Soles:
Número de cuenta: 200-3007251767
CCI: 003-200-003007251767-32

🧡 BCP
🔹 Cuenta Corriente - Soles:
Número de cuenta: 193-7121711-0-73
CCI: 002-19300712171107314`;

/** Número para enlace wa.me: solo dígitos; si falta código de país se agrega (PE 51, CO 57). */
function getWhatsAppPhone(phone: string | undefined, country: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 10 && (digits.startsWith('51') || digits.startsWith('57'))) return digits;
  if (country === 'PE' && digits.length === 9) return '51' + digits;
  if (country === 'CO' && digits.length === 10) return '57' + digits;
  return digits;
}

type LoansSearchState = {
  fromLoansSearch?: boolean;
  driver?: string;
  loan_id?: string;
  driverSearchInput?: string;
  loanIdSearchInput?: string;
  status?: string;
  country?: string;
  date_from?: string;
  date_to?: string;
};

const LoanDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [loan, setLoan] = useState<any>(null);
  const [schedule, setSchedule] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [whatsAppMessage, setWhatsAppMessage] = useState('');
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);

  const getBackToLoansState = (): (LoansSearchState & { fromLoanDetail: true }) | undefined => {
    const s = location.state as LoansSearchState | null;
    if (!s?.fromLoansSearch) return undefined;
    return {
      fromLoanDetail: true,
      fromLoansSearch: true,
      driver: s.driver ?? '',
      loan_id: s.loan_id ?? '',
      driverSearchInput: s.driverSearchInput ?? s.driver ?? '',
      loanIdSearchInput: s.loanIdSearchInput ?? s.loan_id ?? '',
      status: s.status ?? '',
      country: s.country ?? '',
      date_from: s.date_from ?? '',
      date_to: s.date_to ?? '',
    };
  };

  useEffect(() => {
    if (id) {
      fetchLoan();
      fetchSchedule();
    }
  }, [id]);

  const fetchLoan = async () => {
    try {
      const response = await api.get(`/loans/${id}`);
      setLoan(response.data.data || response.data);
    } catch (error) {
      console.error('Error fetching loan:', error);
      setLoan(null);
    } finally {
      setLoading(false);
    }
  };

  const fetchSchedule = async () => {
    try {
      const response = await api.get(`/loans/${id}/schedule`);
      let scheduleData = [];
      if (response.data) {
        if (response.data.success && Array.isArray(response.data.data)) {
          scheduleData = response.data.data;
        } else if (response.data.data && Array.isArray(response.data.data)) {
          scheduleData = response.data.data;
        } else if (Array.isArray(response.data)) {
          scheduleData = response.data;
        }
      }
      setSchedule(scheduleData);
    } catch (error) {
      console.error('Error fetching schedule:', error);
      setSchedule([]);
    }
  };

  const overdueInstallments = useMemo(() => schedule.filter((i) => i.status === 'overdue'), [schedule]);

  // Total mora pendiente = suma de late_fee de cada cuota (no sumar paid_late_fee para no duplicar)
  const totalMoraPendiente = useMemo(() => {
    return schedule.reduce((sum, i) => sum + Math.max(0, parseFloat(i.late_fee ?? 0)), 0);
  }, [schedule]);

  const openWhatsAppModal = () => {
    const name = [loan?.driver_first_name, loan?.driver_last_name].filter(Boolean).join(' ') || 'Conductor';
    const count = overdueInstallments.length;
    const pref = loan?.country === 'PE' ? 'S/.' : loan?.country === 'CO' ? 'COP' : '';
    let defaultText: string;
    if (count > 0) {
      const lineas = overdueInstallments.slice(0, 10).map((c) => {
        const cuota = parseFloat(c.installment_amount || 0);
        const mora = Math.max(0, parseFloat(c.late_fee ?? 0));
        const total = cuota + mora;
        const fecha = c.due_date ? formatDate(c.due_date, 'es-ES') : '';
        if (mora > 0) {
          return `• Cuota ${c.installment_number}: ${pref} ${cuota.toFixed(2)} + ${pref} ${mora.toFixed(2)} mora = ${pref} ${total.toFixed(2)} total (venció ${fecha})`;
        }
        return `• Cuota ${c.installment_number}: ${pref} ${total.toFixed(2)} (venció ${fecha})`;
      });
      const mas = count > 10 ? `\n• Y ${count - 10} cuota(s) más.` : '';
      defaultText = `Hola ${name}, tienes ${count} cuota(s) vencida(s) en tu préstamo:\n\n${lineas.join('\n')}${mas}\n\nPor favor regulariza tu situación lo antes posible. Gracias.\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
    } else {
      defaultText = `Hola ${name}, te contactamos respecto a tu préstamo. Cualquier duda estamos a tu disposición.`;
    }
    setWhatsAppMessage(defaultText);
    setShowWhatsAppModal(true);
  };

  const whatsAppPhone = loan ? getWhatsAppPhone(loan.whatsapp_phone ?? loan.phone, loan.country || 'PE') : '';

  const handleSendWhatsApp = async () => {
    if (!id || !whatsAppMessage.trim() || !whatsAppPhone) return;
    setSendingWhatsApp(true);
    try {
      await api.post(`/loans/${id}/send-whatsapp`, { message: whatsAppMessage });
      toast.success('Mensaje enviado por WhatsApp');
      setShowWhatsAppModal(false);
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al enviar el mensaje');
    } finally {
      setSendingWhatsApp(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const badges: Record<string, { color: string; icon: any; text: string }> = {
      paid: {
        color: 'bg-green-100 text-green-800',
        icon: CheckCircle,
        text: 'Pagado'
      },
      pending: {
        color: 'bg-yellow-100 text-yellow-800',
        icon: Clock,
        text: 'Pendiente'
      },
      overdue: {
        color: 'bg-red-100 text-red-800',
        icon: AlertCircle,
        text: 'Vencido'
      },
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
        icon: XCircle,
        text: 'Vencido'
      }
    };
    const badge = badges[status] || badges.pending;
    const Icon = badge.icon;
    return (
      <span className={`inline-flex items-center space-x-1 px-3 py-1 rounded-full text-sm font-medium ${badge.color}`}>
        <Icon className="w-4 h-4" />
        <span>{badge.text}</span>
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-red-600 border-t-transparent mx-auto mb-4" />
          <p className="text-gray-600">Cargando detalles del préstamo...</p>
        </div>
      </div>
    );
  }

  if (!loan) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="bg-red-50 border-2 border-red-200 rounded-full p-4 mb-4">
          <AlertCircle className="w-12 h-12 text-red-600" />
        </div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Préstamo no encontrado</h3>
        <p className="text-gray-600 mb-6 text-center max-w-md">No se pudo cargar la información del préstamo</p>
        <button
          onClick={() => navigate('/admin/loans', { state: getBackToLoansState() })}
          className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-lg font-medium hover:from-red-700 hover:to-red-800 transition-all shadow-md"
        >
          Volver a Préstamos
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Botón Volver */}
      <button
        onClick={() => navigate('/admin/loans', { state: getBackToLoansState() })}
        className="inline-flex items-center gap-2 text-gray-600 hover:text-red-600 transition-colors text-sm font-medium"
      >
        <ArrowLeft className="h-4 w-4" />
        Volver a Préstamos
      </button>

      {/* Header */}
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
            <Banknote className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
              Detalle de Préstamo
            </h1>
            <p className="text-xs lg:text-sm text-white/90 mt-0.5">
              Información completa del préstamo
            </p>
          </div>
        </div>
      </div>

      {/* Cards de información */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center">
              <User className="h-4 w-4 text-red-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Información del Conductor</h2>
          </div>
          <div className="space-y-3">
            <div>
              <span className="text-xs font-semibold text-gray-600">Nombre:</span>
              <p className="text-sm text-gray-900 mt-0.5 font-medium">{loan.driver_first_name || ''} {loan.driver_last_name || ''}</p>
            </div>
            <div>
              <span className="text-xs font-semibold text-gray-600">DNI:</span>
              <p className="text-sm text-gray-900 mt-0.5">{loan.dni || 'N/A'}</p>
            </div>
            <div>
              <span className="text-xs font-semibold text-gray-600">Teléfono:</span>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-sm text-gray-900">{loan.phone || 'N/A'}</p>
                <button
                  type="button"
                  onClick={openWhatsAppModal}
                  className="text-[#25D366] hover:text-[#20BD5A] p-0.5 shrink-0 transition-colors"
                  title="Enviar mensaje por WhatsApp"
                >
                  <FaWhatsapp className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center">
              <Banknote className="h-4 w-4 text-red-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Información del Préstamo</h2>
          </div>
          <div className="space-y-3">
            <div>
              <span className="text-xs font-semibold text-gray-600">Monto Desembolsado:</span>
              <p className="text-sm text-gray-900 mt-0.5 font-semibold">
                {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : ''} {parseFloat(loan.disbursed_amount || 0).toFixed(2)}
              </p>
            </div>
            <div>
              <span className="text-xs font-semibold text-gray-600">Monto Total del préstamo:</span>
              <p className="text-sm text-gray-900 mt-0.5 font-semibold">
                {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : ''} {parseFloat(loan.total_amount ?? 0).toFixed(2)}
              </p>
            </div>
            <div>
              <span className="text-xs font-semibold text-gray-600">Saldo Pendiente:</span>
              <p className="text-sm text-red-600 mt-0.5 font-bold">
                {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : ''} {parseFloat(loan.pending_balance ?? 0).toFixed(2)}
              </p>
            </div>
            <div>
              <span className="text-xs font-semibold text-gray-600">Total mora pendiente:</span>
              <p className="text-sm text-red-600 mt-0.5 font-semibold">
                {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : ''} {totalMoraPendiente.toFixed(2)}
              </p>
            </div>
            <div>
              <span className="text-xs font-semibold text-gray-600">Tasa de Interés:</span>
              <p className="text-sm text-gray-900 mt-0.5">{loan.interest_rate || 'N/A'}%</p>
            </div>
            <div>
              <span className="text-xs font-semibold text-gray-600">Estado:</span>
              <div className="mt-1">
                {getStatusBadge(loan.status)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Cronograma de Cuotas */}
      {schedule.length === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 lg:p-12 text-center">
          <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <FileText className="w-10 h-10 text-gray-400" />
          </div>
          <h3 className="text-xl lg:text-2xl font-bold text-gray-900 mb-2">
            No hay cronograma disponible
          </h3>
          <p className="text-gray-600 mb-6 text-base">
            No se encontraron cuotas para este préstamo
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
          <div className="border-b border-gray-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <Calendar className="h-5 w-5 text-red-600" />
              <h2 className="text-base font-semibold text-gray-900">Cronograma de Cuotas</h2>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Cuota
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Monto
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Fecha Vencimiento
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Monto Pagado
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Fecha pago
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider" title="Mora por días de atraso">
                    Mora
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Estado
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {schedule.map((installment) => (
                  <tr key={installment.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {installment.installment_number}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : ''} {parseFloat(installment.installment_amount || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {installment.due_date ? formatDate(installment.due_date, 'es-ES') : 'N/A'}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {(() => {
                        const pagadoCuota = parseFloat(installment.paid_amount || 0);
                        const moraPagada = parseFloat(installment.paid_late_fee ?? 0);
                        const totalPagado = pagadoCuota + moraPagada;
                        return totalPagado > 0
                          ? `${loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : ''} ${totalPagado.toFixed(2)}`
                          : (loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : '') + ' 0.00';
                      })()}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {(installment.paid_date || (installment as { last_payment_date?: string }).last_payment_date)
                        ? formatDate(installment.paid_date || (installment as { last_payment_date?: string }).last_payment_date, 'es-ES')
                        : '—'}
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-900">
                      {(() => {
                        const pref = loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP' : '';
                        // Usar solo late_fee como mora pendiente (backend ya envía el valor correcto). No sumar late_fee + paid_late_fee para no duplicar.
                        const pendiente = Math.max(0, parseFloat(installment.late_fee ?? 0));
                        const pagada = Math.max(0, parseFloat(installment.paid_late_fee ?? 0));
                        const cobrada = Math.max(0, Number((installment as { mora_cobrada?: number }).mora_cobrada ?? 0));
                        const hayMora = pendiente > 0 || pagada > 0 || cobrada > 0;
                        if (!hayMora) return <span>{pref} 0.00</span>;
                        return (
                          <span className="block space-y-0.5">
                            {pendiente > 0 && (
                              <span className="block text-red-600 font-medium">{pref} {pendiente.toFixed(2)} <span className="text-xs font-normal text-red-500">(pendiente)</span></span>
                            )}
                            {installment.status === 'paid' && cobrada > 0 && (
                              <span className="block text-amber-700 font-medium">{pref} {cobrada.toFixed(2)} <span className="text-xs font-normal">(cobrada)</span></span>
                            )}
                            {pagada > 0 && installment.status !== 'paid' && (
                              <span className="block text-amber-700 text-xs">{pref} {pagada.toFixed(2)} (pagada)</span>
                            )}
                            {hayMora && (
                              <span className="block text-xs font-semibold text-gray-700 border-t border-gray-200 pt-0.5 mt-0.5">
                                Mora pendiente: {pref} {pendiente.toFixed(2)}
                              </span>
                            )}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      {getStatusBadge(installment.status)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal WhatsApp */}
      {showWhatsAppModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowWhatsAppModal(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gray-50">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 bg-[#25D366] rounded-lg flex items-center justify-center">
                  <FaWhatsapp className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900">Enviar por WhatsApp</h3>
              </div>
              <button type="button" onClick={() => setShowWhatsAppModal(false)} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              <div>
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conductor</span>
                <p className="mt-1 text-gray-900 font-medium">
                  {loan?.driver_first_name || ''} {loan?.driver_last_name || ''}
                </p>
                {loan?.phone && (
                  <p className="text-sm text-gray-500 mt-0.5">{loan.phone}</p>
                )}
              </div>
              <div>
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Cuotas vencidas</span>
                {overdueInstallments.length === 0 ? (
                  <p className="mt-1 text-gray-600 text-sm">No hay cuotas vencidas</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {overdueInstallments.slice(0, 10).map((c) => {
                      const pref = loan?.country === 'PE' ? 'S/.' : loan?.country === 'CO' ? 'COP' : '';
                      const cuota = parseFloat(c.installment_amount || 0);
                      const mora = Math.max(0, parseFloat(c.late_fee ?? 0));
                      const total = cuota + mora;
                      return (
                        <li key={c.id} className="rounded-lg border border-gray-200 bg-gray-50/80 p-3">
                          <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
                            <span className="font-semibold text-gray-700">Cuota {c.installment_number}</span>
                            <span>Vence {c.due_date ? formatDate(c.due_date, 'es-ES') : '—'}</span>
                          </div>
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                            <span><span className="text-gray-500">Cuota:</span> <span className="font-medium text-gray-900">{pref} {cuota.toFixed(2)}</span></span>
                            {mora > 0 && (
                              <span><span className="text-gray-500">Mora:</span> <span className="font-medium text-red-600">{pref} {mora.toFixed(2)}</span></span>
                            )}
                            <span><span className="text-gray-500">Total:</span> <span className="font-semibold text-gray-900">{pref} {total.toFixed(2)}</span></span>
                          </div>
                        </li>
                      );
                    })}
                    {overdueInstallments.length > 10 && (
                      <li className="text-sm text-gray-500 py-1">y {overdueInstallments.length - 10} cuota(s) más</li>
                    )}
                  </ul>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Mensaje que verá el conductor</label>
                <textarea
                  value={whatsAppMessage}
                  onChange={(e) => setWhatsAppMessage(e.target.value)}
                  rows={5}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
                  placeholder="Escribe el mensaje..."
                />
              </div>
            </div>
            <div className="flex gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={() => setShowWhatsAppModal(false)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg font-medium hover:bg-gray-50"
              >
                Cerrar
              </button>
              <button
                type="button"
                onClick={handleSendWhatsApp}
                disabled={!whatsAppPhone || !whatsAppMessage.trim() || sendingWhatsApp}
                className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white ${whatsAppPhone && whatsAppMessage.trim() && !sendingWhatsApp ? 'bg-[#25D366] hover:bg-[#20BD5A]' : 'bg-gray-300 cursor-not-allowed'}`}
              >
                <FaWhatsapp className="w-5 h-5" />
                {sendingWhatsApp ? 'Enviando...' : whatsAppPhone ? 'Enviar por WhatsApp' : 'Sin número'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LoanDetail;







