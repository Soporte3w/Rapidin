import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, User, Banknote, Calendar, AlertCircle, FileText, CheckCircle, Clock, XCircle } from 'lucide-react';
import api from '../services/api';
import { formatDateUTC } from '../utils/date';

const LoanDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loan, setLoan] = useState<any>(null);
  const [schedule, setSchedule] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

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
      partial: {
        color: 'bg-blue-100 text-blue-800',
        icon: Clock,
        text: 'Parcial'
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
          onClick={() => navigate('/admin/loans')}
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
        onClick={() => navigate('/admin/loans')}
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
              <p className="text-sm text-gray-900 mt-0.5">{loan.phone || 'N/A'}</p>
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
                {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP $' : ''} {parseFloat(loan.disbursed_amount || 0).toFixed(2)}
              </p>
            </div>
            <div>
              <span className="text-xs font-semibold text-gray-600">Monto Total (a pagar):</span>
              <p className="text-sm text-gray-900 mt-0.5 font-semibold">
                {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP $' : ''} {parseFloat(loan.pending_balance ?? loan.total_amount ?? 0).toFixed(2)}
              </p>
            </div>
            <div>
              <span className="text-xs font-semibold text-gray-600">Saldo Pendiente:</span>
              <p className="text-sm text-red-600 mt-0.5 font-bold">
                {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP $' : ''} {parseFloat(loan.pending_balance || 0).toFixed(2)}
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
                      {loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP $' : ''} {parseFloat(installment.installment_amount || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {installment.due_date ? formatDateUTC(installment.due_date, 'es-ES') : 'N/A'}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {(() => {
                        const totalPagado = parseFloat(installment.paid_amount || 0) + parseFloat(installment.paid_late_fee ?? 0);
                        return totalPagado > 0
                          ? `${loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP $' : ''} ${totalPagado.toFixed(2)}`
                          : (loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP $' : '') + ' 0.00';
                      })()}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {installment.paid_date ? formatDateUTC(installment.paid_date, 'es-ES') : '—'}
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-900">
                      {(() => {
                        const pref = loan.country === 'PE' ? 'S/.' : loan.country === 'CO' ? 'COP $' : '';
                        const pendiente = Math.max(0, parseFloat(installment.late_fee ?? 0));
                        const pagada = Math.max(0, parseFloat(installment.paid_late_fee ?? 0));
                        const cobrada = Math.max(0, Number((installment as { mora_cobrada?: number }).mora_cobrada ?? 0));
                        const totalMora = pendiente + pagada + (installment.status === 'paid' ? cobrada : 0);
                        if (totalMora === 0 && cobrada === 0) return <span>{pref} 0.00</span>;
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
                            {(pendiente > 0 || pagada > 0 || cobrada > 0) && (
                              <span className="block text-xs font-semibold text-gray-700 border-t border-gray-200 pt-0.5 mt-0.5">Total mora: {pref} {(pendiente + pagada + cobrada).toFixed(2)}</span>
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
    </div>
  );
};

export default LoanDetail;







