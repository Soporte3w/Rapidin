import { ImagePlus, Trash2, X } from 'lucide-react';
import { formatMimotoMoney, type MimotoCoverage, type MimotoCoverageKey, type MimotoCurrency, type MimotoVehicleCoverages } from './mimotoApi';
import {
  MIMOTO_COVERAGE_LABELS,
  configuredMimotoCoverageKeys,
  mimotoCoverageSchedule,
} from './mimotoCronogramaConfigDomain';
import type { MimotoVehicleForm } from './mimotoCronogramaForm';
import MimotoMoneyField, {
  MIMOTO_FIELD_CLASS,
  formatMimotoMoneyInput,
  sanitizeMimotoMoneyInput,
} from './MimotoMoneyField';

const MONTH_OPTIONS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const COVERAGE_DESCRIPTIONS: Record<MimotoCoverageKey, string> = {
  soat: 'Cobro previo al vencimiento del documento',
  impuesto_vehicular: 'Monto anual distribuido según calendario',
  gps: 'Cobro mensual del servicio GPS',
  src: 'Cobro previo al vencimiento del seguro',
  todo_riesgo_mas_gps: 'Cobro semanal agrupado',
  inicial_parcial: 'Solo para contratos con inicial parcial',
};

function CoverageEditor({ coverageKey, coverage, onChange }: {
  coverageKey: MimotoCoverageKey;
  coverage: MimotoCoverage;
  onChange: (patch: Partial<MimotoCoverage>) => void;
}) {
  const numericField = (field: keyof MimotoCoverage, label: string, max?: number) => (
    <label className="min-w-0 text-[10px] text-gray-500">
      {label}
      <input
        type="number"
        min="0"
        max={max}
        value={String(coverage[field] || '')}
        onChange={(event) => onChange({ [field]: Math.max(0, Number(event.target.value) || 0) })}
        className="mt-1 h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-xs outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
      />
    </label>
  );

  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-gray-100 bg-gray-50/70 p-3 shadow-sm">
      <div className="mb-3 min-w-0">
        <h5 className="text-xs font-semibold text-gray-800">{MIMOTO_COVERAGE_LABELS[coverageKey]}</h5>
        <p className="mt-0.5 text-[10px] leading-snug text-gray-400">{COVERAGE_DESCRIPTIONS[coverageKey]}</p>
      </div>
      <label className="text-[10px] text-gray-500">
        Monto
        <div className="mt-1 flex h-8 min-w-0 overflow-hidden rounded-md border border-gray-200 bg-white focus-within:border-red-400 focus-within:ring-2 focus-within:ring-red-100">
          <select
            value={coverage.currency}
            onChange={(event) => onChange({ currency: event.target.value as MimotoCurrency })}
            className="w-[4.5rem] shrink-0 border-0 border-r border-gray-200 bg-gray-50 px-1 text-[10px] font-semibold outline-none"
          >
            <option value="COP">COP</option>
            <option value="USD">USD</option>
          </select>
          <input
            type="text"
            inputMode={coverage.currency === 'COP' ? 'numeric' : 'decimal'}
            value={formatMimotoMoneyInput(String(coverage.amount || ''), coverage.currency)}
            onChange={(event) => onChange({ amount: Number(sanitizeMimotoMoneyInput(event.target.value, coverage.currency)) || 0 })}
            className="min-w-0 flex-1 border-0 px-2 text-right text-xs outline-none"
            placeholder="0"
          />
        </div>
      </label>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(coverageKey === 'soat' || coverageKey === 'src') && numericField('months_before', 'Meses antes', 12)}
        {(coverageKey === 'todo_riesgo_mas_gps' || coverageKey === 'inicial_parcial') && numericField('weeks', 'Semanas', 260)}
        {coverageKey === 'gps' && <p className="col-span-2 rounded-md bg-white px-2 py-2 text-[10px] text-gray-500">Frecuencia: mensual</p>}
        {coverageKey === 'impuesto_vehicular' && (
          <>
            <label className="min-w-0 text-[10px] text-gray-500">
              Mes inicial
              <select
                value={String(coverage.start_month || '')}
                onChange={(event) => onChange({ start_month: Number(event.target.value) || 0 })}
                className="mt-1 h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-xs outline-none focus:border-red-400"
              >
                <option value="">Elegir</option>
                {MONTH_OPTIONS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
              </select>
            </label>
            {numericField('installments', 'Cuotas', 12)}
            {numericField('years', 'Años de vigencia', 10)}
          </>
        )}
      </div>
    </section>
  );
}

type Props = {
  vehicle: MimotoVehicleForm;
  index: number;
  viewOnly: boolean;
  canRemove: boolean;
  onUpdate: (field: keyof MimotoVehicleForm, value: string) => void;
  onRemove: () => void;
  onImage: (file?: File) => void;
  onCoverageMode: (mode: MimotoVehicleCoverages['mode']) => void;
  onCoverage: (key: MimotoCoverageKey, patch: Partial<MimotoCoverage>) => void;
};

export default function MimotoVehicleCoverageCard({
  vehicle,
  index,
  viewOnly,
  canRemove,
  onUpdate,
  onRemove,
  onImage,
  onCoverageMode,
  onCoverage,
}: Props) {
  const configuredCoverages = configuredMimotoCoverageKeys(vehicle.coverages);
  const editCoverageKeys: MimotoCoverageKey[] = [
    'soat',
    'impuesto_vehicular',
    ...(vehicle.coverages.mode === 'grouped'
      ? ['todo_riesgo_mas_gps' as const]
      : ['gps' as const, 'src' as const]),
    'inicial_parcial',
  ];

  return (
    <section className="flex flex-col rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <header className="mb-4 flex items-center justify-between gap-3 border-b border-gray-100 pb-3">
        <p className="text-xs font-semibold uppercase text-gray-500">Moto {index + 1}</p>
        <span className={`rounded px-2 py-1 text-[10px] font-semibold ${configuredCoverages.length ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {configuredCoverages.length ? `${configuredCoverages.length} configurada${configuredCoverages.length === 1 ? '' : 's'}` : 'Sin coberturas'}
        </span>
      </header>

      <div className="flex flex-col items-center gap-2">
        {vehicle.image ? (
          <div className="relative h-24 w-24 overflow-hidden rounded-xl border border-gray-200">
            <img src={vehicle.image} alt={vehicle.name || `Moto ${index + 1}`} className="h-full w-full object-cover" />
            {!viewOnly && (
              <button type="button" title="Quitar foto" onClick={() => onUpdate('image', '')} className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-lg bg-white/95 text-gray-500 shadow hover:text-red-600">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ) : viewOnly ? (
          <div className="grid h-24 w-24 place-items-center rounded-xl border-2 border-dashed border-gray-200 text-xs text-gray-400">Sin foto</div>
        ) : (
          <label className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 text-gray-400 transition hover:border-red-300 hover:bg-red-50/30 hover:text-red-500">
            <ImagePlus className="h-7 w-7" />
            <span className="mt-1 text-xs">Agregar foto</span>
            <input type="file" accept="image/*" className="hidden" onChange={(event) => onImage(event.target.files?.[0])} />
          </label>
        )}
        {vehicle.image && !viewOnly && (
          <label className="cursor-pointer text-xs font-medium text-gray-600 hover:text-red-600">
            Cambiar foto
            <input type="file" accept="image/*" className="hidden" onChange={(event) => onImage(event.target.files?.[0])} />
          </label>
        )}
      </div>

      <div className="mt-4 space-y-3">
        <label className="block text-xs font-semibold uppercase text-gray-700">
          Modelo / nombre *
          <input value={vehicle.name} onChange={(event) => onUpdate('name', event.target.value)} disabled={viewOnly} className={`${MIMOTO_FIELD_CLASS} mt-1.5`} />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold uppercase text-gray-700">
            Inicial
            <div className="mt-1.5">
              <MimotoMoneyField value={vehicle.initial} currency={vehicle.currency} disabled={viewOnly} onChange={(value) => onUpdate('initial', value)} ariaLabel={`Inicial de ${vehicle.name || `moto ${index + 1}`}`} />
            </div>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-semibold uppercase text-gray-700">
              Moneda
              <select value={vehicle.currency} onChange={(event) => onUpdate('currency', event.target.value)} disabled={viewOnly} className={`${MIMOTO_FIELD_CLASS} mt-1.5`}>
                <option value="COP">COP</option>
                <option value="USD">USD</option>
              </select>
            </label>
            <label className="text-xs font-semibold uppercase text-gray-700">
              Cuotas
              <input type="number" min="1" value={vehicle.installments} onChange={(event) => onUpdate('installments', event.target.value)} disabled={viewOnly} className={`${MIMOTO_FIELD_CLASS} mt-1.5`} />
            </label>
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-gray-100 pt-3">
        <div className="mb-3">
          <h4 className="text-xs font-semibold text-gray-800">Gastos y coberturas</h4>
          <p className="mt-0.5 text-[10px] text-gray-500">Solo se generan conceptos configurados con monto mayor a cero.</p>
        </div>
        {viewOnly ? (
          <div className="space-y-2">
            {configuredCoverages.length === 0 ? (
              <div className="rounded-md border border-dashed border-gray-200 px-3 py-4 text-center text-xs text-gray-500">Esta moto no tiene gastos ni coberturas configurados.</div>
            ) : configuredCoverages.map((key) => (
              <div key={key} className="flex items-center justify-between gap-3 rounded-md border border-gray-200 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-gray-800">{MIMOTO_COVERAGE_LABELS[key]}</p>
                  <p className="mt-0.5 truncate text-[10px] text-gray-500">{mimotoCoverageSchedule(key, vehicle.coverages[key])}</p>
                </div>
                <p className="shrink-0 text-sm font-bold tabular-nums text-gray-900">{formatMimotoMoney(vehicle.coverages[key].amount, vehicle.coverages[key].currency)}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block text-xs font-medium text-gray-700">
              Modo de seguro y GPS
              <select value={vehicle.coverages.mode} onChange={(event) => onCoverageMode(event.target.value as MimotoVehicleCoverages['mode'])} className={`${MIMOTO_FIELD_CLASS} mt-1.5`}>
                <option value="grouped">Un solo costo: seguro todo riesgo + GPS</option>
                <option value="separate">Por separado: GPS + SRC</option>
              </select>
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {editCoverageKeys.map((key) => (
                <CoverageEditor key={key} coverageKey={key} coverage={vehicle.coverages[key]} onChange={(patch) => onCoverage(key, patch)} />
              ))}
            </div>
          </div>
        )}
      </div>

      {!viewOnly && canRemove && (
        <button type="button" onClick={onRemove} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 py-2 text-xs font-medium text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600">
          <Trash2 className="h-3.5 w-3.5" />Quitar moto
        </button>
      )}
    </section>
  );
}
