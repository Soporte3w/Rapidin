import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  TrendingUp,
  Calendar,
  AlertCircle,
  CheckCircle,
  Clock,
  ArrowRight,
  PlusCircle,
  FileText,
  TrendingDown,
  Award,
  CreditCard,
  Activity,
  Target,
  Zap
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../services/api';
import { getStoredSelectedParkId } from '../../utils/authStorage';
import { formatCurrency } from '../../utils/currency';

interface DashboardData {
  driver: {
    firstName: string;
    lastName: string;
    phone: string;
  };
  pendingRequest?: {
    id: string;
    status: string;
    requestedAmount: number;
    createdAt: string;
    message?: string;
  } | null;
  activeLoan: {
    id: string;
    loanAmount: number;
    pendingAmount: number;
    status: string;
    totalInstallments: number;
    paidInstallments: number;
    nextPaymentDate: string;
    nextPaymentAmount: number;
    daysUntilPayment: number;
    paymentFrequency: string;
    message?: string;
  } | null;
  /** Préstamos activos de la flota actual (puede haber más de uno en la misma flota) */
  activeLoans?: Array<{
    id: string;
    loanAmount: number;
    pendingAmount: number;
    status: string;
    totalInstallments: number;
    paidInstallments: number;
    nextPaymentDate: string;
    nextPaymentAmount: number;
    daysUntilPayment: number;
    paymentFrequency: string;
    flotaName?: string;
  }>;
  loanHistory: {
    completedLoans: number;
    totalBorrowed: number;
  };
  recentPayments: Array<{
    id: string;
    amount: number;
    paymentDate: string;
    paymentMethod: string;
  }>;
  paymentStats: {
    onTimePayments: number;
    latePayments: number;
    totalPayments: number;
    onTimeRate: number;
  };
}

export default function DriverDashboard() {
  const { user } = useAuth();
  const country = user?.country || 'PE';
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      setLoading(true);
      const parkId = getStoredSelectedParkId();
      const params = parkId ? { park_id: parkId } : {};
      const response = await api.get('/driver/dashboard', { params });
      setDashboardData(response.data.data);
    } catch (error: any) {
      console.error('Error loading dashboard:', error);
      setError(error.response?.data?.message || 'Error al cargar el resumen');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-red-600 border-t-transparent mx-auto mb-4" />
          <p className="text-gray-600">Cargando información...</p>
        </div>
      </div>
    );
  }

  if (error || !dashboardData) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="bg-red-50 border-2 border-red-200 rounded-full p-4 mb-4">
          <AlertCircle className="w-12 h-12 text-red-600" />
        </div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Error al cargar el resumen</h3>
        <p className="text-gray-600 mb-6 text-center max-w-md">{error || 'No se pudo cargar la información'}</p>
        <button
          onClick={loadDashboardData}
          className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-lg font-medium hover:from-red-700 hover:to-red-800 transition-all shadow-md"
        >
          Reintentar
        </button>
      </div>
    );
  }

  const driver = dashboardData.driver ?? { firstName: '', lastName: '', phone: '' };
  const activeLoan = dashboardData.activeLoan ?? null;
  const activeLoansList = Array.isArray(dashboardData.activeLoans) && dashboardData.activeLoans.length > 0
    ? dashboardData.activeLoans
    : (activeLoan ? [activeLoan] : []);
  const loanHistory = dashboardData.loanHistory ?? { completedLoans: 0, totalBorrowed: 0 };
  const recentPayments = Array.isArray(dashboardData.recentPayments) ? dashboardData.recentPayments : [];
  const paymentStats = dashboardData.paymentStats ?? { onTimePayments: 0, latePayments: 0, totalPayments: 0, onTimeRate: 0 };
  const countryName = user?.country === 'PE' ? 'Perú' : user?.country === 'CO' ? 'Colombia' : '';

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Header */}
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
                Resumen
              </h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                Resumen de tu actividad - {countryName}
              </p>
            </div>
          </div>

          {(!activeLoan || !activeLoan.message) && (
            <Link
              to="/driver/loan-benefits"
              className="bg-white border-2 border-red-600 text-red-600 font-semibold py-2 px-4 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2 text-sm w-full lg:w-auto justify-center whitespace-nowrap"
            >
              <PlusCircle className="w-4 h-4" />
              Solicitar Préstamo
            </Link>
          )}
        </div>
      </div>

      {/* Welcome Message */}
      <div className="bg-gradient-to-r from-red-50 to-orange-50 rounded-xl border border-red-100 p-4 lg:p-5">
        <p className="text-base lg:text-lg font-semibold text-gray-800">
          {(() => {
            const hour = new Date().getHours();
            if (hour < 12) return '¡Buenos días';
            if (hour < 19) return '¡Buenas tardes';
            return '¡Buenas noches';
          })()}, <span className="text-red-600">{driver?.firstName || driver?.lastName || 'Conductor'}</span>!
        </p>
      </div>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
        {/* Completed Loans Card */}
        <div className="bg-white rounded-xl shadow-md border border-gray-200 p-5 lg:p-6 hover:shadow-lg transition-all">
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
              <CheckCircle className="w-6 h-6 text-blue-600" />
            </div>
            <span className="text-xs font-semibold text-blue-700 bg-blue-50 px-3 py-1 rounded-full">
              Historial
            </span>
          </div>
          <p className="text-3xl lg:text-4xl font-bold text-gray-900 mb-1">
            {loanHistory.completedLoans}
          </p>
          <p className="text-sm text-gray-600">
            Préstamos completados
          </p>
        </div>

        {/* Total Borrowed Card */}
        <div className="bg-white rounded-xl shadow-md border border-gray-200 p-5 lg:p-6 hover:shadow-lg transition-all">
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-purple-600" />
            </div>
            <span className="text-xs font-semibold text-purple-700 bg-purple-50 px-3 py-1 rounded-full">
              Total
            </span>
          </div>
          <p className="text-3xl lg:text-4xl font-bold text-gray-900 mb-1">
            {formatCurrency(Number(loanHistory.totalBorrowed ?? 0), country)}
          </p>
          <p className="text-sm text-gray-600">
            Histórico prestado
          </p>
        </div>

        {/* Payment Performance Card */}
        <div className="bg-white rounded-xl shadow-md border border-gray-200 p-5 lg:p-6 hover:shadow-lg transition-all sm:col-span-2 lg:col-span-1">
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
              <Activity className="w-6 h-6 text-green-600" />
            </div>
            <span className="text-xs font-semibold text-green-700 bg-green-50 px-3 py-1 rounded-full">
              Puntualidad
            </span>
          </div>
          <div className="flex items-baseline gap-2 mb-2">
            <p className="text-3xl lg:text-4xl font-bold text-gray-900">
              {Number.isFinite(Number(paymentStats.onTimeRate)) ? Number(paymentStats.onTimeRate) : 0}%
            </p>
            {(Number(paymentStats.onTimeRate) || 0) >= 90 && (
              <Award className="w-5 h-5 text-yellow-500" />
            )}
          </div>
          <p className="text-sm text-gray-600">
            Tasa de pagos a tiempo
          </p>
          {paymentStats.totalPayments > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>✅ {paymentStats.onTimePayments} a tiempo</span>
                <span>⚠️ {paymentStats.latePayments} tardíos</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Mensaje: solicitud aprobada pendiente de desembolso */}
      {dashboardData.pendingRequest && dashboardData.pendingRequest.status === 'approved' && !activeLoan && (
        <div className="bg-green-50 border-2 border-green-200 rounded-xl p-5 lg:p-6">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <CheckCircle className="w-5 h-5 text-green-700" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-bold text-green-900 mb-1">Solicitud aprobada – Falta el desembolso</h3>
              <p className="text-sm text-green-800 mb-2">
                Tu solicitud por <strong>S/ {Number(dashboardData.pendingRequest.requestedAmount ?? 0).toFixed(2)}</strong> ya fue aprobada.
                Falta realizar el desembolso para que puedas ver el detalle de las cuotas y el cronograma de pagos en Mis Préstamos.
              </p>
              <Link
                to="/driver/loans"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-700 hover:text-green-800"
              >
                Ver Mis Préstamos
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Préstamos activos de esta flota (puede haber más de uno) */}
      {activeLoansList.length > 0 ? (
        <div className="space-y-6">
          {activeLoansList.map((loan, index) => (
            <div key={loan.id} className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
              <div className="p-5 lg:p-6">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-5">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <h2 className="text-lg lg:text-xl font-bold text-gray-900">
                        Préstamo Activo{activeLoansList.length > 1 ? ` ${index + 1}` : ''}
                        {'flotaName' in loan && loan.flotaName ? ` · ${loan.flotaName}` : ''}
                      </h2>
                      <span className={`px-3 py-1 text-xs font-semibold rounded-full ${
                        loan.status === 'active'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-red-100 text-red-700'
                      }`}>
                        {loan.status === 'active' ? 'Al día' : 'Atrasado'}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600">
                      Cuota {Number(loan.paidInstallments) || 0} de {Number(loan.totalInstallments) || 0} • {(loan.paymentFrequency === 'weekly' || loan.paymentFrequency === 'semanal' || !loan.paymentFrequency) ? 'Semanal' : loan.paymentFrequency === 'biweekly' || loan.paymentFrequency === 'quincenal' ? 'Quincenal' : 'Semanal'}
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
                    <p className="text-xs text-gray-600 mb-1">Próximo pago en</p>
                    <p className={`text-xl lg:text-2xl font-bold ${
                      (loan.daysUntilPayment != null && loan.daysUntilPayment <= 3) ? 'text-red-600' : 'text-gray-900'
                    }`}>
                      {typeof loan.daysUntilPayment === 'number' && !Number.isNaN(loan.daysUntilPayment)
                        ? `${loan.daysUntilPayment} días`
                        : '—'}
                    </p>
                  </div>
                </div>

                <div className="mb-5">
                  <div className="flex items-center justify-between text-sm mb-2">
                    <span className="font-semibold text-gray-700">Progreso de Pago</span>
                    <span className="font-bold text-gray-900">
                      {(() => {
                        const total = Number(loan.totalInstallments) || 0;
                        const paid = Number(loan.paidInstallments) || 0;
                        if (total <= 0) return '0%';
                        return `${Math.round((paid / total) * 100)}%`;
                      })()}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-red-600 to-red-700 h-2.5 rounded-full transition-all duration-500"
                      style={{
                        width: `${(() => {
                          const total = Number(loan.totalInstallments) || 0;
                          const paid = Number(loan.paidInstallments) || 0;
                          if (total <= 0) return 0;
                          return Math.min(100, (paid / total) * 100);
                        })()}%`
                      }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
                  <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Calendar className="w-3.5 h-3.5 text-gray-500" />
                      <p className="text-xs text-gray-600">Monto Total</p>
                    </div>
                    <p className="text-lg lg:text-xl font-bold text-gray-900">
                      {formatCurrency(Number(loan.loanAmount ?? 0), country)}
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                    <div className="flex items-center gap-2 mb-1.5">
                      <TrendingDown className="w-3.5 h-3.5 text-red-500" />
                      <p className="text-xs text-gray-600">Saldo Pendiente</p>
                    </div>
                    <p className="text-lg lg:text-xl font-bold text-red-600">
                      {formatCurrency(Number(loan.pendingAmount ?? 0), country)}
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Clock className="w-3.5 h-3.5 text-blue-500" />
                      <p className="text-xs text-gray-600">Próxima Cuota</p>
                    </div>
                    <p className="text-lg lg:text-xl font-bold text-blue-600">
                      {formatCurrency(Number(loan.nextPaymentAmount ?? 0), country)}
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Target className="w-3.5 h-3.5 text-green-500" />
                      <p className="text-xs text-gray-600">Fecha Pago</p>
                    </div>
                    <p className="text-base font-bold text-green-600">
                      {loan.nextPaymentDate ? (() => {
                        const d = new Date(loan.nextPaymentDate);
                        if (Number.isNaN(d.getTime())) return '—';
                        return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' });
                      })() : '—'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <Link
                    to="/driver/loans"
                    className="flex-1 flex items-center justify-center gap-2 bg-gray-100 text-gray-700 px-4 py-2.5 rounded-lg font-semibold hover:bg-gray-200 transition-all text-sm"
                  >
                    <FileText className="w-4 h-4" />
                    <span>Ver Detalles</span>
                  </Link>
                  <Link
                    to={`/driver/loans/${loan.id}/vouchers`}
                    className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-red-600 to-red-700 text-white px-4 py-2.5 rounded-lg font-semibold hover:from-red-700 hover:to-red-800 transition-all text-sm shadow-md"
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>Realizar Pago</span>
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-6 lg:p-8 text-center">
          <div className="max-w-md mx-auto">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Zap className="w-8 h-8 text-red-600" />
            </div>
            <h3 className="text-xl lg:text-2xl font-bold text-gray-900 mb-2">
              ¿Necesitas financiamiento?
            </h3>
            <p className="text-gray-600 mb-6 leading-relaxed text-sm">
              Solicita tu préstamo ahora y obtén una respuesta rápida. Proceso 100% digital con tasas competitivas.
            </p>
            <Link
              to="/driver/loan-benefits"
              className="inline-flex items-center gap-2 bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-lg font-semibold hover:from-red-700 hover:to-red-800 transition-all shadow-md text-sm"
            >
              <PlusCircle className="w-5 h-5" />
              <span>Solicitar Préstamo</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      )}

      {/* Payment Stats and Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Payment Performance */}
        <div className="bg-white rounded-xl shadow-md border border-gray-200 p-6 lg:p-8">
          <div className="mb-6">
            <h3 className="text-lg lg:text-xl font-bold text-gray-900">Desempeño de Pagos</h3>
            <p className="text-sm text-gray-600">Tus estadísticas de puntualidad</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div className="flex flex-col p-4 bg-gray-50 rounded-lg border border-gray-200">
              <span className="font-semibold text-gray-700 text-sm mb-2">Pagos a Tiempo</span>
              <span className="text-3xl lg:text-4xl font-bold text-gray-900">
                {paymentStats.onTimePayments}
              </span>
            </div>

            <div className="flex flex-col p-4 bg-gray-50 rounded-lg border border-gray-200">
              <span className="font-semibold text-gray-700 text-sm mb-2">Pagos Tardíos</span>
              <span className="text-3xl lg:text-4xl font-bold text-gray-900">
                {paymentStats.latePayments}
              </span>
            </div>
          </div>

          {paymentStats.totalPayments > 0 ? (
            <div className="pt-4 border-t border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-gray-700">Tasa de Puntualidad</span>
                <span className="text-lg font-bold text-gray-900">
                  {Number.isFinite(Number(paymentStats.onTimeRate)) ? Number(paymentStats.onTimeRate) : 0}%
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className="bg-gradient-to-r from-green-600 to-emerald-500 h-2.5 rounded-full transition-all"
                  style={{ width: `${Math.min(100, Math.max(0, Number(paymentStats.onTimeRate) || 0))}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="pt-4 border-t border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-gray-700">Tasa de Puntualidad</span>
                <span className="text-lg font-bold text-gray-900">0%</span>
              </div>
              <p className="text-xs text-gray-500">Aún no tienes pagos registrados</p>
            </div>
          )}
        </div>

        {/* Recent Payments */}
        <div className="bg-white rounded-xl shadow-md border border-gray-200 p-6 lg:p-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-lg lg:text-xl font-bold text-gray-900">Pagos Recientes</h3>
              <p className="text-sm text-gray-600">Tus últimos movimientos</p>
            </div>
            <Link
              to="/driver/loans"
              className="text-sm text-red-600 hover:text-red-700 font-semibold"
            >
              Ver todos
            </Link>
          </div>

          {recentPayments.length > 0 ? (
            <div className="space-y-3">
              {recentPayments.filter(Boolean).map((payment, idx) => (
                <div
                  key={payment?.id ?? `payment-${idx}`}
                  className="flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors border border-gray-100"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                      <CheckCircle className="w-5 h-5 text-green-600" />
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">
                        {formatCurrency(Number(payment?.amount ?? 0), country)}
                      </p>
                      <p className="text-sm text-gray-600">
                        {payment?.paymentDate ? new Date(payment.paymentDate).toLocaleDateString('es-PE', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric'
                        }) : '—'}
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-gray-500 bg-white px-3 py-1 rounded-full border border-gray-200 capitalize">
                    {payment?.paymentMethod ?? 'N/A'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <CreditCard className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">No hay pagos registrados aún</p>
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-6">
        <Link
          to="/driver/loans"
          className="group bg-white rounded-xl shadow-md border border-gray-200 p-6 hover:shadow-lg transition-all"
        >
          <div className="mb-4">
            <h3 className="text-lg font-bold text-gray-900 mb-1">Mis Préstamos</h3>
            <p className="text-sm text-gray-600">Historial completo</p>
          </div>
          <div className="flex items-center space-x-2 text-gray-700 group-hover:text-red-600 font-semibold">
            <span>Ver todos mis préstamos</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </div>
        </Link>

        <Link
          to="/driver/profile"
          className="group bg-white rounded-xl shadow-md border border-gray-200 p-6 hover:shadow-lg transition-all"
        >
          <div className="mb-4">
            <h3 className="text-lg font-bold text-gray-900 mb-1">Mi Perfil</h3>
            <p className="text-sm text-gray-600">Información personal</p>
          </div>
          <div className="flex items-center space-x-2 text-gray-700 group-hover:text-red-600 font-semibold">
            <span>Actualizar datos</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </div>
        </Link>
      </div>
    </div>
  );
}




