import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  PlusCircle,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  TableProperties,
  Trash2,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import {
  fetchMimotoCronogramas,
  mimotoApiErrorMessage,
  type MimotoCronograma,
  type MimotoCoverage,
  type MimotoCoverageKey,
  type MimotoVehicleCoverages,
} from './mimotoApi';
import {
  buildMimotoCronogramaPayload,
  createEmptyMimotoCronogramaForm,
  createMimotoRuleForm,
  createMimotoVehicleForm,
  mimotoVehicleSummary,
  toMimotoCronogramaForm,
  validateMimotoCronogramaForm,
  type MimotoCronogramaForm,
  type MimotoVehicleForm,
} from './mimotoCronogramaForm';
import { MIMOTO_FIELD_CLASS } from './MimotoMoneyField';
import MimotoRulesMatrix from './MimotoRulesMatrix';
import MimotoVehicleCoverageCard from './MimotoVehicleCoverageCard';

type ModalTab = 'general' | 'vehicles' | 'rules';

const MODAL_TABS: Array<{ id: ModalTab; label: string; icon: typeof ClipboardList }> = [
  { id: 'general', label: 'General', icon: ClipboardList },
  { id: 'vehicles', label: 'Motos y coberturas', icon: ShieldCheck },
  { id: 'rules', label: 'Reglas de cuotas', icon: TableProperties },
];

export default function YegoMiMotoConfig() {
  const [cronogramas, setCronogramas] = useState<MimotoCronograma[]>([]);
  const [exchangeRate, setExchangeRate] = useState('');
  const [search, setSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MimotoCronograma | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewOnly, setViewOnly] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ModalTab>('general');
  const [parametersOpen, setParametersOpen] = useState(true);
  const [form, setForm] = useState<MimotoCronogramaForm>(createEmptyMimotoCronogramaForm);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cronRows, rateResponse] = await Promise.all([
        fetchMimotoCronogramas(true),
        api.get('/mimoto/tipo-cambio'),
      ]);
      setCronogramas(cronRows);
      setExchangeRate(String(rateResponse.data?.data?.valor_usd_a_local ?? ''));
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo cargar la configuración Mi Moto'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('es');
    if (!query) return cronogramas;
    return cronogramas.filter((cronograma) =>
      cronograma.name.toLocaleLowerCase('es').includes(query)
      || cronograma.vehiculos.some((vehicle) => vehicle.name.toLocaleLowerCase('es').includes(query)));
  }, [cronogramas, search]);

  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginated = useMemo(() => {
    const page = Math.min(currentPage, totalPages);
    return filtered.slice((page - 1) * pageSize, page * pageSize);
  }, [currentPage, filtered, totalPages]);

  useEffect(() => setCurrentPage((page) => Math.min(page, totalPages)), [totalPages]);

  const saveRate = async () => {
    const value = Number(exchangeRate);
    if (!Number.isFinite(value) || value <= 0) return toast.error('Ingresa un tipo de cambio válido');
    try {
      await api.put('/mimoto/tipo-cambio', { valor_usd_a_local: value });
      toast.success('Tipo de cambio actualizado');
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo actualizar el tipo de cambio'));
    }
  };

  const toggleActive = async (cronograma: MimotoCronograma) => {
    try {
      const response = await api.patch(`/mimoto/cronogramas/${cronograma.id}/toggle-active`);
      const updated = response.data?.data;
      setCronogramas((current) => current.map((item) =>
        item.id === cronograma.id ? { ...item, active: Boolean(updated?.active) } : item));
      toast.success(updated?.active ? 'Cronograma activado' : 'Cronograma desactivado');
      return true;
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo cambiar el estado'));
      return false;
    }
  };

  const openCreate = () => {
    setForm(createEmptyMimotoCronogramaForm());
    setEditingId(null);
    setViewOnly(false);
    setActiveTab('general');
    setParametersOpen(true);
    setModalOpen(true);
  };

  const openDetail = (cronograma: MimotoCronograma) => {
    setForm(toMimotoCronogramaForm(cronograma));
    setEditingId(cronograma.id);
    setViewOnly(true);
    setActiveTab('general');
    setParametersOpen(true);
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving || deleting) return;
    setModalOpen(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || Number(deleteTarget.solicitudes_count || 0) > 0) return;
    setDeleting(true);
    try {
      await api.delete(`/mimoto/cronogramas/${deleteTarget.id}`);
      setCronogramas((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      setModalOpen(false);
      toast.success('Cronograma eliminado');
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo eliminar el cronograma'));
    } finally {
      setDeleting(false);
    }
  };

  const deactivateLinkedCronograma = async () => {
    if (!deleteTarget || !deleteTarget.active) {
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    const changed = await toggleActive(deleteTarget);
    setDeleting(false);
    if (changed) setDeleteTarget(null);
  };

  const updateVehicle = (id: string, field: keyof MimotoVehicleForm, value: string) => {
    setForm((current) => ({
      ...current,
      vehicles: current.vehicles.map((vehicle) => vehicle.id === id ? { ...vehicle, [field]: value } : vehicle),
    }));
  };

  const updateCoverageMode = (vehicleId: string, mode: MimotoVehicleCoverages['mode']) => {
    setForm((current) => ({
      ...current,
      vehicles: current.vehicles.map((vehicle) => vehicle.id === vehicleId
        ? { ...vehicle, coverages: { ...vehicle.coverages, mode } }
        : vehicle),
    }));
  };

  const updateCoverage = (
    vehicleId: string,
    key: MimotoCoverageKey,
    patch: Partial<MimotoCoverage>,
  ) => {
    setForm((current) => ({
      ...current,
      vehicles: current.vehicles.map((vehicle) => vehicle.id === vehicleId
        ? {
          ...vehicle,
          coverages: {
            ...vehicle.coverages,
            [key]: { ...vehicle.coverages[key], ...patch },
          },
        }
        : vehicle),
    }));
  };

  const addVehicle = () => {
    setForm((current) => {
      const vehicle = createMimotoVehicleForm(current.vehicles.length);
      return {
        ...current,
        vehicles: [...current.vehicles, vehicle],
        rules: current.rules.map((rule) => ({ ...rule, amounts: { ...rule.amounts, [vehicle.id]: '' } })),
      };
    });
  };

  const removeVehicle = (id: string) => {
    setForm((current) => ({
      ...current,
      vehicles: current.vehicles.filter((vehicle) => vehicle.id !== id),
      rules: current.rules.map((rule) => {
        const amounts = { ...rule.amounts };
        delete amounts[id];
        return { ...rule, amounts };
      }),
    }));
  };

  const addRule = () => {
    setForm((current) => ({
      ...current,
      rules: [...current.rules, createMimotoRuleForm(current.rules.length, '', current.vehicles.map((vehicle) => vehicle.id))],
    }));
  };

  const removeRule = (id: string) => {
    setForm((current) => ({ ...current, rules: current.rules.filter((rule) => rule.id !== id) }));
  };

  const updateRuleTrips = (id: string, viajes: string) => {
    setForm((current) => ({
      ...current,
      rules: current.rules.map((rule) => rule.id === id ? { ...rule, viajes } : rule),
    }));
  };

  const updateRuleHours = (id: string, minHours: string) => {
    setForm((current) => ({
      ...current,
      rules: current.rules.map((rule) => rule.id === id ? { ...rule, minHours } : rule),
    }));
  };

  const updateRuleAmount = (ruleId: string, vehicleId: string, value: string) => {
    setForm((current) => ({
      ...current,
      rules: current.rules.map((rule) => rule.id === ruleId
        ? { ...rule, amounts: { ...rule.amounts, [vehicleId]: value } }
        : rule),
    }));
  };

  const setVehicleImage = (id: string, file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error('Selecciona una imagen válida');
    if (file.size > 2 * 1024 * 1024) return toast.error('La imagen no puede superar 2 MB');
    const reader = new FileReader();
    reader.onload = () => updateVehicle(id, 'image', String(reader.result || ''));
    reader.onerror = () => toast.error('No se pudo leer la imagen');
    reader.readAsDataURL(file);
  };

  const saveCronograma = async () => {
    const validationError = validateMimotoCronogramaForm(form);
    if (validationError) return toast.error(validationError);
    const existing = cronogramas.find((item) => item.id === editingId);
    const payload = buildMimotoCronogramaPayload(form, existing);
    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/mimoto/cronogramas/${editingId}`, payload);
        toast.success('Cronograma actualizado');
      } else {
        await api.post('/mimoto/cronogramas', payload);
        toast.success('Cronograma creado');
      }
      setModalOpen(false);
      await load();
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo guardar el cronograma'));
    } finally {
      setSaving(false);
    }
  };

  const activeTabIndex = MODAL_TABS.findIndex((tab) => tab.id === activeTab);

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="rounded-lg bg-[#8B1A1A] p-4 lg:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#6B1515]">
              <SettingsIcon className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight text-white lg:text-xl">Cronogramas Mi Moto</h1>
              <p className="mt-0.5 text-xs text-white/90 lg:text-sm">Planes, motos, coberturas y reglas de cuotas para Colombia</p>
            </div>
          </div>
          <button type="button" onClick={openCreate} className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/20 px-4 py-2.5 font-medium text-white transition-colors hover:bg-white/30">
            <PlusCircle className="h-5 w-5" /> Crear cronograma
          </button>
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-base font-semibold text-gray-900">Valor del dólar (tipo de cambio)</h2>
        </div>
        <div className="p-4 sm:p-6">
          <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4">
            <label className="mb-2 block text-sm font-medium text-gray-700">Colombia (CO)</label>
            <p className="mb-1 text-xs text-gray-500">1 USD =</p>
            <div className="flex flex-wrap items-center gap-2">
              <input type="number" min="0" step="1" value={exchangeRate} onChange={(event) => setExchangeRate(event.target.value)} className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="4100" />
              <span className="text-sm font-medium text-gray-600">COP</span>
              <button type="button" onClick={() => void saveRate()} className="rounded-lg bg-[#8B1A1A] px-4 py-2 text-sm font-medium text-white hover:bg-[#6B1515]">Guardar</button>
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-500">Se usa para convertir pagos y cuotas configuradas en USD a pesos colombianos.</p>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
        <div className="p-4 sm:p-6">
          {loading ? (
            <div className="flex justify-center py-12"><div className="h-10 w-10 animate-spin rounded-full border-2 border-red-600 border-t-transparent" /></div>
          ) : cronogramas.length === 0 ? (
            <div className="py-8 text-center"><h3 className="mb-2 text-lg font-semibold text-gray-800">No hay cronogramas</h3><p className="text-gray-500">Crea el primer cronograma para definir motos y bonos por viajes.</p></div>
          ) : (
            <>
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="order-2 text-sm text-gray-500 sm:order-1">{filtered.length === 0 ? 'Sin resultados' : `${filtered.length} cronograma(s)`}</p>
                <div className="relative order-1 w-full sm:order-2 sm:w-auto sm:min-w-[240px] sm:max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nombre o moto..." className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-red-500 focus:ring-2 focus:ring-red-500" />
                </div>
              </div>
              {filtered.length === 0 ? (
                <p className="py-8 text-center text-gray-500">No hay cronogramas que coincidan con la búsqueda.</p>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {paginated.map((cronograma) => (
                      <article key={cronograma.id} role="button" tabIndex={0} onClick={() => openDetail(cronograma)} onKeyDown={(event) => event.key === 'Enter' && openDetail(cronograma)} className="flex max-w-sm cursor-pointer flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition-all duration-200 hover:border-gray-300 hover:shadow-md">
                        <header className="flex items-start justify-between gap-2 border-b border-gray-100 p-4">
                          <h3 className="min-w-0 flex-1 text-base font-bold uppercase leading-tight text-gray-900">{cronograma.name}</h3>
                          <span className="shrink-0 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">CO</span>
                        </header>
                        <div className="flex-1 p-4">
                          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
                            <dt className="font-medium text-gray-500">Estado</dt>
                            <dd><button type="button" role="switch" aria-checked={cronograma.active} title={cronograma.active ? 'Desactivar cronograma' : 'Activar cronograma'} onClick={(event) => { event.stopPropagation(); void toggleActive(cronograma); }} className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors ${cronograma.active ? 'bg-green-500' : 'bg-gray-200'}`}><span className={`pointer-events-none absolute left-0.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition-transform ${cronograma.active ? 'translate-x-4' : 'translate-x-0'}`} /></button></dd>
                            <dt className="font-medium text-gray-500">Motos</dt><dd className="text-xs font-medium leading-snug text-gray-800">{mimotoVehicleSummary(cronograma.vehiculos)}</dd>
                          </dl>
                        </div>
                        <footer className="border-t border-gray-100 p-3 pt-0"><button type="button" onClick={(event) => { event.stopPropagation(); openDetail(cronograma); }} className="w-full rounded-lg border border-red-200 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50">Ver detalle</button></footer>
                      </article>
                    ))}
                  </div>
                  {totalPages > 1 && (
                    <div className="mt-6 flex items-center justify-between gap-4 border-t border-gray-200 pt-4">
                      <p className="text-sm text-gray-600">Página {currentPage} de {totalPages}</p>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage <= 1} className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"><ChevronLeft className="h-4 w-4" />Anterior</button>
                        <button type="button" onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} disabled={currentPage >= totalPages} className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">Siguiente<ChevronRight className="h-4 w-4" /></button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </section>

      {modalOpen && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={editingId ? 'Cronograma Mi Moto' : 'Crear cronograma'}>
          <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
            <header className="flex shrink-0 items-center justify-between gap-4 border-b border-gray-200 bg-white px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-bold text-gray-900">{viewOnly ? form.name || 'Detalle del cronograma' : editingId ? 'Editar cronograma' : 'Crear cronograma'}</h2>
                <p className="mt-0.5 text-xs text-gray-500">{viewOnly ? 'Configuración vigente del plan' : 'Define el plan, sus motos y reglas de cuotas'}</p>
              </div>
              <div className="flex items-center gap-2">
                {viewOnly ? (
                  <>
                    {editingId && (
                      <button
                        type="button"
                        onClick={() => {
                          const current = cronogramas.find((item) => item.id === editingId);
                          if (current) setDeleteTarget(current);
                        }}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-600 transition-colors hover:bg-red-50"
                        aria-label="Eliminar cronograma"
                        title="Eliminar cronograma"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                    <button type="button" onClick={() => setViewOnly(false)} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700">Editar</button>
                  </>
                ) : editingId ? (
                  <button type="button" onClick={() => { const current = cronogramas.find((item) => item.id === editingId); if (current) setForm(toMimotoCronogramaForm(current)); setViewOnly(true); }} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">Ver detalle</button>
                ) : null}
                <button type="button" onClick={closeModal} className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700" aria-label="Cerrar"><X className="h-5 w-5" /></button>
              </div>
            </header>

            <nav className="shrink-0 border-b border-gray-200 bg-gray-50 px-4" aria-label="Secciones del cronograma">
              <div className="flex gap-1 overflow-x-auto py-2" role="tablist">
                {MODAL_TABS.map((tab) => {
                  const Icon = tab.icon;
                  const active = activeTab === tab.id;
                  const count = tab.id === 'vehicles' ? String(form.vehicles.length) : tab.id === 'rules' ? String(form.rules.length) : null;
                  return <button key={tab.id} type="button" role="tab" aria-selected={active} onClick={() => setActiveTab(tab.id)} className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${active ? 'bg-white text-[#8B1A1A] shadow-sm ring-1 ring-gray-200' : 'text-gray-600 hover:bg-white/70 hover:text-gray-900'}`}><Icon className="h-4 w-4" />{tab.label}{count && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] tabular-nums text-gray-600">{count}</span>}</button>;
                })}
              </div>
            </nav>

            <div className="overflow-y-auto p-4 sm:p-5">
              {activeTab === 'general' && (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-12 lg:items-end lg:gap-x-4">
                    <label className="text-sm font-medium text-gray-700 lg:col-span-9">Nombre del cronograma *<input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value.toUpperCase() }))} disabled={viewOnly} className={`${MIMOTO_FIELD_CLASS} mt-1.5`} placeholder="Ej. PLAN 78 SEMANAS" /></label>
                    <label className="text-sm font-medium text-gray-700 lg:col-span-3">País<input value="Colombia (CO)" disabled className={`${MIMOTO_FIELD_CLASS} mt-1.5`} /></label>
                  </div>
                  <div className="overflow-hidden rounded-xl border border-gray-200">
                    <button type="button" onClick={() => setParametersOpen((open) => !open)} className="flex w-full items-center justify-between bg-gray-50 px-4 py-3 text-left transition-colors hover:bg-gray-100" aria-expanded={parametersOpen}>
                      <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-gray-700"><SlidersHorizontal className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />Parámetros del cronograma</span>
                      {parametersOpen ? <ChevronDown className="h-5 w-5 shrink-0 text-gray-500" /> : <ChevronRight className="h-5 w-5 shrink-0 text-gray-500" />}
                    </button>
                    <div className="grid transition-[grid-template-rows] duration-300 ease-in-out" style={{ gridTemplateRows: parametersOpen ? '1fr' : '0fr' }}>
                      <div className="min-h-0 overflow-hidden">
                        <div className="border-t border-gray-100 bg-gray-50/50 p-4 pt-2 sm:p-5 sm:pt-2">
                          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3 lg:gap-4 lg:divide-x lg:divide-gray-200">
                            <div className="min-w-0 space-y-2 lg:pr-4">
                              <h4 className="text-sm font-medium leading-tight text-gray-900">Interés por mora</h4>
                              <p className="text-[11px] leading-snug text-gray-500" title="Si no paga la cuota el lunes, interés por día de atraso">Cuota semanal (lunes). Interés/día = (cuota × tasa) ÷ 7</p>
                              <label htmlFor="mimoto-tasa-interes-mora" className="block w-fit text-xs text-gray-600">Tasa (%)<input id="mimoto-tasa-interes-mora" type="number" min="0" max="100" step="0.5" value={form.moraRate} onChange={(event) => setForm((current) => ({ ...current, moraRate: event.target.value }))} disabled={viewOnly} className="mt-1 h-9 w-[5.5rem] rounded-lg border border-gray-300 bg-white px-2 text-sm text-gray-900 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-100 disabled:cursor-default disabled:bg-gray-50" /></label>
                            </div>
                            <div className="min-w-0 space-y-2 border-t border-gray-200 pt-2 lg:border-t-0 lg:px-4 lg:pt-0">
                              <h4 className="text-sm font-medium leading-tight text-gray-900">Bono a tiempo</h4>
                              <p className="text-[11px] leading-snug text-gray-500">Activa el beneficio definido para pagos consecutivos realizados dentro del plazo.</p>
                              <label className="inline-flex cursor-pointer select-none items-start gap-2.5"><input type="checkbox" checked={form.bonusTime} onChange={(event) => setForm((current) => ({ ...current, bonusTime: event.target.checked }))} disabled={viewOnly} className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-red-600 focus:ring-red-500" /><span className="text-sm text-gray-800">Activar bono tiempo</span></label>
                            </div>
                            <div className="min-w-0 space-y-2 border-t border-gray-200 pt-2 lg:border-t-0 lg:pl-4 lg:pt-0">
                              <h4 className="text-sm font-medium leading-tight text-gray-900">Estado del plan</h4>
                              <p className="text-[11px] leading-snug text-gray-500">Solo los cronogramas activos pueden asignarse a nuevas solicitudes.</p>
                              <label className="inline-flex cursor-pointer select-none items-center gap-2.5"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} disabled={viewOnly} className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500" /><span className={`text-sm font-medium ${form.active ? 'text-green-700' : 'text-gray-600'}`}>{form.active ? 'Activo' : 'Inactivo'}</span></label>
                            </div>
                          </div>
                          <div className="mt-4 border-t border-gray-200 pt-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <div className="min-w-0"><h4 className="text-sm font-medium leading-tight text-gray-900">Modalidad de pago inicial</h4><p className="mt-1 text-[11px] leading-snug text-gray-500">Nueva Solicitud mostrará únicamente las modalidades habilitadas aquí.</p></div>
                              <div className="flex flex-wrap items-center gap-4">
                                <label className="inline-flex cursor-pointer select-none items-center gap-2.5"><input type="checkbox" checked={form.initialComplete} onChange={(event) => setForm((current) => ({ ...current, initialComplete: event.target.checked }))} disabled={viewOnly} className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500" /><span className="text-sm text-gray-800">Inicial completa</span></label>
                                <label className="inline-flex cursor-pointer select-none items-center gap-2.5"><input type="checkbox" checked={form.initialPartial} onChange={(event) => setForm((current) => ({ ...current, initialPartial: event.target.checked }))} disabled={viewOnly} className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500" /><span className="text-sm text-gray-800">Inicial parcial</span></label>
                              </div>
                            </div>
                          </div>
                          <div className="mt-4 border-t border-gray-200 pt-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <div className="min-w-0"><h4 className="text-sm font-medium leading-tight text-gray-900">Criterio para calcular la cuota</h4><p className="mt-1 text-[11px] leading-snug text-gray-500">Define si el conductor debe cumplir solo viajes o viajes y horas conectadas.</p></div>
                              <div className="inline-flex w-full rounded-lg border border-gray-300 bg-white p-1 sm:w-auto" role="group" aria-label="Criterio de evaluación">
                                {([
                                  ['viajes', 'Solo viajes'],
                                  ['viajes_horas', 'Viajes + horas'],
                                ] as const).map(([value, label]) => (
                                  <button key={value} type="button" onClick={() => setForm((current) => ({ ...current, ruleMode: value }))} disabled={viewOnly} className={`h-8 flex-1 rounded-md px-3 text-xs font-semibold transition-colors sm:flex-none ${form.ruleMode === value ? 'bg-[#8B1A1A] text-white' : 'text-gray-600 hover:bg-gray-100'} disabled:cursor-default`}>{label}</button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'vehicles' && (
                <div className="space-y-4">
                  <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <h3 className="flex items-center gap-2 font-semibold text-gray-900"><ShieldCheck className="h-4 w-4 text-gray-500" />Motos y coberturas <span className="text-xs font-normal text-gray-500">({form.vehicles.length})</span></h3>
                      <p className="mt-0.5 text-xs text-gray-500">Datos de cada moto y conceptos que generará el contrato</p>
                    </div>
                    {!viewOnly && <button type="button" onClick={addVehicle} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#8B1A1A] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#6B1515]"><PlusCircle className="h-4 w-4" />Añadir moto</button>}
                  </div>
                  <div className="grid gap-4 xl:grid-cols-2">
                    {form.vehicles.map((vehicle, index) => (
                      <MimotoVehicleCoverageCard
                        key={vehicle.id}
                        vehicle={vehicle}
                        index={index}
                        viewOnly={viewOnly}
                        canRemove={form.vehicles.length > 1}
                        onUpdate={(field, value) => updateVehicle(vehicle.id, field, value)}
                        onRemove={() => removeVehicle(vehicle.id)}
                        onImage={(file) => setVehicleImage(vehicle.id, file)}
                        onCoverageMode={(mode) => updateCoverageMode(vehicle.id, mode)}
                        onCoverage={(key, patch) => updateCoverage(vehicle.id, key, patch)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'rules' && (
                <MimotoRulesMatrix
                  rules={form.rules}
                  vehicles={form.vehicles}
                  evaluationMode={form.ruleMode}
                  viewOnly={viewOnly}
                  onAdd={addRule}
                  onRemove={removeRule}
                  onTrips={updateRuleTrips}
                  onHours={updateRuleHours}
                  onAmount={updateRuleAmount}
                />
              )}
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-gray-200 bg-white px-3 py-3 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.06)] sm:px-5">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <button type="button" onClick={() => setActiveTab(MODAL_TABS[activeTabIndex - 1].id)} disabled={activeTabIndex <= 0} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-300 px-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:invisible sm:px-3"><ChevronLeft className="h-4 w-4" /><span className="hidden sm:inline">Anterior</span></button>
                <button type="button" onClick={() => setActiveTab(MODAL_TABS[activeTabIndex + 1].id)} disabled={activeTabIndex >= MODAL_TABS.length - 1} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-300 px-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:invisible sm:px-3"><span className="hidden sm:inline">Siguiente</span><ChevronRight className="h-4 w-4" /></button>
              </div>
              <div className="flex min-w-0 justify-end gap-1.5 sm:gap-2">
                <button type="button" onClick={closeModal} className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:px-4">{viewOnly ? 'Cerrar' : 'Cancelar'}</button>
                {!viewOnly && <button type="button" onClick={() => void saveCronograma()} disabled={saving} className="h-9 whitespace-nowrap rounded-md bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 sm:px-4">{saving ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear cronograma'}</button>}
              </div>
            </footer>
          </div>
        </div>,
        document.body
      )}

      {deleteTarget && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="delete-mimoto-cronograma-title">
          <div className="w-full max-w-md overflow-hidden rounded-lg bg-white shadow-xl">
            <header className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
              <div>
                <h2 id="delete-mimoto-cronograma-title" className="text-base font-bold text-gray-900">
                  {Number(deleteTarget.solicitudes_count || 0) > 0 ? 'Cronograma en uso' : 'Eliminar cronograma'}
                </h2>
                <p className="mt-1 text-sm text-gray-500">{deleteTarget.name}</p>
              </div>
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={deleting} className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-50" aria-label="Cerrar"><X className="h-5 w-5" /></button>
            </header>
            <div className="px-5 py-4 text-sm leading-6 text-gray-600">
              {Number(deleteTarget.solicitudes_count || 0) > 0
                ? `No puede eliminarse porque está vinculado a ${deleteTarget.solicitudes_count} solicitud(es). Puedes desactivarlo para impedir nuevas asignaciones sin perder el historial.`
                : 'Esta acción retirará el cronograma y sus motos de las opciones disponibles. No podrá recuperarse desde la interfaz.'}
            </div>
            <footer className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={deleting} className="h-9 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">Cancelar</button>
              {Number(deleteTarget.solicitudes_count || 0) > 0 ? (
                deleteTarget.active && <button type="button" onClick={() => void deactivateLinkedCronograma()} disabled={deleting} className="h-9 rounded-md bg-gray-800 px-4 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50">{deleting ? 'Desactivando...' : 'Desactivar'}</button>
              ) : (
                <button type="button" onClick={() => void confirmDelete()} disabled={deleting} className="inline-flex h-9 items-center gap-2 rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"><Trash2 className="h-4 w-4" />{deleting ? 'Eliminando...' : 'Eliminar'}</button>
              )}
            </footer>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
