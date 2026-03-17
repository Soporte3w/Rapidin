import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  Menu,
  LayoutDashboard,
  FileText,
  PlusCircle,
  Banknote,
  CreditCard,
  BarChart3,
  TrendingUp,
  Settings,
  LogOut,
  X,
  Car,
  Bike,
} from 'lucide-react';

type AdminProduct = 'rapidin' | 'yego-mi-auto' | 'yego-mi-moto';
type MenuItem = { text: string; icon: typeof LayoutDashboard; path: string };
type MenuSection = { title: string; items: MenuItem[] };

const ADMIN_MENU: Record<AdminProduct, { newRequest: MenuItem; sections: MenuSection[]; subtitle: string; dashboardPath: string }> = {
  rapidin: {
    newRequest: { text: 'Nueva solicitud', icon: PlusCircle, path: '/admin/loan-requests/new' },
    subtitle: 'Yego Rapidín',
    dashboardPath: '/admin/dashboard',
    sections: [
      { title: 'Principal', items: [{ text: 'Dashboard', icon: LayoutDashboard, path: '/admin/dashboard' }] },
      { title: 'Operación', items: [
        { text: 'Solicitudes', icon: FileText, path: '/admin/loan-requests' },
        { text: 'Préstamos', icon: Banknote, path: '/admin/loans' },
        { text: 'Pagos', icon: CreditCard, path: '/admin/payments' },
      ]},
      { title: 'Reportes', items: [
        { text: 'Análisis', icon: BarChart3, path: '/admin/analysis' },
        { text: 'Provisiones', icon: TrendingUp, path: '/admin/provisions' },
      ]},
      { title: 'Sistema', items: [{ text: 'Configuración', icon: Settings, path: '/admin/settings' }] },
    ],
  },
  'yego-mi-auto': {
    newRequest: { text: 'Nueva solicitud Mi Auto', icon: PlusCircle, path: '/admin/yego-mi-auto/loan-requests/new' },
    subtitle: 'Yego mi auto',
    dashboardPath: '/admin/yego-mi-auto/dashboard',
    sections: [
      { title: 'Principal', items: [{ text: 'Dashboard', icon: LayoutDashboard, path: '/admin/yego-mi-auto/dashboard' }] },
      { title: 'Operación', items: [
        { text: 'Solicitudes', icon: FileText, path: '/admin/yego-mi-auto/requests' },
        { text: 'Alquiler / Venta', icon: Banknote, path: '/admin/yego-mi-auto/rent-sale' },
        { text: 'Pagos', icon: CreditCard, path: '/admin/yego-mi-auto/payments' },
      ]},
      { title: 'Reportes', items: [{ text: 'Análisis', icon: BarChart3, path: '/admin/yego-mi-auto/analysis' }] },
      { title: 'Sistema', items: [{ text: 'Configuración', icon: Settings, path: '/admin/yego-mi-auto/config' }] },
    ],
  },
  'yego-mi-moto': {
    newRequest: { text: 'Nueva solicitud Mi Moto', icon: PlusCircle, path: '/admin/yego-mi-moto/loan-requests/new' },
    subtitle: 'Yego mi moto',
    dashboardPath: '/admin/yego-mi-moto/dashboard',
    sections: [
      { title: 'Principal', items: [{ text: 'Dashboard', icon: LayoutDashboard, path: '/admin/yego-mi-moto/dashboard' }] },
      { title: 'Operación', items: [
        { text: 'Préstamos', icon: Banknote, path: '/admin/yego-mi-moto/loans' },
        { text: 'Pagos', icon: CreditCard, path: '/admin/yego-mi-moto/payments' },
      ]},
      { title: 'Reportes', items: [{ text: 'Análisis', icon: BarChart3, path: '/admin/yego-mi-moto/analysis' }] },
      { title: 'Sistema', items: [{ text: 'Configuración', icon: Settings, path: '/admin/yego-mi-moto/config' }] },
    ],
  },
};

const Layout = ({ children }: { children: React.ReactNode }) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const currentProduct: AdminProduct = location.pathname.startsWith('/admin/yego-mi-moto')
    ? 'yego-mi-moto'
    : location.pathname.startsWith('/admin/yego-mi-auto')
      ? 'yego-mi-auto'
      : 'rapidin';

  const { newRequest: newRequestItem, sections, subtitle: productSubtitle } = ADMIN_MENU[currentProduct];

  const handleDrawerToggle = () => setMobileOpen((o) => !o);
  const handleLogout = () => { logout(); navigate('/admin/login', { replace: true }); };
  const handleProductSwitch = (product: AdminProduct) => {
    if (product === currentProduct) return;
    setMobileOpen(false);
    navigate(ADMIN_MENU[product].dashboardPath);
  };

  const sidebar = (
    <div className="flex flex-col h-full bg-white shadow-lg">
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center space-x-3 min-w-0">
          <div className="w-10 h-10 bg-gradient-to-br from-red-600 to-red-700 rounded-lg flex items-center justify-center flex-shrink-0">
            <span className="text-white font-bold text-xl">Y</span>
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-gray-900">YEGO</h1>
            <p className="text-xs text-gray-500">{productSubtitle}</p>
          </div>
        </div>
        <button
          onClick={handleDrawerToggle}
          className="lg:hidden text-gray-500 hover:text-gray-700 flex-shrink-0"
        >
          <X className="w-6 h-6" />
        </button>
      </div>

      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        <div className="px-2 pt-1 pb-1">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider text-left">— Menú —</p>
        </div>
        <Link
          to={newRequestItem.path}
          onClick={() => setMobileOpen(false)}
          className={`flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${
            location.pathname === newRequestItem.path
              ? 'bg-red-600 text-white'
              : 'text-gray-700 hover:bg-gray-100'
          }`}
        >
          <PlusCircle className="w-5 h-5" />
          <span className="font-medium">{newRequestItem.text}</span>
        </Link>
        {sections.map((section) => (
          <div key={section.title} className="pt-4">
            <p className="px-2 pb-2 text-xs font-semibold text-gray-400 uppercase tracking-wider text-left">
              — {section.title} —
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const isNewRequest = location.pathname.includes('/loan-requests/new');
                const isDashboard = item.path.endsWith('/dashboard');
                const isActive = !isNewRequest && (location.pathname === item.path || (!isDashboard && location.pathname.startsWith(item.path + '/')));
                return (
                  <Link
                    key={item.text}
                    to={item.path}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${
                      isActive
                        ? 'bg-red-600 text-white'
                        : 'text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    <Icon className="w-5 h-5 flex-shrink-0" />
                    <span className="font-medium">{item.text}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-4 border-t">
        <button
          onClick={handleLogout}
          className="flex items-center space-x-3 px-4 py-3 w-full text-gray-700 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors"
        >
          <LogOut className="w-5 h-5" />
          <span className="font-medium">Cerrar Sesión</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-gray-50">
      {mobileOpen && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
          onClick={handleDrawerToggle}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white shadow-lg transform transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebar}
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden min-w-0 lg:ml-64">
        <header className="bg-white shadow-sm sticky top-0 z-30">
          <div className="flex items-center justify-between gap-4 px-4 py-4 lg:px-8">
            <button
              onClick={handleDrawerToggle}
              className="lg:hidden text-gray-700 hover:text-gray-900"
            >
              <Menu className="w-6 h-6" />
            </button>

            <div className="flex rounded-lg bg-gray-100 p-1 flex-wrap gap-1">
              <button
                type="button"
                onClick={() => handleProductSwitch('rapidin')}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  currentProduct === 'rapidin' ? 'bg-white text-gray-900 shadow' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <FileText className="w-4 h-4" />
                Yego Rapidín
              </button>
              <button
                type="button"
                onClick={() => handleProductSwitch('yego-mi-auto')}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  currentProduct === 'yego-mi-auto' ? 'bg-white text-gray-900 shadow' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <Car className="w-4 h-4" />
                Yego mi auto
              </button>
              <button
                type="button"
                onClick={() => handleProductSwitch('yego-mi-moto')}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  currentProduct === 'yego-mi-moto' ? 'bg-white text-gray-900 shadow' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <Bike className="w-4 h-4" />
                Yego mi moto
              </button>
            </div>

            <div className="flex-1 min-w-0" />

            <div className="flex items-center">
              <div className="hidden md:flex items-center space-x-3">
                <div className="flex flex-col min-w-0 text-right">
                  <p className="text-sm font-semibold text-gray-900 leading-tight">
                    {user?.first_name} {user?.last_name}
                  </p>
                  <p className="text-xs text-gray-500 leading-tight mt-0.5">{user?.email || user?.role}</p>
                </div>
                <div className="w-10 h-10 bg-red-600 rounded-full flex items-center justify-center text-white font-semibold text-base flex-shrink-0 shadow-sm">
                  {user?.first_name?.charAt(0) || user?.email?.charAt(0)?.toUpperCase() || 'A'}
                </div>
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="max-w-full">{children}</div>
        </main>
      </div>
    </div>
  );
};

export default Layout;

