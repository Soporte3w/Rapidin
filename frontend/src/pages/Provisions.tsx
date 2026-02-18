import { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import api from '../services/api';
import { Calculator, TrendingUp, AlertCircle, FileText, Info } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';

const Provisions = () => {
  const { user } = useAuth();
  const [country, setCountry] = useState(user?.country || 'PE');
  const [history, setHistory] = useState<any[]>([]);
  const [par, setPar] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchHistory(), fetchPAR()]).finally(() => setLoading(false));
  }, [country]);

  const fetchHistory = async () => {
    try {
      setError('');
      const response = await api.get('/provisions/history', { params: { country } });
      let historyData: any[] = [];
      if (response.data) {
        const raw = response.data.success !== false ? response.data.data : response.data;
        historyData = Array.isArray(raw) ? raw : Array.isArray(response.data.data) ? response.data.data : [];
      }
      setHistory(historyData);
    } catch (error: any) {
      console.error('Error fetching provisions history:', error);
      setError(error.response?.data?.message || 'Error al cargar el historial de provisiones');
      setHistory([]);
    }
  };

  const fetchPAR = async () => {
    try {
      const response = await api.get('/provisions/par', { params: { country, days: 30 } });
      const raw = response.data?.data ?? response.data;
      setPar(raw && typeof raw === 'object' ? raw : null);
    } catch (error: any) {
      console.error('Error fetching PAR:', error);
      setPar(null);
    }
  };

  const handleCalculate = async () => {
    try {
      setLoading(true);
      setError('');
      await api.post('/provisions/calculate', { country });
      toast.success('Provisiones calculadas correctamente');
      await Promise.all([fetchHistory(), fetchPAR()]);
    } catch (error: any) {
      console.error('Error calculating provisions:', error);
      toast.error(error.response?.data?.message || 'Error al calcular las provisiones');
    } finally {
      setLoading(false);
    }
  };

  const countryName = country === 'PE' ? 'Perú' : country === 'CO' ? 'Colombia' : '';
  const currencyLabel = country === 'PE' ? 'S/.' : country === 'CO' ? 'COP' : '';
  const chartData = useMemo(() => [...history].reverse(), [history]);

  if (loading && history.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-red-600 border-t-transparent mx-auto mb-4" />
          <p className="text-gray-600">Cargando provisiones...</p>
        </div>
      </div>
    );
  }

  if (error && history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="bg-red-50 border-2 border-red-200 rounded-full p-4 mb-4">
          <AlertCircle className="w-12 h-12 text-red-600" />
        </div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Error al cargar las provisiones</h3>
        <p className="text-gray-600 mb-6 text-center max-w-md">{error}</p>
        <button
          onClick={fetchHistory}
          className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-lg font-medium hover:from-red-700 hover:to-red-800 transition-all shadow-md"
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
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <TrendingUp className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
                Provisiones
              </h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                Gestión y cálculo de provisiones - {countryName || 'Todos los países'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Qué son las provisiones */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
        <Info className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-gray-700">
          <p className="font-semibold text-gray-900 mb-1">¿Qué son las provisiones?</p>
          <p>
            Es el monto que se reserva por posible incobrabilidad según días de atraso: 7+ días 25%, 30+ días 50%, 60+ días 75%, 90+ días 100%.
            Se calcula sobre la cartera activa por país. El historial y el PAR se actualizan al hacer clic en &quot;Calcular Provisiones&quot;.
          </p>
        </div>
      </div>

      {/* Filtros y botón */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label htmlFor="country" className="block text-xs font-semibold text-gray-900 mb-1.5">
              País
            </label>
            <select
              id="country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none transition-all text-sm"
            >
              <option value="PE">Perú</option>
              <option value="CO">Colombia</option>
            </select>
          </div>
          <div className="flex items-end">
            <button
              onClick={handleCalculate}
              disabled={loading}
              className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-semibold py-2 px-5 rounded-lg transition-all shadow-md flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm whitespace-nowrap"
            >
              <Calculator className="h-4 w-4" />
              Calcular Provisiones
            </button>
          </div>
        </div>
      </div>

      {/* Cards de PAR (Portfolio at Risk) */}
      {par && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">PAR 30</h3>
            <p className="text-2xl font-bold text-red-600 mb-1">
              {parseFloat(par.par_percentage || 0).toFixed(2)}%
            </p>
            <p className="text-xs text-gray-600">
              {currencyLabel} {parseFloat(par.par_amount || 0).toFixed(2)} en riesgo (cuotas con 30+ días de atraso)
            </p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Préstamos en Riesgo</h3>
            <p className="text-2xl font-bold text-gray-900">{par.par_loans ?? 0}</p>
            <p className="text-xs text-gray-600">Préstamos con al menos una cuota vencida 30+ días</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Cartera Total Activa</h3>
            <p className="text-2xl font-bold text-gray-900">
              {currencyLabel} {parseFloat(par.total_portfolio || 0).toFixed(2)}
            </p>
            <p className="text-xs text-gray-600">Saldo pendiente de préstamos activos</p>
          </div>
        </div>
      )}

      {/* Gráfico histórico (% provisión en el tiempo) */}
      {chartData.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Evolución del % de Provisión</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis 
                dataKey="calculation_date" 
                stroke="#6b7280" 
                tickFormatter={(v) => (v ? new Date(v).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' }) : '')}
              />
              <YAxis stroke="#6b7280" tickFormatter={(v) => `${v}%`} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '12px' }}
                labelFormatter={(v) => (v ? new Date(v).toLocaleDateString('es-ES', { dateStyle: 'medium' }) : '')}
                formatter={(value: number) => [`${Number(value).toFixed(2)}%`, '% Provisión']}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Line type="monotone" dataKey="provision_percentage" stroke="#ef4444" strokeWidth={2} name="% Provisión" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Tabla de historial */}
      {history.length === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 lg:p-12 text-center">
          <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <FileText className="w-10 h-10 text-gray-400" />
          </div>
          <h3 className="text-xl lg:text-2xl font-bold text-gray-900 mb-2">
            No hay historial de provisiones
          </h3>
          <p className="text-gray-600 mb-6 text-base">
            Calcula las provisiones para ver el historial
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Fecha
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Cartera Total
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Monto Provisionado
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    % Provisión
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Préstamos Activos
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Préstamos Vencidos
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {history.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {item.calculation_date ? new Date(item.calculation_date).toLocaleDateString('es-ES', { 
                        year: 'numeric', 
                        month: 'short', 
                        day: 'numeric' 
                      }) : 'N/A'}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {currencyLabel} {parseFloat(item.total_amount || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm font-semibold text-gray-900">
                      {currencyLabel} {parseFloat(item.provisioned_amount || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm font-semibold text-red-600">
                      {parseFloat(item.provision_percentage || 0).toFixed(2)}%
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {item.active_loans || 0}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                      {item.overdue_loans || 0}
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

export default Provisions;







