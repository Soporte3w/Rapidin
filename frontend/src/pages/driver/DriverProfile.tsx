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
import { getStoredRapidinDriverId, getStoredSelectedParkId } from '../../utils/authStorage';

interface ProfileData {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  documentNumber: string | null;
  license: string | null;
  country: string;
  park_id: string | null;
}

export default function DriverProfile() {
  const { user, updateUser } = useAuth();
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(user?.email ?? '');
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);

  useEffect(() => {
    const loadProfile = async () => {
      try {
        const rapidinDriverId = getStoredRapidinDriverId();
        const parkId = getStoredSelectedParkId();
        const params: Record<string, string> = {};
        if (rapidinDriverId) params.rapidin_driver_id = rapidinDriverId;
        if (parkId) params.park_id = parkId;
        const { data } = await api.get('/driver/profile', { params });
        const d = data?.data;
        if (d) {
          setProfileData({
            id: d.id,
            firstName: d.firstName ?? '',
            lastName: d.lastName ?? '',
            phone: d.phone ?? '',
            email: d.email ?? null,
            documentNumber: d.documentNumber ?? null,
            license: d.license ?? null,
            country: d.country ?? '',
            park_id: d.park_id ?? null
          });
          setEmail(d.email ?? '');
          updateUser({ email: d.email ?? undefined, license: d.license ?? undefined });
        }
      } catch (_) {
        setProfileData(null);
      } finally {
        setLoadingProfile(false);
      }
    };
    loadProfile();
  }, []);

  useEffect(() => {
    if (!profileData) setEmail(user?.email ?? '');
    else setEmail(profileData.email ?? '');
  }, [user?.email, profileData]);

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

  const country = profileData?.country || user?.country || '';
  const countryName = country === 'PE' ? 'Perú' : country === 'CO' ? 'Colombia' : '';
  const firstName = profileData?.firstName ?? user?.first_name ?? '';
  const lastName = profileData?.lastName ?? user?.last_name ?? '';
  const phone = profileData?.phone ?? user?.phone ?? '';
  const documentNumber = profileData?.documentNumber ?? user?.document_number ?? '';

  if (loadingProfile) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-red-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-full pb-6 space-y-3 sm:space-y-4 lg:space-y-6 px-2 sm:px-0">
      {/* Header - compacto en móvil, botones táctiles (min 44px) */}
      <div className="bg-[#8B1A1A] rounded-xl sm:rounded-lg p-3 sm:p-4 lg:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 sm:w-10 sm:h-10 bg-[#6B1515] rounded-xl sm:rounded-lg flex items-center justify-center flex-shrink-0">
              <User className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg lg:text-xl font-bold text-white leading-tight truncate">
                Mi Perfil
              </h1>
              <p className="text-xs text-white/90 mt-0.5 truncate">
                {countryName ? `Información personal · ${countryName}` : 'Información personal'}
              </p>
            </div>
          </div>

          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="bg-white border-2 border-red-600 text-red-600 font-semibold min-h-[44px] py-3 px-4 rounded-xl sm:rounded-lg active:bg-red-50 transition-colors flex items-center justify-center gap-2 text-sm w-full lg:w-auto touch-manipulation"
            >
              <Edit2 className="w-4 h-4 flex-shrink-0" />
              <span>Editar Perfil</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 w-full lg:w-auto">
              <button
                onClick={() => setEditing(false)}
                className="bg-gray-200 text-gray-700 font-semibold min-h-[44px] py-3 px-4 rounded-xl sm:rounded-lg active:bg-gray-300 transition-colors flex items-center justify-center gap-2 text-sm flex-1 lg:flex-none touch-manipulation"
              >
                <X className="w-4 h-4 flex-shrink-0" />
                Cancelar
              </button>
              <button
                onClick={handleSave}
                className="bg-[#8B1A1A] text-white font-semibold min-h-[44px] py-3 px-4 rounded-xl sm:rounded-lg border-2 border-white hover:bg-[#7A1717] active:bg-[#6B1515] transition-colors flex items-center justify-center gap-2 text-sm flex-1 lg:flex-none touch-manipulation"
              >
                <Save className="w-4 h-4 flex-shrink-0" />
                Guardar
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Profile card - menos padding en móvil */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        <div className="bg-gradient-to-r from-red-600 to-red-700 p-4 sm:p-6 lg:p-8">
          <div className="flex flex-col items-center sm:flex-row sm:items-start gap-3 sm:gap-6">
            <div className="w-16 h-16 sm:w-20 sm:h-20 lg:w-24 lg:h-24 bg-white rounded-full flex items-center justify-center shadow-lg flex-shrink-0">
              <span className="text-2xl sm:text-3xl lg:text-4xl font-bold text-red-600">
                {(firstName || lastName) ? (firstName || lastName).charAt(0) : 'U'}
              </span>
            </div>
            <div className="text-white text-center sm:text-left flex-1 min-w-0">
              <h2 className="text-lg sm:text-xl lg:text-2xl font-bold break-words">
                {firstName} {lastName}
              </h2>
              <div className="flex items-center justify-center sm:justify-start gap-2 mt-1.5 flex-wrap">
                <Phone className="w-4 h-4 text-red-100 flex-shrink-0" />
                <p className="text-sm text-red-100 break-all">{phone}</p>
              </div>
              <div className="flex items-center justify-center sm:justify-start gap-2 mt-2">
                <Star className="w-5 h-5 fill-yellow-400 text-yellow-400 flex-shrink-0" />
                <span className="font-semibold text-sm sm:text-base lg:text-lg">{user?.rating?.toFixed(1) || 'N/A'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Información personal - inputs más altos en móvil (touch), text-base evita zoom iOS */}
        <div className="p-3 sm:p-5 lg:p-8">
          <h3 className="text-base sm:text-lg lg:text-xl font-bold text-gray-900 mb-3 sm:mb-5 lg:mb-6 flex items-center gap-2">
            <User className="w-5 h-5 text-red-600 flex-shrink-0" />
            <span>Información Personal</span>
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
            <div className="rounded-xl sm:rounded-lg p-3 sm:p-4 border border-gray-100 sm:border-0">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-1.5 sm:mb-2 uppercase">
                <User className="w-4 h-4 flex-shrink-0" />
                <span>Nombres</span>
              </label>
              <input
                type="text"
                value={firstName}
                disabled={!editing}
                className={`w-full px-3 sm:px-4 py-3 sm:py-2.5 border-2 rounded-lg font-medium text-base transition-all touch-manipulation ${
                  editing
                    ? 'border-red-300 focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-white'
                    : 'border-gray-200 bg-gray-50 text-gray-700'
                }`}
              />
            </div>

            <div className="rounded-xl sm:rounded-lg p-3 sm:p-4 border border-gray-100 sm:border-0">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-1.5 sm:mb-2 uppercase">
                <User className="w-4 h-4 flex-shrink-0" />
                <span>Apellidos</span>
              </label>
              <input
                type="text"
                value={lastName}
                disabled={!editing}
                className={`w-full px-3 sm:px-4 py-3 sm:py-2.5 border-2 rounded-lg font-medium text-base transition-all touch-manipulation ${
                  editing
                    ? 'border-red-300 focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-white'
                    : 'border-gray-200 bg-gray-50 text-gray-700'
                }`}
              />
            </div>

            <div className="rounded-xl sm:rounded-lg p-3 sm:p-4 border border-gray-100 sm:border-0 sm:col-span-2 md:col-span-1">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-1.5 sm:mb-2 uppercase">
                <Phone className="w-4 h-4 flex-shrink-0" />
                <span>Teléfono</span>
              </label>
              <input
                type="text"
                value={phone}
                disabled
                className="w-full px-3 sm:px-4 py-3 sm:py-2.5 border-2 border-gray-200 rounded-lg bg-gray-100 text-gray-600 font-medium text-base"
              />
            </div>

            <div className="rounded-xl sm:rounded-lg p-3 sm:p-4 border border-gray-100 sm:border-0 sm:col-span-2 md:col-span-1">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-1.5 sm:mb-2 uppercase">
                <Mail className="w-4 h-4 flex-shrink-0" />
                <span>Correo electrónico</span>
              </label>
              <input
                type="email"
                value={editing ? email : (profileData?.email ?? user?.email ?? '')}
                disabled={!editing}
                onChange={(e) => editing && setEmail(e.target.value)}
                placeholder="Ej: correo@ejemplo.com"
                className={`w-full px-3 sm:px-4 py-3 sm:py-2.5 border-2 rounded-lg font-medium text-base transition-all touch-manipulation ${
                  editing
                    ? 'border-red-300 focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-white'
                    : 'border-gray-200 bg-gray-50 text-gray-700'
                }`}
              />
            </div>

            <div className="rounded-xl sm:rounded-lg p-3 sm:p-4 border border-gray-100 sm:border-0">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-1.5 sm:mb-2 uppercase">
                <MapPin className="w-4 h-4 flex-shrink-0" />
                <span>País</span>
              </label>
              <input
                type="text"
                value={countryName || '—'}
                disabled
                className="w-full px-3 sm:px-4 py-3 sm:py-2.5 border-2 border-gray-200 rounded-lg bg-gray-100 text-gray-600 font-medium text-base"
              />
            </div>

            <div className="rounded-xl sm:rounded-lg p-3 sm:p-4 border border-gray-100 sm:border-0">
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-1.5 sm:mb-2 uppercase">
                <CreditCard className="w-4 h-4 flex-shrink-0" />
                <span>Número de Documento</span>
              </label>
              <input
                type="text"
                value={documentNumber || ''}
                disabled
                className="w-full px-3 sm:px-4 py-3 sm:py-2.5 border-2 border-gray-200 rounded-lg bg-gray-100 text-gray-600 font-medium text-base"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Información de cuenta - compacto en móvil */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-3 sm:p-5 lg:p-8">
        <h3 className="text-base sm:text-lg lg:text-xl font-bold text-gray-900 mb-3 sm:mb-5 lg:mb-6 flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-red-600 flex-shrink-0" />
          <span>Información de Cuenta</span>
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:gap-6">
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-4 sm:p-5 lg:p-6 border-2 border-blue-200 shadow-sm min-h-[72px] flex flex-col justify-center">
            <p className="text-xs font-semibold text-gray-600 mb-1 sm:mb-2 uppercase">Estado</p>
            <p className="text-base sm:text-lg lg:text-xl font-bold text-blue-600">
              {user?.has_active_loan ? 'Con préstamo activo' : 'Sin préstamo'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}




