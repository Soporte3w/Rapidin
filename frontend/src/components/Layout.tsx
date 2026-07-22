import { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  Menu,
  LayoutDashboard,
  FileText,
  PlusCircle,
  Banknote,
  CreditCard,
  Layers,
  BarChart3,
  TrendingUp,
  Settings,
  LogOut,
  X,
  Car,
  Bike,
  MessageCircle,
  ClipboardCheck,
  ShieldCheck,
} from 'lucide-react';
import { hasGroupAccess, hasSectionAccess, type AdminPermissionGroupKey } from '../config/adminPermissions';

type AdminProduct = 'rapidin' | 'yego-mi-auto' | 'yego-mi-moto';
type MenuItem = { text: string; icon: typeof LayoutDashboard; path: string; permission?: string };
type MenuSection = { title: string; items: MenuItem[] };
const PRODUCT_PERMISSION_KEY: Record<AdminProduct, AdminPermissionGroupKey> = {
  rapidin: 'rapidin',
  'yego-mi-auto': 'miauto',
  'yego-mi-moto': 'mimoto',
};

const ADMIN_MENU: Record<AdminProduct, { newRequest?: MenuItem; sections: MenuSection[]; subtitle: string; dashboardPath: string }> = {
  rapidin: {
    newRequest: { text: 'Nueva solicitud', icon: PlusCircle, path: '/admin/loan-requests/credit-type', permission: 'rapidin.nueva_solicitud' },
    subtitle: 'Yego Rapidín',
    dashboardPath: '/admin/dashboard',
    sections: [
      { title: 'Principal', items: [{ text: 'Dashboard', icon: LayoutDashboard, path: '/admin/dashboard', permission: 'rapidin.dashboard' }] },
      { title: 'Operación', items: [
        { text: 'Solicitudes', icon: FileText, path: '/admin/loan-requests', permission: 'rapidin.solicitudes' },
        { text: 'Préstamos', icon: Banknote, path: '/admin/loans', permission: 'rapidin.prestamos' },
        { text: 'Pagos', icon: CreditCard, path: '/admin/payments', permission: 'rapidin.pagos' },
        { text: 'Cobros masivos YEGO', icon: Layers, path: '/admin/payments-bulk', permission: 'rapidin.cobros_masivos' },
      ]},
      { title: 'Reportes', items: [
        { text: 'Análisis', icon: BarChart3, path: '/admin/analysis', permission: 'rapidin.analisis' },
        { text: 'Provisiones', icon: TrendingUp, path: '/admin/provisions', permission: 'rapidin.provisiones' },
      ]},
      { title: 'Sistema', items: [
        { text: 'Configuración', icon: Settings, path: '/admin/settings', permission: 'rapidin.configuracion' },
      ] },
    ],
  },
  'yego-mi-auto': {
    subtitle: 'Yego mi auto',
    dashboardPath: '/admin/yego-mi-auto/requests',
    sections: [
      { title: 'Operacion', items: [
        { text: 'Nueva Solicitud', icon: PlusCircle, path: '/admin/yego-mi-auto/nueva-solicitud', permission: 'miauto.nueva_solicitud' },
        { text: 'Solicitudes', icon: FileText, path: '/admin/yego-mi-auto/requests', permission: 'miauto.solicitudes' },
        { text: 'Alquiler / Venta', icon: Banknote, path: '/admin/yego-mi-auto/rent-sale', permission: 'miauto.alquiler_venta' },
        { text: 'Validar comprobantes', icon: ClipboardCheck, path: '/admin/yego-mi-auto/validar-comprobantes', permission: 'miauto.validar_comprobantes' },
        { text: 'Mensajes', icon: MessageCircle, path: '/admin/yego-mi-auto/mensajes', permission: 'miauto.mensajes' },
      ]},
      { title: 'Reportes', items: [{ text: 'Análisis', icon: BarChart3, path: '/admin/yego-mi-auto/analysis', permission: 'miauto.analisis' }] },
      { title: 'Sistema', items: [
        { text: 'Configuración', icon: Settings, path: '/admin/yego-mi-auto/config', permission: 'miauto.configuracion' },
      ] },
    ],
  },
  'yego-mi-moto': {
    subtitle: 'Yego mi moto',
    dashboardPath: '/admin/yego-mi-moto/requests',
    sections: [
      { title: 'Operacion', items: [
        { text: 'Nueva Solicitud', icon: PlusCircle, path: '/admin/yego-mi-moto/nueva-solicitud', permission: 'mimoto.nueva_solicitud' },
        { text: 'Solicitudes', icon: FileText, path: '/admin/yego-mi-moto/requests', permission: 'mimoto.solicitudes' },
        { text: 'Alquiler / Venta', icon: Banknote, path: '/admin/yego-mi-moto/rent-sale', permission: 'mimoto.alquiler_venta' },
        { text: 'Validar comprobantes', icon: ClipboardCheck, path: '/admin/yego-mi-moto/validar-comprobantes', permission: 'mimoto.validar_comprobantes' },
        { text: 'Mensajes', icon: MessageCircle, path: '/admin/yego-mi-moto/mensajes', permission: 'mimoto.mensajes' },
      ]},
      { title: 'Reportes', items: [{ text: 'Análisis', icon: BarChart3, path: '/admin/yego-mi-moto/analysis', permission: 'mimoto.analisis' }] },
      { title: 'Sistema', items: [{ text: 'Configuración', icon: Settings, path: '/admin/yego-mi-moto/config', permission: 'mimoto.configuracion' }] },
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

  const userPermissions = user?.allowed_modules ?? ['rapidin'];
  const isSystemAdmin = user?.role === 'admin';
  const canAccessProduct = (product: AdminProduct) =>
    isSystemAdmin || hasGroupAccess(userPermissions, PRODUCT_PERMISSION_KEY[product]);
  const canAccessItem = (item: MenuItem, product = currentProduct) =>
    isSystemAdmin || hasSectionAccess(userPermissions, PRODUCT_PERMISSION_KEY[product], item.permission);
  const canAccessSystemUsers =
    isSystemAdmin
    || hasSectionAccess(userPermissions, 'rapidin', 'rapidin.usuarios')
    || hasSectionAccess(userPermissions, 'miauto', 'miauto.usuarios')
    || hasSectionAccess(userPermissions, 'mimoto', 'mimoto.usuarios');
  const systemUsersPath = hasSectionAccess(userPermissions, 'rapidin', 'rapidin.usuarios')
    ? '/admin/system-users'
    : hasSectionAccess(userPermissions, 'miauto', 'miauto.usuarios')
      ? '/admin/yego-mi-auto/system-users'
      : '/admin/system-users';

  const firstAccessibleProduct = (): AdminProduct =>
    (['rapidin', 'yego-mi-auto', 'yego-mi-moto'] as const).find((product) => canAccessProduct(product)) ?? 'rapidin';

  const firstAccessiblePath = (product: AdminProduct) => {
    const menu = ADMIN_MENU[product];
    const directItem = menu.newRequest && canAccessItem(menu.newRequest, product) ? menu.newRequest : null;
    const sectionItem = menu.sections.flatMap((section) => section.items).find((item) => canAccessItem(item, product));
    return directItem?.path ?? sectionItem?.path ?? menu.dashboardPath;
  };

  const getCurrentRouteItem = (product: AdminProduct) => {
    const menu = ADMIN_MENU[product];
    if (
      menu.newRequest
      && (location.pathname === menu.newRequest.path
        || location.pathname.startsWith(`${menu.newRequest.path}/`)
        || location.pathname.endsWith('/loan-requests/new'))
    ) {
      return menu.newRequest;
    }

    return menu.sections
      .flatMap((section) => section.items)
      .sort((a, b) => b.path.length - a.path.length)
      .find((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`));
  };

  // Si el usuario no tiene acceso al producto actual, redirigir al primero disponible.
  useEffect(() => {
    if (!canAccessProduct(currentProduct)) {
      const product = firstAccessibleProduct();
      navigate(firstAccessiblePath(product), { replace: true });
      return;
    }

    const currentRouteItem = getCurrentRouteItem(currentProduct);
    if (currentRouteItem && !canAccessItem(currentRouteItem)) {
      navigate(firstAccessiblePath(currentProduct), { replace: true });
    }
  }, [currentProduct, location.pathname, user]);

  const { newRequest: newRequestItem, sections, subtitle: productSubtitle } = ADMIN_MENU[currentProduct];
  const visibleNewRequestItem = newRequestItem && canAccessItem(newRequestItem) ? newRequestItem : undefined;
  const visibleSections = sections
    .map((section) => ({ ...section, items: section.items.filter((item) => canAccessItem(item)) }))
    .filter((section) => section.items.length > 0);

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
        {visibleNewRequestItem && (
        <Link
          to={visibleNewRequestItem.path}
          onClick={() => setMobileOpen(false)}
          className={`flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${
            location.pathname === visibleNewRequestItem.path
              ? 'bg-red-600 text-white'
              : 'text-gray-700 hover:bg-gray-100'
          }`}
        >
          <PlusCircle className="w-5 h-5" />
          <span className="font-medium">{visibleNewRequestItem.text}</span>
        </Link>
        )}
        {visibleSections.map((section) => (
          <div key={section.title} className="pt-4">
            <p className="px-2 pb-2 text-xs font-semibold text-gray-400 uppercase tracking-wider text-left">
              {section.title}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const isNewRequest = location.pathname.includes('/loan-requests/new') || location.pathname.includes('/loan-requests/credit-type');
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
        {canAccessSystemUsers && (
          <Link
            to={systemUsersPath}
            onClick={() => setMobileOpen(false)}
            className={`flex items-center space-x-3 px-4 py-3 w-full rounded-lg transition-colors mb-1 ${
              location.pathname.endsWith('/system-users')
                ? 'bg-red-600 text-white'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <ShieldCheck className="w-5 h-5" />
            <span className="font-medium">Usuarios y permisos</span>
          </Link>
        )}
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
              {canAccessProduct('rapidin') && (
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
              )}
              {canAccessProduct('yego-mi-auto') && (
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
              )}
              {canAccessProduct('yego-mi-moto') && (
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
              )}
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
