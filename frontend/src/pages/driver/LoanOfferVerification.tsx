import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getStoredSelectedParkId, getStoredSelectedExternalDriverId } from '../../utils/authStorage';
import { formatCurrency } from '../../utils/currency';
import api from '../../services/api';
import { CheckCircle2, Info, ChevronRight, ArrowLeft, PartyPopper, FileCheck, ShieldCheck } from 'lucide-react';

interface LoanOffer {
  cycle: number;
  maxAmount: number;
  hasOffer: boolean;
}

export default function LoanOfferVerification() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const country = user?.country || 'PE';
  const [loading, setLoading] = useState(true);
  const [offer, setOffer] = useState<LoanOffer | null>(null);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState<{ reason?: string; flotas?: Array<{ flota_name: string; status?: string }> } | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [blockingFlotas, setBlockingFlotas] = useState<Array<{ flota_name: string; status?: string }>>([]);

  useEffect(() => {
    loadOffer();
  }, []);

  // Mostrar confeti cuando se confirme que está apto
  useEffect(() => {
    if (!loading && offer?.hasOffer && !error) {
      setShowConfetti(true);
      // Ocultar confeti después de 3 segundos
      const timer = setTimeout(() => {
        setShowConfetti(false);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [loading, offer, error]);

  const loadOffer = async () => {
    try {
      setLoading(true);
      setError('');
      setBlockingFlotas([]);
      const parkId = getStoredSelectedParkId() || undefined;
      const externalDriverId = getStoredSelectedExternalDriverId() || undefined;
      const params = new URLSearchParams();
      if (parkId) params.set('park_id', parkId);
      if (externalDriverId) params.set('external_driver_id', externalDriverId);
      const response = await api.get('/driver/loan-offer', { params: Object.fromEntries(params) });
      setOffer(response.data.data);
    } catch (err: any) {
      console.error('Error loading offer:', err);
      setError(err.response?.data?.message || 'Error al verificar la oferta');
      const details = err.response?.data?.details;
      setErrorDetails(details || null);
      const flotas = details?.flotas;
      if (Array.isArray(flotas) && flotas.length > 0) setBlockingFlotas(flotas);
    } finally {
      setLoading(false);
    }
  };

  const handleContinue = () => {
    if (offer?.hasOffer) {
      navigate('/driver/loan-request-flow');
    }
  };

  const handleGoBack = () => {
    navigate('/driver/loan-benefits');
  };

  if (loading) {
    return (
      <div className="h-screen overflow-hidden flex items-center justify-center bg-gradient-to-b from-gray-50 to-white">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-[#8B1A1A] border-t-transparent rounded-full animate-spin mx-auto mb-5"></div>
          <p className="text-base font-semibold text-gray-700">Verificando ofertas disponibles...</p>
        </div>
      </div>
    );
  }

  if (error) {
    const isInsufficientTrips = errorDetails?.reason === 'insufficient_trips';
    const isAlreadyHasLoan = !isInsufficientTrips && /préstamo|solicitud|aprobada|pendiente|en proceso|activo|firmada|desembolsada|crédito/i.test(error);
    const mentionsFlota = /en\s+["'].*["']|en otra flota|en esta flota/i.test(error);
    const errorTitle = isInsufficientTrips
      ? 'No cumples el mínimo de viajes'
      : isAlreadyHasLoan
        ? (mentionsFlota ? 'Crédito o solicitud en otra flota' : 'Ya tienes un préstamo o solicitud en curso')
        : 'No puedes continuar';
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        <div className="flex-1 flex items-center justify-center p-4 min-h-0">
          <div className="bg-white rounded-3xl shadow-xl border border-amber-100 max-w-md w-full overflow-hidden">
            <div className="p-6 sm:p-8 text-center">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">
                {errorTitle}
              </h2>
              <p className="text-sm sm:text-base text-gray-600 leading-relaxed mb-4 whitespace-pre-line">
                {error}
              </p>
              {blockingFlotas.length > 0 && (
                <div className="mb-6 text-left">
                  <p className="text-sm font-semibold text-gray-700 mb-2">Flotas donde tienes crédito o solicitud en curso:</p>
                  <ul className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-1.5 max-h-40 overflow-y-auto">
                    {blockingFlotas.map((f, i) => (
                      <li key={i} className="text-sm text-gray-800 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
                        {f.flota_name}
                        {f.status && (
                          <span className="text-gray-500 text-xs">({f.status === 'pending' ? 'pendiente' : f.status === 'approved' ? 'aprobada' : f.status === 'signed' ? 'firmada' : f.status === 'disbursed' ? 'desembolsada' : f.status})</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button
                onClick={() => navigate('/driver/resumen')}
                className="w-full bg-[#8B1A1A] hover:bg-[#7A1616] text-white font-semibold py-3.5 px-6 rounded-xl transition-colors shadow-md hover:shadow-lg"
              >
                Ir al Resumen
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!offer?.hasOffer) {
    return (
      <div className="h-screen overflow-hidden flex flex-col bg-gradient-to-b from-gray-50 via-white to-slate-50">
        <div className="flex-1 flex items-center justify-center p-4 min-h-0">
          <div className="bg-white rounded-3xl shadow-xl border border-gray-100 max-w-md w-full overflow-hidden text-center">
            <div className="p-6 sm:p-8">
              <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-5 rounded-2xl bg-gradient-to-br from-gray-400 to-gray-500 flex items-center justify-center shadow-lg">
                <Info className="w-8 h-8 sm:w-10 sm:h-10 text-white" strokeWidth={2.5} />
              </div>
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">No hay ofertas disponibles</h2>
              <p className="text-sm sm:text-base text-gray-600 leading-relaxed mb-6">
                En este momento no tienes ofertas de préstamo disponibles. Mantén un buen historial de cumplimiento para acceder a préstamos en el futuro.
              </p>
              <button
                onClick={() => navigate('/driver/resumen')}
                className="w-full bg-[#8B1A1A] hover:bg-[#7A1616] text-white font-semibold py-3.5 px-6 rounded-xl transition-colors shadow-md hover:shadow-lg"
              >
                Ir al Resumen
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const countryName = user?.country === 'PE' ? 'Perú' : user?.country === 'CO' ? 'Colombia' : '';

  return (
    <div className="space-y-2 lg:space-y-3 flex flex-col">
      {/* Header */}
      <div className="bg-[#8B1A1A] rounded-lg p-2.5 lg:p-3 flex-shrink-0">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <CheckCircle2 className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm lg:text-base font-bold text-white leading-tight">
                Verificación de Oferta Rapidín
              </h1>
              <p className="text-xs text-white/90">
                Beneficio exclusivo Yego Premium Oro - {countryName}
              </p>
            </div>
          </div>

          <button
            onClick={handleContinue}
            className="bg-white border-2 border-red-600 text-red-600 font-semibold py-3 px-5 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2 text-sm w-full lg:w-auto justify-center whitespace-nowrap"
          >
            Continuar con mi solicitud
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Botón Volver */}
      <button
        onClick={handleGoBack}
        className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-red-600 transition-colors flex-shrink-0"
      >
        <ArrowLeft className="w-3 h-3" />
        <span>Volver para ver los beneficios</span>
      </button>

      {/* Offer Section */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-3 lg:p-4 animate-fade-in relative overflow-hidden flex-1 flex flex-col">
        {/* Confeti Animation dentro del card - Explosión */}
        {showConfetti && (
          <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden rounded-xl">
            {Array.from({ length: 100 }).map((_, i) => {
              const angle = (Math.PI * 2 * i) / 100;
              const randomAngle = angle + (Math.random() - 0.5) * 0.8;
              const velocity = 120 + Math.random() * 150;
              const x = Math.cos(randomAngle) * velocity;
              const y = Math.sin(randomAngle) * velocity;
              const rotation = Math.random() * 1080;
              return (
                <div
                  key={i}
                  className="absolute confetti-explosion"
                  style={{
                    left: '50%',
                    top: '50%',
                    animationDelay: `${Math.random() * 0.2}s`,
                    animationDuration: `${1.2 + Math.random() * 0.8}s`,
                    '--x': `${x}px`,
                    '--y': `${y}px`,
                    '--rotation': `${rotation}deg`,
                    backgroundColor: ['#ef4444', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#22c55e', '#eab308'][Math.floor(Math.random() * 10)],
                    width: `${12 + Math.random() * 14}px`,
                    height: `${12 + Math.random() * 14}px`,
                    borderRadius: Math.random() > 0.4 ? '50%' : '0%',
                  } as React.CSSProperties}
                />
              );
            })}
          </div>
        )}

        <style>{`
          @keyframes confetti-explosion {
            0% {
              transform: translate(-50%, -50%) translate(0, 0) rotate(0deg) scale(1.2);
              opacity: 1;
            }
            50% {
              opacity: 1;
            }
            100% {
              transform: translate(-50%, -50%) translate(var(--x), var(--y)) rotate(var(--rotation)) scale(0.3);
              opacity: 0;
            }
          }
          .confetti-explosion {
            animation: confetti-explosion cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
          }
        `}</style>

        <div className="text-center mb-2 relative z-20 flex-shrink-0">
          <div className="flex items-center justify-center gap-2 mb-2">
            <PartyPopper className="w-4 h-4 lg:w-5 lg:h-5 text-yellow-500 animate-bounce" />
            <h2 className="text-base lg:text-lg font-bold text-gray-900">
              ¡Tienes una oferta disponible!
            </h2>
            <PartyPopper className="w-4 h-4 lg:w-5 lg:h-5 text-yellow-500 animate-bounce" />
          </div>
        </div>

        {/* Monto */}
        <div className="bg-white rounded-xl p-5 lg:p-6 mb-4 shadow-lg flex-shrink-0">
          <div className="text-center">
            <p className="text-sm font-medium text-gray-500 mb-2 uppercase tracking-wide">
              Monto máximo disponible
            </p>
            <div className="flex items-baseline justify-center gap-2">
              <p className="text-4xl lg:text-5xl font-bold text-gray-900">
                {formatCurrency(offer.maxAmount, country)}
              </p>
            </div>
            <div className="mt-3 pt-3 border-t border-gray-200">
              <p className="text-sm text-gray-500">
                Según tu historial de cumplimiento
              </p>
            </div>
          </div>
        </div>

        {/* Información Importante */}
        <div className="bg-[#fefcea] rounded-lg border-l-4 border-[#e08a00] p-3 lg:p-4 mb-4 flex-shrink-0">
            <div className="flex items-start gap-2.5">
              <div className="flex-shrink-0 mt-0.5">
                <Info className="w-4 h-4 text-[#e08a00]" />
              </div>
              <div className="flex-1">
              <h3 className="text-xs font-bold text-[#e08a00] mb-1">
                Importante
              </h3>
                <p className="text-xs text-[#e08a00] leading-relaxed">
                Mientras más cumplas con tus pagos a <span className="font-semibold">Rapidín</span>, más te prestamos. Si mantienes un buen cumplimiento, podrás acceder a montos mayores en los siguientes ciclos.
              </p>
              </div>
            </div>
          </div>

        <div className="pt-1.5 border-t border-gray-200 text-center flex-shrink-0">
          <a
            href="#"
            className="text-xs font-medium text-gray-600 hover:text-red-600 transition-colors"
          >
            ¿Necesitas ayuda? Contactar por WhatsApp
          </a>
        </div>
      </div>
    </div>
  );
}




