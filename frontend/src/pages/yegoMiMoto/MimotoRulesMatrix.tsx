import { PlusCircle, Trash2 } from 'lucide-react';
import type { MimotoRuleForm, MimotoVehicleForm } from './mimotoCronogramaForm';
import type { MimotoRuleMode } from './mimotoApi';
import MimotoMoneyField, { MIMOTO_FIELD_CLASS } from './MimotoMoneyField';

type Props = {
  rules: MimotoRuleForm[];
  vehicles: MimotoVehicleForm[];
  evaluationMode: MimotoRuleMode;
  viewOnly: boolean;
  onAdd: () => void;
  onRemove: (ruleId: string) => void;
  onTrips: (ruleId: string, viajes: string) => void;
  onHours: (ruleId: string, hours: string) => void;
  onAmount: (ruleId: string, vehicleId: string, value: string) => void;
};

export default function MimotoRulesMatrix({
  rules,
  vehicles,
  evaluationMode,
  viewOnly,
  onAdd,
  onRemove,
  onTrips,
  onHours,
  onAmount,
}: Props) {
  const removeButton = (rule: MimotoRuleForm) => !viewOnly && (
    <button
      type="button"
      onClick={() => onRemove(rule.id)}
      disabled={rules.length <= 1}
      title="Quitar fila"
      className="shrink-0 rounded-md p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="font-semibold text-gray-900">Reglas de cuotas</h3>
          <p className="text-xs text-gray-500">
            {evaluationMode === 'viajes_horas'
              ? 'Cada nivel exige cumplir los viajes y las horas mínimas.'
              : 'Cada nivel se evalúa únicamente por cantidad de viajes.'}
          </p>
        </div>
        {!viewOnly && (
          <button type="button" onClick={onAdd} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700">
            <PlusCircle className="h-4 w-4" />Añadir fila
          </button>
        )}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-gray-200 md:block">
        <table className="w-full text-sm" style={{ minWidth: Math.max(680, 190 + vehicles.length * 190 + (evaluationMode === 'viajes_horas' ? 130 : 0)) }}>
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="sticky left-0 z-10 w-[170px] bg-gray-50 px-4 py-3 text-left">Viajes</th>
              {evaluationMode === 'viajes_horas' && <th className="w-[130px] px-4 py-3 text-left">Horas mín.</th>}
              {vehicles.map((vehicle) => (
                <th key={vehicle.id} className="min-w-[190px] px-4 py-3 text-right">
                  <span className="block truncate" title={vehicle.name}>{vehicle.name || 'Sin nombre'}</span>
                  <span className="text-[10px] font-medium normal-case text-gray-400">Cuota semanal · {vehicle.currency}</span>
                </th>
              ))}
              {!viewOnly && <th className="w-14 px-2 py-3" aria-label="Acciones" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rules.map((rule, ruleIndex) => (
              <tr key={rule.id} className="hover:bg-gray-50/60">
                <td className="sticky left-0 z-10 bg-white px-3 py-3 align-middle">
                  {viewOnly ? (
                    <p className="font-semibold text-gray-900">{rule.viajes} viajes</p>
                  ) : (
                    <input type="text" value={rule.viajes} onChange={(event) => onTrips(rule.id, event.target.value)} className={MIMOTO_FIELD_CLASS} placeholder="Ej. 40-74" aria-label={`Viajes fila ${ruleIndex + 1}`} />
                  )}
                </td>
                {evaluationMode === 'viajes_horas' && (
                  <td className="px-3 py-3 align-middle">
                    {viewOnly ? (
                      <p className="font-semibold text-gray-900">{rule.minHours || '0'} h</p>
                    ) : (
                      <input type="number" min="0" step="0.5" value={rule.minHours} onChange={(event) => onHours(rule.id, event.target.value)} className={MIMOTO_FIELD_CLASS} aria-label={`Horas mínimas fila ${ruleIndex + 1}`} />
                    )}
                  </td>
                )}
                {vehicles.map((vehicle) => (
                  <td key={vehicle.id} className="px-3 py-3">
                    <MimotoMoneyField
                      value={rule.amounts[vehicle.id] || ''}
                      currency={vehicle.currency}
                      disabled={viewOnly}
                      onChange={(value) => onAmount(rule.id, vehicle.id, value)}
                      ariaLabel={`Cuota ${vehicle.name || 'moto'} para ${rule.viajes || `fila ${ruleIndex + 1}`}`}
                    />
                  </td>
                ))}
                {!viewOnly && <td className="px-2 py-3 text-right">{removeButton(rule)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 md:hidden">
        {rules.map((rule, ruleIndex) => (
          <section key={rule.id} className="rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between gap-3">
              {viewOnly ? (
                <h4 className="font-semibold text-gray-900">{rule.viajes} viajes</h4>
              ) : (
                <input type="text" value={rule.viajes} onChange={(event) => onTrips(rule.id, event.target.value)} className={MIMOTO_FIELD_CLASS} placeholder="Ej. 40-74" aria-label={`Viajes fila ${ruleIndex + 1}`} />
              )}
              {removeButton(rule)}
            </div>
            {evaluationMode === 'viajes_horas' && (
              <label className="mt-3 block text-sm font-medium text-gray-700">
                Horas mínimas
                {viewOnly ? (
                  <span className="ml-2 font-semibold text-gray-900">{rule.minHours || '0'} h</span>
                ) : (
                  <input type="number" min="0" step="0.5" value={rule.minHours} onChange={(event) => onHours(rule.id, event.target.value)} className={`${MIMOTO_FIELD_CLASS} mt-1.5`} />
                )}
              </label>
            )}
            <div className="mt-3 grid gap-3">
              {vehicles.map((vehicle) => (
                <label key={vehicle.id} className="text-sm font-medium text-gray-700">
                  {vehicle.name || 'Sin nombre'}
                  <div className="mt-1.5">
                    <MimotoMoneyField
                      value={rule.amounts[vehicle.id] || ''}
                      currency={vehicle.currency}
                      disabled={viewOnly}
                      onChange={(value) => onAmount(rule.id, vehicle.id, value)}
                      ariaLabel={`Cuota ${vehicle.name || 'moto'} para ${rule.viajes || `fila ${ruleIndex + 1}`}`}
                    />
                  </div>
                </label>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
