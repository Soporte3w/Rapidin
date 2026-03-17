import { useState, useEffect } from 'react';
import { FileText, CheckCircle, TrendingUp, XCircle, DollarSign, BarChart3 } from 'lucide-react';
import api from '../../../services/api';
import { DateRangePicker } from '../../../components/DateRangePicker';

interface WeeklyAnalysisProps {
  country: string;
}

const defaultStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const defaultEnd = new Date().toISOString().split('T')[0];

const WeeklyAnalysis: React.FC<WeeklyAnalysisProps> = ({ country }) => {
  const [dateFrom, setDateFrom] = useState(defaultStart);
  const [dateTo, setDateTo] = useState(defaultEnd);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const currencyLabel = country === 'PE' ? 'S/.' : country === 'CO' ? 'COP' : '';

  const fetchAnalysis = async () => {
    setLoading(true);
    setError('');
    try {
      const start_date = dateFrom || defaultStart;
      const end_date = dateTo || defaultEnd;
      const response = await api.get('/analysis/weekly', {
        params: { country, start_date, end_date },
      });
      const raw = response.data?.data ?? response.data;
      setData(raw && typeof raw === 'object' ? raw : null);
    } catch (err) {
      console.error('Error fetching weekly analysis:', err);
      setError((err as any)?.response?.data?.message || 'Error al cargar el análisis semanal');
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalysis();
  }, [country, dateFrom, dateTo]);

  const statCards = data
    ? [
        { title: 'Solicitudes Pendientes', value: String(data.pending_requests ?? 0), icon: FileText, color: 'bg-yellow-100 text-yellow-600' },
        { title: 'Solicitudes Aprobadas', value: String(data.approved_requests ?? 0), icon: CheckCircle, color: 'bg-green-100 text-green-600' },
        { title: 'Préstamos Desembolsados', value: String(data.disbursed_loans ?? 0), icon: TrendingUp, color: 'bg-blue-100 text-blue-600' },
        { title: 'Solicitudes Rechazadas', value: String(data.rejected_requests ?? 0), icon: XCircle, color: 'bg-red-100 text-red-600' },
        { title: 'Monto Total Desembolsado', value: `${currencyLabel} ${parseFloat(data.total_disbursed || 0).toFixed(2)}`, icon: DollarSign, color: 'bg-amber-100 text-amber-600' },
        { title: 'Monto Promedio por Préstamo', value: `${currencyLabel} ${parseFloat(data.avg_loan_amount || 0).toFixed(2)}`, icon: BarChart3, color: 'bg-purple-100 text-purple-600' },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
        <DateRangePicker
          label="Fecha"
          value={{ date_from: dateFrom, date_to: dateTo }}
          onChange={(r) => {
            setDateFrom(r.date_from);
            setDateTo(r.date_to);
          }}
          placeholder="Filtrar por fecha"
        />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-red-600 border-t-transparent" />
        </div>
      ) : statCards.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {statCards.map((card, index) => {
            const Icon = card.icon;
            return (
              <div key={index} className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 hover:shadow-md transition-all">
                <div className={`${card.color} p-2.5 rounded-lg w-fit mb-2`}>
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="text-xs font-medium text-gray-600 mb-1">{card.title}</h3>
                <p className={`text-xl font-bold ${index === 4 ? 'text-red-600' : 'text-gray-900'}`}>{card.value}</p>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-gray-50 rounded-lg border border-gray-200 p-8 text-center text-gray-600 text-sm">
          No hay datos para el rango de fechas seleccionado. Prueba otro intervalo o país.
        </div>
      )}
    </div>
  );
};

export default WeeklyAnalysis;






