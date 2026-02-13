import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { Send, ArrowLeft, CheckCircle, AlertCircle } from 'lucide-react';

const LoanRequestPE = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const isSubmittingRef = useRef(false);
  const [formData, setFormData] = useState({
    dni: '',
    first_name: '',
    last_name: '',
    phone: '',
    email: '',
    requested_amount: '',
    yego_premium: false
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setLoading(true);
    setError('');
    setSuccess(false);

    try {
      await api.post('/rapidin/request', {
        ...formData,
        country: 'PE',
        requested_amount: parseFloat(formData.requested_amount)
      });
      setSuccess(true);
      setTimeout(() => {
        navigate('/');
      }, 3000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Error al enviar la solicitud');
    } finally {
      isSubmittingRef.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-white to-gray-50 py-8 sm:py-12 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-6 sm:mb-8">
          <button
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-2 text-gray-600 hover:text-primary mb-4 transition-colors text-sm sm:text-base"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver al inicio
          </button>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 sm:w-14 sm:h-14 bg-gradient-to-br from-primary to-primary-600 rounded-xl sm:rounded-2xl flex items-center justify-center shadow-lg">
              <span className="text-xl sm:text-2xl font-bold text-white">YR</span>
            </div>
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900">
              Solicitud de Préstamo - <span className="text-primary">Perú</span>
            </h1>
          </div>
          <p className="text-sm sm:text-base text-gray-600 mt-2">
            Completa el formulario para solicitar tu préstamo en soles peruanos
          </p>
        </div>

        {/* Form Card */}
        <div className="bg-white rounded-xl sm:rounded-2xl shadow-2xl border border-gray-100 p-6 sm:p-8">
          {error && (
            <div className="mb-6 p-4 bg-red-50 border-l-4 border-red-500 rounded-lg flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-800 font-medium">{error}</p>
            </div>
          )}

          {success && (
            <div className="mb-6 p-4 bg-green-50 border-l-4 border-green-500 rounded-lg flex items-start gap-3">
              <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-green-800 font-medium mb-1">Solicitud enviada exitosamente</p>
                <p className="text-xs text-green-700">Serás contactado pronto. Redirigiendo...</p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5 sm:space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
              <div className="sm:col-span-2">
                <label htmlFor="dni" className="block text-sm font-semibold text-gray-700 mb-2">
                  DNI (8 dígitos) <span className="text-primary">*</span>
                </label>
                <input
                  id="dni"
                  type="text"
                  value={formData.dni}
                  onChange={(e) => {
                    const value = e.target.value.replace(/\D/g, '').slice(0, 8);
                    setFormData({ ...formData, dni: value });
                  }}
                  required
                  maxLength={8}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all hover:border-gray-300 text-base"
                  placeholder="12345678"
                />
              </div>

              <div>
                <label htmlFor="first_name" className="block text-sm font-semibold text-gray-700 mb-2">
                  Nombre <span className="text-primary">*</span>
                </label>
                <input
                  id="first_name"
                  type="text"
                  value={formData.first_name}
                  onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                  required
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all hover:border-gray-300 text-base"
                  placeholder="Juan"
                />
              </div>

              <div>
                <label htmlFor="last_name" className="block text-sm font-semibold text-gray-700 mb-2">
                  Apellido <span className="text-primary">*</span>
                </label>
                <input
                  id="last_name"
                  type="text"
                  value={formData.last_name}
                  onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                  required
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all hover:border-gray-300 text-base"
                  placeholder="Pérez"
                />
              </div>

              <div>
                <label htmlFor="phone" className="block text-sm font-semibold text-gray-700 mb-2">
                  Teléfono
                </label>
                <input
                  id="phone"
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all hover:border-gray-300 text-base"
                  placeholder="+51 987654321"
                />
              </div>

              <div>
                <label htmlFor="email" className="block text-sm font-semibold text-gray-700 mb-2">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all hover:border-gray-300 text-base"
                  placeholder="juan@email.com"
                />
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="requested_amount" className="block text-sm font-semibold text-gray-700 mb-2">
                  Monto Solicitado (PEN) <span className="text-primary">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-medium">PEN</span>
                  <input
                    id="requested_amount"
                    type="number"
                    value={formData.requested_amount}
                    onChange={(e) => setFormData({ ...formData, requested_amount: e.target.value })}
                    required
                    min="0"
                    step="0.01"
                    className="w-full pl-16 pr-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all hover:border-gray-300 text-base"
                    placeholder="0.00"
                  />
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || success}
              className="w-full bg-gradient-to-r from-primary to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white font-bold py-3 sm:py-4 px-6 rounded-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5 text-base sm:text-lg"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  <span>Enviando...</span>
                </>
              ) : (
                <>
                  <Send className="h-5 w-5" />
                  Enviar Solicitud
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default LoanRequestPE;







