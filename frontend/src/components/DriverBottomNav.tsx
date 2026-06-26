import { Link, useLocation } from 'react-router-dom';
import { Car, FileText, LayoutDashboard, User } from 'lucide-react';

const tabs = [
  { path: '/driver/resumen', label: 'Resumen', icon: LayoutDashboard },
  { path: '/driver/quiero-mi-auto', label: 'Mi Auto', icon: Car },
  { path: '/driver/loans', label: 'Préstamos', icon: FileText },
  { path: '/driver/profile', label: 'Perfil', icon: User },
];

export default function DriverBottomNav() {
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === '/driver/loans') {
      return location.pathname.startsWith('/driver/loans');
    }
    return location.pathname === path;
  };

  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50 safe-area-bottom">
      <div className="flex items-center justify-around h-16">
        {tabs.map((tab) => {
          const active = isActive(tab.path);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.path}
              to={tab.path}
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full min-h-[56px] touch-manipulation active:bg-gray-50 transition-colors ${
                active ? 'text-[#8B1A1A]' : 'text-gray-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-semibold">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
