import { useState, useEffect } from 'react';
import {
  User,
  Phone,
  MapPin,
  CreditCard,
  Star,
  Edit2,
  Save,
  X,
  CheckCircle2,
  Mail
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../services/api';
import toast from 'react-hot-toast';

export default function DriverProfile() {
  const { user, updateUser } = useAuth();
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(user?.email ?? '');

  useEffect(() => {
    setEmail(user?.email ?? '');
  }, [user?.email]);

  const handleSave = async () => {
    try {
      await api.patch('/driver/profile', { email: email.trim() || null });
      updateUser({ email: email.trim() || undefined });
      setEditing(false);
      toast.success('Perfil actualizado');
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    }
  };

  const countryName = user?.country === 'PE' ? 'Perú' : user?.country === 'CO' ? 'Colombia' : '';

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Header */}
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <User className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
                Mi Perfil
              </h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">
                Administra tu información personal - {countryName}
              </p>
            </div>
          </div>

          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="bg-white border-2 border-red-600 text-red-600 font-semibold py-2 px-4 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2 text-sm w-full lg:w-auto justify-center whitespace-nowrap"
            >
              <Edit2 className="w-4 h-4" />
              Editar Perfil
            </button>
          ) : (
            <div className="flex items-center gap-2 w-full lg:w-auto">
              <button
                onClick={() => setEditing(false)}
                className="bg-gray-200 text-gray-700 font-semibold py-2 px-4 rounded-lg hover:bg-gray-300 transition-colors flex items-center gap-2 text-sm flex-1 lg:flex-none justify-center"
              >
                <X className="w-4 h-4" />
                Cancelar
              </button>
              <button
                onClick={handleSave}
                className="bg-green-600 text-white font-semibold py-2 px-4 rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2 text-sm flex-1 lg:flex-none justify-center"
              >
                <Save className="w-4 h-4" />
                Guardar
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Profile card */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        {/* Header with gradient */}
        <div className="bg-gradient-to-r from-red-600 to-red-700 p-6 lg:p-8">
          <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-6">
            <div className="w-20 h-20 lg:w-24 lg:h-24 bg-white rounded-full flex items-center justify-center shadow-lg flex-shrink-0">
              <span className="text-3xl lg:text-4xl font-bold text-red-600">
                {user?.first_name?.charAt(0) || 'U'}
              </span>
            </div>
            <div className="text-white text-center sm:text-left flex-1">
              <h2 className="text-xl lg:text-2xl font-bold">
                {user?.first_name} {user?.last_name}
              </h2>
              <div className="flex items-center justify-center sm:justify-start gap-2 mt-1.5">
                <Phone className="w-4 h-4 text-red-100" />
                <p className="text-sm lg:text-base text-red-100">{user?.phone}</p>
              </div>
              <div className="flex items-center justify-center sm:justify-start gap-2 mt-2">
                <Star className="w-5 h-5 fill-yellow-400 text-yellow-400" />
                <span className="font-semibold text-base lg:text-lg">{user?.rating?.toFixed(1) || 'N/A'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Profile details */}
        <div className="p-5 lg:p-8">
          <h3 className="text-lg lg:text-xl font-bold text-gray-900 mb-5 lg:mb-6 flex items-center gap-2">
            <User className="w-5 h-5 text-red-600" />
            Información Personal
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 lg:gap-0">
            <div className= "rounded-lg p-4">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2 uppercase">
                <User className="w-4 h-4" />
                <span>Nombres</span>
              </label>
              <input
                type="text"
                value={user?.first_name || ''}
                disabled={!editing}
                className={`w-full px-4 py-2.5 border-2 rounded-lg font-medium transition-all ${
                  editing
                    ? 'border-red-300 focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-white'
                    : 'border-gray-200 bg-gray-50 text-gray-700'
                }`}
              />
            </div>

            <div className="rounded-lg p-4">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2 uppercase">
                <User className="w-4 h-4" />
                <span>Apellidos</span>
              </label>
              <input
                type="text"
                value={user?.last_name || ''}
                disabled={!editing}
                className={`w-full px-4 py-2.5 border-2 rounded-lg font-medium transition-all ${
                  editing
                    ? 'border-red-300 focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-white'
                    : 'border-gray-200 bg-gray-50 text-gray-700'
                }`}
              />
            </div>

            <div className="rounded-lg p-4">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2 uppercase">
                <Phone className="w-4 h-4" />
                <span>Teléfono</span>
              </label>
              <input
                type="text"
                value={user?.phone || ''}
                disabled
                className="w-full px-4 py-2.5 border-2 border-gray-200 rounded-lg bg-gray-100 text-gray-600 font-medium"
              />
            </div>

            <div className="rounded-lg p-4">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2 uppercase">
                <Mail className="w-4 h-4" />
                <span>Correo electrónico</span>
              </label>
              <input
                type="email"
                value={editing ? email : (user?.email ?? '')}
                disabled={!editing}
                onChange={(e) => editing && setEmail(e.target.value)}
                placeholder="Ej: correo@ejemplo.com"
                className={`w-full px-4 py-2.5 border-2 rounded-lg font-medium transition-all ${
                  editing
                    ? 'border-red-300 focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-white'
                    : 'border-gray-200 bg-gray-50 text-gray-700'
                }`}
              />
            </div>

            <div className="rounded-lg p-4">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2 uppercase">
                <MapPin className="w-4 h-4" />
                <span>País</span>
              </label>
              <input
                type="text"
                value={countryName}
                disabled
                className="w-full px-4 py-2.5 border-2 border-gray-200 rounded-lg bg-gray-100 text-gray-600 font-medium"
              />
            </div>

            <div className="rounded-lg p-4">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2 uppercase">
                <CreditCard className="w-4 h-4" />
                <span>Tipo de Documento</span>
              </label>
              <input
                type="text"
                value={user?.document_type || ''}
                disabled
                className="w-full px-4 py-2.5 border-2 border-gray-200 rounded-lg bg-gray-100 text-gray-600 font-medium"
              />
            </div>

            <div className="rounded-lg p-4">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2 uppercase">
                <CreditCard className="w-4 h-4" />
                <span>Número de Documento</span>
              </label>
              <input
                type="text"
                value={user?.document_number || ''}
                disabled
                className="w-full px-4 py-2.5 border-2 border-gray-200 rounded-lg bg-gray-100 text-gray-600 font-medium"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Account info */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-5 lg:p-8">
        <h3 className="text-lg lg:text-xl font-bold text-gray-900 mb-5 lg:mb-6 flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-red-600" />
          Información de Cuenta
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-6">
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-5 lg:p-6 border-2 border-blue-200 shadow-sm hover:shadow-md transition-shadow">
            <p className="text-xs font-semibold text-gray-600 mb-2 uppercase">Estado</p>
            <p className="text-lg lg:text-xl font-bold text-blue-600">
              {user?.has_active_loan ? 'Con préstamo activo' : 'Sin préstamo'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}




