import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PenTool, CheckCircle, AlertCircle } from 'lucide-react';
import api from '../../services/api';

const GuarantorSignaturePublic = () => {
  const { token } = useParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    dni: '',
    signature: ''
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await api.post(`/documents/sign/${token}`, {
        signed_by: formData.name,
        signature: formData.signature
      });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Error al firmar el documento');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-white to-gray-50 py-8 sm:py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6 sm:mb-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 sm:w-16 sm:h-16 bg-gradient-to-br from-primary to-primary-600 rounded-xl sm:rounded-2xl mb-4 shadow-lg">
            <PenTool className="h-7 w-7 sm:h-8 sm:w-8 text-white" />
          </div>
          <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
            Firma de Documento - <span className="text-primary">Fiador</span>
          </h1>
          <p className="text-sm sm:text-base text-gray-600">
            Confirma tu identidad para firmar el documento como fiador
          </p>
        </div>

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
                <p className="text-sm text-green-800 font-medium mb-1">Documento firmado exitosamente</p>
                <p className="text-xs text-green-700">Tu firma ha sido registrada correctamente.</p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5 sm:space-y-6">
            <div>
              <label htmlFor="name" className="block text-sm font-semibold text-gray-700 mb-2">
                Nombre Completo <span className="text-primary">*</span>
              </label>
              <input
                id="name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all hover:border-gray-300 text-base"
                placeholder="Juan Pérez García"
              />
            </div>

            <div>
              <label htmlFor="dni" className="block text-sm font-semibold text-gray-700 mb-2">
                DNI <span className="text-primary">*</span>
              </label>
              <input
                id="dni"
                type="text"
                value={formData.dni}
                onChange={(e) => {
                  const value = e.target.value.replace(/\D/g, '').slice(0, 10);
                  setFormData({ ...formData, dni: value });
                }}
                required
                maxLength={10}
                className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all hover:border-gray-300 text-base"
                placeholder="12345678"
              />
            </div>

            <div>
              <label htmlFor="signature" className="block text-sm font-semibold text-gray-700 mb-2">
                Firma (escribe tu nombre completo) <span className="text-primary">*</span>
              </label>
              <input
                id="signature"
                type="text"
                value={formData.signature}
                onChange={(e) => setFormData({ ...formData, signature: e.target.value })}
                required
                className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all hover:border-gray-300 text-base"
                placeholder="Escribe tu nombre completo para confirmar"
              />
              <p className="mt-2 text-xs text-gray-500">
                Al escribir tu nombre completo, confirmas que eres el fiador y aceptas las condiciones del documento.
              </p>
            </div>

            <button
              type="submit"
              disabled={loading || success}
              className="w-full bg-gradient-to-r from-primary to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white font-bold py-3 sm:py-4 px-6 rounded-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5 text-base sm:text-lg"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  <span>Firmando...</span>
                </>
              ) : success ? (
                <>
                  <CheckCircle className="h-5 w-5" />
                  <span>Documento Firmado</span>
                </>
              ) : (
                <>
                  <PenTool className="h-5 w-5" />
                  Firmar Documento
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default GuarantorSignaturePublic;







