import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, RefreshCw, Save, X } from 'lucide-react';

interface MiautoConfiguredExpenseRule {
  monto?: number | null;
  moneda?: 'PEN' | 'USD' | 'COP' | string;
  cobro?: {
    meses_anticipo?: number;
    cuotas?: number;
    mes_inicio?: number;
    anios_vigencia_tras_modelo?: number;
    semanas?: number;
  };
}

export interface MiautoGastoConfiguration {
  fecha_entrega_vehiculo?: string | null;
  vehiculo_anio?: number | null;
  soat_fecha_vencimiento?: string | null;
  str_gps_monto_semanal?: number | null;
  str_gps_moneda?: 'PEN' | 'USD' | 'COP';
  str_gps_heredado?: boolean;
  inicial_parcial_activa?: boolean;
  gastos_automaticos_activos?: boolean;
  requisitos_gastos?: {
    soat?: MiautoConfiguredExpenseRule;
    impuesto_vehicular?: MiautoConfiguredExpenseRule;
    todo_riesgo_mas_gps_agrupado?: MiautoConfiguredExpenseRule;
    inicial_parcial?: MiautoConfiguredExpenseRule;
  };
}

export interface MiautoGastoGenerationInput {
  periodoAnio: number;
  impuestoVehicularMontoTotal?: number;
}

export type MiautoGastoConfigFocus =
  | 'soat'
  | 'impuesto_vehicular'
  | 'inicial_parcial'
  | 'str_gps';

interface Props {
  open: boolean;
  config: MiautoGastoConfiguration | null;
  saving: boolean;
  generating: boolean;
  initialFocus?: MiautoGastoConfigFocus | null;
  onClose: () => void;
  onSave: (config: MiautoGastoConfiguration) => Promise<void>;
  onSaveAndGenerate: (
    config: MiautoGastoConfiguration,
    generation: MiautoGastoGenerationInput,
  ) => Promise<void>;
}

const inputClassName =
  'mt-1 h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-red-600 focus:ring-2 focus:ring-red-100';

function normalizeDraft(config: MiautoGastoConfiguration): MiautoGastoConfiguration {
  return {
    ...config,
    fecha_entrega_vehiculo: String(config.fecha_entrega_vehiculo || '').slice(0, 10),
    soat_fecha_vencimiento: String(config.soat_fecha_vencimiento || '').slice(0, 10),
    str_gps_moneda: config.str_gps_moneda || 'USD',
    inicial_parcial_activa: Boolean(config.inicial_parcial_activa),
    gastos_automaticos_activos: config.gastos_automaticos_activos !== false,
  };
}

function configuredAmountLabel(rule?: MiautoConfiguredExpenseRule): string {
  if (!rule) return 'Sin configuración';
  const amount = Number(rule?.monto);
  const currency = String(rule?.moneda || 'PEN').toUpperCase();
  return `${currency} ${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'}`;
}

export function MiautoGastosConfigurationModal({
  open,
  config,
  saving,
  generating,
  initialFocus = null,
  onClose,
  onSave,
  onSaveAndGenerate,
}: Props) {
  const [draft, setDraft] = useState<MiautoGastoConfiguration | null>(null);
  const [periodo, setPeriodo] = useState(String(new Date().getFullYear()));
  const [impuestoMonto, setImpuestoMonto] = useState('');
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const busy = saving || generating;

  useEffect(() => {
    if (!open || !config) return;
    setDraft(normalizeDraft(config));
    setPeriodo(String(new Date().getFullYear()));
    const configuredTaxAmount = Number(config.requisitos_gastos?.impuesto_vehicular?.monto);
    setImpuestoMonto(configuredTaxAmount > 0 ? String(configuredTaxAmount) : '');
  }, [open, config]);

  useEffect(() => {
    if (!open || !config) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const scrollBody = scrollBodyRef.current;
      if (!scrollBody) return;
      if (!initialFocus) {
        scrollBody.scrollTop = 0;
        return;
      }
      const target = scrollBody.querySelector<HTMLElement>(`[data-config-section="${initialFocus}"]`);
      target?.scrollIntoView({ block: 'center' });
      target?.querySelector<HTMLElement>('input, select')?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [config, initialFocus, open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onClose, open]);

  const generation = useMemo<MiautoGastoGenerationInput | null>(() => {
    const periodoAnio = Number(periodo);
    const taxAmount = impuestoMonto.trim() ? Number(impuestoMonto) : undefined;
    if (!Number.isInteger(periodoAnio) || periodoAnio < 2020 || periodoAnio > 2100) return null;
    if (taxAmount !== undefined && (!Number.isFinite(taxAmount) || taxAmount <= 0)) return null;
    return { periodoAnio, impuestoVehicularMontoTotal: taxAmount };
  }, [impuestoMonto, periodo]);

  if (!open || !draft) return null;

  const setField = <K extends keyof MiautoGastoConfiguration>(
    field: K,
    value: MiautoGastoConfiguration[K],
  ) => setDraft((current) => (current ? { ...current, [field]: value } : current));

  const canGenerate = Boolean(draft.fecha_entrega_vehiculo && generation);
  const configuredSoat = draft.requisitos_gastos?.soat;
  const configuredTax = draft.requisitos_gastos?.impuesto_vehicular;
  const configuredStrGps = draft.requisitos_gastos?.todo_riesgo_mas_gps_agrupado;
  const configuredInitial = draft.requisitos_gastos?.inicial_parcial;

  return createPortal(
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="miauto-gastos-config-title"
      onClick={() => !busy && onClose()}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-red-50 text-red-700">
              <CalendarDays className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 id="miauto-gastos-config-title" className="text-base font-bold text-gray-900">
                Configurar otros gastos
              </h2>
              <p className="text-xs text-gray-500">Datos del contrato y generación por periodo</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div ref={scrollBodyRef} className="overflow-y-auto px-5 py-4">
          <section className="pb-5">
            <h3 className="mb-3 text-sm font-semibold text-gray-900">Datos del vehículo</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-xs font-medium text-gray-600">
                Fecha de entrega
                <input
                  type="date"
                  value={draft.fecha_entrega_vehiculo || ''}
                  onChange={(event) => setField('fecha_entrega_vehiculo', event.target.value || null)}
                  className={inputClassName}
                />
              </label>
              <label className="text-xs font-medium text-gray-600">
                Año del vehículo
                <input
                  type="number"
                  min="1990"
                  max="2100"
                  value={draft.vehiculo_anio ?? ''}
                  onChange={(event) => setField('vehiculo_anio', event.target.value ? Number(event.target.value) : null)}
                  className={inputClassName}
                />
              </label>
            </div>
          </section>

          <section className="border-t border-gray-200 py-5">
            <h3 className="mb-3 text-sm font-semibold text-gray-900">Seguros y cobros semanales</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <label
                data-config-section="soat"
                className={`rounded-md text-xs font-medium text-gray-600 ${initialFocus === 'soat' ? 'ring-2 ring-red-200 ring-offset-4' : ''}`}
              >
                Vencimiento SOAT
                <input
                  type="date"
                  value={draft.soat_fecha_vencimiento || ''}
                  onChange={(event) => setField('soat_fecha_vencimiento', event.target.value || null)}
                  className={inputClassName}
                />
                <span className="mt-1.5 block text-[11px] font-normal text-gray-500">
                  Cronograma: {configuredAmountLabel(configuredSoat)} · {Number(configuredSoat?.cobro?.meses_anticipo) || 0} cobros mensuales
                </span>
              </label>
              <div
                data-config-section="str_gps"
                className={`grid grid-cols-[1fr_7.5rem] gap-3 rounded-md ${initialFocus === 'str_gps' ? 'ring-2 ring-red-200 ring-offset-4' : ''}`}
              >
                <label className="text-xs font-medium text-gray-600">
                  STR + GPS semanal
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={draft.str_gps_monto_semanal ?? ''}
                    onChange={(event) => setField('str_gps_monto_semanal', event.target.value ? Number(event.target.value) : null)}
                    className={inputClassName}
                  />
                </label>
                <label className="text-xs font-medium text-gray-600">
                  Moneda
                  <select
                    value={draft.str_gps_moneda || 'USD'}
                    onChange={(event) => setField('str_gps_moneda', event.target.value as 'PEN' | 'USD' | 'COP')}
                    className={inputClassName}
                  >
                    <option value="USD">USD ($)</option>
                    <option value="PEN">PEN (S/.)</option>
                    <option value="COP">COP ($)</option>
                  </select>
                </label>
                <p className="col-span-2 text-[11px] text-gray-500">
                  Cronograma: {configuredAmountLabel(configuredStrGps)} · {Number(configuredStrGps?.cobro?.semanas) || 0} semanas
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label
                data-config-section="inicial_parcial"
                className={`flex min-h-11 items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm font-medium text-gray-700 ${initialFocus === 'inicial_parcial' ? 'border-red-300 ring-2 ring-red-100' : 'border-gray-200'}`}
              >
                Inicial parcial
                <input
                  type="checkbox"
                  checked={Boolean(draft.inicial_parcial_activa)}
                  onChange={(event) => setField('inicial_parcial_activa', event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-red-700 focus:ring-red-600"
                />
                <span className="sr-only">
                  Cronograma: {configuredAmountLabel(configuredInitial)} · {Number(configuredInitial?.cobro?.semanas) || 0} semanas
                </span>
              </label>
              <label className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700">
                Generación automática
                <input
                  type="checkbox"
                  checked={draft.gastos_automaticos_activos !== false}
                  onChange={(event) => setField('gastos_automaticos_activos', event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-red-700 focus:ring-red-600"
                />
              </label>
            </div>
            <p className="mt-2 text-[11px] text-gray-500">
              Inicial parcial del cronograma: {configuredAmountLabel(configuredInitial)} · {Number(configuredInitial?.cobro?.semanas) || 0} semanas
            </p>
          </section>

          <section className="border-t border-gray-200 pt-5">
            <h3 className="mb-3 text-sm font-semibold text-gray-900">Periodo a generar</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-xs font-medium text-gray-600">
                Año del periodo
                <input
                  type="number"
                  min="2020"
                  max="2100"
                  value={periodo}
                  onChange={(event) => setPeriodo(event.target.value)}
                  className={inputClassName}
                />
              </label>
              <label
                data-config-section="impuesto_vehicular"
                className={`rounded-md text-xs font-medium text-gray-600 ${initialFocus === 'impuesto_vehicular' ? 'ring-2 ring-red-200 ring-offset-4' : ''}`}
              >
                Impuesto vehicular total (PEN)
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="Opcional"
                  value={impuestoMonto}
                  onChange={(event) => setImpuestoMonto(event.target.value)}
                  className={inputClassName}
                />
                <span className="mt-1.5 block text-[11px] font-normal text-gray-500">
                  Cronograma: {configuredAmountLabel(configuredTax)} · {Number(configuredTax?.cobro?.cuotas) || 0} cuotas desde el mes {Number(configuredTax?.cobro?.mes_inicio) || 0} · vigencia {Number(configuredTax?.cobro?.anios_vigencia_tras_modelo) || 0} años
                </span>
              </label>
            </div>
          </section>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-gray-200 bg-gray-50 px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-10 rounded-md border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            disabled={busy}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-100 disabled:opacity-50"
          >
            {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Guardar
          </button>
          <button
            type="button"
            onClick={() => generation && onSaveAndGenerate(draft, generation)}
            disabled={busy || !canGenerate}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#8B1A1A] px-4 text-sm font-semibold text-white hover:bg-[#741616] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${generating ? 'animate-spin' : ''}`} />
            Guardar y generar
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
