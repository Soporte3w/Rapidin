import { Settings as SettingsIcon } from 'lucide-react';

export default function YegoMiMotoConfig() {
  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Header mismo estilo que Configuración Rapidín / Yego mi auto */}
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
              Cronogramas y configuración para Yego mi moto
            </p>
          </div>
        </div>
      </div>

      {/* Contenido en tarjeta blanca */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        <div className="p-4 sm:p-6">
          <p className="text-gray-600">Cronogramas y configuración — Próximamente.</p>
        </div>
      </div>
    </div>
  );
}
