import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import { CreditCard, Eye, DollarSign, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate } from '../../utils/date';
import toast from 'react-hot-toast';

interface AlquilerVentaItem {
  id: string;
  dni: string;
  status: string;
  created_at: string;
  fecha_inicio_cobro_semanal: string;
  driver_name?: string;
  phone?: string;
  email?: string;
  cronograma_name?: string;
  vehiculo_name?: string;
  cuotas_semanales_plan?: number;
  total_cuotas: number;
  cuotas_pagadas: number;
  cuotas_vencidas: number;
  total_pagado: number;
}

interface CuotaSemanal {
  id: string;
  due_date: string;
  week_start_date: string;
  amount_due: number;
  paid_amount: number;
  late_fee: number;
  status: string;
  pending_total: number;
}

function conductorDisplay(row: AlquilerVentaItem): string {
  if (row.driver_name) return row.driver_name;
  if (row.phone) return `Tel: ${row.phone}`;
  if (row.email) return row.email;
  return '—';
}

const COUNTRY_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'PE', label: 'Perú' },
  { value: 'CO', label: 'Colombia' },
];

export default function YegoMiAutoPayments() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [items, setItems] = useState<AlquilerVentaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [country, setCountry] = useState((user?.country as string) || '');
  const [modalPagar, setModalPagar] = useState<AlquilerVentaItem | null>(null);
  const [cuotas, setCuotas] = useState<CuotaSemanal[]>([]);
  const [loadingCuotas, setLoadingCuotas] = useState(false);
  const [pagoMonto, setPagoMonto] = useState('');
  const [pagoMoneda, setPagoMoneda] = useState<'PEN' | 'USD'>('PEN');
  const [cuotaSeleccionadaId, setCuotaSeleccionadaId] = useState<string>('');
  const [enviando, setEnviando] = useState(false);

  const fetchList = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const params = new URLSearchParams();
      params.append('page', '1');
      params.append('limit', '500');
      if (country) params.append('country', country);
      const response = await api.get(`/miauto/alquiler-venta?${params.toString()}`);
      const data = response.data?.data ?? [];
      setItems(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e.response?.data?.message || 'Error al cargar');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [country]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const abrirModalPagar = useCallback(async (row: AlquilerVentaItem) => {
    setModalPagar(row);
    setCuotaSeleccionadaId('');
    setPagoMonto('');
    setPagoMoneda('PEN');
    setCuotas([]);
    try {
      setLoadingCuotas(true);
      const res = await api.get(`/miauto/solicitudes/${row.id}/cuotas-semanales`);
      const payload = res.data?.data ?? res.data;
      const lista = Array.isArray(payload) ? payload : (payload?.data ?? []);
      const conPendiente = lista.filter(
        (c: CuotaSemanal) =>
          (c.status === 'pending' || c.status === 'overdue') &&
          (c.pending_total == null || Number(c.pending_total) > 0)
      );
      setCuotas(conPendiente);
      if (conPendiente.length > 0) {
        setCuotaSeleccionadaId(conPendiente[0].id);
      }
    } catch {
      setCuotas([]);
      toast.error('No se pudieron cargar las cuotas');
    } finally {
      setLoadingCuotas(false);
    }
  }, []);

  const cerrarModal = useCallback(() => {
    setModalPagar(null);
    setCuotas([]);
    setCuotaSeleccionadaId('');
    setPagoMonto('');
  }, []);

  const registrarPago = async () => {
    if (!modalPagar || !cuotaSeleccionadaId) {
      toast.error('Elige una cuota');
      return;
    }
    const monto = parseFloat(pagoMonto);
    if (Number.isNaN(monto) || monto <= 0) {
      toast.error('Indica un monto válido');
      return;
    }
    try {
      setEnviando(true);
      await api.post(
        `/miauto/solicitudes/${modalPagar.id}/cuotas-semanales/${cuotaSeleccionadaId}/pago-manual`,
        { monto, moneda: pagoMoneda }
      );
      toast.success('Pago manual registrado');
      cerrarModal();
      fetchList();
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al registrar pago');
    } finally {
      setEnviando(false);
    }
  };

  const countryLabel = COUNTRY_OPTIONS.find((o) => o.value === country)?.label ?? 'Todos';

  return (
    <div className="space-y-4 lg:space-y-6">
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
            <CreditCard className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Pagos</h1>
            <p className="text-xs lg:text-sm text-white/90 mt-0.5">
              Registrar pago manual a los contratos de Alquiler / Venta — {countryLabel}
            </p>
          </div>
        </div>
      </header>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <label htmlFor="country-pagos" className="block text-xs font-semibold text-gray-900 mb-1.5">
          País
        </label>
        <select
          id="country-pagos"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm"
        >
          {COUNTRY_OPTIONS.map((o) => (
            <option key={o.value || 'all'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 text-center">
          <CreditCard className="w-10 h-10 text-gray-400 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-900 mb-2">No hay contratos</h3>
          <p className="text-gray-600 text-sm">
            No hay contratos de Alquiler / Venta. Para registrar pagos manuales primero deben existir contratos con cobro semanal activo.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto bg-white rounded-lg border border-gray-200 shadow-sm">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Conductor</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">DNI</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Cronograma</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Cuotas</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Vencidas</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Total pagado</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {items.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{conductorDisplay(row)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{row.dni}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{row.cronograma_name || '—'}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {row.cuotas_pagadas} / {(row.cuotas_semanales_plan ?? row.total_cuotas) || 0}
                  </td>
                  <td className="px-4 py-3">
                    {row.cuotas_vencidas > 0 ? (
                      <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                        {row.cuotas_vencidas}
                      </span>
                    ) : (
                      <span className="text-gray-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-green-700">S/. {row.total_pagado.toFixed(2)}</td>
                  <td className="px-4 py-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/admin/yego-mi-auto/rent-sale/${row.id}`, { state: { driver_name: row.driver_name } })}
                      className="inline-flex items-center gap-1 px-2 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg border border-gray-300"
                    >
                      <Eye className="w-4 h-4" />
                      Ver detalle
                    </button>
                    <button
                      type="button"
                      onClick={() => abrirModalPagar(row)}
                      className="inline-flex items-center gap-1 px-2 py-1.5 text-sm font-medium text-[#8B1A1A] hover:bg-red-50 rounded-lg border border-[#8B1A1A]"
                    >
                      <DollarSign className="w-4 h-4" />
                      Pagar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Registrar pago manual */}
      {modalPagar && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={cerrarModal}>
          <div
            className="bg-white rounded-xl shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-900">Registrar pago manual</h2>
              <button type="button" onClick={cerrarModal} className="p-1 text-gray-500 hover:text-gray-700 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              Contrato: <strong>{conductorDisplay(modalPagar)}</strong> — DNI {modalPagar.dni}
            </p>

            {loadingCuotas ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-[#8B1A1A] border-t-transparent" />
              </div>
            ) : cuotas.length === 0 ? (
              <p className="text-sm text-gray-500 py-4">No hay cuotas con saldo pendiente para este contrato.</p>
            ) : (
              <>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cuota</label>
                <select
                  value={cuotaSeleccionadaId}
                  onChange={(e) => setCuotaSeleccionadaId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4"
                >
                  {cuotas.map((c) => (
                    <option key={c.id} value={c.id}>
                      Vence {formatDate(c.due_date || c.week_start_date, 'es-ES')} — S/. {(c.pending_total ?? 0).toFixed(2)} pendiente
                    </option>
                  ))}
                </select>

                <label className="block text-sm font-medium text-gray-700 mb-1">Monto</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={pagoMonto}
                  onChange={(e) => setPagoMonto(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-2"
                />

                <label className="block text-sm font-medium text-gray-700 mb-1">Moneda</label>
                <select
                  value={pagoMoneda}
                  onChange={(e) => setPagoMoneda(e.target.value as 'PEN' | 'USD')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4"
                >
                  <option value="PEN">S/. Soles</option>
                  <option value="USD">USD Dólares</option>
                </select>

                <div className="flex gap-2 justify-end pt-2">
                  <button
                    type="button"
                    onClick={cerrarModal}
                    className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={enviando}
                    onClick={registrarPago}
                    className="px-4 py-2 text-sm font-medium text-white bg-[#8B1A1A] rounded-lg hover:bg-[#6B1515] disabled:opacity-50"
                  >
                    {enviando ? 'Registrando...' : 'Registrar pago'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
