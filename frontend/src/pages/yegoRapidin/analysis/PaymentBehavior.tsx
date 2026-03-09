import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import api from '../../../services/api';

interface PaymentBehaviorProps {
  country: string;
}

const PaymentBehavior: React.FC<PaymentBehaviorProps> = ({ country }) => {
  const [startDate, setStartDate] = useState(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const currencyLabel = country === 'PE' ? 'S/.' : country === 'CO' ? 'COP' : '';

  const fetchAnalysis = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/analysis/payment-behavior', {
        params: { country, start_date: startDate, end_date: endDate },
      });
      const raw = response.data?.data ?? response.data;
      setData(Array.isArray(raw) ? raw : []);
    } catch (err) {
      console.error('Error fetching payment behavior:', err);
      setError((err as any)?.response?.data?.message || 'Error al cargar comportamiento de pago');
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalysis();
  }, [country]);

  const totalCuotas = data.reduce((s, r) => s + Number(r.total_installments || 0), 0);

  return (
    <div className="space-y-4">
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label className="block text-xs font-semibold text-gray-900 mb-1.5">Fecha Inicio (vencimiento cuota)</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs font-semibold text-gray-900 mb-1.5">Fecha Fin</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
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
      ) : data.length > 0 ? (
        <>
          <p className="text-sm text-gray-600">
            Cuotas con vencimiento en el período: <strong>{totalCuotas}</strong> (por número de cuota).
          </p>
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Cuota</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Total</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">A tiempo</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Tarde</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Vencidas</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Días atraso (prom.)</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Total mora</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {data.map((row) => (
                    <tr key={row.installment_number} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">{row.installment_number}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">{row.total_installments}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-green-700">{row.paid_on_time ?? 0}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-amber-700">{row.paid_late ?? 0}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-red-700">{row.overdue ?? 0}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">{parseFloat(row.avg_days_overdue || 0).toFixed(1)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-semibold text-gray-900">
                        {currencyLabel} {parseFloat(row.total_late_fees || 0).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="bg-gray-50 rounded-lg border border-gray-200 p-8 text-center text-gray-600 text-sm">
          No hay datos de comportamiento de pago para el rango de fechas seleccionado.
        </div>
      )}
    </div>
  );
};

export default PaymentBehavior;






