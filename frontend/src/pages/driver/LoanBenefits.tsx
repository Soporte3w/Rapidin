import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  Shield, DollarSign, Car, Hospital, Cake, Wrench, Smartphone, Star, Droplet,
  ChevronRight, Info
} from 'lucide-react';

const benefits = [
  { icon: Shield, title: 'Escudo de Bonos', description: 'Protección especial para situaciones inesperadas', tag: 'Oro' },
  { icon: DollarSign, title: 'Préstamos Urgentes', description: 'Acceso a préstamos rápidos para emergencias', tag: 'Oro' },
  { icon: Car, title: 'Apoyo ante Choques', description: 'Asistencia en caso de accidentes durante tus rutas', tag: 'Oro' },
  { icon: Hospital, title: 'Apoyo Hospitalización', description: 'Asistencia en caso de hospitalización', tag: 'Oro' },
  { icon: Cake, title: 'Celebración de Cumpleaños', description: 'Sorpresas especiales en tu día especial', tag: 'Oro' },
  { icon: Wrench, title: 'Apoyo Multa ATU', description: 'Asistencia con multas de tránsito', tag: 'Oro' },
  { icon: Smartphone, title: 'Reposición de Celular', description: 'Apoyo en caso de robo de tu dispositivo', tag: 'Oro' },
  { icon: Star, title: 'Eventos Especiales', description: 'Participación en eventos exclusivos de la comunidad', tag: 'Oro' },
  { icon: Droplet, title: 'Lavado de Salón', description: 'Servicio de limpieza para tu vehículo', tag: 'Oro' },
];

export default function LoanBenefits() {
  const navigate = useNavigate();
  useAuth();
  const [currentPage, setCurrentPage] = useState(0);
  const itemsPerPage = 4;
  const totalPages = Math.ceil(benefits.length / itemsPerPage);
  const currentBenefits = benefits.slice(currentPage * itemsPerPage, (currentPage + 1) * itemsPerPage);

  // Auto-avance automático cada 5 segundos
  useEffect(() => {
    if (totalPages <= 1) return; // No hacer auto-avance si solo hay una página

    const interval = setInterval(() => {
      setCurrentPage((prevPage) => (prevPage + 1) % totalPages);
    }, 5000); // Cambia cada 5 segundos

    return () => clearInterval(interval);
  }, [totalPages]);

  const handleContinue = () => {
    navigate('/driver/loan-offer-verification');
  };
   // para un futuro bagde por pais para los beneficios de los conductores de cada pais
   // const countryName = user?.country === 'PE' ? 'Perú' : user?.country === 'CO' ? 'Colombia' : '';

  return (
    <div className="space-y-3 sm:space-y-4 lg:space-y-8 px-2 sm:px-0">
      {/* Header - compacto en móvil */}
      <div className="bg-[#8B1A1A] rounded-xl sm:rounded-lg p-3 sm:p-4 lg:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 sm:w-11 sm:h-11 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <Star className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-xl lg:text-2xl font-bold text-white leading-tight truncate">
                Beneficios Yego Premium Oro
              </h1>
              <p className="text-xs sm:text-sm lg:text-base text-white/90 mt-0.5 truncate">
                Recursos exclusivos para conductores activos
              </p>
            </div>
          </div>

          <button
            onClick={handleContinue}
            className="bg-white border-2 border-white text-[#8B1A1A] font-semibold min-h-[44px] py-3 px-4 rounded-xl sm:rounded-lg hover:bg-gray-50 active:bg-gray-100 transition-colors flex items-center justify-center gap-2 text-sm w-full lg:w-auto touch-manipulation"
          >
            <span>Solicitar Préstamo Rapidín</span>
            <ChevronRight className="w-4 h-4 flex-shrink-0" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="bg-white rounded-xl sm:rounded-2xl shadow-xl border border-gray-100 p-4 sm:p-6 lg:p-10 animate-fade-in">
          <div className="text-center mb-4 sm:mb-6">
            <h2 className="text-lg sm:text-2xl lg:text-3xl font-bold text-gray-900 mb-2">
              Yego Premium - <span className="text-red-600">Beneficios Exclusivos</span>
            </h2>
            <p className="text-sm sm:text-base text-gray-700 mb-2 sm:mb-3">
              Tu esfuerzo merece respaldo. Con Yego Premium, conduces con más seguridad.
            </p>
            <div className="inline-flex items-center gap-2 bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-300 rounded-lg px-3 sm:px-4 py-2">
              <p className="text-xs sm:text-sm text-gray-900 font-bold">
                Es completamente <span className="text-red-600">gratis</span> para conductores activos en YEGO
              </p>
            </div>
          </div>

          {/* Benefits Carousel con paginación */}
          <div className="mb-5 sm:mb-8">
            <div className="relative">
              <div className="flex justify-center mb-4 sm:mb-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 max-w-7xl w-full">
                  {currentBenefits.map((benefit, idx) => {
                    const Icon = benefit.icon;
                    return (
                      <div
                        key={idx}
                        className="bg-white rounded-xl border-2 border-gray-200 hover:border-red-300 transition-all shadow-md hover:shadow-xl flex flex-col group"
                      >
                        <div className="relative p-3 sm:p-4 pb-2 sm:pb-3">
                          <div className="flex items-start justify-between mb-1.5 sm:mb-2">
                            <div className="w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-br from-red-500 to-red-600 rounded-xl flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                              <Icon className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
                            </div>
                            <span className="bg-white border-2 border-gray-200 text-gray-900 text-[10px] sm:text-xs font-bold px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-lg shadow-sm">
                              {benefit.tag}
                            </span>
                          </div>
                        </div>

                        <div className="px-3 sm:px-4 pb-2 sm:pb-3 flex-1">
                          <h3 className="text-sm sm:text-base font-bold text-gray-900 mb-1 sm:mb-1.5 group-hover:text-red-600 transition-colors">
                            {benefit.title}
                          </h3>
                          <p className="text-[11px] sm:text-xs text-gray-600 leading-relaxed">
                            {benefit.description}
                          </p>
                        </div>

                        <div className="border-t border-gray-200 mx-3 sm:mx-4"></div>

                        <div className="px-3 sm:px-4 py-2 sm:py-3">
                          <div className="flex items-center gap-2 text-[10px] sm:text-xs text-gray-500">
                            <span>Beneficio exclusivo Yego Premium Oro</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Paginación con puntos - táctil en móvil */}
              <div className="flex flex-col items-center gap-2 sm:gap-3">
                <div className="flex items-center justify-center gap-1.5 sm:gap-2">
                  {Array.from({ length: totalPages }).map((_, idx) => (
                    <button
                      key={idx}
                      onClick={() => setCurrentPage(idx)}
                      className={`h-1.5 sm:h-2 rounded-full transition-all duration-300 touch-manipulation min-w-[8px] ${
                        currentPage === idx
                          ? 'bg-gradient-to-r from-red-600 to-red-500 w-6 sm:w-8 shadow-md'
                          : 'bg-gray-300 w-1.5 sm:w-2 hover:bg-gray-400'
                      }`}
                      aria-label={`Página ${idx + 1}`}
                    />
                  ))}
                </div>
                <p className="text-xs sm:text-sm font-semibold text-gray-600">
                  {Math.min((currentPage + 1) * itemsPerPage, benefits.length)} de {benefits.length} beneficios
                </p>
              </div>
            </div>
          </div>

          {/* Información Importante */}
          <div className="bg-[#fefcea] rounded-lg border-l-2 border-[#e08a00] p-2.5 sm:p-3 lg:p-4 mb-0">
            <div className="flex items-start gap-2 sm:gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <Info className="w-4 h-4 text-[#e08a00]" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-xs sm:text-sm lg:text-base font-bold text-[#e08a00] mb-1 sm:mb-1.5">
                  Importante
                </h3>
                <p className="text-[11px] sm:text-xs lg:text-sm text-[#e08a00] leading-relaxed">
                  <span className="font-semibold">Rapidín</span> es un beneficio exclusivo de <strong>Yego Premium Oro</strong>. Si dejas de ser conductor activo o no cumples con los requisitos (<strong>2 meses + 400 viajes</strong>), perderás el acceso a estos beneficios.
                </p>
              </div>
            </div>
          </div>

        </div>
    </div>
  );
}




