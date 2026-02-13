import { useState } from 'react';
import { BarChart3, Calendar, Layers, CreditCard, Gauge } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import WeeklyAnalysis from './analysis/WeeklyAnalysis';
import VintageAnalysis from './analysis/VintageAnalysis';
import PaymentBehavior from './analysis/PaymentBehavior';
import ExecutiveKPIs from './analysis/ExecutiveKPIs';

const tabs = [
  { label: 'Análisis Semanal', icon: Calendar, desc: 'Solicitudes y desembolsos por rango de fechas' },
  { label: 'Análisis Vintage', icon: Layers, desc: 'Cohortes por mes: préstamos pagados vs incumplidos' },
  { label: 'Comportamiento de Pago', icon: CreditCard, desc: 'Cuotas pagadas a tiempo, tarde o vencidas por número de cuota' },
  { label: 'KPIs Ejecutivos', icon: Gauge, desc: 'Indicadores actuales: cartera, activos, vencidos, cobros' },
];

const Analysis = () => {
  const { user } = useAuth();
  const [tab, setTab] = useState(0);
  const [country, setCountry] = useState(user?.country || 'PE');

  const countryName = country === 'PE' ? 'Perú' : country === 'CO' ? 'Colombia' : '';

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Header */}
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <BarChart3 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
                Análisis y Reportes
              </h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                Indicadores por país - {countryName || 'Selecciona país'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Filtro de país + descripción del tab */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex flex-col sm:flex-row sm:items-end gap-4">
          <div className="sm:w-48">
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
          <div className="flex-1 text-sm text-gray-600 border-l border-gray-200 sm:pl-4">
            <p className="font-medium text-gray-800">{tabs[tab].label}</p>
            <p>{tabs[tab].desc}</p>
          </div>
        </div>
      </div>

      {/* Tabs y contenido */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        <div className="border-b border-gray-200 overflow-x-auto">
          <nav className="flex -mb-px min-w-max">
            {tabs.map((tabItem, index) => {
              const Icon = tabItem.icon;
              return (
                <button
                  key={index}
                  onClick={() => setTab(index)}
                  className={`px-4 lg:px-5 py-3 flex items-center gap-2 text-xs lg:text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
                    tab === index
                      ? 'border-red-600 text-red-600 bg-red-50/50'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {tabItem.label}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-4 sm:p-6 min-h-[280px]">
          {tab === 0 && <WeeklyAnalysis country={country} />}
          {tab === 1 && <VintageAnalysis country={country} />}
          {tab === 2 && <PaymentBehavior country={country} />}
          {tab === 3 && <ExecutiveKPIs country={country} />}
        </div>
      </div>
    </div>
  );
};

export default Analysis;







