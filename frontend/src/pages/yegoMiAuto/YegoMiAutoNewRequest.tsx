import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import { FileText } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';

const COUNTRY_OPTIONS = [
  { value: 'PE', label: 'Perú' },
  { value: 'CO', label: 'Colombia' },
] as const;

const APPS_OPTIONS = [
  { code: 'yango', name: 'Yango' },
  { code: 'uber', name: 'Uber' },
  { code: 'indriver', name: 'InDriver' },
  { code: 'beat', name: 'Beat' },
  { code: 'didii', name: 'Didi' },
];

const INPUT_CLASS =
  'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500';

async function uploadAdjunto(
  solicitudId: number,
  tipo: string,
  file: File
): Promise<void> {
  const fd = new FormData();
  fd.append('tipo', tipo);
  fd.append('file', file);
  await api.post(`/miauto/solicitudes/${solicitudId}/adjuntos`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}

export default function YegoMiAutoNewRequest() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    country: (user?.country as string) || 'PE',
    dni: '',
    phone: '',
    email: '',
    license_number: '',
    description: '',
    app_codes: [] as string[],
  });
  const [fileLicencia, setFileLicencia] = useState<File | null>(null);
  const [fileComprobante, setFileComprobante] = useState<File | null>(null);

  const setField = (key: Exclude<keyof typeof form, 'app_codes'>) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
    };

  const handleAppToggle = (code: string) => {
    setForm((prev) => ({
      ...prev,
      app_codes: prev.app_codes.includes(code)
        ? prev.app_codes.filter((c) => c !== code)
        : [...prev.app_codes, code],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.dni.trim()) {
      toast.error('DNI es requerido');
      return;
    }
    if (!fileLicencia) {
      toast.error('Debes adjuntar la foto de la licencia');
      return;
    }
    try {
      setSubmitting(true);
      const payload = {
        country: form.country,
        dni: form.dni.trim(),
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        license_number: form.license_number.trim() || undefined,
        description: form.description.trim() || undefined,
        apps: form.app_codes,
      };
      const createRes = await api.post('/miauto/solicitudes', payload);
      const solicitud = createRes.data?.data ?? createRes.data;
      const id = solicitud?.id;
      if (!id) {
        toast.error('No se obtuvo el ID de la solicitud');
        return;
      }

      await uploadAdjunto(id, 'licencia', fileLicencia);
      if (fileComprobante) await uploadAdjunto(id, 'comprobante_viajes', fileComprobante);

      toast.success('Solicitud creada correctamente');
      navigate('/admin/yego-mi-auto/requests');
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { message?: string } } }).response?.data?.message
          : null;
      toast.error(msg || 'Error al crear la solicitud');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">
              Nueva solicitud Mi Auto
            </h1>
            <p className="text-xs lg:text-sm text-white/90 mt-0.5">
              Datos del conductor y apps en las que ha trabajado
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 lg:p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="country" className="block text-sm font-medium text-gray-700 mb-1">País *</label>
            <select
              id="country"
              value={form.country}
              onChange={setField('country')}
              className={INPUT_CLASS}
              required
            >
              {COUNTRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="dni" className="block text-sm font-medium text-gray-700 mb-1">DNI *</label>
            <input
              id="dni"
              type="text"
              value={form.dni}
              onChange={setField('dni')}
              className={INPUT_CLASS}
              required
            />
          </div>
          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">Celular</label>
            <input
              id="phone"
              type="text"
              value={form.phone}
              onChange={setField('phone')}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Correo</label>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={setField('email')}
              className={INPUT_CLASS}
            />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="license_number" className="block text-sm font-medium text-gray-700 mb-1">Número de licencia</label>
            <input
              id="license_number"
              type="text"
              value={form.license_number}
              onChange={setField('license_number')}
              className={INPUT_CLASS}
            />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">Descripción</label>
            <textarea
              id="description"
              value={form.description}
              onChange={setField('description')}
              rows={3}
              className={INPUT_CLASS}
            />
          </div>
        </div>

        <div>
          <span className="block text-sm font-medium text-gray-700 mb-2">Apps en las que ha trabajado</span>
          <div className="flex flex-wrap gap-3">
            {APPS_OPTIONS.map((app) => (
              <label key={app.code} className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.app_codes.includes(app.code)}
                  onChange={() => handleAppToggle(app.code)}
                  className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm text-gray-700">{app.name}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Foto de licencia *</label>
            <input
              type="file"
              accept="image/*,.pdf"
              onChange={(e) => setFileLicencia(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-red-50 file:text-red-700"
            />
            {fileLicencia && <p className="text-xs text-gray-500 mt-1">{fileLicencia.name}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Comprobante de viajes (opcional)</label>
            <input
              type="file"
              accept="image/*,.pdf"
              onChange={(e) => setFileComprobante(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-gray-100 file:text-gray-700"
            />
            {fileComprobante && <p className="text-xs text-gray-500 mt-1">{fileComprobante.name}</p>}
          </div>
        </div>

        <div className="flex gap-3 pt-4">
          <button
            type="button"
            onClick={() => navigate('/admin/yego-mi-auto/requests')}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] disabled:opacity-50 font-medium"
          >
            {submitting ? 'Enviando...' : 'Crear solicitud'}
          </button>
        </div>
      </form>
    </div>
  );
}
