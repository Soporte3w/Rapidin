import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  PlusCircle,
  User,
  LogOut,
  X
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

interface DriverSidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function DriverSidebar({ isOpen, onClose }: DriverSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout } = useAuth();

  const handleLogout = () => {
    logout();
    navigate('/driver/login', { replace: true });
  };

  const navigation = [
    { name: 'Mi Perfil', href: '/driver/profile', icon: User },
    { name: 'Resumen', href: '/driver/resumen', icon: LayoutDashboard },
    { name: 'Mis Préstamos', href: '/driver/loans', icon: FileText },
    { name: 'Nueva Solicitud', href: '/driver/new-loan', icon: PlusCircle },
  ];

  return (
    <>
      {/* Mobile sidebar backdrop - cierra al tocar fuera */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar: drawer en móvil, fijo en desktop */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] lg:w-64 lg:max-w-none bg-white shadow-xl lg:shadow-lg transform transition-transform duration-300 ease-out lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Cabecera con logo y botón cerrar (móvil) */}
          <div className="flex items-center justify-between p-4 sm:p-5 lg:p-6 border-b border-gray-100 flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 bg-gradient-to-br from-red-600 to-red-700 rounded-lg flex items-center justify-center flex-shrink-0">
                <span className="text-white font-bold text-xl">Y</span>
              </div>
              <div className="min-w-0">
                <h1 className="text-lg lg:text-xl font-bold text-gray-900 truncate">YEGO</h1>
                <p className="text-xs text-gray-500">Rapidín</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="lg:hidden min-w-[44px] min-h-[44px] flex items-center justify-center -mr-2 text-gray-500 hover:text-gray-700 active:bg-gray-100 rounded-lg touch-manipulation"
              aria-label="Cerrar menú"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Navegación - ítems más altos en móvil para tocar mejor */}
          <nav className="flex-1 p-3 sm:p-4 space-y-1 overflow-y-auto">
            {navigation.map((item) => {
              let isActive = location.pathname === item.href;
              if (item.href === '/driver/new-loan') {
                isActive = location.pathname === '/driver/new-loan' ||
                  location.pathname.startsWith('/driver/loan-');
              }
              const Icon = item.icon;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  onClick={onClose}
                  className={`flex items-center gap-3 px-4 py-3.5 min-h-[48px] lg:min-h-0 lg:py-3 rounded-xl lg:rounded-lg transition-colors touch-manipulation active:scale-[0.98] ${
                    isActive
                      ? 'bg-[#8B1A1A] text-white'
                      : 'text-gray-700 hover:bg-gray-100 active:bg-gray-100'
                  }`}
                >
                  <Icon className="w-5 h-5 flex-shrink-0" />
                  <span className="font-medium text-left">{item.name}</span>
                </Link>
              );
            })}
          </nav>

          {/* Cerrar sesión - área táctil amplia en móvil */}
          <div className="p-3 sm:p-4 border-t border-gray-100 flex-shrink-0">
            <button
              onClick={handleLogout}
              className="flex items-center gap-3 px-4 py-3.5 min-h-[48px] w-full text-gray-700 hover:bg-red-50 hover:text-red-600 rounded-xl lg:rounded-lg transition-colors touch-manipulation active:bg-red-50"
            >
              <LogOut className="w-5 h-5 flex-shrink-0" />
              <span className="font-medium">Cerrar Sesión</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
