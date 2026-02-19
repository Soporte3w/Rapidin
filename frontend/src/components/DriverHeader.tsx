import { useState, useEffect } from 'react';
import { Menu } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getStoredFlotaName, getStoredSelectedParkId, setStoredFlotaName } from '../utils/authStorage';
import api from '../services/api';

interface DriverHeaderProps {
  onMenuClick: () => void;
}

export default function DriverHeader({ onMenuClick }: DriverHeaderProps) {
  const { user } = useAuth();
  const [flotaName, setFlotaName] = useState<string | null>(getStoredFlotaName());

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
    <header className="bg-white shadow-sm sticky top-0 z-30">
      <div className="flex items-center justify-between px-4 py-4 lg:px-8">
        <button
          onClick={onMenuClick}
          className="lg:hidden min-w-[44px] min-h-[44px] flex items-center justify-center -ml-2 text-gray-700 hover:text-gray-900 active:bg-gray-100 rounded-lg touch-manipulation"
          aria-label="Abrir menú"
        >
          <Menu className="w-6 h-6" />
        </button>
        
        <div className="flex-1 lg:flex-none" />

        <div className="flex items-center">
          {/* User Account Info */}
          <div className="hidden md:flex items-center space-x-3">
            <div className="flex flex-col min-w-0 text-right">
              <p className="text-xs font-semibold text-gray-900 leading-tight mt-0.5">
                {user?.first_name} {user?.last_name} 
              </p>
              {flotaName ? (
                <p className="text-xs text-gray-500 font-medium leading-tight">{flotaName}</p>
              ) : null}
            </div>
            <div className="w-10 h-10 bg-red-600 rounded-full flex items-center justify-center text-white font-semibold text-base flex-shrink-0 shadow-sm">
              {user?.first_name?.charAt(0) || 'U'}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
