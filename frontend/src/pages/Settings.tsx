import { useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import LoanConditionsSettings from './settings/LoanConditionsSettings';
import CycleConfigSettings from './settings/CycleConfigSettings';
import UsersManagement from './settings/UsersManagement';
import InterestRatesSettings from './settings/InterestRatesSettings';

const Settings = () => {
  const [tab, setTab] = useState(0);

  const tabs = [
    { label: 'Condiciones de Préstamo', component: LoanConditionsSettings },
    { label: 'Configuración de Ciclos', component: CycleConfigSettings },
    { label: 'Tasas de Interés', component: InterestRatesSettings },
    { label: 'Gestión de Usuarios', component: UsersManagement },
  ];

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Header */}
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
            <SettingsIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
              Configuración
            </h1>
            <p className="text-xs lg:text-sm text-white/90 mt-0.5">
              Gestiona las configuraciones del sistema
            </p>
          </div>
        </div>
      </div>

      {/* Tabs y contenido */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-x-hidden overflow-y-hidden">
        <div className="border-b border-gray-200 overflow-x-auto overflow-y-hidden">
          <nav className="flex -mb-px min-w-max">
            {tabs.map((tabItem, index) => (
              <button
                key={index}
                onClick={() => setTab(index)}
                className={`px-4 lg:px-6 py-3 lg:py-4 text-xs lg:text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
                  tab === index
                    ? 'border-red-600 text-red-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {tabItem.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4 sm:p-6 overflow-x-hidden overflow-y-hidden">
          {tab === 0 && <LoanConditionsSettings />}
          {tab === 1 && <CycleConfigSettings />}
          {tab === 2 && <InterestRatesSettings />}
          {tab === 3 && <UsersManagement />}
        </div>
      </div>
    </div>
  );
};

export default Settings;







