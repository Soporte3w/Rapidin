import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Car, Loader2, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { MIAUTO_NO_CACHE_HEADERS, isAxiosAbortError, unwrapApiData } from '../../utils/miautoApiUtils';
import {
  getPagoInicialTiposPermitidos,
  type PagoInicialTipo,
  type RequisitosVehiculo,
} from '../../pages/yegoMiAuto/miautoCronogramaConfigDomain';

type CronogramaOption = {
  id: string;
  name: string;
  requisitos_vehiculo?: Partial<RequisitosVehiculo> | null;
};

type VehicleOption = { id: string; name: string };

type Props = {
  open: boolean;
  sourceContractId: string;
  country: string;
  onClose: () => void;
  onCreated: (contractId: string) => void;
};

export function MiautoAttachContractModal({ open, sourceContractId, country, onClose, onCreated }: Props) {
  const [cronogramas, setCronogramas] = useState<CronogramaOption[]>([]);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [cronogramaId, setCronogramaId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [pagoTipo, setPagoTipo] = useState<PagoInicialTipo>('completo');
  const [placa, setPlaca] = useState('');
  const [loadingCronogramas, setLoadingCronogramas] = useState(false);
  const [loadingVehicles, setLoadingVehicles] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    setCronogramaId('');
    setVehicleId('');
    setPagoTipo('completo');
    setPlaca('');
    setVehicles([]);
    const ac = new AbortController();
    setLoadingCronogramas(true);
    api.get(`/miauto/cronogramas?country=${encodeURIComponent(country || 'PE')}&active=true&lite=true`, {
      signal: ac.signal,
      headers: MIAUTO_NO_CACHE_HEADERS,
    })
      .then((response) => {
        const data = unwrapApiData(response);
        setCronogramas(Array.isArray(data) ? data : []);
      })
      .catch((error) => {
        if (!isAxiosAbortError(error)) toast.error('No se pudieron cargar los cronogramas');
      })
      .finally(() => setLoadingCronogramas(false));
    return () => ac.abort();
  }, [country, open]);

  useEffect(() => {
    if (!open || !cronogramaId) {
      setVehicles([]);
      setVehicleId('');
      return undefined;
    }
    const ac = new AbortController();
    setLoadingVehicles(true);
    api.get(`/miauto/cronogramas/${cronogramaId}`, {
      signal: ac.signal,
      headers: MIAUTO_NO_CACHE_HEADERS,
    })
      .then((response) => {
        const data = unwrapApiData(response) as { vehicles?: VehicleOption[]; vehiculos?: VehicleOption[] } | undefined;
        const list = data?.vehicles ?? data?.vehiculos ?? [];
        setVehicles(Array.isArray(list) ? list : []);
        if (Array.isArray(list) && list.length === 1) setVehicleId(list[0].id);
      })
      .catch((error) => {
        if (!isAxiosAbortError(error)) toast.error('No se pudieron cargar los vehículos');
      })
      .finally(() => setLoadingVehicles(false));
    return () => ac.abort();
  }, [cronogramaId, open]);

  const selectedCronograma = useMemo(
    () => cronogramas.find((item) => item.id === cronogramaId),
    [cronogramaId, cronogramas],
  );
  const paymentTypes = selectedCronograma
    ? getPagoInicialTiposPermitidos(selectedCronograma)
    : (['completo', 'parcial'] as PagoInicialTipo[]);

  useEffect(() => {
    if (paymentTypes.length > 0 && !paymentTypes.includes(pagoTipo)) setPagoTipo(paymentTypes[0]);
  }, [pagoTipo, paymentTypes]);

  if (!open) return null;

  const submit = async () => {
    const normalizedPlate = placa.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!cronogramaId || !vehicleId || !normalizedPlate) {
      toast.error('Completa cronograma, vehículo y placa');
      return;
    }
    try {
      setSaving(true);
      const response = await api.post(`/miauto/solicitudes/${sourceContractId}/contratos-adicionales`, {
        cronograma_id: cronogramaId,
        cronograma_vehiculo_id: vehicleId,
        pago_tipo: pagoTipo,
        placa_asignada: normalizedPlate,
      });
      const created = unwrapApiData(response) as { id?: string } | undefined;
      if (!created?.id) throw new Error('El servidor no devolvió el contrato creado');
      toast.success('Contrato adicional anexado');
      onCreated(created.id);
    } catch (error: any) {
      toast.error(error.response?.data?.message || error.message || 'Error al anexar el contrato');
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-[#8B1A1A] focus:ring-2 focus:ring-[#8B1A1A]/20 disabled:bg-gray-100';

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Anexar nuevo contrato" onClick={() => !saving && onClose()}>
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-[#8B1A1A]">
              <Car className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-semibold text-gray-900">Anexar nuevo contrato</h2>
              <p className="text-xs text-gray-500">Se agregará al mismo conductor, sin crear una solicitud.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-50" aria-label="Cerrar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-gray-700">Cronograma</label>
            <select value={cronogramaId} onChange={(event) => { setCronogramaId(event.target.value); setVehicleId(''); }} className={inputClass} disabled={loadingCronogramas || saving}>
              <option value="">{loadingCronogramas ? 'Cargando...' : 'Seleccionar...'}</option>
              {cronogramas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-gray-700">Vehículo / plan</label>
            <select value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} className={inputClass} disabled={!cronogramaId || loadingVehicles || saving}>
              <option value="">{loadingVehicles ? 'Cargando...' : 'Seleccionar...'}</option>
              {vehicles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-gray-700">Placa del nuevo vehículo</label>
            <input value={placa} onChange={(event) => setPlaca(event.target.value.toUpperCase())} className={`${inputClass} font-mono tracking-wide`} placeholder="Ej. ABC123" maxLength={20} disabled={saving} />
            <p className="mt-1 text-xs text-gray-500">Debe existir como placa activa en la flota Yego Mi Auto y no pertenecer a otro contrato activo.</p>
          </div>
          <div>
            <span className="mb-2 block text-xs font-semibold text-gray-700">Modalidad de pago inicial</span>
            <div className="flex gap-5">
              {paymentTypes.map((type) => (
                <label key={type} className="inline-flex items-center gap-2 text-sm text-gray-700">
                  <input type="radio" checked={pagoTipo === type} onChange={() => setPagoTipo(type)} disabled={saving} className="text-[#8B1A1A] focus:ring-[#8B1A1A]" />
                  {type === 'completo' ? 'Completo' : 'Parcial'}
                </label>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            El contrato quedará por activar. Después se registra y valida el pago inicial antes de iniciar sus cuotas.
          </div>
        </div>

        <div className="flex gap-3 border-t border-gray-200 bg-gray-50 px-5 py-4">
          <button type="button" onClick={onClose} disabled={saving} className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">Cancelar</button>
          <button type="button" onClick={submit} disabled={saving} className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[#8B1A1A] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#6B1515] disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {saving ? 'Anexando...' : 'Anexar contrato'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
