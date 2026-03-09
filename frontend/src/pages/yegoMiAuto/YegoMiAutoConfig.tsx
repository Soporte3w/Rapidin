import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { PlusCircle, Trash2, X, Settings as SettingsIcon, Car, ImagePlus, ChevronDown, ChevronRight, ChevronLeft, ListOrdered, Search } from 'lucide-react';

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

/** Fila del cronograma: viajes, bono auto (con moneda), y cuota semanal por cada carro */
export interface CronogramaRule {
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

export default function YegoMiAutoConfig() {
  const [cronogramas, setCronogramas] = useState<Cronograma[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<Cronograma, 'id'>>({
    name: '',
    country: 'PE',
    active: true,
    vehicles: [{ ...createEmptyVehicle() }],
    rules: [],
  });
  const [modalSectionOpen, setModalSectionOpen] = useState<'carros' | 'filas' | null>(null);
  const [isModalEntering, setIsModalEntering] = useState(false);
  const [isModalClosing, setIsModalClosing] = useState(false);
  const [searchName, setSearchName] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

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
    setForm({
      name: '',
      country: 'PE',
      active: true,
      vehicles: [createEmptyVehicle()],
      rules: [createEmptyRule(1)],
    });
    setModalOpen(true);
  };

  const openEdit = (c: Cronograma) => {
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
    setForm({ name: c.name, country: c.country, active: c.active, vehicles, rules });
    setModalOpen(true);
  };

  const finishCloseModal = () => {
    setModalOpen(false);
    setEditingId(null);
    setModalSectionOpen(null);
    setIsModalClosing(false);
  };

  const closeModal = () => {
    if (isModalClosing) return;
    setIsModalClosing(true);
  };

  const toggleSection = (section: 'carros' | 'filas') => {
    setModalSectionOpen((prev) => (prev === section ? null : section));
  };

  const handleSave = () => {
    if (!form.name.trim()) return;
    if (editingId) {
      setCronogramas((prev) => prev.map((c) => (c.id === editingId ? { ...form, id: c.id } : c)));
    } else {
      setCronogramas((prev) => [...prev, { ...form, id: generateId() }]);
    }
    closeModal();
  };

  const toggleCronogramaActive = (id: string) => {
    setCronogramas((prev) => prev.map((c) => (c.id === id ? { ...c, active: !c.active } : c)));
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
        <div className="p-4 sm:p-6">
          {cronogramas.length === 0 ? (
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
              <h2 className="text-xl font-bold text-gray-900">{editingId ? 'Editar cronograma' : 'Incluir cronograma'}</h2>
              <button type="button" onClick={closeModal} className="p-2 text-gray-500 hover:bg-gray-200 hover:text-gray-700 rounded-lg transition-colors" aria-label="Cerrar">
                <X className="w-5 h-5" />
              </button>
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
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
                    placeholder="Ej. Cronograma 2025 - II"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">País</label>
                  <select
                    value={form.country}
                    onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
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
                  className="rounded border-gray-300 text-red-600 focus:ring-red-500 w-4 h-4"
                />
                <label htmlFor="active" className="text-sm font-medium text-gray-700">Activo</label>
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
                      <button
                        type="button"
                        onClick={addVehicle}
                        className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors shadow-sm"
                      >
                        <Car className="w-4 h-4" />
                        Añadir carro
                      </button>
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
                            <button
                              type="button"
                              onClick={() => updateVehicle(i, 'image', undefined)}
                              className="absolute top-1 right-1 w-7 h-7 bg-white/95 backdrop-blur-sm border border-gray-200 text-gray-500 rounded-lg flex items-center justify-center shadow-sm hover:bg-red-50 hover:border-red-200 hover:text-red-600 transition-colors z-10"
                              title="Quitar foto"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
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
                        )}
                        {v.image && (
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
                            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 transition-shadow"
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
                                className="w-12 pl-2 pr-1 py-2 text-sm font-medium border-0 border-r border-gray-200 rounded-l-lg bg-transparent focus:ring-0 cursor-pointer text-gray-700"
                                title="Moneda"
                              >
                                <option value="USD">$</option>
                                <option value="PEN">S/.</option>
                              </select>
                              <input
                                type="number"
                                min={0}
                                step={v.inicial_moneda === 'PEN' ? 0.01 : 1}
                                value={v.inicial || ''}
                                onChange={(e) => updateVehicle(i, 'inicial', Number(e.target.value) || 0)}
                                onWheel={(e) => e.currentTarget.blur()}
                                className={`flex-1 min-w-0 px-3 py-2 text-sm bg-transparent border-0 rounded-r-lg focus:ring-0 focus:outline-none placeholder-gray-400${INPUT_NUMBER_CLASS}`}
                                placeholder={v.inicial_moneda === 'USD' ? '1000' : '3500'}
                              />
                            </div>
                          </div>
                          <div className="min-w-0">
                            <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Cuotas</label>
                            <input
                              type="number"
                              min={1}
                              value={v.cuotas_semanales != null && v.cuotas_semanales !== 0 ? v.cuotas_semanales : ''}
                              onChange={(e) => updateVehicle(i, 'cuotas_semanales', Number(e.target.value) || 0)}
                              onWheel={(e) => e.currentTarget.blur()}
                              className={`w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 transition-shadow${INPUT_NUMBER_CLASS}`}
                              placeholder="264"
                            />
                          </div>
                        </div>
                      </div>
                      {form.vehicles.length > 1 && (
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
                      <p className="text-xs text-gray-500">Tramos de viajes, bono mi auto ($ o S/.) y cuota semanal por cada carro.</p>
                      <button type="button" onClick={addRule} className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700">
                        + Añadir fila
                      </button>
                    </div>
                    <div className="border border-gray-200 rounded-xl overflow-hidden overflow-x-auto bg-white">
                      <table className="w-full text-sm" style={{ minWidth: 360 }}>
                        <thead>
                          <tr className="bg-gray-100 border-b border-gray-200">
                            <th className="text-left py-2.5 px-2 font-semibold text-gray-700 w-36">Viajes</th>
                            <th className="text-left py-2.5 px-2 font-semibold text-gray-700 w-28">Bono mi auto</th>
                            {form.vehicles.map((v, i) => (
                              <th key={v.id} className="text-left py-2.5 px-2 font-semibold text-gray-700 w-28 min-w-0" title={v.name || `Carro ${i + 1}`}>
                                <span className="block truncate text-gray-800">{v.name || `Carro ${i + 1}`}</span>
                              </th>
                            ))}
                            <th className="text-right py-2.5 px-2 w-14" scope="col" aria-label="Quitar fila"> </th>
                          </tr>
                        </thead>
                        <tbody>
                          {form.rules.map((r, ri) => (
                            <tr key={ri} className="border-b border-gray-100 last:border-0 hover:bg-gray-50/50">
                              <td className="py-2 px-2 align-top">
                                <input
                                  type="text"
                                  value={r.viajes}
                                  onChange={(e) => updateRule(ri, 'viajes', e.target.value)}
                                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500"
                                  placeholder="180, 150, 0-119"
                                />
                              </td>
                              <td className="py-2 px-2 align-top">
                                <div className="flex w-full rounded border border-gray-300 bg-white focus-within:border-red-500 focus-within:ring-1 focus-within:ring-red-500">
                                  <select
                                    value={r.bono_auto_moneda ?? 'PEN'}
                                    onChange={(e) => updateRule(ri, 'bono_auto_moneda', e.target.value as BonoAutoMoneda)}
                                    className="shrink-0 flex items-center px-2 py-1.5 text-sm text-gray-700 border-r border-gray-200 bg-gray-50 rounded-l focus:ring-0 focus:outline-none cursor-pointer"
                                    title="Moneda bono mi auto"
                                  >
                                    <option value="USD">$</option>
                                    <option value="PEN">S/.</option>
                                  </select>
                                  <input
                                    type="number"
                                    min={0}
                                    step={0.01}
                                    value={r.bono_auto != null && r.bono_auto !== 0 ? r.bono_auto : ''}
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
                                    className={`flex-1 min-w-0 px-2 py-1.5 text-sm border-0 rounded-r bg-transparent focus:outline-none focus:ring-0${INPUT_NUMBER_CLASS}`}
                                  />
                                </div>
                              </td>
                              {form.vehicles.map((_, vi) => {
                                const val = (r.cuotas_por_vehiculo || [])[vi] ?? 0;
                                const moneda = (r.cuota_moneda_por_vehiculo || [])[vi] ?? 'PEN';
                                return (
                                  <td key={vi} className="py-2 px-2 align-top">
                                    <div className="flex w-full rounded border border-gray-300 bg-white focus-within:border-red-500 focus-within:ring-1 focus-within:ring-red-500">
                                      <select
                                        value={moneda}
                                        onChange={(e) => updateRuleCuotaMoneda(ri, vi, e.target.value as BonoAutoMoneda)}
                                        className="shrink-0 flex items-center px-2 py-1.5 text-sm text-gray-700 border-r border-gray-200 bg-gray-50 rounded-l focus:ring-0 focus:outline-none cursor-pointer"
                                        title="Moneda cuota"
                                      >
                                        <option value="USD">$</option>
                                        <option value="PEN">S/.</option>
                                      </select>
                                      <input
                                        type="number"
                                        min={0}
                                        step={0.01}
                                        value={val != null && val !== 0 ? val : ''}
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
                                        className={`flex-1 min-w-0 px-2 py-1.5 text-sm border-0 rounded-r bg-transparent focus:outline-none focus:ring-0${INPUT_NUMBER_CLASS}`}
                                      />
                                    </div>
                                  </td>
                                );
                              })}
                              <td className="py-2 px-2 align-top text-right">
                                <button
                                  type="button"
                                  onClick={() => removeRule(ri)}
                                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                  title="Quitar fila"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
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
              <button type="button" onClick={closeModal} className="px-5 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium transition-colors">
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!form.name.trim()}
                className="px-5 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors"
              >
                {editingId ? 'Guardar' : 'Crear'}
              </button>
            </div>
            </div>
          </div>
        ),
        document.body
      )}
    </div>
  );
}
