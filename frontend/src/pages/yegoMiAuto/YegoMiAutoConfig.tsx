import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PlusCircle, Trash2, X, Settings as SettingsIcon, Car, ImagePlus, ChevronDown, ChevronRight, ChevronLeft, ListOrdered, Search, DollarSign } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

/** Moneda de la cuota inicial */
export type MonedaInicial = 'USD' | 'PEN';

/** Carro ofrecido en el cronograma: inicial (con moneda) + cuotas semanales + foto */
export interface VehiculoCronograma {
  id: string;
  name: string;
  inicial: number;
  /** Moneda de la inicial: dólares (USD) o soles (PEN) */
  inicial_moneda: MonedaInicial;
  cuotas_semanales: number;
  /** URL o data URL (base64) de la foto del carro */
  image?: string;
}

/** Moneda del bono mi auto por fila */
export type BonoAutoMoneda = 'USD' | 'PEN';

/** Fila del cronograma: viajes (intervalo ej. "0 - 119"), bono auto (con moneda), y cuota semanal por cada carro */
export interface CronogramaRule {
  /** Intervalo de viajes, ej: "0 - 119" = entre 0 y 119 viajes usan este bono y estas cuotas por carro */
  viajes: string;
  bono_auto: number;
  /** Moneda del bono: USD ($) o PEN (S/.) */
  bono_auto_moneda?: BonoAutoMoneda;
  cuotas_por_vehiculo: number[];
  /** Moneda de cada cuota por carro: USD ($) o PEN (S/.) */
  cuota_moneda_por_vehiculo?: BonoAutoMoneda[];
}

export interface Cronograma {
  id: string;
  name: string;
  country: string;
  active: boolean;
  /** Tasa de interés por mora (ej. 0.05 = 5%). Interés por día = (cuota_semanal * tasa) / 7 */
  tasa_interes_mora?: number;
  vehicles: VehiculoCronograma[];
  rules: CronogramaRule[];
}

function generateId() {
  return Math.random().toString(36).slice(2, 11);
}

function createEmptyRule(vehicleCount: number): CronogramaRule {
  return {
    viajes: '',
    bono_auto: 0,
    bono_auto_moneda: 'PEN',
    cuotas_por_vehiculo: Array(vehicleCount).fill(0),
    cuota_moneda_por_vehiculo: Array(vehicleCount).fill('PEN'),
  };
}

function createEmptyVehicle(): VehiculoCronograma {
  return { id: generateId(), name: '', inicial: 0, inicial_moneda: 'USD', cuotas_semanales: 261 };
}

/** Clases para inputs numéricos sin spinners y sin cambio por rueda */
const INPUT_NUMBER_CLASS =
  ' [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-inner-spin-button]:m-0';

function getCountryBadgeClass(country: string): string {
  if (country === 'PE') return 'bg-red-100 text-red-700';
  if (country === 'CO') return 'bg-amber-100 text-amber-800';
  return 'bg-gray-100 text-gray-600';
}

/** Parsea "viajes" (ej: "0 - 119", "400+") a intervalo [min, max]. Usado para saber qué fila aplica según número de viajes. */
export function parseViajesInterval(viajesStr: string): { min: number; max: number } | null {
  if (!viajesStr || typeof viajesStr !== 'string') return null;
  const s = viajesStr.trim();
  if (!s) return null;
  const plusMatch = s.match(/^(\d+)\s*\+$/);
  if (plusMatch) {
    const min = parseInt(plusMatch[1], 10);
    if (Number.isNaN(min) || min < 0) return null;
    return { min, max: Infinity };
  }
  const parts = s.split(/\s*-\s*/).map((p) => p.trim());
  if (parts.length >= 2) {
    const min = parseInt(parts[0], 10);
    const max = parseInt(parts[1], 10);
    if (!Number.isNaN(min) && !Number.isNaN(max) && min >= 0 && max >= min) return { min, max };
  }
  const single = parseInt(s, 10);
  if (!Number.isNaN(single) && single >= 0) return { min: single, max: single };
  return null;
}

/** Devuelve la regla cuyo intervalo de viajes contiene a numViajes (bono auto y cuotas por carro aplican). */
export function getRuleForTripCount(rules: CronogramaRule[], numViajes: number): CronogramaRule | null {
  if (!Array.isArray(rules) || rules.length === 0 || numViajes == null || numViajes < 0) return null;
  const n = Number(numViajes);
  if (Number.isNaN(n)) return null;
  for (const rule of rules) {
    const interval = parseViajesInterval(rule.viajes);
    if (!interval) continue;
    if (n >= interval.min && n <= interval.max) return rule;
  }
  return null;
}

export default function YegoMiAutoConfig() {
  const [cronogramas, setCronogramas] = useState<Cronograma[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<Cronograma, 'id'>>({
    name: '',
    country: 'PE',
    active: true,
    tasa_interes_mora: 0,
    vehicles: [{ ...createEmptyVehicle() }],
    rules: [],
  });
  const [modalSectionOpen, setModalSectionOpen] = useState<'carros' | 'filas' | null>(null);
  const [modalViewOnly, setModalViewOnly] = useState(true);
  const isViewMode = Boolean(editingId && modalViewOnly);
  const [isModalEntering, setIsModalEntering] = useState(false);
  const [isModalClosing, setIsModalClosing] = useState(false);
  const [searchName, setSearchName] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [tipoCambioPE, setTipoCambioPE] = useState<string>('');
  const [tipoCambioCO, setTipoCambioCO] = useState<string>('');
  const [loadingTipoCambio, setLoadingTipoCambio] = useState(true);
  const [savingTipoCambio, setSavingTipoCambio] = useState<string | null>(null);

  const PAGE_SIZE = 8;

  const filteredCronogramas = useMemo(() => {
    const q = searchName.trim().toLowerCase();
    if (!q) return cronogramas;
    return cronogramas.filter((c) => (c.name || '').toLowerCase().includes(q));
  }, [cronogramas, searchName]);

  const totalPages = Math.max(1, Math.ceil(filteredCronogramas.length / PAGE_SIZE));
  const paginatedCronogramas = useMemo(() => {
    const page = Math.min(Math.max(1, currentPage), totalPages);
    const start = (page - 1) * PAGE_SIZE;
    return filteredCronogramas.slice(start, start + PAGE_SIZE);
  }, [filteredCronogramas, currentPage, totalPages]);

  const fetchCronogramas = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/miauto/cronogramas');
      const data = res.data?.data ?? res.data;
      setCronogramas(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al cargar cronogramas');
      setCronogramas([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTiposCambio = useCallback(async () => {
    try {
      setLoadingTipoCambio(true);
      const res = await api.get('/miauto/tipo-cambio/all');
      const list = res.data?.data ?? res.data ?? [];
      const arr = Array.isArray(list) ? list : [];
      const pe = arr.find((r: { country: string }) => r.country === 'PE');
      const co = arr.find((r: { country: string }) => r.country === 'CO');
      setTipoCambioPE(pe?.valor_usd_a_local != null ? String(pe.valor_usd_a_local) : '');
      setTipoCambioCO(co?.valor_usd_a_local != null ? String(co.valor_usd_a_local) : '');
    } catch {
      setTipoCambioPE('');
      setTipoCambioCO('');
    } finally {
      setLoadingTipoCambio(false);
    }
  }, []);

  const initialFetchDone = useRef(false);
  useEffect(() => {
    if (initialFetchDone.current) return;
    initialFetchDone.current = true;
    setLoading(true);
    setLoadingTipoCambio(true);
    Promise.all([api.get('/miauto/cronogramas'), api.get('/miauto/tipo-cambio/all')])
      .then(([resCron, resTc]) => {
        const data = resCron.data?.data ?? resCron.data;
        setCronogramas(Array.isArray(data) ? data : []);
        const list = resTc.data?.data ?? resTc.data ?? [];
        const arr = Array.isArray(list) ? list : [];
        const pe = arr.find((r: { country: string }) => r.country === 'PE');
        const co = arr.find((r: { country: string }) => r.country === 'CO');
        setTipoCambioPE(pe?.valor_usd_a_local != null ? String(pe.valor_usd_a_local) : '');
        setTipoCambioCO(co?.valor_usd_a_local != null ? String(co.valor_usd_a_local) : '');
      })
      .catch((e: any) => {
        toast.error(e.response?.data?.message || 'Error al cargar');
        setCronogramas([]);
        setTipoCambioPE('');
        setTipoCambioCO('');
      })
      .finally(() => {
        setLoading(false);
        setLoadingTipoCambio(false);
      });
  }, []);

  const saveTipoCambio = useCallback(async (country: 'PE' | 'CO') => {
    const valor = country === 'PE' ? tipoCambioPE : tipoCambioCO;
    const num = parseFloat(valor);
    if (Number.isNaN(num) || num < 0) {
      toast.error('Ingresa un valor numérico válido');
      return;
    }
    try {
      setSavingTipoCambio(country);
      await api.put('/miauto/tipo-cambio', {
        country,
        valor_usd_a_local: num,
        moneda_local: country === 'PE' ? 'PEN' : 'COP',
      });
      toast.success('Tipo de cambio actualizado');
      await fetchTiposCambio();
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al guardar');
    } finally {
      setSavingTipoCambio(null);
    }
  }, [tipoCambioPE, tipoCambioCO, fetchTiposCambio]);

  useEffect(() => {
    setCurrentPage((p) => Math.min(p, Math.max(1, Math.ceil(filteredCronogramas.length / PAGE_SIZE)) || 1));
  }, [filteredCronogramas.length]);

  useEffect(() => {
    if (modalOpen && !isModalClosing) {
      setIsModalEntering(true);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setIsModalEntering(false));
      });
      return () => cancelAnimationFrame(id);
    }
  }, [modalOpen, isModalClosing]);

  const openNew = () => {
    setEditingId(null);
    setModalViewOnly(false);
    setForm({
      name: '',
      country: 'PE',
      active: true,
      tasa_interes_mora: 0,
      vehicles: [createEmptyVehicle()],
      rules: [createEmptyRule(1)],
    });
    setModalOpen(true);
  };

  const openEdit = (c: Cronograma) => {
    setModalViewOnly(true);
    setEditingId(c.id);
    const vehicles = (c.vehicles?.length ? c.vehicles : [createEmptyVehicle()]).map((v) => ({
      ...v,
      inicial_moneda: v.inicial_moneda ?? 'USD',
    }));
    const rules = c.rules?.length
      ? c.rules.map((r) => {
          const cuotas = r.cuotas_por_vehiculo?.length === vehicles.length
            ? r.cuotas_por_vehiculo
            : [...(r.cuotas_por_vehiculo || []), ...Array(Math.max(0, vehicles.length - (r.cuotas_por_vehiculo?.length || 0))).fill(0)];
          const monedas = r.cuota_moneda_por_vehiculo?.length === vehicles.length
            ? r.cuota_moneda_por_vehiculo
            : [...(r.cuota_moneda_por_vehiculo || []), ...Array(Math.max(0, vehicles.length - (r.cuota_moneda_por_vehiculo?.length || 0))).fill('PEN') as BonoAutoMoneda[]];
          return {
            ...r,
            bono_auto_moneda: r.bono_auto_moneda ?? 'PEN',
            cuotas_por_vehiculo: cuotas,
            cuota_moneda_por_vehiculo: monedas,
          };
        })
      : [createEmptyRule(vehicles.length)];
    setForm({ name: c.name, country: c.country, active: c.active, tasa_interes_mora: c.tasa_interes_mora ?? 0, vehicles, rules });
    setModalOpen(true);
  };

  const finishCloseModal = () => {
    setModalOpen(false);
    setEditingId(null);
    setModalSectionOpen(null);
    setModalViewOnly(true);
    setIsModalClosing(false);
  };

  const closeModal = () => {
    if (isModalClosing) return;
    setIsModalClosing(true);
  };

  const toggleSection = (section: 'carros' | 'filas') => {
    setModalSectionOpen((prev) => (prev === section ? null : section));
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        country: form.country,
        active: form.active,
        tasa_interes_mora: typeof form.tasa_interes_mora === 'number' ? form.tasa_interes_mora : 0,
        vehicles: form.vehicles,
        rules: form.rules,
      };
      if (editingId) {
        await api.put(`/miauto/cronogramas/${editingId}`, payload);
        toast.success('Cronograma actualizado');
      } else {
        await api.post('/miauto/cronogramas', payload);
        toast.success('Cronograma creado');
      }
      await fetchCronogramas();
      closeModal();
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al guardar cronograma');
    } finally {
      setSaving(false);
    }
  };

  const toggleCronogramaActive = async (id: string) => {
    try {
      const res = await api.patch(`/miauto/cronogramas/${id}/toggle-active`);
      const updated = res.data?.data ?? res.data;
      if (updated) {
        setCronogramas((prev) => prev.map((c) => (c.id === id ? { ...updated } : c)));
      }
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Error al cambiar estado');
    }
  };

  const addVehicle = () => {
    const newV = createEmptyVehicle();
    setForm((f) => ({
      ...f,
      vehicles: [...f.vehicles, newV],
      rules: f.rules.map((r) => ({
        ...r,
        cuotas_por_vehiculo: [...(r.cuotas_por_vehiculo || []), 0],
        cuota_moneda_por_vehiculo: [...(r.cuota_moneda_por_vehiculo || []), 'PEN'],
      })),
    }));
  };

  const updateVehicle = (index: number, field: keyof VehiculoCronograma, value: string | number | undefined) => {
    if (field === 'id') return;
    setForm((f) => ({
      ...f,
      vehicles: f.vehicles.map((v, i) => {
        if (i !== index) return v;
        const next = { ...v, [field]: value };
        if (value === undefined && field === 'image') delete next.image;
        return next;
      }),
    }));
  };

  const setVehicleImageFromFile = (index: number, file: File) => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => updateVehicle(index, 'image', reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleVehicleImageChange = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVehicleImageFromFile(index, file);
    e.target.value = '';
  };

  const [dragOverPhotoIndex, setDragOverPhotoIndex] = useState<number | null>(null);

  const handlePhotoDrop = (index: number, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPhotoIndex(null);
    const file = e.dataTransfer.files?.[0];
    if (file) setVehicleImageFromFile(index, file);
  };

  const handlePhotoDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) setDragOverPhotoIndex(index);
  };

  const handlePhotoDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPhotoIndex(null);
  };

  const removeVehicle = (index: number) => {
    if (form.vehicles.length <= 1) return;
    setForm((f) => ({
      ...f,
      vehicles: f.vehicles.filter((_, i) => i !== index),
      rules: f.rules.map((r) => ({
        ...r,
        cuotas_por_vehiculo: r.cuotas_por_vehiculo.filter((_, i) => i !== index),
        cuota_moneda_por_vehiculo: (r.cuota_moneda_por_vehiculo || r.cuotas_por_vehiculo.map(() => 'PEN' as BonoAutoMoneda)).filter((_, i) => i !== index),
      })),
    }));
  };

  const addRule = () => {
    setForm((f) => ({
      ...f,
      rules: [...f.rules, createEmptyRule(f.vehicles.length)],
    }));
  };

  const updateRule = (ruleIndex: number, field: 'viajes' | 'bono_auto' | 'bono_auto_moneda', value: string | number | BonoAutoMoneda) => {
    setForm((f) => ({
      ...f,
      rules: f.rules.map((r, i) =>
        i === ruleIndex ? { ...r, [field]: value } : r
      ),
    }));
  };

  const updateRuleCuota = (ruleIndex: number, vehicleIndex: number, value: number) => {
    setForm((f) => ({
      ...f,
      rules: f.rules.map((r, i) => {
        if (i !== ruleIndex) return r;
        const arr = [...(r.cuotas_por_vehiculo || [])];
        arr[vehicleIndex] = value;
        return { ...r, cuotas_por_vehiculo: arr };
      }),
    }));
  };

  const updateRuleCuotaMoneda = (ruleIndex: number, vehicleIndex: number, value: BonoAutoMoneda) => {
    setForm((f) => ({
      ...f,
      rules: f.rules.map((r, i) => {
        if (i !== ruleIndex) return r;
        const arr = [...(r.cuota_moneda_por_vehiculo || r.cuotas_por_vehiculo.map(() => 'PEN' as BonoAutoMoneda))];
        arr[vehicleIndex] = value;
        return { ...r, cuota_moneda_por_vehiculo: arr };
      }),
    }));
  };

  const removeRule = (index: number) => {
    setForm((f) => ({ ...f, rules: f.rules.filter((_, i) => i !== index) }));
  };

  /** Solo dígitos y un decimal (punto o coma). Sin "e", ni signos ni caracteres especiales. */
  const sanitizeDecimalInput = (raw: string): string => {
    const cleaned = raw.replace(/[^\d.,]/g, '').replace(',', '.');
    const parts = cleaned.split('.');
    if (parts.length <= 2) return cleaned;
    return parts[0] + '.' + parts.slice(1).join('');
  };

  const handleDecimalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const { key } = e;
    const value = e.currentTarget.value;
    const allowedKeys = ['Backspace', 'Delete', 'Tab', 'Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (allowedKeys.includes(key) || ((e.ctrlKey || e.metaKey) && ['a', 'c', 'v', 'x'].includes(key.toLowerCase()))) return;
    if (key === 'e' || key === 'E' || key === '+' || key === '-') {
      e.preventDefault();
      return;
    }
    if (key === '.' || key === ',') {
      if (value.includes('.') || value.includes(',')) e.preventDefault();
      return;
    }
    if (key.length === 1 && !/^\d$/.test(key)) e.preventDefault();
  };

  const handleDecimalPaste = (
    e: React.ClipboardEvent<HTMLInputElement>,
    setValue: (n: number) => void
  ) => {
    e.preventDefault();
    const pasted = (e.clipboardData.getData('text') || '').trim();
    const sanitized = sanitizeDecimalInput(pasted);
    const num = parseFloat(sanitized);
    setValue(Number.isFinite(num) ? num : 0);
  };

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <SettingsIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Configuración</h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">Cronogramas: viajes, bono mi auto y carros ofrecidos (inicial + cuotas semanales)</p>
            </div>
          </div>
          <button
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white/20 hover:bg-white/30 text-white rounded-lg font-medium transition-colors"
          >
            <PlusCircle className="w-5 h-5" />
            Incluir cronograma
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-[#8B1A1A]" />
          <h2 className="text-base font-semibold text-gray-900">Valor del dólar (tipo de cambio)</h2>
        </div>
        <div className="p-4 sm:p-6">
          {loadingTipoCambio ? (
            <div className="flex justify-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-red-600 border-t-transparent" />
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="p-4 rounded-xl border border-gray-200 bg-gray-50/50">
                <label className="block text-sm font-medium text-gray-700 mb-2">Perú (PE)</label>
                <p className="text-xs text-gray-500 mb-1">1 USD =</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={tipoCambioPE}
                    onChange={(e) => setTipoCambioPE(e.target.value)}
                    className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder="3.75"
                  />
                  <span className="text-sm font-medium text-gray-600">S/. (PEN)</span>
                  <button
                    type="button"
                    onClick={() => saveTipoCambio('PE')}
                    disabled={savingTipoCambio === 'PE'}
                    className="px-4 py-2 bg-[#8B1A1A] text-white rounded-lg text-sm font-medium hover:bg-[#6B1515] disabled:opacity-50"
                  >
                    {savingTipoCambio === 'PE' ? 'Guardando...' : 'Guardar'}
                  </button>
                </div>
              </div>
              <div className="p-4 rounded-xl border border-gray-200 bg-gray-50/50">
                <label className="block text-sm font-medium text-gray-700 mb-2">Colombia (CO)</label>
                <p className="text-xs text-gray-500 mb-1">1 USD =</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={tipoCambioCO}
                    onChange={(e) => setTipoCambioCO(e.target.value)}
                    className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder="4100"
                  />
                  <span className="text-sm font-medium text-gray-600">COP</span>
                  <button
                    type="button"
                    onClick={() => saveTipoCambio('CO')}
                    disabled={savingTipoCambio === 'CO'}
                    className="px-4 py-2 bg-[#8B1A1A] text-white rounded-lg text-sm font-medium hover:bg-[#6B1515] disabled:opacity-50"
                  >
                    {savingTipoCambio === 'CO' ? 'Guardando...' : 'Guardar'}
                  </button>
                </div>
              </div>
            </div>
          )}
          <p className="text-xs text-gray-500 mt-3">Se usa para mostrar el equivalente en moneda local cuando los montos del cronograma están en USD.</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        <div className="p-4 sm:p-6">
          {loading ? (
            <div className="py-12 flex justify-center">
              <div className="animate-spin rounded-full h-10 w-10 border-2 border-red-600 border-t-transparent" />
            </div>
          ) : cronogramas.length === 0 ? (
            <div className="py-8 text-center">
              <h3 className="text-lg font-semibold text-gray-800 mb-2">No hay cronogramas</h3>
              <p className="text-gray-500 max-w-sm mx-auto">Crea tu primer cronograma para definir viajes, bono mi auto y cuotas por carro.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                <p className="text-sm text-gray-500 order-2 sm:order-1">
                  {filteredCronogramas.length === 0
                    ? 'Sin resultados'
                    : `${filteredCronogramas.length} cronograma(s)`}
                </p>
                <div className="relative w-full sm:w-auto sm:min-w-[200px] sm:max-w-xs order-1 sm:order-2">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                  <input
                    type="text"
                    value={searchName}
                    onChange={(e) => setSearchName(e.target.value)}
                    placeholder="Buscar por nombre..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500"
                  />
                </div>
              </div>

              {filteredCronogramas.length === 0 ? (
                <p className="text-gray-500 py-8 text-center">No hay cronogramas que coincidan con la búsqueda.</p>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {paginatedCronogramas.map((c) => (
                <article
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openEdit(c)}
                  onKeyDown={(e) => e.key === 'Enter' && openEdit(c)}
                  className="max-w-sm rounded-2xl border border-gray-200 bg-white overflow-hidden shadow-sm hover:shadow-md hover:border-gray-300 transition-all duration-200 flex flex-col cursor-pointer"
                >
                  <header className="flex items-start justify-between gap-2 p-4 border-b border-gray-100">
                    <h3 className="text-base font-bold text-gray-900 leading-tight uppercase min-w-0 flex-1" title={c.name || 'Sin nombre'}>
                      {c.name || 'Sin nombre'}
                    </h3>
                    <span className={`shrink-0 px-2 py-0.5 text-xs font-semibold rounded ${getCountryBadgeClass(c.country)}`}>
                      {c.country}
                    </span>
                  </header>

                  <div className="p-4 flex-1">
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                      <dt className="text-gray-500 font-medium">Estado</dt>
                      <dd>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={c.active}
                          onClick={(e) => { e.stopPropagation(); toggleCronogramaActive(c.id); }}
                          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-2 ${
                            c.active ? 'bg-green-500' : 'bg-gray-200'
                          }`}
                        >
                          <span
                            className={`pointer-events-none absolute left-0.5 top-1/2 h-5 w-5 -translate-y-1/2 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                              c.active ? 'translate-x-4' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </dd>
                      <dt className="text-gray-500 font-medium">Carros</dt>
                      <dd className="text-gray-800 text-xs leading-snug">
                        {(c.vehicles || []).length === 0 ? (
                          '—'
                        ) : (
                          <span className="font-medium">
                            {(c.vehicles || []).map((v) => v.name?.trim() || 'Sin nombre').join(', ')}
                          </span>
                        )}
                      </dd>
                    </dl>
                  </div>

                  <footer className="p-3 pt-0 border-t border-gray-100">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); openEdit(c); }}
                      className="w-full py-2 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
                    >
                      Ver detalle
                    </button>
                  </footer>
                </article>
                  ))}
                  </div>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-between gap-4 mt-6 pt-4 border-t border-gray-200">
                      <p className="text-sm text-gray-600">
                        Página {currentPage} de {totalPages}
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                          disabled={currentPage <= 1}
                          className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <ChevronLeft className="w-4 h-4" />
                          Anterior
                        </button>
                        <button
                          type="button"
                          onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                          disabled={currentPage >= totalPages}
                          className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Siguiente
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {modalOpen && createPortal(
        (
          <div
            className={`fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm transition-opacity duration-200 ${
              isModalEntering || isModalClosing ? 'opacity-0' : 'opacity-100'
            }`}
            onTransitionEnd={(e) => {
              if (e.target !== e.currentTarget) return;
              if (isModalClosing) finishCloseModal();
            }}
          >
            <div
              className={`bg-white rounded-2xl shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col transition-all duration-200 ${
                isModalEntering ? 'opacity-0 scale-95' : isModalClosing ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
              }`}
            >
            {/* Header del modal */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gray-50/80 flex-shrink-0">
              <h2 className="text-xl font-bold text-gray-900">
                {isViewMode ? 'Ver detalle' : editingId ? 'Editar cronograma' : 'Incluir cronograma'}
              </h2>
              <div className="flex items-center gap-2">
                {isViewMode ? (
                  <button
                    type="button"
                    onClick={() => setModalViewOnly(false)}
                    className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
                  >
                    Editar
                  </button>
                ) : editingId ? (
                  <button
                    type="button"
                    onClick={() => setModalViewOnly(true)}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Ver detalle
                  </button>
                ) : null}
                <button type="button" onClick={closeModal} className="p-2 text-gray-500 hover:bg-gray-200 hover:text-gray-700 rounded-lg transition-colors" aria-label="Cerrar">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto space-y-6">
              {/* Datos generales */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Nombre del cronograma *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.toUpperCase() }))}
                    readOnly={isViewMode}
                    className={`w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 ${isViewMode ? 'bg-gray-50 cursor-default' : ''}`}
                    placeholder="Ej. Cronograma 2025 - II"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">País</label>
                  <select
                    value={form.country}
                    onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
                    disabled={isViewMode}
                    className={`w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 ${isViewMode ? 'bg-gray-50 cursor-default' : ''}`}
                  >
                    <option value="PE">PE</option>
                    <option value="CO">CO</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="active"
                  checked={form.active}
                  onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                  disabled={isViewMode}
                  className="rounded border-gray-300 text-red-600 focus:ring-red-500 w-4 h-4"
                />
                <label htmlFor="active" className="text-sm font-medium text-gray-700">Activo</label>
              </div>

              {/* Interés por mora (pago semanal en lunes) */}
              <div className="border border-gray-200 rounded-xl p-4 bg-gray-50/50">
                <h4 className="text-sm font-medium text-gray-800 mb-2">Interés por mora (pago semanal en lunes)</h4>
                <div className="mb-2">
                  <label htmlFor="tasa_interes_mora" className="block text-sm text-gray-600 mb-1">Tasa de interés (%)</label>
                  <input
                    id="tasa_interes_mora"
                    type="number"
                    min={0}
                    step={0.5}
                    value={((form.tasa_interes_mora ?? 0) * 100).toString()}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setForm((f) => ({ ...f, tasa_interes_mora: Number.isNaN(v) || v < 0 ? 0 : v / 100 }));
                    }}
                    disabled={isViewMode}
                    className={`w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 ${INPUT_NUMBER_CLASS} ${isViewMode ? 'bg-gray-50 cursor-default' : ''}`}
                  />
                </div>
                <p className="text-xs text-gray-500 mb-1">
                  Si el conductor no paga la cuota semanal completa el lunes, se aplica este interés por cada día de atraso.
                </p>
                <p className="text-xs text-gray-600 font-medium">Fórmula: Interés por día = (Cuota semanal × Tasa) / 7</p>
              </div>

              {/* Sección: Carros ofrecidos (acordeón) */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleSection('carros')}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
                >
                  <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
                    <Car className="w-4 h-4 text-gray-500" />
                    Carros ofrecidos
                    {form.vehicles.length > 0 && (
                      <span className="text-xs font-normal text-gray-500">({form.vehicles.length})</span>
                    )}
                  </span>
                  {modalSectionOpen === 'carros' ? (
                    <ChevronDown className="w-5 h-5 text-gray-500 transition-transform duration-200" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-500 transition-transform duration-200" />
                  )}
                </button>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                  style={{ gridTemplateRows: modalSectionOpen === 'carros' ? '1fr' : '0fr' }}
                >
                  <div className="min-h-0 overflow-hidden">
                  <div className="p-5 pt-3 border-t border-gray-100">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                      <p className="text-sm text-gray-600">Añade los carros con foto, inicial y cuotas semanales.</p>
                      {!isViewMode && (
                        <button
                          type="button"
                          onClick={addVehicle}
                          className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors shadow-sm"
                        >
                          <Car className="w-4 h-4" />
                          Añadir carro
                        </button>
                      )}
                    </div>
                    <div className="flex gap-5 overflow-x-auto pb-2 scroll-smooth">
                  {form.vehicles.map((v, i) => (
                    <div
                      key={v.id}
                      className="flex-shrink-0 w-[280px] p-4 bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md hover:border-gray-300 transition-all duration-200 flex flex-col items-stretch gap-4"
                    >
                      {/* Foto */}
                      <div className="flex flex-col items-center gap-2">
                        {v.image ? (
                          <div
                            className={`relative w-24 h-24 rounded-xl border-2 border-dashed border-transparent overflow-hidden transition-colors ${
                              dragOverPhotoIndex === i ? 'border-red-400 bg-red-50/80 ring-2 ring-red-200' : ''
                            }`}
                            onDrop={(e) => handlePhotoDrop(i, e)}
                            onDragOver={(e) => handlePhotoDragOver(e, i)}
                            onDragLeave={handlePhotoDragLeave}
                          >
                            <img
                              src={v.image}
                              alt={v.name || 'Carro'}
                              className="w-full h-full object-cover pointer-events-none"
                            />
                            {dragOverPhotoIndex === i && (
                              <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-xs font-medium">
                                Soltar aquí
                              </span>
                            )}
                            {!isViewMode && (
                              <button
                                type="button"
                                onClick={() => updateVehicle(i, 'image', undefined)}
                                className="absolute top-1 right-1 w-7 h-7 bg-white/95 backdrop-blur-sm border border-gray-200 text-gray-500 rounded-lg flex items-center justify-center shadow-sm hover:bg-red-50 hover:border-red-200 hover:text-red-600 transition-colors z-10"
                                title="Quitar foto"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        ) : (
                          isViewMode ? (
                            <div className="w-24 h-24 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 text-gray-400 text-xs">Sin foto</div>
                          ) : (
                          <label
                            className={`w-24 h-24 flex flex-col items-center justify-center rounded-xl border-2 border-dashed cursor-pointer transition-all ${
                              dragOverPhotoIndex === i
                                ? 'border-red-500 bg-red-50 text-red-600'
                                : 'border-gray-200 text-gray-400 hover:border-red-300 hover:bg-red-50/30 hover:text-red-500'
                            }`}
                            onDrop={(e) => handlePhotoDrop(i, e)}
                            onDragOver={(e) => handlePhotoDragOver(e, i)}
                            onDragLeave={handlePhotoDragLeave}
                          >
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => handleVehicleImageChange(i, e)} />
                            {dragOverPhotoIndex === i ? (
                              <span className="text-xs font-medium">Soltar aquí</span>
                            ) : (
                              <>
                                <ImagePlus className="w-7 h-7" />
                                <span className="text-xs mt-1 text-center px-1">Foto o arrastrar</span>
                              </>
                            )}
                          </label>
                          )
                        )}
                        {v.image && !isViewMode && (
                          <label className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-red-600 cursor-pointer transition-colors">
                            <ImagePlus className="w-3.5 h-3.5" />
                            Cambiar foto
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => handleVehicleImageChange(i, e)} />
                          </label>
                        )}
                      </div>
                      <div className="space-y-3">
                        <div>
                          <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Modelo / nombre</label>
                          <input
                            type="text"
                            value={v.name ?? ''}
                            onChange={(e) => updateVehicle(i, 'name', e.target.value)}
                            readOnly={isViewMode}
                            className={`w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 transition-shadow ${isViewMode ? 'bg-gray-50 cursor-default' : ''}`}
                            placeholder="Ej. Kia Soluto 2026"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="min-w-0">
                            <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Inicial</label>
                            <div className="flex w-full rounded-lg border border-gray-200 bg-gray-50/50 focus-within:bg-white focus-within:ring-2 focus-within:ring-red-500/20 focus-within:border-red-500 transition-shadow">
                              <select
                                value={v.inicial_moneda ?? 'USD'}
                                onChange={(e) => updateVehicle(i, 'inicial_moneda', e.target.value as MonedaInicial)}
                                disabled={isViewMode}
                                className={`w-12 pl-2 pr-1 py-2 text-sm font-medium border-0 border-r border-gray-200 rounded-l-lg bg-transparent focus:ring-0 cursor-pointer text-gray-700 ${isViewMode ? 'cursor-default' : ''}`}
                                title="Moneda"
                              >
                                <option value="USD">$</option>
                                <option value="PEN">S/.</option>
                              </select>
                              <input
                                type="number"
                                min={0}
                                step={v.inicial_moneda === 'PEN' ? 0.01 : 1}
                                value={v.inicial != null ? v.inicial : ''}
                                onChange={(e) => updateVehicle(i, 'inicial', Number(e.target.value) || 0)}
                                onWheel={(e) => e.currentTarget.blur()}
                                readOnly={isViewMode}
                                className={`flex-1 min-w-0 px-3 py-2 text-sm bg-transparent border-0 rounded-r-lg focus:ring-0 focus:outline-none placeholder-gray-400${INPUT_NUMBER_CLASS} ${isViewMode ? 'cursor-default' : ''}`}
                                placeholder={v.inicial_moneda === 'USD' ? '1000' : '3500'}
                              />
                            </div>
                          </div>
                          <div className="min-w-0">
                            <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Cuotas</label>
                            <input
                              type="number"
                              min={0}
                              value={v.cuotas_semanales != null ? v.cuotas_semanales : ''}
                              onChange={(e) => updateVehicle(i, 'cuotas_semanales', Number(e.target.value) || 0)}
                              onWheel={(e) => e.currentTarget.blur()}
                              readOnly={isViewMode}
                              className={`w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 transition-shadow${INPUT_NUMBER_CLASS} ${isViewMode ? 'bg-gray-50 cursor-default' : ''}`}
                              placeholder="264"
                            />
                          </div>
                        </div>
                      </div>
                      {form.vehicles.length > 1 && !isViewMode && (
                        <button
                          type="button"
                          onClick={() => removeVehicle(i)}
                          className="mt-auto inline-flex items-center justify-center gap-2 w-full py-2 text-xs font-medium text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg border border-gray-200 hover:border-red-200 transition-colors"
                          title="Quitar carro"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Quitar carro
                        </button>
                      )}
                    </div>
                  ))}
                    </div>
                  </div>
                  </div>
                </div>
              </div>

              {/* Sección: Filas del cronograma (acordeón) */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleSection('filas')}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
                >
                  <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
                    <ListOrdered className="w-4 h-4 text-gray-500" />
                    Filas del cronograma
                    {form.rules.length > 0 && (
                      <span className="text-xs font-normal text-gray-500">({form.rules.length})</span>
                    )}
                  </span>
                  {modalSectionOpen === 'filas' ? (
                    <ChevronDown className="w-5 h-5 text-gray-500 transition-transform duration-200" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-500 transition-transform duration-200" />
                  )}
                </button>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                  style={{ gridTemplateRows: modalSectionOpen === 'filas' ? '1fr' : '0fr' }}
                >
                  <div className="min-h-0 overflow-hidden">
                  <div className="p-4 pt-2 border-t border-gray-100">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      {!isViewMode && (
                        <button type="button" onClick={addRule} className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700">
                          + Añadir fila
                        </button>
                      )}
                    </div>
                    <div className="border border-gray-200 rounded-xl overflow-hidden overflow-x-auto bg-white">
                      <table className="w-full text-sm table-fixed" style={{ minWidth: 360 }}>
                        <thead>
                          <tr className="bg-gray-100 border-b border-gray-200">
                            <th className="text-left py-2.5 px-2 font-semibold text-gray-700 w-[7rem]">Viajes</th>
                            <th className="text-left py-2.5 px-2 font-semibold text-gray-700 w-[7rem]">Bono mi auto</th>
                            {form.vehicles.map((v, i) => (
                              <th key={v.id} className="text-left py-2.5 px-2 font-semibold text-gray-700 w-[7rem]" title={v.name || `Carro ${i + 1}`}>
                                <span className="block truncate text-gray-800">{v.name || `Carro ${i + 1}`}</span>
                              </th>
                            ))}
                            <th className="text-right py-2.5 px-2 w-14" scope="col" aria-label="Quitar fila"> </th>
                          </tr>
                        </thead>
                        <tbody>
                          {form.rules.map((r, ri) => (
                            <tr key={ri} className="border-b border-gray-100 last:border-0 hover:bg-gray-50/50">
                              <td className="py-2 px-2 align-top w-[7rem]">
                                <input
                                  type="text"
                                  value={r.viajes}
                                  onChange={(e) => updateRule(ri, 'viajes', e.target.value)}
                                  readOnly={isViewMode}
                                  className={`w-full rounded border border-gray-300 px-1.5 py-1 text-xs focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 box-border ${isViewMode ? 'bg-gray-50 cursor-default' : ''}`}
                                  placeholder="0 - 119"
                                />
                              </td>
                              <td className="py-2 px-2 align-top w-[7rem]">
                                <div className="flex w-full rounded border border-gray-300 bg-white focus-within:border-red-500 focus-within:ring-1 focus-within:ring-red-500 min-w-0 box-border">
                                  <select
                                    value={r.bono_auto_moneda ?? 'PEN'}
                                    onChange={(e) => updateRule(ri, 'bono_auto_moneda', e.target.value as BonoAutoMoneda)}
                                    disabled={isViewMode}
                                    className={`shrink-0 flex items-center px-1.5 py-1 text-xs text-gray-700 border-r border-gray-200 bg-gray-50 rounded-l focus:ring-0 focus:outline-none cursor-pointer ${isViewMode ? 'cursor-default' : ''}`}
                                    title="Moneda bono mi auto"
                                  >
                                    <option value="USD">$</option>
                                    <option value="PEN">S/.</option>
                                  </select>
                                  <input
                                    type="number"
                                    min={0}
                                    step={0.01}
                                    value={r.bono_auto != null ? r.bono_auto : ''}
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      const sanitized = sanitizeDecimalInput(raw);
                                      const num = parseFloat(sanitized);
                                      updateRule(ri, 'bono_auto', Number.isFinite(num) ? num : 0);
                                    }}
                                    onKeyDown={handleDecimalKeyDown}
                                    onPaste={(e) => handleDecimalPaste(e, (n) => updateRule(ri, 'bono_auto', n))}
                                    onWheel={(e) => e.currentTarget.blur()}
                                    placeholder="0"
                                    readOnly={isViewMode}
                                    className={`flex-1 min-w-0 w-0 px-1.5 py-1 text-xs border-0 rounded-r bg-transparent focus:outline-none focus:ring-0${INPUT_NUMBER_CLASS} ${isViewMode ? 'cursor-default' : ''}`}
                                  />
                                </div>
                              </td>
                              {form.vehicles.map((_, vi) => {
                                const val = (r.cuotas_por_vehiculo || [])[vi] ?? 0;
                                const moneda = (r.cuota_moneda_por_vehiculo || [])[vi] ?? 'PEN';
                                return (
                                  <td key={vi} className="py-2 px-2 align-top w-[7rem]">
                                    <div className="flex w-full rounded border border-gray-300 bg-white focus-within:border-red-500 focus-within:ring-1 focus-within:ring-red-500 min-w-0 box-border">
                                      <select
                                        value={moneda}
                                        onChange={(e) => updateRuleCuotaMoneda(ri, vi, e.target.value as BonoAutoMoneda)}
                                        disabled={isViewMode}
                                        className={`shrink-0 flex items-center px-1.5 py-1 text-xs text-gray-700 border-r border-gray-200 bg-gray-50 rounded-l focus:ring-0 focus:outline-none cursor-pointer ${isViewMode ? 'cursor-default' : ''}`}
                                        title="Moneda cuota"
                                      >
                                        <option value="USD">$</option>
                                        <option value="PEN">S/.</option>
                                      </select>
                                      <input
                                        type="number"
                                        min={0}
                                        step={0.01}
                                        value={val != null ? val : ''}
                                        onChange={(e) => {
                                          const raw = e.target.value;
                                          const sanitized = sanitizeDecimalInput(raw);
                                          const num = parseFloat(sanitized);
                                          updateRuleCuota(ri, vi, Number.isFinite(num) ? num : 0);
                                        }}
                                        onKeyDown={handleDecimalKeyDown}
                                        onPaste={(e) => handleDecimalPaste(e, (n) => updateRuleCuota(ri, vi, n))}
                                        onWheel={(e) => e.currentTarget.blur()}
                                        placeholder="0"
                                        readOnly={isViewMode}
                                        className={`flex-1 min-w-0 w-0 px-1.5 py-1 text-xs border-0 rounded-r bg-transparent focus:outline-none focus:ring-0${INPUT_NUMBER_CLASS} ${isViewMode ? 'cursor-default' : ''}`}
                                      />
                                    </div>
                                  </td>
                                );
                              })}
                              <td className="py-2 px-2 align-top text-right">
                                {!isViewMode && (
                                  <button
                                    type="button"
                                    onClick={() => removeRule(ri)}
                                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                    title="Quitar fila"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer del modal */}
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-white flex-shrink-0 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.08)]">
              {isViewMode ? (
                <button type="button" onClick={closeModal} className="px-5 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium transition-colors">
                  Cerrar
                </button>
              ) : (
                <>
                  <button type="button" onClick={closeModal} className="px-5 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium transition-colors">
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={!form.name.trim() || saving}
                    className="px-5 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors"
                  >
                    {saving ? 'Guardando...' : editingId ? 'Guardar' : 'Crear'}
                  </button>
                </>
              )}
            </div>
            </div>
          </div>
        ),
        document.body
      )}
    </div>
  );
}
