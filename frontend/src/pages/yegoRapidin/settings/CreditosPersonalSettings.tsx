import { useState, useEffect } from 'react';
import api from '../../../services/api';
import toast from 'react-hot-toast';
import { Loader2, Save, Building2 } from 'lucide-react';

export default function CreditosPersonalSettings() {
  const [interestRate, setInterestRate] = useState('7');
  const [maxInstallments, setMaxInstallments] = useState('10');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/creditos-personal-yego/config');
        if (cancelled) return;
        if (res.data?.data) {
          setInterestRate(String(res.data.data.interest_rate));
          setMaxInstallments(String(res.data.data.max_installments));
        }
      } catch {
        // defaults
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/creditos-personal-yego/config', {
        interest_rate: parseFloat(interestRate),
        max_installments: parseInt(maxInstallments, 10),
      });
      toast.success('Configuracion guardada');
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>;

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h3 className="text-lg font-bold text-gray-900">Credito Personal Yego</h3>
        <p className="text-sm text-gray-500 mt-0.5">Tasa de interes y plazos para creditos al personal</p>
      </div>

      <div className="bg-white rounded-xl shadow border border-gray-200 overflow-hidden">
        <div className="bg-red-700 px-6 py-3.5">
          <div className="flex items-center gap-3">
            <Building2 className="w-5 h-5 text-red-200" />
            <h4 className="text-sm font-bold text-white">Parametros del credito</h4>
          </div>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-5">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Interes mensual (%)</label>
              <div className="relative">
                <input
                  type="number"
                  value={interestRate}
                  onChange={(e) => setInterestRate(e.target.value)}
                  min="0" max="100" step="0.01"
                  className="w-full pl-4 pr-12 py-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Maximo de cuotas</label>
              <input
                type="number"
                value={maxInstallments}
                onChange={(e) => setMaxInstallments(e.target.value)}
                min="1" max="60" step="1"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-8 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium text-sm shadow-sm"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saving ? 'Guardando...' : 'Guardar Cambios'}
            </button>
            <p className="text-xs text-gray-400">Aplica a nuevos creditos</p>
          </div>
        </div>
      </div>
    </div>
  );
}
