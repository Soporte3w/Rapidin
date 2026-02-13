import { useState, useEffect, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import api from '../../services/api';

interface VintageAnalysisProps {
  country: string;
}

// Formatear YYYY-MM o fecha ISO como "ene 2026" en hora local (evitar UTC que muestra mes anterior)
const formatCohortLabel = (v: string) => {
  if (!v) return '';
  const s = String(v).trim().slice(0, 7);
  const match = s.match(/^(\d{4})-(\d{2})$/);
  if (!match) return v;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const d = new Date(year, month, 1);
  return isNaN(d.getTime()) ? v : d.toLocaleDateString('es-ES', { month: 'short', year: 'numeric' });
};

const VintageAnalysis: React.FC<VintageAnalysisProps> = ({ country }) => {
  const [cohortMonth, setCohortMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchAnalysis = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/analysis/vintage', {
        params: { country, cohort_month: cohortMonth },
      });
      const raw = response.data?.data ?? response.data;
      setData(Array.isArray(raw) ? raw : []);
    } catch (err) {
      console.error('Error fetching vintage analysis:', err);
      setError((err as any)?.response?.data?.message || 'Error al cargar el análisis vintage');
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalysis();
  }, [country]);

  const chartData = useMemo(
    () =>
      data.map((row) => ({
        ...row,
        cohort_label: formatCohortLabel(row.cohort_month || ''),
      })),
    [data]
  );

  const totals = useMemo(() => {
    const t = data.reduce(
      (acc, row) => ({
        total_loans: acc.total_loans + Number(row.total_loans || 0),
        paid_loans: acc.paid_loans + Number(row.paid_loans || 0),
        defaulted_loans: acc.defaulted_loans + Number(row.defaulted_loans || 0),
      }),
      { total_loans: 0, paid_loans: 0, defaulted_loans: 0 }
    );
    return t;
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 max-w-xs">
            <label className="block text-xs font-semibold text-gray-900 mb-1.5">Mes de cohort (desembolso)</label>
            <input
              type="month"
              value={cohortMonth}
              onChange={(e) => setCohortMonth(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={fetchAnalysis}
              disabled={loading}
              className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-semibold py-2 px-5 rounded-lg transition-all shadow-md flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm whitespace-nowrap"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Actualizar
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}

      {loading && data.length === 0 ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-red-600 border-t-transparent" />
        </div>
      ) : chartData.length > 0 ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-blue-50 rounded-lg border border-blue-100 p-3 text-center">
              <p className="text-xs font-medium text-blue-700">Total préstamos</p>
              <p className="text-lg font-bold text-blue-900">{totals.total_loans}</p>
            </div>
            <div className="bg-green-50 rounded-lg border border-green-100 p-3 text-center">
              <p className="text-xs font-medium text-green-700">Pagados</p>
              <p className="text-lg font-bold text-green-900">{totals.paid_loans}</p>
            </div>
            <div className="bg-red-50 rounded-lg border border-red-100 p-3 text-center">
              <p className="text-xs font-medium text-red-700">Incumplidos</p>
              <p className="text-lg font-bold text-red-900">{totals.defaulted_loans}</p>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Préstamos por cohort (mes de desembolso)</h3>
            <ResponsiveContainer width="100%" height={360}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="cohort_label" stroke="#6b7280" tick={{ fontSize: 11 }} />
                <YAxis stroke="#6b7280" />
                <Tooltip
                  contentStyle={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '12px' }}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.cohort_label || ''}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar dataKey="total_loans" fill="#3b82f6" name="Total Préstamos" />
                <Bar dataKey="paid_loans" fill="#10b981" name="Pagados" />
                <Bar dataKey="defaulted_loans" fill="#ef4444" name="Incumplidos" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : (
        <div className="bg-gray-50 rounded-lg border border-gray-200 p-8 text-center text-gray-600 text-sm">
          No hay datos de cohort para el mes seleccionado.
        </div>
      )}
    </div>
  );
};

export default VintageAnalysis;






