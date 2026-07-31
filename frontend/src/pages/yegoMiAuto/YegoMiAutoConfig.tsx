import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  PlusCircle,
  Trash2,
  X,
  Settings as SettingsIcon,
  ImagePlus,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ListOrdered,
  Search,
  SlidersHorizontal,
  Car,
  ClipboardList,
  ShieldCheck,
  TableProperties,
} from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';
import {
  EXPENSE_LABELS,
  MONTH_OPTIONS,
  TIPO_VEHICULO_OPTIONS,
  configuredExpenseKeys,
  countConfiguredExpenses,
  createDefaultRequisitosGastosVehiculo,
  createDefaultRequisitosVehiculo,
  createEmptyRule,
  createEmptyVehicle,
  expenseScheduleLabel,
  formatExpenseAmount,
  incompleteExpenseKeys,
  isExpenseScheduleComplete,
  mergeRequisitosFromApi,
  mergeRequisitosGastosFromApi,
  validateCronogramaForm,
  type BonoAutoMoneda,
  type Cronograma,
  type GastoRequisitoMoneda,
  type ItemGastoConCobro,
  type MonedaInicial,
  type PagoInicialTipo,
  type RequisitosGastosVehiculo,
  type TipoVehiculoCronograma,
  type TodoRiesgoGpsModo,
  type VehiculoCronograma,
} from './miautoCronogramaConfigDomain';

export {
  createDefaultRequisitosGastosVehiculo,
  createDefaultRequisitosVehiculo,
  getRuleForTripCount,
  mergeRequisitosFromApi,
  mergeRequisitosGastosFromApi,
  parseViajesInterval,
} from './miautoCronogramaConfigDomain';

type CronogramaModalTab = 'general' | 'vehicles' | 'rules';

const MODAL_TABS: Array<{
  id: CronogramaModalTab;
  label: string;
  icon: typeof ClipboardList;
}> = [
  { id: 'general', label: 'General', icon: ClipboardList },
  { id: 'vehicles', label: 'Vehículos y coberturas', icon: ShieldCheck },
  { id: 'rules', label: 'Reglas de cuotas', icon: TableProperties },
];

/** Clases para inputs numéricos sin spinners y sin cambio por rueda */
const INPUT_NUMBER_CLASS =
  ' [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-inner-spin-button]:m-0';

function getCountryBadgeClass(country: string): string {
  if (country === 'PE') return 'bg-red-100 text-red-700';
  if (country === 'CO') return 'bg-amber-100 text-amber-800';
  return 'bg-gray-100 text-gray-600';
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
    bono_tiempo_activo: false,
    requisitos_vehiculo: createDefaultRequisitosVehiculo(),
    vehicles: [{ ...createEmptyVehicle() }],
    rules: [],
  });
  const [modalSectionsOpen, setModalSectionsOpen] = useState({
    parametros: true,
    carros: true,
    filas: false,
  });
  const [modalActiveTab, setModalActiveTab] = useState<CronogramaModalTab>('general');
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
      bono_tiempo_activo: false,
      requisitos_vehiculo: createDefaultRequisitosVehiculo(),
      vehicles: [createEmptyVehicle()],
      rules: [createEmptyRule(1)],
    });
    setModalActiveTab('general');
    setModalOpen(true);
  };

  const openEdit = (c: Cronograma) => {
    setModalViewOnly(true);
    setEditingId(c.id);
    const vehicles = (c.vehicles?.length ? c.vehicles : [createEmptyVehicle()]).map((v) => ({
      ...v,
      inicial_moneda: v.inicial_moneda ?? 'USD',
      requisitos_gastos: mergeRequisitosGastosFromApi(v.requisitos_gastos),
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
    setForm({
      name: c.name,
      country: c.country,
      active: c.active,
      tasa_interes_mora: c.tasa_interes_mora ?? 0,
      bono_tiempo_activo: c.bono_tiempo_activo ?? false,
      requisitos_vehiculo: mergeRequisitosFromApi(c.requisitos_vehiculo),
      vehicles,
      rules,
    });
    setModalActiveTab('general');
    setModalOpen(true);
  };

  const finishCloseModal = () => {
    setModalOpen(false);
    setEditingId(null);
    setModalSectionsOpen({ parametros: true, carros: true, filas: false });
    setModalActiveTab('general');
    setModalViewOnly(true);
    setIsModalClosing(false);
  };

  const closeModal = () => {
    if (isModalClosing) return;
    setIsModalClosing(true);
  };

  const toggleModalSection = (key: 'parametros' | 'carros' | 'filas') => {
    setModalSectionsOpen((s) => ({ ...s, [key]: !s[key] }));
  };

  const selectModalTab = (tab: CronogramaModalTab) => {
    setModalActiveTab(tab);
    const section = tab === 'general' ? 'parametros' : tab === 'vehicles' ? 'carros' : 'filas';
    setModalSectionsOpen((current) => ({ ...current, [section]: true }));
  };

  const handleSave = async () => {
    const validationError = validateCronogramaForm(form);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        country: form.country,
        active: form.active,
        tasa_interes_mora: typeof form.tasa_interes_mora === 'number' ? form.tasa_interes_mora : 0,
        bono_tiempo_activo: form.bono_tiempo_activo ?? false,
        requisitos_vehiculo: mergeRequisitosFromApi(form.requisitos_vehiculo),
        vehicles: form.vehicles.map((v) => ({
          ...v,
          requisitos_gastos: mergeRequisitosGastosFromApi(v.requisitos_gastos),
        })),
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
    newV.requisitos_gastos = createDefaultRequisitosGastosVehiculo();
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

  const updateRule = (
    ruleIndex: number,
    field: 'viajes' | 'bono_auto' | 'bono_auto_moneda',
    value: string | number | BonoAutoMoneda
  ) => {
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

  const setTipoVehiculoCronograma = (tipo: TipoVehiculoCronograma) => {
    setForm((f) => ({
      ...f,
      requisitos_vehiculo: { ...mergeRequisitosFromApi(f.requisitos_vehiculo), tipo_vehiculo: tipo },
    }));
  };

  const setModalidadPagoInicial = (type: PagoInicialTipo, enabled: boolean) => {
    setForm((current) => {
      const requirements = mergeRequisitosFromApi(current.requisitos_vehiculo);
      return {
        ...current,
        requisitos_vehiculo: {
          ...requirements,
          modalidades_pago_inicial: {
            ...requirements.modalidades_pago_inicial,
            [type]: enabled,
          },
        },
      };
    });
  };

  const updateVehicleRequisitosGastos = (vehicleIndex: number, patch: Partial<RequisitosGastosVehiculo>) => {
    setForm((f) => ({
      ...f,
      vehicles: f.vehicles.map((v, i) => {
        if (i !== vehicleIndex) return v;
        const cur = mergeRequisitosGastosFromApi(v.requisitos_gastos);
        return { ...v, requisitos_gastos: mergeRequisitosGastosFromApi({ ...cur, ...patch }) };
      }),
    }));
  };

  const patchVehiculoGasto = (
    vehicleIndex: number,
    key: 'src' | 'gps' | 'soat' | 'impuesto_vehicular' | 'todo_riesgo_mas_gps_agrupado' | 'inicial_parcial',
    field: Partial<ItemGastoConCobro>
  ) => {
    setForm((f) => ({
      ...f,
      vehicles: f.vehicles.map((v, i) => {
        if (i !== vehicleIndex) return v;
        const cur = mergeRequisitosGastosFromApi(v.requisitos_gastos);
        const item = cur[key];
        if (typeof item !== 'object') return v;
        const nextItem = {
          ...item,
          ...field,
          ...(field.cobro ? { cobro: { ...(item.cobro || {}), ...field.cobro } } : {}),
        };
        return {
          ...v,
          requisitos_gastos: mergeRequisitosGastosFromApi({
            ...cur,
            [key]: nextItem,
          }),
        };
      }),
    }));
  };

  const patchVehiculoGastoCobro = (
    vehicleIndex: number,
    key: 'src' | 'soat' | 'impuesto_vehicular' | 'todo_riesgo_mas_gps_agrupado' | 'inicial_parcial',
    cobroPatch: Record<string, number>
  ) => {
    patchVehiculoGasto(vehicleIndex, key, { cobro: cobroPatch });
  };

  const requisitosCronograma = mergeRequisitosFromApi(form.requisitos_vehiculo);
  const tipoCronograma = requisitosCronograma.tipo_vehiculo;
  const configuredExpenseTotal = useMemo(
    () => form.vehicles.reduce((total, vehicle) => total + countConfiguredExpenses(vehicle, tipoCronograma), 0),
    [form.vehicles, tipoCronograma],
  );
  const activeModalTabIndex = MODAL_TABS.findIndex((tab) => tab.id === modalActiveTab);

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
              <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Cronogramas Mi Auto</h1>
              <p className="text-xs lg:text-sm text-white/90 mt-0.5">Planes, vehículos, gastos, coberturas y reglas de cuotas</p>
            </div>
          </div>
          <button
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white/20 hover:bg-white/30 text-white rounded-lg font-medium transition-colors"
          >
            <PlusCircle className="w-5 h-5" />
            Crear cronograma
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
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
              className={`bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[92vh] overflow-hidden flex flex-col transition-all duration-200 ${
                isModalEntering ? 'opacity-0 scale-95' : isModalClosing ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
              }`}
            >
            {/* Header del modal */}
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-200 bg-white flex-shrink-0">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-bold text-gray-900">
                  {isViewMode ? form.name || 'Detalle del cronograma' : editingId ? 'Editar cronograma' : 'Crear cronograma'}
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  {isViewMode ? 'Configuración vigente del plan' : 'Define el plan, sus vehículos, coberturas y reglas de cuotas'}
                </p>
              </div>
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

            <nav className="flex-shrink-0 border-b border-gray-200 bg-gray-50 px-4" aria-label="Secciones del cronograma">
              <div className="flex gap-1 overflow-x-auto py-2" role="tablist">
                {MODAL_TABS.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = modalActiveTab === tab.id;
                  const count = tab.id === 'vehicles'
                    ? `${form.vehicles.length} · ${configuredExpenseTotal}`
                    : tab.id === 'rules' ? String(form.rules.length) : null;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => selectModalTab(tab.id)}
                      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
                        isActive ? 'bg-white text-[#8B1A1A] shadow-sm ring-1 ring-gray-200' : 'text-gray-600 hover:bg-white/70 hover:text-gray-900'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {tab.label}
                      {count && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] tabular-nums text-gray-600">{count}</span>}
                    </button>
                  );
                })}
              </div>
            </nav>

            <div className="overflow-y-auto p-4 sm:p-5">
              <div className={modalActiveTab === 'general' ? 'space-y-5' : 'hidden'}>
              {/* Datos generales: nombre + tipo de vehículo (misma fila) + país */}
              <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-12 lg:gap-x-4 lg:items-end">
                <div className="lg:col-span-5">
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Nombre del cronograma *
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.toUpperCase() }))}
                    readOnly={isViewMode}
                    className={`w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 ${isViewMode ? 'bg-gray-50 cursor-default' : ''}`}
                    placeholder="Ej. Cronograma 2025 - II"
                  />
                </div>
                <div className="lg:col-span-4">
                  <label htmlFor="tipo_vehiculo_cronograma" className="block text-sm font-medium text-gray-700 mb-1.5">
                    Tipo de vehículo
                  </label>
                  <select
                    id="tipo_vehiculo_cronograma"
                    value={tipoCronograma}
                    onChange={(e) => setTipoVehiculoCronograma(e.target.value as TipoVehiculoCronograma)}
                    disabled={isViewMode}
                    className={`w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 ${isViewMode ? 'bg-gray-50 cursor-default' : 'bg-white'}`}
                  >
                    {TIPO_VEHICULO_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value} title={opt.hint}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2 lg:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    País
                  </label>
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

              {/* Parámetros del cronograma (acordeón, mismo patrón que Filas) */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleModalSection('parametros')}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
                >
                  <span className="text-sm font-medium text-gray-700 flex items-center gap-2 min-w-0">
                    <SlidersHorizontal className="w-4 h-4 text-gray-500 shrink-0" aria-hidden />
                    Parámetros del cronograma
                  </span>
                  {modalSectionsOpen.parametros ? (
                    <ChevronDown className="w-5 h-5 text-gray-500 transition-transform duration-200 shrink-0" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-500 transition-transform duration-200 shrink-0" />
                  )}
                </button>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                  style={{ gridTemplateRows: modalSectionsOpen.parametros ? '1fr' : '0fr' }}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="p-4 sm:p-5 pt-2 border-t border-gray-100 bg-gray-50/50">
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 lg:gap-4 lg:divide-x lg:divide-gray-200">
                        {/* Interés por mora */}
                        <div className="lg:pr-4 space-y-2 min-w-0">
                          <h4 className="text-sm font-medium text-gray-900 leading-tight">
                            Interés por mora
                          </h4>
                          <p className="text-[11px] text-gray-500 leading-snug" title="Si no paga la cuota el lunes, interés por día de atraso">
                            Cuota semanal (lunes). Interés/día = (cuota × tasa) ÷ 7
                          </p>
                          <div className="flex flex-wrap items-end gap-2">
                            <div>
                              <label htmlFor="tasa_interes_mora" className="block text-xs text-gray-600 mb-1">
                                Tasa (%)
                              </label>
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
                                className={`w-[5.5rem] rounded-lg border border-gray-300 px-2 py-2 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 ${INPUT_NUMBER_CLASS} ${isViewMode ? 'bg-gray-50 cursor-default' : 'bg-white'}`}
                              />
                            </div>
                          </div>
                        </div>

                        {/* Bono tiempo */}
                        <div className="lg:px-4 space-y-2 min-w-0 pt-2 border-t border-gray-200 lg:border-t-0 lg:pt-0">
                          <h4 className="text-sm font-medium text-gray-900 leading-tight">
                            Bono a tiempo
                          </h4>
                          <p className="text-[11px] text-gray-500 leading-snug" title="Bonificación por 4 pagos seguidos a tiempo con ≥120 viajes por semana">
                            Requiere 4 pagos consecutivos a tiempo y ≥120 viajes en cada una de esas semanas.
                          </p>
                          <label className="inline-flex items-start gap-2.5 cursor-pointer select-none">
                            <input
                              id="bono_tiempo_activo"
                              type="checkbox"
                              checked={form.bono_tiempo_activo ?? false}
                              onChange={(e) => setForm((f) => ({ ...f, bono_tiempo_activo: e.target.checked }))}
                              disabled={isViewMode}
                              className="mt-0.5 rounded border-gray-300 text-red-600 focus:ring-red-500 w-4 h-4 shrink-0"
                            />
                            <span className="text-sm text-gray-800">Activar bono tiempo</span>
                          </label>
                        </div>

                        <div className="space-y-2 min-w-0 border-t border-gray-200 pt-2 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
                          <h4 className="text-sm font-medium text-gray-900 leading-tight">Estado del plan</h4>
                          <p className="text-[11px] text-gray-500 leading-snug">Solo los cronogramas activos pueden asignarse a nuevas solicitudes.</p>
                          <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={form.active}
                              onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))}
                              disabled={isViewMode}
                              className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                            />
                            <span className={`text-sm font-medium ${form.active ? 'text-green-700' : 'text-gray-600'}`}>
                              {form.active ? 'Activo' : 'Inactivo'}
                            </span>
                          </label>
                        </div>

                      </div>
                      <div className="mt-4 border-t border-gray-200 pt-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <h4 className="text-sm font-medium leading-tight text-gray-900">Modalidad de pago inicial</h4>
                            <p className="mt-1 text-[11px] leading-snug text-gray-500">
                              Nueva Solicitud mostrará únicamente las modalidades habilitadas aquí.
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-4">
                            {([
                              ['completo', 'Inicial completa'],
                              ['parcial', 'Inicial parcial'],
                            ] as const).map(([type, label]) => {
                              return (
                                <label key={type} className="inline-flex cursor-pointer select-none items-center gap-2.5">
                                  <input
                                    type="checkbox"
                                    checked={requisitosCronograma.modalidades_pago_inicial[type]}
                                    onChange={(event) => setModalidadPagoInicial(type, event.target.checked)}
                                    disabled={isViewMode}
                                    className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                                  />
                                  <span className="text-sm text-gray-800">{label}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              </div>

              {/* Carros ofrecidos (acordeón) */}
              <div className={`${modalActiveTab === 'vehicles' ? 'flex' : 'hidden'} min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200`}>
                <div className="flex flex-col sm:flex-row sm:items-stretch gap-2 sm:gap-3 px-4 py-3 bg-gray-50 border-b border-gray-100">
                  <button
                    type="button"
                    onClick={() => toggleModalSection('carros')}
                    className="flex-1 flex items-center justify-between gap-2 min-w-0 text-left rounded-lg hover:bg-gray-100/80 transition-colors py-0.5 sm:py-0 -my-0.5 px-0 sm:pr-1"
                  >
                    <span className="min-w-0">
                      <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
                        <Car className="w-4 h-4 text-gray-500 shrink-0" aria-hidden />
                        Vehículos y coberturas
                        <span className="text-xs font-normal text-gray-500">
                          ({form.vehicles.length} carro{form.vehicles.length !== 1 ? 's' : ''})
                        </span>
                      </span>
                      <span className="block text-[11px] text-gray-500 truncate mt-0.5">
                        Datos del vehículo y conceptos que generará el contrato
                      </span>
                    </span>
                    {modalSectionsOpen.carros ? (
                      <ChevronDown className="w-5 h-5 text-gray-500 shrink-0" />
                    ) : (
                      <ChevronRight className="w-5 h-5 text-gray-500 shrink-0" />
                    )}
                  </button>
                  {!isViewMode && (
                    <button
                      type="button"
                      onClick={addVehicle}
                      className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-[#8B1A1A] rounded-xl hover:bg-[#6B1515] focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors shadow-sm w-full sm:w-auto sm:self-center"
                    >
                      <PlusCircle className="w-4 h-4" />
                      Añadir vehículo
                    </button>
                  )}
                </div>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-in-out min-h-0"
                  style={{ gridTemplateRows: modalSectionsOpen.carros ? '1fr' : '0fr' }}
                >
                  <div className="min-h-0 overflow-hidden flex flex-col">
                    <div className="max-h-[65vh] min-h-[420px] flex-1 overflow-y-auto bg-white p-4">
                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {form.vehicles.map((v, i) => {
                    const rg = mergeRequisitosGastosFromApi(v.requisitos_gastos);
                    const modoAgr = rg.todo_riesgo_y_gps_modo === 'agrupado';
                    const configuredKeys = configuredExpenseKeys(rg, tipoCronograma);
                    const configuredCount = configuredKeys.length;
                    const incompleteCount = incompleteExpenseKeys(v, tipoCronograma).length;
                    const srcConfigurationEditor = (
                      <div className="order-2 min-w-0 rounded-lg border border-gray-100 bg-gray-50/60 p-3 shadow-sm">
                        <div className="mb-2 min-w-0">
                          <label className="block text-[10px] font-medium leading-tight text-gray-700">
                            Seguro de responsabilidad civil (SRC)
                          </label>
                          <p className="mt-0.5 text-[10px] leading-snug text-gray-400">
                            Cobro mensual previo al vencimiento
                          </p>
                        </div>
                        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] items-end gap-2">
                          <label className="min-w-0 text-[10px] text-gray-500">
                            Monto
                            <div className="mt-1 flex min-w-0 rounded-md border border-gray-200 bg-white shadow-sm">
                              <select
                                value={rg.src.moneda}
                                onChange={(event) => patchVehiculoGasto(i, 'src', { moneda: event.target.value as GastoRequisitoMoneda })}
                                className="w-14 shrink-0 rounded-l-md border-0 border-r border-gray-200 bg-gray-50 py-1.5 text-xs"
                              >
                                <option value="USD">USD</option>
                                <option value="PEN">PEN</option>
                              </select>
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                value={rg.src.monto}
                                onChange={(event) => patchVehiculoGasto(i, 'src', { monto: Math.max(0, parseFloat(event.target.value) || 0) })}
                                className={`min-w-0 flex-1 rounded-r-md border-0 px-2 py-1.5 text-xs${INPUT_NUMBER_CLASS}`}
                              />
                            </div>
                          </label>
                          <label className="min-w-0 text-[10px] text-gray-500">
                            Meses antes
                            <input
                              type="number"
                              min={1}
                              max={12}
                              value={rg.src.cobro?.meses_anticipo || ''}
                              onChange={(event) => patchVehiculoGastoCobro(i, 'src', { meses_anticipo: Math.max(0, parseInt(event.target.value, 10) || 0) })}
                              className={`mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs${INPUT_NUMBER_CLASS}`}
                            />
                          </label>
                        </div>
                      </div>
                    );
                    return (
                    <div
                      key={v.id}
                      className="flex flex-col items-stretch gap-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-3 border-b border-gray-100 pb-3">
                        <p className="text-xs font-semibold uppercase text-gray-500">Vehículo {i + 1}</p>
                        <span className={`rounded px-2 py-1 text-[10px] font-semibold ${
                          incompleteCount > 0
                            ? 'bg-amber-50 text-amber-700'
                            : configuredCount > 0 ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
                        }`}>
                          {incompleteCount > 0
                            ? `${incompleteCount} por completar`
                            : configuredCount > 0 ? `${configuredCount} configurada${configuredCount === 1 ? '' : 's'}` : 'Sin coberturas'}
                        </span>
                      </div>
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

                      {/* Gastos variables por carro */}
                      <div className="border-t border-gray-100 pt-3 space-y-2.5">
                        <div>
                          <p className="text-xs font-semibold text-gray-800">Gastos y coberturas</p>
                          <p className="mt-0.5 text-[10px] text-gray-500">
                            Los conceptos permanecen activos incluso cuando su monto configurado es cero.
                          </p>
                        </div>
                        {isViewMode && (
                          <div className="space-y-2">
                            {configuredKeys.length === 0 ? (
                              <div className="rounded-md border border-dashed border-gray-200 px-3 py-4 text-center text-xs text-gray-500">
                                Este vehículo no tiene gastos ni coberturas configurados.
                              </div>
                            ) : configuredKeys.map((key) => {
                              const expense = rg[key];
                              return (
                                <div key={key} className="flex items-center justify-between gap-4 rounded-md border border-gray-200 px-3 py-2.5">
                                  <div className="min-w-0">
                                    <p className="truncate text-xs font-semibold text-gray-800">{EXPENSE_LABELS[key]}</p>
                                    <p className={`mt-0.5 truncate text-[10px] ${
                                      isExpenseScheduleComplete(key, expense) ? 'text-gray-500' : 'font-medium text-amber-700'
                                    }`}>{expenseScheduleLabel(key, expense)}</p>
                                  </div>
                                  <p className="shrink-0 text-sm font-bold tabular-nums text-gray-900">{formatExpenseAmount(expense)}</p>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <div className={`${isViewMode ? 'hidden' : 'grid'} grid-cols-2 items-stretch gap-3`}>
                          <div className="col-span-2 flex flex-col min-w-0 rounded-lg border border-gray-100 bg-gray-50/60 p-2.5 shadow-sm">
                            <label className="block text-[10px] font-medium text-gray-700 mb-1.5">Todo riesgo + GPS</label>
                            <select
                              value={rg.todo_riesgo_y_gps_modo}
                              onChange={(e) =>
                                updateVehicleRequisitosGastos(i, {
                                  todo_riesgo_y_gps_modo: e.target.value as TodoRiesgoGpsModo,
                                })
                              }
                              disabled={isViewMode}
                              className={`w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs shadow-sm focus:ring-2 focus:ring-red-500/30 ${isViewMode ? 'bg-gray-50' : ''}`}
                            >
                              <option value="agrupado">Un solo costo (agrupado): GPS + seguro todo riesgo</option>
                              <option value="separado">Por separado: GPS + seguro de responsabilidad civil</option>
                            </select>
                          </div>
                          {tipoCronograma !== 'nuevo' && modoAgr && srcConfigurationEditor}

                          <div className="order-1 flex flex-col h-full min-w-0 rounded-lg border border-gray-100 bg-gray-50/60 p-2.5 shadow-sm">
                            <div className="mb-2 min-h-0">
                              <label className="block text-[10px] font-medium text-gray-700 leading-tight">SOAT</label>
                              <p className="text-[10px] text-gray-400 leading-snug mt-0.5 line-clamp-2">
                                Monto total distribuido antes del vencimiento
                              </p>
                            </div>
                            <div className="mt-auto flex w-full min-w-0 rounded-lg border border-gray-200 bg-white shadow-sm">
                              <select
                                value={rg.soat.moneda}
                                onChange={(e) => patchVehiculoGasto(i, 'soat', { moneda: e.target.value as GastoRequisitoMoneda })}
                                disabled={isViewMode}
                                className="w-14 shrink-0 border-0 border-r border-gray-200 rounded-l-lg bg-gray-50 text-xs py-1.5"
                              >
                                <option value="PEN">PEN</option>
                                <option value="USD">USD</option>
                              </select>
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                value={rg.soat.monto}
                                onChange={(e) => patchVehiculoGasto(i, 'soat', { monto: Math.max(0, parseFloat(e.target.value) || 0) })}
                                readOnly={isViewMode}
                                className={`flex-1 min-w-0 px-2 py-1.5 text-xs border-0 rounded-r-lg${INPUT_NUMBER_CLASS} ${isViewMode ? 'bg-gray-50' : ''}`}
                              />
                            </div>
                            <div className="mt-2">
                              <label className="text-[10px] text-gray-500">
                                Meses antes (n.º de cobros)
                                <input
                                  type="number"
                                  min={1}
                                  max={12}
                                  value={rg.soat.cobro?.meses_anticipo || ''}
                                  onChange={(e) => patchVehiculoGastoCobro(i, 'soat', { meses_anticipo: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                                  readOnly={isViewMode}
                                  className={`mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs${INPUT_NUMBER_CLASS}`}
                                />
                              </label>
                            </div>
                          </div>

                          <div className="order-1 flex flex-col h-full min-w-0 rounded-lg border border-gray-100 bg-gray-50/60 p-2.5 shadow-sm">
                            <div className="mb-2 min-h-0">
                              <label className="block text-[10px] font-medium text-gray-700 leading-tight">Impuesto vehicular</label>
                              <p className="text-[10px] text-gray-400 leading-snug mt-0.5 line-clamp-2">
                                Monto anual dividido según el calendario configurado
                              </p>
                            </div>
                            <div className="mt-auto flex w-full min-w-0 rounded-lg border border-gray-200 bg-white shadow-sm">
                              <select
                                value={rg.impuesto_vehicular.moneda}
                                onChange={(e) => patchVehiculoGasto(i, 'impuesto_vehicular', { moneda: e.target.value as GastoRequisitoMoneda })}
                                disabled={isViewMode}
                                className="w-14 shrink-0 border-0 border-r border-gray-200 rounded-l-lg bg-gray-50 text-xs py-1.5"
                              >
                                <option value="PEN">PEN</option>
                                <option value="USD">USD</option>
                              </select>
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                value={rg.impuesto_vehicular.monto}
                                onChange={(e) =>
                                  patchVehiculoGasto(i, 'impuesto_vehicular', { monto: Math.max(0, parseFloat(e.target.value) || 0) })
                                }
                                readOnly={isViewMode}
                                className={`flex-1 min-w-0 px-2 py-1.5 text-xs border-0 rounded-r-lg${INPUT_NUMBER_CLASS} ${isViewMode ? 'bg-gray-50' : ''}`}
                              />
                            </div>
                            <div className="mt-2 grid grid-cols-3 gap-1.5">
                              <label className="text-[10px] text-gray-500">
                                Mes inicial
                                <select
                                  value={rg.impuesto_vehicular.cobro?.mes_inicio || ''}
                                  onChange={(event) => patchVehiculoGastoCobro(i, 'impuesto_vehicular', {
                                    mes_inicio: parseInt(event.target.value, 10) || 0,
                                  })}
                                  className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs"
                                >
                                  <option value="">Seleccionar</option>
                                  {MONTH_OPTIONS.map((month) => (
                                    <option key={month.value} value={month.value}>{month.label}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="text-[10px] text-gray-500">
                                Cuotas
                                <input
                                  type="number"
                                  min={1}
                                  max={12}
                                  value={rg.impuesto_vehicular.cobro?.cuotas || ''}
                                  onChange={(e) => patchVehiculoGastoCobro(i, 'impuesto_vehicular', { cuotas: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                                  readOnly={isViewMode}
                                  className={`mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs${INPUT_NUMBER_CLASS}`}
                                />
                              </label>
                              <label className="text-[10px] text-gray-500">
                                Años
                                <input
                                  type="number"
                                  min={1}
                                  max={10}
                                  value={rg.impuesto_vehicular.cobro?.anios_vigencia_tras_modelo || ''}
                                  onChange={(e) => patchVehiculoGastoCobro(i, 'impuesto_vehicular', { anios_vigencia_tras_modelo: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                                  readOnly={isViewMode}
                                  className={`mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs${INPUT_NUMBER_CLASS}`}
                                />
                              </label>
                            </div>
                          </div>

                          {!modoAgr && (
                            <>
                              <div className="order-3 flex flex-col h-full min-w-0 rounded-lg border border-gray-100 bg-gray-50/60 p-2.5 shadow-sm">
                                <div className="mb-2 min-h-0">
                                  <label className="block text-[10px] font-medium text-gray-700 leading-tight">GPS</label>
                                  <p className="text-[10px] text-gray-400 leading-snug mt-0.5 line-clamp-2">
                                    Mensual · fin de mes
                                  </p>
                                </div>
                              <div className="mt-auto flex w-full min-w-0 rounded-lg border border-gray-200 bg-white shadow-sm">
                                <select
                                  value={rg.gps.moneda}
                                    onChange={(e) => patchVehiculoGasto(i, 'gps', { moneda: e.target.value as GastoRequisitoMoneda })}
                                    disabled={isViewMode}
                                    className="w-14 shrink-0 border-0 border-r border-gray-200 rounded-l-lg bg-gray-50 text-xs py-1.5"
                                  >
                                    <option value="PEN">PEN</option>
                                    <option value="USD">USD</option>
                                  </select>
                                  <input
                                    type="number"
                                    min={0}
                                    step={0.01}
                                    value={rg.gps.monto}
                                    onChange={(e) => patchVehiculoGasto(i, 'gps', { monto: Math.max(0, parseFloat(e.target.value) || 0) })}
                                    readOnly={isViewMode}
                                    className={`flex-1 min-w-0 px-2 py-1.5 text-xs border-0 rounded-r-lg${INPUT_NUMBER_CLASS} ${isViewMode ? 'bg-gray-50' : ''}`}
                                  />
                                </div>
                              </div>
                              {srcConfigurationEditor}
                            </>
                          )}

                          {modoAgr && (
                            <div
                              className={`order-3 flex flex-col h-full min-w-0 rounded-lg border border-gray-100 bg-gray-50/60 p-2.5 shadow-sm ${tipoCronograma === 'nuevo' ? 'col-span-2' : ''}`}
                            >
                              <div className="mb-2 min-h-0">
                                <label className="block text-[10px] font-medium text-gray-700 leading-tight">
                                  Seguro todo riesgo + GPS (agrupado)
                                </label>
                                <p className="text-[10px] text-gray-400 leading-snug mt-0.5 line-clamp-2">
                                  {rg.todo_riesgo_mas_gps_agrupado.cobro?.semanas
                                    ? `Semanal en ${rg.todo_riesgo_mas_gps_agrupado.cobro.semanas} semanas`
                                    : 'Configura las semanas en el cronograma'}
                                </p>
                              </div>
                              <div className="mt-auto grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] items-end gap-2">
                                <label className="min-w-0 text-[10px] text-gray-500">
                                  Monto semanal
                                  <div className="mt-1 flex min-w-0 rounded-md border border-gray-200 bg-white shadow-sm">
                                    <select
                                      value={rg.todo_riesgo_mas_gps_agrupado.moneda}
                                      onChange={(e) =>
                                        patchVehiculoGasto(i, 'todo_riesgo_mas_gps_agrupado', {
                                          moneda: e.target.value as GastoRequisitoMoneda,
                                        })
                                      }
                                      disabled={isViewMode}
                                      className="w-14 shrink-0 rounded-l-md border-0 border-r border-gray-200 bg-gray-50 py-1.5 text-xs"
                                    >
                                      <option value="PEN">PEN</option>
                                      <option value="USD">USD</option>
                                    </select>
                                    <input
                                      type="number"
                                      min={0}
                                      step={0.01}
                                      value={rg.todo_riesgo_mas_gps_agrupado.monto}
                                      onChange={(e) =>
                                        patchVehiculoGasto(i, 'todo_riesgo_mas_gps_agrupado', {
                                          monto: Math.max(0, parseFloat(e.target.value) || 0),
                                        })
                                      }
                                      readOnly={isViewMode}
                                      className={`min-w-0 flex-1 rounded-r-md border-0 px-2 py-1.5 text-xs${INPUT_NUMBER_CLASS} ${isViewMode ? 'bg-gray-50' : ''}`}
                                    />
                                  </div>
                                </label>
                                <label className="min-w-0 text-[10px] text-gray-500">
                                  Semanas
                                  <input
                                    type="number"
                                    min={1}
                                    max={52}
                                    value={rg.todo_riesgo_mas_gps_agrupado.cobro?.semanas || ''}
                                    onChange={(e) => patchVehiculoGastoCobro(i, 'todo_riesgo_mas_gps_agrupado', { semanas: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                                    readOnly={isViewMode}
                                    className={`mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs${INPUT_NUMBER_CLASS}`}
                                  />
                                </label>
                              </div>
                            </div>
                          )}

                          <div className={`order-2 min-w-0 rounded-lg border border-gray-100 bg-gray-50/60 p-3 shadow-sm ${tipoCronograma === 'nuevo' && modoAgr ? 'col-span-2' : ''}`}>
                            <div className="mb-2 min-w-0">
                              <label className="block text-[10px] font-medium leading-tight text-gray-700">Inicial parcial</label>
                              <p className="mt-0.5 text-[10px] leading-snug text-gray-400">
                                Solo para contratos con pago inicial parcial
                              </p>
                            </div>
                            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] items-end gap-2">
                              <label className="min-w-0 text-[10px] text-gray-500">
                                Monto semanal
                                <div className="mt-1 flex min-w-0 rounded-md border border-gray-200 bg-white shadow-sm">
                                  <select
                                    value={rg.inicial_parcial.moneda}
                                    onChange={(event) => patchVehiculoGasto(i, 'inicial_parcial', { moneda: event.target.value as GastoRequisitoMoneda })}
                                    disabled={isViewMode}
                                    className="w-14 shrink-0 rounded-l-md border-0 border-r border-gray-200 bg-gray-50 py-1.5 text-xs"
                                  >
                                    <option value="USD">USD</option>
                                    <option value="PEN">PEN</option>
                                  </select>
                                  <input
                                    type="number"
                                    min={0}
                                    step={0.01}
                                    value={rg.inicial_parcial.monto}
                                    onChange={(event) => patchVehiculoGasto(i, 'inicial_parcial', { monto: Math.max(0, parseFloat(event.target.value) || 0) })}
                                    readOnly={isViewMode}
                                    className={`min-w-0 flex-1 rounded-r-md border-0 px-2 py-1.5 text-xs${INPUT_NUMBER_CLASS} ${isViewMode ? 'bg-gray-50' : ''}`}
                                  />
                                </div>
                              </label>
                              <label className="min-w-0 text-[10px] text-gray-500">
                                Semanas
                                <input
                                  type="number"
                                  min={1}
                                  max={52}
                                  value={rg.inicial_parcial.cobro?.semanas || ''}
                                  onChange={(event) => patchVehiculoGastoCobro(i, 'inicial_parcial', { semanas: Math.max(0, parseInt(event.target.value, 10) || 0) })}
                                  readOnly={isViewMode}
                                  className={`mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs${INPUT_NUMBER_CLASS}`}
                                />
                              </label>
                            </div>
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
                    );
                  })}
                    </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sección: Filas del cronograma (acordeón, mismo patrón que Parámetros y Carros) */}
              <div className={`${modalActiveTab === 'rules' ? 'block' : 'hidden'} overflow-hidden rounded-lg border border-gray-200`}>
                <button
                  type="button"
                  onClick={() => toggleModalSection('filas')}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
                >
                  <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
                    <ListOrdered className="w-4 h-4 text-gray-500" />
                    Filas del cronograma
                    {form.rules.length > 0 && (
                      <span className="text-xs font-normal text-gray-500">({form.rules.length})</span>
                    )}
                  </span>
                  {modalSectionsOpen.filas ? (
                    <ChevronDown className="w-5 h-5 text-gray-500 transition-transform duration-200" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-500 transition-transform duration-200" />
                  )}
                </button>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                  style={{ gridTemplateRows: modalSectionsOpen.filas ? '1fr' : '0fr' }}
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
                      <table className="w-full text-sm table-fixed" style={{ minWidth: 520 }}>
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
                                        title="Moneda cuota semanal (según esta regla del cronograma)"
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
            <div className="flex items-center justify-between gap-2 border-t border-gray-200 bg-white px-3 py-3 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.06)] sm:px-5">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <button
                  type="button"
                  onClick={() => selectModalTab(MODAL_TABS[activeModalTabIndex - 1].id)}
                  disabled={activeModalTabIndex <= 0}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-300 px-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:invisible sm:px-3"
                  title="Sección anterior"
                >
                  <ChevronLeft className="h-4 w-4" /><span className="hidden sm:inline">Anterior</span>
                </button>
                <button
                  type="button"
                  onClick={() => selectModalTab(MODAL_TABS[activeModalTabIndex + 1].id)}
                  disabled={activeModalTabIndex >= MODAL_TABS.length - 1}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-300 px-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:invisible sm:px-3"
                  title="Sección siguiente"
                >
                  <span className="hidden sm:inline">Siguiente</span><ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <div className="flex min-w-0 justify-end gap-1.5 sm:gap-2">
                <button type="button" onClick={closeModal} className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:px-4">
                  {isViewMode ? 'Cerrar' : 'Cancelar'}
                </button>
                {!isViewMode && (
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={!form.name.trim() || saving}
                    className="h-9 whitespace-nowrap rounded-md bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 sm:px-4"
                  >
                    {saving ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear cronograma'}
                  </button>
                )}
              </div>
            </div>
            </div>
          </div>
        ),
        document.body
      )}
    </div>
  );
}
