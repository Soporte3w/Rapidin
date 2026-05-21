import { useNavigate } from 'react-router-dom';
import { DollarSign, User, Bike } from 'lucide-react';

export default function YegoMiMotoCreditTypeSelection() {
  const navigate = useNavigate();

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="bg-red-800 text-white rounded-lg p-4 flex items-center gap-3">
        <DollarSign className="w-10 h-10 flex-shrink-0" />
        <div>
          <h1 className="text-xl font-bold">Nuevo Crédito - Yego Mi Moto</h1>
          <p className="text-sm text-red-100">Selecciona el tipo de crédito</p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <button
          onClick={() => navigate('/admin/yego-mi-moto/loan-requests/new?type=conductor')}
          className="bg-white rounded-xl shadow border-2 border-gray-200 hover:border-red-400 p-6 text-left transition-all"
        >
          <div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center mb-4">
            <User className="w-6 h-6 text-red-600" />
          </div>
          <h3 className="text-lg font-bold text-gray-900 mb-1">Socio Conductor</h3>
          <p className="text-sm text-gray-500">Crédito para conductores de flota</p>
        </button>
        <button
          onClick={() => navigate('/admin/yego-mi-moto/loan-requests/new?type=moto')}
          className="bg-white rounded-xl shadow border-2 border-gray-200 hover:border-red-400 p-6 text-left transition-all"
        >
          <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center mb-4">
            <Bike className="w-6 h-6 text-blue-600" />
          </div>
          <h3 className="text-lg font-bold text-gray-900 mb-1">Crédito Moto</h3>
          <p className="text-sm text-gray-500">Crédito para adquisición de moto</p>
        </button>
      </div>
    </div>
  );
}
