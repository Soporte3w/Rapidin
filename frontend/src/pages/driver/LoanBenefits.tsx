import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  Shield, DollarSign, Car, Hospital, Cake, Wrench, Smartphone, Star, Droplet,
  ChevronRight, Info,
  Badge
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
  const { user } = useAuth();
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
    <div className="space-y-6 lg:space-y-8">
      {/* Header */}
      <div className="bg-[#8B1A1A] rounded-lg p-5 lg:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <Star className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl lg:text-2xl font-bold text-white leading-tight">
                Beneficios Yego Premium Oro
              </h1>
              <p className="text-sm lg:text-base text-white/90 mt-0.5">
                Recursos exclusivos para conductores activos
              </p>
            </div>
          </div>

          <button
            onClick={handleContinue}
            className="bg-white border-2 border-red-600 text-red-600 font-semibold py-2.5 px-5 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2 text-sm lg:text-base w-full lg:w-auto justify-center whitespace-nowrap"
          >
            Solicitar Préstamo Rapidín
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-6 lg:p-10 animate-fade-in">
          <div className="text-center mb-6">
            <h2 className="text-2xl lg:text-3xl font-bold text-gray-900 mb-2">
              Yego Premium - <span className="text-red-600">Beneficios Exclusivos</span>
            </h2>
            <p className="text-base text-gray-700 mb-3">
              Tu esfuerzo merece respaldo. Con Yego Premium, conduces con más seguridad.
            </p>
            <div className="inline-flex items-center gap-2 bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-300 rounded-lg px-4 py-2">
              <p className="text-sm text-gray-900 font-bold">
                Es completamente <span className="text-red-600">gratis</span> para todos los conductores activos en YEGO
              </p>
            </div>
          </div>

          {/* Benefits Carousel con paginación */}
          <div className="mb-8">
            <div className="relative">
              {/* Grid de tarjetas */}
              <div className="flex justify-center mb-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-7xl w-full">
                  {currentBenefits.map((benefit, idx) => {
                    const Icon = benefit.icon;
                    return (
                      <div
                        key={idx}
                        className="bg-white rounded-xl border-2 border-gray-200 hover:border-red-300 transition-all shadow-md hover:shadow-xl flex flex-col group"
                      >
                        {/* Header con icono y tag */}
                        <div className="relative p-4 pb-3">
                          <div className="flex items-start justify-between mb-2">
                            <div className="w-12 h-12 bg-gradient-to-br from-red-500 to-red-600 rounded-xl flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                              <Icon className="w-6 h-6 text-white" />
                            </div>
                            <span className="bg-white border-2 border-gray-200 text-gray-900 text-xs font-bold px-2.5 py-1 rounded-lg shadow-sm">
                              {benefit.tag}
                            </span>
                          </div>
                        </div>

                        {/* Contenido */}
                        <div className="px-4 pb-3 flex-1">
                          <h3 className="text-base font-bold text-gray-900 mb-1.5 group-hover:text-red-600 transition-colors">
                            {benefit.title}
                          </h3>
                          <p className="text-xs text-gray-600 leading-relaxed">
                            {benefit.description}
                          </p>
                        </div>

                        {/* Separador */}
                        <div className="border-t border-gray-200 mx-4"></div>

                        {/* Footer */}
                        <div className="px-4 py-3">
                          <div className="flex items-center gap-2 text-xs text-gray-500">
                            <span>Beneficio exclusivo Yego Premium Oro</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Paginación con puntos */}
              <div className="flex flex-col items-center gap-3">
                <div className="flex items-center justify-center gap-2">
                  {Array.from({ length: totalPages }).map((_, idx) => (
                    <button
                      key={idx}
                      onClick={() => setCurrentPage(idx)}
                      className={`h-2 rounded-full transition-all duration-300 ${
                        currentPage === idx
                          ? 'bg-gradient-to-r from-red-600 to-red-500 w-8 shadow-md'
                          : 'bg-gray-300 w-2 hover:bg-gray-400'
                      }`}
                    />
                  ))}
                </div>
                <p className="text-sm font-semibold text-gray-600">
                  Has visto {Math.min((currentPage + 1) * itemsPerPage, benefits.length)} de {benefits.length} beneficios
                </p>
              </div>
            </div>
          </div>

          {/* Información Importante */}
          <div className="bg-[#fefcea] rounded-lg border-l-2 border-[#e08a00] p-3 lg:p-4 mb-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <Info className="w-4 h-4 text-[#e08a00]" />
              </div>
              <div className="flex-1">
                <h3 className="text-sm lg:text-base font-bold text-[#e08a00] mb-1.5">
                  Importante
                </h3>
                <p className="text-xs lg:text-sm text-[#e08a00] leading-relaxed">
                  <span className="font-semibold">Rapidín</span> es un beneficio exclusivo de <strong>Yego Premium Oro</strong>. Si dejas de ser conductor activo o no cumples con los requisitos (<strong>2 meses anteriores + 400 viajes</strong>), perderás el acceso a todos estos beneficios.
                </p>
              </div>
            </div>
          </div>

        </div>
    </div>
  );
}




