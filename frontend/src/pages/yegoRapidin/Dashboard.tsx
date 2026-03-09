import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../services/api';
import {
  FileText,
  Banknote,
  TrendingUp,
  LayoutDashboard,
  AlertCircle,
  CreditCard,
  BarChart3,
  ArrowRight,
  RefreshCw,
  DollarSign,
} from 'lucide-react';

const Dashboard = () => {
  const { user } = useAuth();
  const [country, setCountry] = useState<string>(user?.country || 'PE');
  const [kpis, setKpis] = useState<{
    total_requests?: number;
    active_loans?: number;
    total_portfolio?: number;
    overdue_installments?: number;
    payments_last_30_days?: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const countryName = country === 'PE' ? 'Perú' : country === 'CO' ? 'Colombia' : '';
  const currencyLabel = country === 'PE' ? 'S/.' : country === 'CO' ? 'COP' : '';

  const fetchStats = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await api.get('/kpis/executive', { params: { country } });
      const raw = response.data?.data ?? response.data;
      const data = raw && typeof raw === 'object' ? raw : null;
      setKpis(data ? {
        total_requests: Number(data.total_requests) || 0,
        active_loans: Number(data.active_loans) || 0,
        total_portfolio: data.total_portfolio != null ? Number(data.total_portfolio) : 0,
        overdue_installments: Number(data.overdue_installments) || 0,
        payments_last_30_days: Number(data.payments_last_30_days) || 0,
      } : null);
    } catch (err: any) {
      console.error('Error fetching dashboard:', err);
      setError(err.response?.data?.message || 'Error al cargar el dashboard');
      setKpis(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, [country]);

  const n = (v: number | string | null | undefined) => (v != null && v !== '') ? Number(v) : 0;
  const statCards = kpis
    ? [
        { title: 'Total Solicitudes', value: String(n(kpis.total_requests)), icon: FileText, iconBg: 'bg-blue-100', iconColor: 'text-blue-600' },
        { title: 'Préstamos Activos', value: String(n(kpis.active_loans)), icon: Banknote, iconBg: 'bg-green-100', iconColor: 'text-green-600' },
        { title: 'Cartera Total', value: `${currencyLabel} ${n(kpis.total_portfolio).toFixed(2)}`, icon: TrendingUp, iconBg: 'bg-amber-100', iconColor: 'text-amber-700', highlight: true },
        { title: 'Préstamos con cuotas vencidas', value: String(n(kpis.overdue_installments)), icon: AlertCircle, iconBg: 'bg-red-100', iconColor: 'text-red-600', alert: n(kpis.overdue_installments) > 0 },
        { title: 'Cobros últimos 30 días', value: `${currencyLabel} ${n(kpis.payments_last_30_days).toFixed(2)}`, icon: DollarSign, iconBg: 'bg-purple-100', iconColor: 'text-purple-600' },
      ]
    : [];

  if (loading && !kpis) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-red-600 border-t-transparent mx-auto mb-3" />
          <p className="text-sm text-gray-600">Cargando indicadores...</p>
        </div>
      </div>
    );
  }

  if (error && !kpis) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh]">
        <div className="bg-red-50 border border-red-200 rounded-full p-4 mb-4">
          <AlertCircle className="w-10 h-10 text-red-600" />
        </div>
        <h3 className="text-lg font-bold text-gray-900 mb-2">Error al cargar el dashboard</h3>
        <p className="text-gray-600 text-sm mb-4 text-center max-w-md">{error}</p>
        <button
          onClick={fetchStats}
          className="bg-red-600 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-red-700 transition-colors"
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
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <LayoutDashboard className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Dashboard</h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                Hola, <span className="font-semibold">{user?.first_name}</span> · {countryName || 'Selecciona país'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="dashboard-country" className="sr-only">País</label>
            <select
              id="dashboard-country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="min-w-[120px] rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-800 shadow-sm focus:border-red-500 focus:ring-2 focus:ring-red-500/20 focus:outline-none cursor-pointer"
            >
              <option value="PE">Perú</option>
              <option value="CO">Colombia</option>
            </select>
            <button
              onClick={fetchStats}
              disabled={loading}
              className="bg-white/20 hover:bg-white/30 text-white p-2 rounded-lg transition-colors disabled:opacity-50"
              title="Actualizar"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.title}
              className={`bg-white rounded-lg border shadow-sm p-4 transition-all ${
                (card as { alert?: boolean }).alert ? 'border-red-200 bg-red-50/30' : 'border-gray-200 hover:shadow-md'
              }`}
            >
              <div className={`${card.iconBg} p-2.5 rounded-lg w-fit mb-2`}>
                <Icon className={`h-5 w-5 ${card.iconColor}`} />
              </div>
              <h3 className="text-xs font-medium text-gray-600 mb-1">{card.title}</h3>
              <p
                className={`text-xl font-bold ${
                  (card as { highlight?: boolean }).highlight ? 'text-red-600' : (card as { alert?: boolean }).alert ? 'text-red-700' : 'text-gray-900'
                }`}
              >
                {card.value}
              </p>
            </div>
          );
        })}
      </div>

      {/* Accesos rápidos */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/50">
          <h2 className="text-sm font-semibold text-gray-800">Accesos rápidos</h2>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Link
            to="/admin/loan-requests"
            className="flex items-center justify-between gap-3 p-4 rounded-lg border border-gray-200 hover:border-red-200 hover:bg-red-50/30 transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="bg-blue-100 p-2.5 rounded-lg">
                <FileText className="h-5 w-5 text-blue-600" />
              </div>
              <span className="font-medium text-gray-900">Solicitudes</span>
            </div>
            <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-red-600" />
          </Link>
          <Link
            to="/admin/loans"
            className="flex items-center justify-between gap-3 p-4 rounded-lg border border-gray-200 hover:border-red-200 hover:bg-red-50/30 transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="bg-green-100 p-2.5 rounded-lg">
                <Banknote className="h-5 w-5 text-green-600" />
              </div>
              <span className="font-medium text-gray-900">Préstamos</span>
            </div>
            <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-red-600" />
          </Link>
          <Link
            to="/admin/payments"
            className="flex items-center justify-between gap-3 p-4 rounded-lg border border-gray-200 hover:border-red-200 hover:bg-red-50/30 transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="bg-amber-100 p-2.5 rounded-lg">
                <CreditCard className="h-5 w-5 text-amber-600" />
              </div>
              <span className="font-medium text-gray-900">Pagos</span>
            </div>
            <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-red-600" />
          </Link>
          <Link
            to="/admin/analysis"
            className="flex items-center justify-between gap-3 p-4 rounded-lg border border-gray-200 hover:border-red-200 hover:bg-red-50/30 transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="bg-purple-100 p-2.5 rounded-lg">
                <BarChart3 className="h-5 w-5 text-purple-600" />
              </div>
              <span className="font-medium text-gray-900">Análisis</span>
            </div>
            <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-red-600" />
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
