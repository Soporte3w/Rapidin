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
  Building2,
  Car,
  Bike,
} from 'lucide-react';

type AdminProduct = 'rapidin' | 'yego-mi-auto' | 'yego-mi-moto';

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const currentProduct: AdminProduct = location.pathname.startsWith('/admin/yego-mi-moto')
    ? 'yego-mi-moto'
    : location.pathname.startsWith('/admin/yego-mi-auto')
      ? 'yego-mi-auto'
      : 'rapidin';

  const newRequestItemRapidin = { text: 'Nueva solicitud', icon: PlusCircle, path: '/admin/loan-requests/new' };
  const menuItemsRapidin = [
    { text: 'Dashboard', icon: LayoutDashboard, path: '/admin/dashboard' },
    { text: 'Solicitudes', icon: FileText, path: '/admin/loan-requests' },
    { text: 'Préstamos', icon: Banknote, path: '/admin/loans' },
    { text: 'Pagos', icon: CreditCard, path: '/admin/payments' },
    { text: 'Análisis', icon: BarChart3, path: '/admin/analysis' },
    { text: 'Provisiones', icon: TrendingUp, path: '/admin/provisions' },
    { text: 'Configuración', icon: Settings, path: '/admin/settings' },
  ];

  const newRequestItemYegoMiAuto = { text: 'Nueva solicitud de Yego mi auto', icon: PlusCircle, path: '/admin/yego-mi-auto/loan-requests/new' };
  const menuItemsYegoMiAuto = [
    { text: 'Dashboard', icon: LayoutDashboard, path: '/admin/yego-mi-auto/dashboard' },
    { text: 'Flotas', icon: Building2, path: '/admin/yego-mi-auto/flotas' },
    { text: 'Configuración', icon: Settings, path: '/admin/yego-mi-auto/config' },
    { text: 'Análisis', icon: BarChart3, path: '/admin/yego-mi-auto/analysis' },
    { text: 'Pagos', icon: CreditCard, path: '/admin/yego-mi-auto/payments' },
    { text: 'Préstamos', icon: Banknote, path: '/admin/yego-mi-auto/loans' },
  ];

  const newRequestItemYegoMiMoto = { text: 'Nueva solicitud de Yego mi moto', icon: PlusCircle, path: '/admin/yego-mi-moto/loan-requests/new' };
  const menuItemsYegoMiMoto = [
    { text: 'Dashboard', icon: LayoutDashboard, path: '/admin/yego-mi-moto/dashboard' },
    { text: 'Flotas', icon: Building2, path: '/admin/yego-mi-moto/flotas' },
    { text: 'Configuración', icon: Settings, path: '/admin/yego-mi-moto/config' },
    { text: 'Análisis', icon: BarChart3, path: '/admin/yego-mi-moto/analysis' },
    { text: 'Pagos', icon: CreditCard, path: '/admin/yego-mi-moto/payments' },
    { text: 'Préstamos', icon: Banknote, path: '/admin/yego-mi-moto/loans' },
  ];

  const newRequestItem = currentProduct === 'rapidin' ? newRequestItemRapidin : currentProduct === 'yego-mi-auto' ? newRequestItemYegoMiAuto : newRequestItemYegoMiMoto;
  const menuItems = currentProduct === 'rapidin' ? menuItemsRapidin : currentProduct === 'yego-mi-auto' ? menuItemsYegoMiAuto : menuItemsYegoMiMoto;

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen);
  };

  const handleLogout = () => {
    logout();
    navigate('/admin/login', { replace: true });
  };

  const handleProductSwitch = (product: AdminProduct) => {
    setMobileOpen(false);
    if (product === currentProduct) return;
    if (product === 'rapidin') navigate('/admin/dashboard');
    if (product === 'yego-mi-auto') navigate('/admin/yego-mi-auto/dashboard');
    if (product === 'yego-mi-moto') navigate('/admin/yego-mi-moto/dashboard');
  };

  const productSubtitle = currentProduct === 'rapidin' ? 'Yego Rapidín' : currentProduct === 'yego-mi-auto' ? 'Yego mi auto' : 'Yego mi moto';

  const sidebar = (
    <div className="flex flex-col h-full bg-white shadow-lg">
      {/* Logo */}
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

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {/* Nueva solicitud arriba, separada del resto */}
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
        <div className="my-2 border-t border-gray-200" />
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isNewRequestPage = location.pathname === '/admin/loan-requests/new';
          const isActive = isNewRequestPage
            ? false
            : (location.pathname === item.path ||
               (item.path !== '/admin/dashboard' && location.pathname.startsWith(item.path + '/')));
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
              <Icon className="w-5 h-5" />
              <span className="font-medium">{item.text}</span>
            </Link>
          );
        })}
      </nav>

      {/* Logout */}
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
      {/* Mobile sidebar backdrop */}
      {mobileOpen && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
          onClick={handleDrawerToggle}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white shadow-lg transform transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebar}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0 lg:ml-64">
        {/* Header */}
        <header className="bg-white shadow-sm sticky top-0 z-30">
          <div className="flex items-center justify-between gap-4 px-4 py-4 lg:px-8">
            <button
              onClick={handleDrawerToggle}
              className="lg:hidden text-gray-700 hover:text-gray-900"
            >
              <Menu className="w-6 h-6" />
            </button>

            {/* Combo producto: Yego Rapidín | Yego mi auto | Yego mi moto */}
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
              {/* User Account Info */}
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

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="max-w-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default Layout;

