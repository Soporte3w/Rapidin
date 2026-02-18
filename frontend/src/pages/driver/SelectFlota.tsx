import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Building2, CheckCircle } from 'lucide-react';
import { getStoredSelectedParkId, updateStoredFlota } from '../../utils/authStorage';

interface FlotaItem {
  driver_id: string | null;
  park_id: string | null;
  flota_name: string;
  rapidin_driver_id?: string | null;
}

export default function SelectFlota() {
  const navigate = useNavigate();
  const location = useLocation();
  const flotas: FlotaItem[] = (location.state as { flotas?: FlotaItem[] })?.flotas || [];

  // Validar llegada por URL o atrás/adelante: sin flotas en state y sin flota ya elegida → login
  if (flotas.length === 0) {
    const hasPark = !!getStoredSelectedParkId();
    if (hasPark) {
      navigate('/driver/resumen', { replace: true });
    } else {
      navigate('/driver/login', { replace: true });
    }
    return null;
  }

  // Bloquear uso de atrás/adelante del navegador: mantener siempre en esta pantalla hasta elegir flota
  useEffect(() => {
    const path = window.location.pathname + window.location.search;
    window.history.pushState(null, '', path);

    const handlePopState = () => {
      window.history.pushState(null, '', path);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleSelect = (f: FlotaItem) => {
    // Guardar el id de ese conductor en esa flota (rapidin_driver_id = id en module_rapidin_drivers)
    updateStoredFlota(f.park_id || '', f.driver_id || '', f.flota_name || undefined, f.rapidin_driver_id ?? undefined);
    navigate('/driver/resumen', { replace: true });
  };

  return (
    <div className="min-h-screen w-full bg-gray-100 flex flex-col items-center justify-center p-6 fixed inset-0 z-50">
      {/* Marca mínima arriba */}
      <div className="absolute top-6 left-0 right-0 flex justify-center">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 bg-red-600 rounded-full flex items-center justify-center">
            <span className="text-white font-bold text-lg">Y</span>
          </div>
          <span className="font-bold text-gray-800">Rapidín</span>
        </div>
      </div>

      {/* Contenido central: solo flotas */}
      <div className="w-full max-w-lg">
        <h1 className="text-xl font-bold text-gray-900 mb-1 text-center">Elige tu flota</h1>
        <p className="text-gray-600 mb-8 text-center text-sm">
          Selecciona con cuál flota deseas continuar.
        </p>
        <div className="grid gap-4">
          {flotas.map((f) => (
            <button
              key={f.park_id || f.driver_id || f.flota_name}
              type="button"
              onClick={() => handleSelect(f)}
              className="flex items-center gap-4 p-4 rounded-xl border-2 border-gray-200 bg-white hover:border-red-500 hover:bg-red-50/50 transition-all text-left shadow-sm w-full"
            >
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <Building2 className="w-6 h-6 text-red-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-gray-900 truncate">{f.flota_name}</p>
                <p className="text-sm text-gray-500">Estado: Activo</p>
              </div>
              <CheckCircle className="w-5 h-5 text-gray-400 flex-shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
