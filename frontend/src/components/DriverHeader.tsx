import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Menu } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getStoredFlotaName, getStoredSelectedParkId, setStoredFlotaName } from '../utils/authStorage';
import api from '../services/api';

interface DriverHeaderProps {
  onMenuClick: () => void;
}

export default function DriverHeader({ onMenuClick }: DriverHeaderProps) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [flotaName, setFlotaName] = useState<string | null>(getStoredFlotaName());

  const handleLogout = () => {
    logout();
    navigate('/driver/login', { replace: true });
  };

  // Si hay park_id en sesión pero no tenemos nombre, obtenerlo por API de partners y guardarlo en sesión
  useEffect(() => {
    const parkId = getStoredSelectedParkId();
    const storedName = getStoredFlotaName();
    if (storedName) {
      setFlotaName(storedName);
      return;
    }
    if (!parkId) {
      setFlotaName(null);
      return;
    }
    const controller = new AbortController();
    api
      .get<{ data?: { name?: string | null } }>('/driver/flota-name', {
        params: { park_id: parkId },
        signal: controller.signal,
      })
      .then((res) => {
        const name = res.data?.data?.name ?? null;
        if (name) {
          setStoredFlotaName(name);
          setFlotaName(name);
        }
      })
      .catch((err) => {
        if (err.name !== 'CanceledError' && err.code !== 'ERR_CANCELED') setFlotaName(null);
      });
    return () => controller.abort();
  }, []);

  return (
    <header className="bg-[#8B1A1A] lg:bg-white lg:shadow-sm sticky top-0 z-30">
      <div className="flex items-center justify-between px-4 py-3 lg:px-8 lg:py-4">
        {/* Logo / nombre de app */}
        <div className="flex items-center gap-2 lg:hidden">
          <span className="text-white font-bold text-lg">YEGO Rapidín</span>
        </div>

        {/* Botón hamburguesa - solo desktop */}
        <button
          onClick={onMenuClick}
          className="hidden lg:flex min-w-[44px] min-h-[44px] items-center justify-center -ml-2 text-gray-700 hover:text-gray-900 active:bg-gray-100 rounded-lg touch-manipulation"
          aria-label="Abrir menú"
        >
          <Menu className="w-6 h-6" />
        </button>
        
        <div className="flex-1 lg:flex-none" />

        <div className="flex min-w-0 items-center gap-2">
          {/* En móvil compacto se priorizan el avatar y la acción de salida. */}
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="hidden min-w-0 flex-col text-right sm:flex">
              <p className="max-w-28 truncate text-xs font-semibold leading-tight text-white sm:max-w-44 lg:max-w-none lg:text-gray-900">
                {user?.first_name} {user?.last_name} 
              </p>
              {flotaName ? (
                <p className="max-w-28 truncate text-xs font-medium leading-tight text-white/70 sm:max-w-44 lg:max-w-none lg:text-gray-500">{flotaName}</p>
              ) : null}
            </div>
            <div className="w-9 h-9 lg:w-10 lg:h-10 bg-white/20 lg:bg-red-600 rounded-full flex items-center justify-center text-white font-semibold text-sm lg:text-base flex-shrink-0">
              {user?.first_name?.charAt(0) || 'U'}
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white transition-colors hover:bg-white/15 active:bg-white/25 lg:hidden"
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </div>
    </header>
  );
}
