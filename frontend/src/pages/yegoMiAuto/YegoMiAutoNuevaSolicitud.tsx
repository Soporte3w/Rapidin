import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../services/api';
import toast from 'react-hot-toast';
import YegoMiAutoNuevaSolicitudConductor from './YegoMiAutoNuevaSolicitudConductor';
import type { YangoSuggestion } from './YegoMiAutoNuevaSolicitudConductor';
import YegoMiAutoNuevaSolicitudConfig from './YegoMiAutoNuevaSolicitudConfig';
import YegoMiAutoNuevaSolicitudRevisar from './YegoMiAutoNuevaSolicitudRevisar';
import type { RequisitosVehiculo } from './miautoCronogramaConfigDomain';

export type NuevaSolicitudState = {
  conductor: YangoSuggestion | null;
  country: string;
  cronogramaId: string;
  cronogramaName: string;
  vehiculoId: string;
  vehiculoName: string;
  apps: string[];
  pagoTipo: 'completo' | 'parcial';
  fileComprobante: File | null;
};

type Cronograma = { id: string; name: string; requisitos_vehiculo?: Partial<RequisitosVehiculo> | null };
type Vehiculo = { id: string; name: string };

type TabName = 'conductor' | 'configurar' | 'revisar';

const TABS: { key: TabName; label: string }[] = [
  { key: 'conductor', label: 'Conductor' },
  { key: 'configurar', label: 'Configurar' },
  { key: 'revisar', label: 'Revisar y Crear' },
];



function canGoTo(tab: TabName, state: NuevaSolicitudState): boolean {
  if (tab === 'configurar') return state.conductor !== null;
  if (tab === 'revisar') return state.conductor !== null && state.cronogramaId !== '' && state.vehiculoId !== '' && state.cronogramaName !== '';
  return true;
}

export default function YegoMiAutoNuevaSolicitud() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState<TabName>('conductor');
  const [submitting, setSubmitting] = useState(false);
  const [cronogramas, setCronogramas] = useState<Cronograma[]>([]);
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);

  const [state, setState] = useState<NuevaSolicitudState>({
    conductor: null,
    country: (user?.country as string) || 'PE',
    cronogramaId: '',
    cronogramaName: '',
    vehiculoId: '',
    vehiculoName: '',
    apps: [],
    pagoTipo: 'parcial',
    fileComprobante: null,
  });

  const updateState = useCallback((patch: Partial<NuevaSolicitudState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const uploadFile = async (solicitudId: string, tipo: string, file: File): Promise<void> => {
    const fd = new FormData();
    fd.append('tipo', tipo);
    fd.append('file', file);
    await api.post(`/miauto/solicitudes/${solicitudId}/adjuntos`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  };

  const handleSubmit = async () => {
    if (!state.conductor) { toast.error('Selecciona un conductor'); return; }

    try {
      setSubmitting(true);

      const payload: Record<string, unknown> = {
        country: state.country,
        phone: state.conductor.phone,
        driver_id_fleet: state.conductor.contractor_id,
        apps: state.apps,
        cronograma_id: state.cronogramaId,
        cronograma_vehiculo_id: state.vehiculoId,
        placa_asignada: state.conductor.vehicle?.plate || '',
        pago_tipo: state.pagoTipo,
        pago_estado: 'pendiente',
        status: 'pendiente',
      };

      const createRes = await api.post('/miauto/solicitudes', payload);
      const solicitud = createRes.data?.data ?? createRes.data;
      const id = solicitud?.id;
      if (!id) { toast.error('No se obtuvo el ID de la solicitud'); return; }

      if (state.fileComprobante) {
        await uploadFile(id, 'comprobante_viajes', state.fileComprobante);
      }

      toast.success('Solicitud creada correctamente');
      navigate(`/admin/yego-mi-auto/requests/${id}`);
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

  const tabIndex = TABS.findIndex((t) => t.key === tab);

  return (
    <div className="space-y-6">
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Nueva Solicitud</h1>
        <p className="text-xs lg:text-sm text-white/90 mt-0.5">Buscar conductor en Yango y configurar contrato Mi Auto</p>
      </header>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="flex border-b border-gray-200">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              disabled={!canGoTo(t.key, state)}
              onClick={() => setTab(t.key)}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors border-b-2
                ${tab === t.key
                  ? 'border-[#8B1A1A] text-[#8B1A1A]'
                  : 'border-transparent text-gray-500 hover:text-gray-700'}
                ${!canGoTo(t.key, state) ? 'opacity-40 cursor-not-allowed' : ''}
              `}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="p-4 lg:p-6">
          {tab === 'conductor' && (
            <YegoMiAutoNuevaSolicitudConductor
              value={state.conductor}
              onChange={(v) => updateState({ conductor: v })}
            />
          )}
          {tab === 'configurar' && (
            <YegoMiAutoNuevaSolicitudConfig
              state={state}
              onChange={updateState}
              cronogramas={cronogramas}
              vehiculos={vehiculos}
              onCronogramasLoaded={setCronogramas}
              onVehiculosLoaded={setVehiculos}
            />
          )}
          {tab === 'revisar' && (
            <YegoMiAutoNuevaSolicitudRevisar
              state={state}
              isSubmitting={submitting}
              onCancel={() => navigate('/admin/yego-mi-auto/requests')}
              onSubmit={handleSubmit}
            />
          )}
        </div>

        {tab !== 'revisar' && (
          <div className="flex justify-between items-center px-4 lg:px-6 py-4 border-t border-gray-200">
            <button
              type="button"
              onClick={() => navigate('/admin/yego-mi-auto/requests')}
              className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 text-sm"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={tabIndex >= TABS.length - 1 || !canGoTo(TABS[tabIndex + 1].key, state)}
              onClick={() => {
                const next = TABS[tabIndex + 1];
                if (next) setTab(next.key);
              }}
              className="px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] disabled:opacity-50 font-medium text-sm"
            >
              Siguiente: {TABS[tabIndex + 1]?.label ?? ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
