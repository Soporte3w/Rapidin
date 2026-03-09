import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getStoredSession } from '../../utils/authStorage';
import toast from 'react-hot-toast';
import { Lock, AlertCircle, ArrowRight, Shield, Zap, BarChart3, User, Eye, EyeOff } from 'lucide-react';

const Login = () => {
  const navigate = useNavigate();
  const { login, user } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Redirigir si ya está autenticado (solo si no hay error)
  useEffect(() => {
    if (user && !loading && !error) {
      // Si es conductor (tiene phone o role=driver)
      if (user.role === 'driver' || user.phone) {
        navigate('/driver/resumen', { replace: true });
      } else if (user.role && ['admin', 'analyst', 'approver', 'payer'].includes(user.role)) {
        // Si es admin u otro rol de administración
        navigate('/admin/dashboard', { replace: true });
      }
    }
  }, [user, loading, error, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await login(email, password);
      const session = getStoredSession();
      const storedUser = session?.user;
      if (!storedUser || !(storedUser as { role?: string }).role) {
        throw new Error('Error al obtener información del usuario');
      }

      const role = (storedUser as { role?: string }).role;
      if (role && ['admin', 'analyst', 'approver', 'payer'].includes(role)) {
        toast.success('Inicio de sesión exitoso');
        navigate('/admin/dashboard', { replace: true });
      } else if (role === 'driver' || (storedUser as { phone?: string }).phone) {
        toast.success('Inicio de sesión exitoso');
        navigate('/driver/resumen', { replace: true });
      } else {
        throw new Error('Tipo de usuario no reconocido');
      }
    } catch (err: any) {
      const errorMessage = err.response?.data?.message || err.message || 'Credenciales inválidas. Por favor intenta nuevamente.';
      setError(errorMessage);
      toast.error(errorMessage);
      setLoading(false);
    }
  };

  const features = [
    {
      icon: Shield,
      title: 'Seguridad Avanzada',
      description: 'Autenticación robusta y protección de datos',
      color: 'primary',
    },
    {
      icon: Zap,
      title: 'Alto Rendimiento',
      description: 'Optimizado para operaciones empresariales',
      color: 'green',
    },
    {
      icon: BarChart3,
      title: 'Analytics Avanzado',
      description: 'Reportes y métricas en tiempo real',
      color: 'yellow',
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-white to-gray-50 flex items-center justify-center px-3 sm:px-4 py-6 sm:py-8 lg:py-12">
      <div className="w-full max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-[1.2fr_1fr] gap-8 lg:gap-12 items-center">
          {/* En móvil: formulario primero (order-1); en desktop: contenido a la izquierda */}
          {/* Left Section - Content (en móvil va abajo) */}
          <div className="w-full order-2 lg:order-1">
            {/* Logo */}
            <div className="flex items-center gap-2 sm:gap-3 mb-5 sm:mb-8">
              <div className="w-11 h-11 sm:w-14 sm:h-14 bg-gradient-to-br from-primary to-primary-700 rounded-full flex items-center justify-center shadow-lg flex-shrink-0">
                <span className="text-xl sm:text-2xl font-bold text-white">Y</span>
              </div>
              <div className="min-w-0">
                <h2 className="text-xl sm:text-2xl font-bold text-gray-900">YEGO</h2>
                <p className="text-xs sm:text-sm text-gray-500">Sistema Integral</p>
              </div>
            </div>

            {/* Headline */}
            <div className="space-y-2 sm:space-y-4 mb-6 sm:mb-10">
              <h1 className="text-2xl sm:text-3xl lg:text-5xl font-bold text-gray-900 leading-tight">
                Gestión empresarial <span className="text-primary">inteligente</span>
              </h1>
              <p className="text-sm sm:text-base lg:text-lg text-gray-600 leading-relaxed">
                Plataforma integral para la gestión de conductores, entregas y operaciones empresariales con tecnología de vanguardia.
              </p>
            </div>

            {/* Features */}
            <div className="space-y-3 sm:space-y-4 max-w-xl">
              {features.map((feature, index) => {
                const Icon = feature.icon;
                const colorClasses = {
                  primary: 'bg-red-50',
                  green: 'bg-green-50',
                  yellow: 'bg-yellow-50',
                };
                const iconColorClasses = {
                  primary: 'text-red-600',
                  green: 'text-green-600',
                  yellow: 'text-yellow-600',
                };

                return (
                  <div
                    key={index}
                    className={`${colorClasses[feature.color as keyof typeof colorClasses]} rounded-xl sm:rounded-2xl p-3 sm:p-5 flex items-center gap-3 sm:gap-4 shadow-sm hover:shadow-md transition-shadow duration-200`}
                  >
                    <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-lg sm:rounded-xl ${colorClasses[feature.color as keyof typeof colorClasses]} flex items-center justify-center flex-shrink-0 border border-gray-100`}>
                      <Icon className={`h-5 w-5 sm:h-6 sm:w-6 ${iconColorClasses[feature.color as keyof typeof iconColorClasses]}`} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-bold text-gray-900 text-sm sm:text-base mb-0.5">{feature.title}</h3>
                      <p className="text-xs sm:text-sm text-gray-600">{feature.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Section - Login Form (en móvil va primero) */}
          <div className="flex justify-center lg:justify-end order-1 lg:order-2">
            <div className="w-full max-w-md">
              <div className="bg-white rounded-xl sm:rounded-2xl shadow-2xl p-4 sm:p-6 lg:p-8 border border-gray-100">
                {error && (
                  <div className="mb-4 sm:mb-6 p-3 sm:p-4 bg-red-50 border-l-4 border-red-500 rounded-lg flex items-start gap-2 sm:gap-3">
                    <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                    <p className="text-xs sm:text-sm text-red-800 font-medium">{error}</p>
                  </div>
                )}

                <div className="mb-4 sm:mb-6">
                  <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-1 sm:mb-2">Iniciar Sesión</h2>
                  <p className="text-xs sm:text-sm text-gray-600">Accede a tu cuenta empresarial</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
                  <div>
                    <label htmlFor="email" className="block text-xs sm:text-sm font-semibold text-gray-700 mb-1.5 sm:mb-2">
                      Usuario
                    </label>
                    <div className="relative group">
                      <div className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-primary transition-colors duration-200 pointer-events-none">
                        <User className="h-4 w-4 sm:h-5 sm:w-5" />
                      </div>
                      <input
                        id="email"
                        type="text"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        autoComplete="username"
                        autoFocus
                        className="w-full min-h-[44px] pl-10 sm:pl-12 pr-3 sm:pr-4 py-3 sm:py-3.5 bg-gray-50 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary focus:bg-white outline-none transition-all duration-200 text-sm sm:text-base text-gray-900 placeholder-gray-400 touch-manipulation"
                        placeholder="DNI, email o usuario"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="password" className="block text-xs sm:text-sm font-semibold text-gray-700 mb-1.5 sm:mb-2">
                      Contraseña
                    </label>
                    <div className="relative group">
                      <div className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-primary transition-colors duration-200 pointer-events-none">
                        <Lock className="h-4 w-4 sm:h-5 sm:w-5" />
                      </div>
                      <input
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        autoComplete="current-password"
                        className="w-full min-h-[44px] pl-10 sm:pl-12 pr-10 sm:pr-12 py-3 sm:py-3.5 bg-gray-50 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary focus:bg-white outline-none transition-all duration-200 text-sm sm:text-base text-gray-900 placeholder-gray-400 touch-manipulation"
                        placeholder="Ingrese su contraseña"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 sm:right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-primary transition-colors duration-200 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center touch-manipulation"
                        aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      >
                        {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full min-h-[44px] bg-gradient-to-r from-primary to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white font-bold py-3 sm:py-3.5 px-4 sm:px-6 rounded-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg hover:shadow-xl active:translate-y-0 mt-4 sm:mt-6 text-sm sm:text-base touch-manipulation"
                  >
                    {loading ? (
                      <>
                        <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent flex-shrink-0"></div>
                        <span>Iniciando sesión...</span>
                      </>
                    ) : (
                      <>
                        <span>Iniciar Sesión</span>
                        <ArrowRight className="h-5 w-5 flex-shrink-0" />
                      </>
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;






