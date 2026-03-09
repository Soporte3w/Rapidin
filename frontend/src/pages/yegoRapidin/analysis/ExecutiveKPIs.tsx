import { useState, useEffect } from 'react';
import { RefreshCw, FileText, Banknote, DollarSign, AlertCircle, TrendingUp } from 'lucide-react';
import api from '../../../services/api';

interface ExecutiveKPIsProps {
  country: string;
}

function ExecutiveKPIs({ country }: ExecutiveKPIsProps) {
  const [kpis, setKpis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const currencyLabel = country === 'PE' ? 'S/.' : country === 'CO' ? 'COP' : '';

  const fetchKPIs = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/kpis/executive', { params: { country } });
      const raw = response.data?.data ?? response.data;
      setKpis(raw && typeof raw === 'object' ? raw : null);
    } catch (err) {
      console.error('Error fetching KPIs:', err);
      setError((err as any)?.response?.data?.message || 'Error al cargar KPIs ejecutivos');
      setKpis(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKPIs();
  }, [country]);

  if (loading && !kpis) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-red-600 border-t-transparent" />
      </div>
    );
  }

  if (error && !kpis) {
    return (
      <div className="space-y-4">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">{error}</div>
        <button
          onClick={fetchKPIs}
          className="bg-gradient-to-r from-red-600 to-red-700 text-white font-semibold py-2 px-5 rounded-lg"
        >
          Reintentar
        </button>
      </div>
    );
  }

  const kpiCards = kpis
    ? [
        { title: 'Total Solicitudes', value: String(kpis.total_requests ?? 0), icon: FileText, color: 'bg-blue-100 text-blue-600' },
        { title: 'Préstamos Activos', value: String(kpis.active_loans ?? 0), icon: Banknote, color: 'bg-green-100 text-green-600' },
        { title: 'Cartera Total (saldo pendiente)', value: `${currencyLabel} ${parseFloat(kpis.total_portfolio || 0).toFixed(2)}`, icon: DollarSign, color: 'bg-amber-100 text-amber-700' },
        { title: 'Préstamos con cuotas vencidas', value: String(kpis.overdue_installments ?? 0), icon: AlertCircle, color: 'bg-red-100 text-red-600' },
        { title: 'Cobros últimos 30 días', value: `${currencyLabel} ${Number(kpis.payments_last_30_days ?? 0).toFixed(2)}`, icon: TrendingUp, color: 'bg-purple-100 text-purple-600', subtitle: 'Suma de pagos registrados' },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={fetchKPIs}
          disabled={loading}
          className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-semibold py-2 px-5 rounded-lg transition-all shadow-md flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Actualizar KPIs
        </button>
      </div>

      {kpiCards.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {kpiCards.map((card, index) => {
            const Icon = card.icon;
            return (
              <div key={index} className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 hover:shadow-md transition-all">
                <div className={`${card.color} p-2.5 rounded-lg w-fit mb-2`}>
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="text-xs font-medium text-gray-600 mb-1">{card.title}</h3>
                <p className={`text-xl font-bold ${index === 2 ? 'text-red-600' : 'text-gray-900'}`}>{card.value}</p>
                {'subtitle' in card && (card as { subtitle?: string }).subtitle && (
                  <p className="text-xs text-gray-500 mt-1">{(card as { subtitle: string }).subtitle}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && !error && kpiCards.length === 0 && (
        <div className="bg-gray-50 rounded-lg border border-gray-200 p-8 text-center text-gray-600 text-sm">
          No hay datos de KPIs para este país.
        </div>
      )}
    </div>
  );
}

export default ExecutiveKPIs;






