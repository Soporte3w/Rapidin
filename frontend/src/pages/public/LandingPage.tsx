import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getStoredSelectedParkId, getStoredSelectedExternalDriverId, getStoredSession, setStoredSession } from '../../utils/authStorage';
import { Shield, ArrowRight, CheckCircle, AlertCircle, Zap, Clock } from 'lucide-react';
import api from '../../services/api';

const LandingPage = () => {
  const navigate = useNavigate();
  const { loginWithPhone, user, updateUser } = useAuth();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [detectedCountry, setDetectedCountry] = useState<'PE' | 'CO'>('PE'); // Por defecto Perú
  const [countdown, setCountdown] = useState(0);

  // Redirigir si ya está autenticado (conductores solo a resumen si ya eligieron flota)
  useEffect(() => {
    if (user) {
      if (user.role === 'driver' || user.phone) {
        // Solo redirigir a resumen si ya tiene flota elegida; si no, el flujo de código llevará a seleccionar-flota
        if (getStoredSelectedParkId() || getStoredSelectedExternalDriverId()) {
          navigate('/driver/resumen', { replace: true });
        }
      } else {
        navigate('/admin/dashboard', { replace: true });
      }
    }
  }, [user, navigate]);

  const features = [
    {
      icon: Zap,
      title: 'Aprobación Rápida',
      description: 'Respuesta en minutos',
      color: 'green',
    },
    {
      icon: Shield,
      title: 'Seguro y Confiable',
      description: 'Protección de datos garantizada',
      color: 'red',
    },
    {
      icon: Clock,
      title: 'Disponible 24/7',
      description: 'Solicita cuando lo necesites',
      color: 'yellow',
    },
  ];

  const formatPhone = (value: string) => {
    // Solo números, sin formato especial
    const cleaned = value.replace(/\D/g, '');
    
    if (detectedCountry === 'PE') {
      // Formato Perú: 987 654 321 (9 dígitos)
      if (cleaned.length <= 3) return cleaned;
      if (cleaned.length <= 6) return `${cleaned.slice(0, 3)} ${cleaned.slice(3)}`;
      return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(6, 9)}`;
    } else {
      // Formato Colombia: 300 123 4567 (10 dígitos)
      if (cleaned.length <= 3) return cleaned;
      if (cleaned.length <= 6) return `${cleaned.slice(0, 3)} ${cleaned.slice(3)}`;
      return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(6, 10)}`;
    }
  };

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const cleanedPhone = phone.replace(/\D/g, '');
    
    // Construir el número completo con el código de país (con +)
    const countryCode = detectedCountry === 'PE' ? '51' : '57';
    const fullPhone = `+${countryCode}${cleanedPhone}`;

    if (!cleanedPhone || cleanedPhone.length < 9) {
      setError('Por favor ingresa un número de teléfono válido');
      setLoading(false);
      return;
    }

    console.log('[DEBUG] Enviando phone:', fullPhone); // Debug

    try {
      await api.post('/auth/send-otp', { phone: fullPhone, country: detectedCountry });
      setStep('code');
      setCountdown(60);
      const interval = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(interval);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Error al enviar el código. Verifica tu número de teléfono.');
    } finally {
      setLoading(false);
    }
  };

  const handleCodeChange = (index: number, value: string) => {
    if (value.length > 1) return;
    const newCode = [...code];
    newCode[index] = value.replace(/\D/g, '');
    setCode(newCode);

    if (value && index < 5) {
      const nextInput = document.getElementById(`code-${index + 1}`);
      nextInput?.focus();
    }
  };

  const handleCodePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '');
    
    if (pastedData.length === 6) {
      const newCode = pastedData.split('').slice(0, 6);
      setCode(newCode);
      // Enfocar el último input
      document.getElementById('code-5')?.focus();
    }
  };

  const handleCodeKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      const prevInput = document.getElementById(`code-${index - 1}`);
      prevInput?.focus();
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const codeString = code.join('');
    
    if (codeString.length !== 6) {
      setError('Por favor ingresa el código completo de 6 dígitos');
      return;
    }

    setLoading(true);
    setError('');

    const cleanedPhone = phone.replace(/\D/g, '');
    const countryCode = detectedCountry === 'PE' ? '51' : '57';
    const fullPhone = `+${countryCode}${cleanedPhone}`;

    try {
      const data = await loginWithPhone(fullPhone, codeString, detectedCountry);
      const flotas = data?.flotas || [];
      if (flotas.length > 1) {
        // No dejar driver_id/car_id hasta que elija flota (evitar autocompletado)
        updateUser({ driver_id: undefined, car_id: undefined });
        navigate('/driver/seleccionar-flota', { state: { flotas }, replace: true });
      } else if (flotas.length === 1) {
        const session = getStoredSession();
        if (session) {
          const f = flotas[0];
          setStoredSession({
            ...session,
            user: session.user,
            selectedParkId: f.park_id || undefined,
            selectedExternalDriverId: f.driver_id || undefined,
            selectedRapidinDriverId: (f as { rapidin_driver_id?: string | null }).rapidin_driver_id ?? undefined,
            selectedFlotaName: f.flota_name || undefined,
          });
        }
        navigate('/driver/resumen', { replace: true });
      } else {
        navigate('/driver/resumen', { replace: true });
      }
    } catch (err: any) {
      const msg = err.response?.data?.message || 'Código inválido. Por favor intenta nuevamente.';
      setError(msg);
      // Si el código expiró, no borrar los dígitos para que el usuario vea el mensaje y lo que ingresó
      const isExpired = /expirado|expiró/i.test(msg);
      if (!isExpired) {
        setCode(['', '', '', '', '', '']);
        document.getElementById('code-0')?.focus();
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (countdown > 0) return;
    
    setLoading(true);
    setError('');
    const cleanedPhone = phone.replace(/\D/g, '');
    const countryCode = detectedCountry === 'PE' ? '51' : '57';
    const fullPhone = `+${countryCode}${cleanedPhone}`;

    try {
      await api.post('/auth/send-otp', { phone: fullPhone, country: detectedCountry });
      setCountdown(60);
      const interval = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(interval);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Error al reenviar el código');
    } finally {
      setLoading(false);
    }
  };

  const getIconBg = (color: string) => {
    switch (color) {
      case 'green':
        return 'bg-green-50';
      case 'red':
        return 'bg-red-50';
      case 'yellow':
        return 'bg-yellow-50';
      default:
        return 'bg-gray-50';
    }
  };

  const getIconColor = (color: string) => {
    switch (color) {
      case 'green':
        return 'text-green-600';
      case 'red':
        return 'text-red-600';
      case 'yellow':
        return 'text-yellow-600';
      default:
        return 'text-gray-600';
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <div className="w-full max-w-7xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          {/* Left Section - Content (Hidden on mobile) */}
          <div className="hidden lg:block space-y-8">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <div className="w-14 h-14 bg-primary rounded-full flex items-center justify-center shadow-lg">
                <span className="text-2xl font-bold text-white">Y</span>
              </div>
              <div>
                <h2 className="text-2xl font-bold text-gray-900">YEGO</h2>
                <p className="text-sm text-gray-500">Rapidín</p>
              </div>
            </div>

            {/* Headline */}
            <div className="space-y-4">
              <h1 className="text-4xl lg:text-5xl font-bold text-gray-900 leading-tight">
                Micro-préstamos <span className="text-primary">rápidos</span>
              </h1>
              <p className="text-lg text-gray-600 leading-relaxed max-w-xl">
                Plataforma integral para la gestión de préstamos rápidos para conductores Yego con tecnología de vanguardia.
              </p>
            </div>

            {/* Features */}
            <div className="space-y-4 max-w-xl">
              {features.map((feature, index) => {
                const Icon = feature.icon;
                return (
                  <div
                    key={index}
                    className={`${getIconBg(feature.color)} rounded-2xl p-5 flex items-center gap-4`}
                  >
                    <div className={`w-12 h-12 rounded-xl ${getIconBg(feature.color)} flex items-center justify-center flex-shrink-0 border border-gray-100`}>
                      <Icon className={`h-6 w-6 ${getIconColor(feature.color)}`} />
                    </div>
                    <div>
                      <h3 className="font-bold text-gray-900 text-base mb-0.5">{feature.title}</h3>
                      <p className="text-sm text-gray-600">{feature.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Section - Login Form */}
          <div className="w-full flex justify-center lg:justify-end">
            {/* Mobile Logo - Only visible on mobile */}
            <div className="w-full max-w-md">
              <div className="lg:hidden flex items-center justify-center gap-3 mb-8">
                <div className="w-12 h-12 bg-primary rounded-full flex items-center justify-center shadow-lg">
                  <span className="text-xl font-bold text-white">Y</span>
                </div>
                <div>
                  <h2 className="text-xl font-bold text-gray-900">YEGO</h2>
                  <p className="text-xs text-gray-500">Rapidín</p>
                </div>
              </div>

              <div className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl p-4 sm:p-6 lg:p-8 border border-gray-100">
                {step === 'phone' ? (
                  <form onSubmit={handlePhoneSubmit} className="space-y-6">
                    <div>
                      <h2 className="text-2xl font-bold text-gray-900 mb-2">Inicia Sesión</h2>
                      <p className="text-sm text-gray-600">Accede a tu cuenta</p>
                    </div>

                    <div>
                      <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-2">
                        Número de Teléfono
                      </label>
                      <div className="flex gap-2">
                        {/* Country Selector */}
                        <select
                          value={detectedCountry}
                          onChange={(e) => setDetectedCountry(e.target.value as 'PE' | 'CO')}
                          className="w-28 px-3 py-4 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-transparent focus:bg-white outline-none transition-all text-base font-semibold appearance-none cursor-pointer"
                          style={{
                            backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`,
                            backgroundPosition: 'right 0.5rem center',
                            backgroundRepeat: 'no-repeat',
                            backgroundSize: '1.5em 1.5em',
                            paddingRight: '2.5rem'
                          }}
                        >
                          <option value="PE">🇵🇪 +51</option>
                          <option value="CO">🇨🇴 +57</option>
                        </select>

                        {/* Phone Input */}
                        <div className="relative flex-1">
                          <input
                            id="phone"
                            type="tel"
                            value={phone}
                            onChange={(e) => setPhone(formatPhone(e.target.value))}
                            required
                            autoComplete="tel"
                            autoFocus
                            maxLength={detectedCountry === 'PE' ? 13 : 14}
                            className="w-full px-4 py-4 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-transparent focus:bg-white outline-none transition-all text-base"
                            placeholder={detectedCountry === 'PE' ? '987 654 321' : '300 123 4567'}
                          />
                        </div>
                      </div>
                      {error && step === 'phone' && (
                        <p className="mt-2 text-sm text-red-600 flex items-center gap-1.5">
                          <AlertCircle className="h-4 w-4 flex-shrink-0" />
                          {error}
                        </p>
                      )}
                      {!error && (
                        <p className="mt-2 text-xs text-gray-500">
                          {detectedCountry === 'PE' 
                            ? 'Ingresa tu número de celular de 9 dígitos' 
                            : 'Ingresa tu número de celular de 10 dígitos'}
                        </p>
                      )}
                    </div>
                    
                    <button
                      type="submit"
                      disabled={loading || !phone || phone.replace(/\D/g, '').length < 9}
                      className="w-full bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white font-bold py-4 px-6 rounded-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                    >
                      {loading ? (
                        <>
                          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                          <span>Enviando...</span>
                        </>
                      ) : (
                        <>
                          <span>Enviar</span>
                          <ArrowRight className="h-5 w-5" />
                        </>
                      )}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleCodeSubmit} className="space-y-4 sm:space-y-6">
                    <div>
                      <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-1.5 sm:mb-2">Verifica tu código</h2>
                      <p className="text-xs sm:text-sm text-gray-600 leading-relaxed break-all">
                        Hemos enviado un código de 6 dígitos al <span className="font-semibold text-gray-900">+{detectedCountry === 'PE' ? '51' : '57'} {phone}</span>
                      </p>
                    </div>

                    {/* Inputs del código: más grandes y táctiles en móvil */}
                    <div>
                      <div className="flex justify-center gap-2 sm:gap-3 mb-4 sm:mb-6 flex-wrap">
                        {code.map((digit, index) => (
                          <input
                            key={index}
                            id={`code-${index}`}
                            type="text"
                            inputMode="numeric"
                            maxLength={1}
                            value={digit}
                            onChange={(e) => handleCodeChange(index, e.target.value)}
                            onKeyDown={(e) => handleCodeKeyDown(index, e)}
                            onPaste={handleCodePaste}
                            autoFocus={index === 0}
                            className="w-11 h-12 sm:w-12 sm:h-14 lg:w-14 lg:h-14 min-w-[44px] min-h-[48px] text-center text-xl sm:text-2xl font-bold bg-gray-50 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary focus:bg-white outline-none transition-all touch-manipulation"
                          />
                        ))}
                      </div>
                      {error && (
                        <p className="mb-3 text-xs sm:text-sm text-red-600 flex items-center justify-center gap-1.5">
                          <AlertCircle className="h-4 w-4 flex-shrink-0" />
                          {error}
                        </p>
                      )}
                      <div className="text-center">
                        {countdown > 0 ? (
                          <p className="text-xs sm:text-sm text-gray-600">
                            Reenviar código en <span className="font-semibold text-primary">{countdown}s</span>
                          </p>
                        ) : (
                          <button
                            type="button"
                            onClick={handleResendCode}
                            disabled={loading}
                            className="min-h-[44px] px-4 py-2 text-sm text-primary hover:text-primary-600 font-semibold transition-colors touch-manipulation"
                          >
                            Reenviar código
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setStep('phone');
                          setCode(['', '', '', '', '', '']);
                          setError('');
                        }}
                        className="flex-1 min-h-[44px] px-4 py-3 text-gray-700 bg-gray-100 hover:bg-gray-200 active:bg-gray-300 rounded-xl transition-all font-semibold touch-manipulation"
                      >
                        Cambiar número
                      </button>
                      <button
                        type="submit"
                        disabled={loading || code.join('').length !== 6}
                        className="flex-1 min-h-[44px] bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white font-bold py-3 px-6 rounded-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg hover:shadow-xl touch-manipulation"
                      >
                        {loading ? (
                          <>
                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white flex-shrink-0"></div>
                            <span>Verificando...</span>
                          </>
                        ) : (
                          <>
                            <span>Verificar</span>
                            <CheckCircle className="h-5 w-5 flex-shrink-0" />
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LandingPage;
