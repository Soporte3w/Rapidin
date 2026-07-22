import type {
  MimotoCoverage,
  MimotoCoverageKey,
  MimotoCurrency,
  MimotoVehicleCoverages,
} from './mimotoApi';

export const MIMOTO_COVERAGE_LABELS: Record<MimotoCoverageKey, string> = {
  soat: 'SOAT',
  impuesto_vehicular: 'Impuesto vehicular',
  gps: 'GPS',
  src: 'Seguro de responsabilidad civil (SRC)',
  todo_riesgo_mas_gps: 'Seguro todo riesgo + GPS',
  inicial_parcial: 'Inicial parcial',
};

const COVERAGE_KEYS = Object.keys(MIMOTO_COVERAGE_LABELS) as MimotoCoverageKey[];

function emptyCoverage(currency: MimotoCurrency = 'COP'): MimotoCoverage {
  return { amount: 0, currency };
}

export function createDefaultMimotoCoverages(): MimotoVehicleCoverages {
  return {
    mode: 'grouped',
    soat: { ...emptyCoverage(), months_before: 0 },
    impuesto_vehicular: { ...emptyCoverage(), start_month: 0, installments: 0, years: 0 },
    gps: { ...emptyCoverage(), frequency: 'monthly' },
    src: { ...emptyCoverage(), months_before: 0 },
    todo_riesgo_mas_gps: { ...emptyCoverage(), weeks: 0 },
    inicial_parcial: { ...emptyCoverage('USD'), weeks: 0 },
  };
}

function normalizeCurrency(value: unknown, fallback: MimotoCurrency): MimotoCurrency {
  return value === 'USD' || value === 'COP' ? value : fallback;
}

function nonNegative(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function mergeCoverage(value: Partial<MimotoCoverage> | undefined, fallback: MimotoCoverage): MimotoCoverage {
  return {
    ...fallback,
    ...(value || {}),
    amount: nonNegative(value?.amount),
    currency: normalizeCurrency(value?.currency, fallback.currency),
    months_before: nonNegative(value?.months_before),
    start_month: nonNegative(value?.start_month),
    installments: nonNegative(value?.installments),
    years: nonNegative(value?.years),
    weeks: nonNegative(value?.weeks),
  };
}

export function mergeMimotoCoverages(value: Partial<MimotoVehicleCoverages> | undefined): MimotoVehicleCoverages {
  const defaults = createDefaultMimotoCoverages();
  return {
    mode: value?.mode === 'separate' ? 'separate' : 'grouped',
    soat: mergeCoverage(value?.soat, defaults.soat),
    impuesto_vehicular: mergeCoverage(value?.impuesto_vehicular, defaults.impuesto_vehicular),
    gps: mergeCoverage(value?.gps, defaults.gps),
    src: mergeCoverage(value?.src, defaults.src),
    todo_riesgo_mas_gps: mergeCoverage(value?.todo_riesgo_mas_gps, defaults.todo_riesgo_mas_gps),
    inicial_parcial: mergeCoverage(value?.inicial_parcial, defaults.inicial_parcial),
  };
}

export function configuredMimotoCoverageKeys(value: MimotoVehicleCoverages) {
  return COVERAGE_KEYS.filter((key) => Number(value[key].amount) > 0);
}

export function mimotoCoverageSchedule(key: MimotoCoverageKey, coverage: MimotoCoverage) {
  if (key === 'gps') return 'Cobro mensual';
  if (key === 'soat' || key === 'src') {
    return coverage.months_before ? `${coverage.months_before} mes(es) antes del vencimiento` : 'Sin anticipación configurada';
  }
  if (key === 'impuesto_vehicular') {
    const parts = [
      coverage.installments ? `${coverage.installments} cuota(s)` : null,
      coverage.start_month ? `desde el mes ${coverage.start_month}` : null,
      coverage.years ? `durante ${coverage.years} año(s)` : null,
    ].filter(Boolean);
    return parts.join(' · ') || 'Sin calendario configurado';
  }
  return coverage.weeks ? `${coverage.weeks} semana(s)` : 'Sin semanas configuradas';
}

export function validateMimotoCoverages(value: MimotoVehicleCoverages, vehicleName: string) {
  const configured = configuredMimotoCoverageKeys(value);
  for (const key of configured) {
    const coverage = value[key];
    if ((key === 'soat' || key === 'src') && !coverage.months_before) {
      return `${MIMOTO_COVERAGE_LABELS[key]} de ${vehicleName} necesita meses de anticipación`;
    }
    if ((key === 'todo_riesgo_mas_gps' || key === 'inicial_parcial') && !coverage.weeks) {
      return `${MIMOTO_COVERAGE_LABELS[key]} de ${vehicleName} necesita una cantidad de semanas`;
    }
    if (key === 'impuesto_vehicular' && (!coverage.start_month || !coverage.installments || !coverage.years)) {
      return `Completa el calendario del impuesto vehicular de ${vehicleName}`;
    }
  }
  return null;
}
