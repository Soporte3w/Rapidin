import type {
  MimotoCronograma,
  MimotoCurrency,
  MimotoRule,
  MimotoRuleMode,
  MimotoVehicle,
  MimotoVehicleCoverages,
} from './mimotoApi';
import {
  createDefaultMimotoCoverages,
  mergeMimotoCoverages,
  validateMimotoCoverages,
} from './mimotoCronogramaConfigDomain';

export type MimotoVehicleForm = {
  id: string;
  name: string;
  initial: string;
  installments: string;
  currency: MimotoCurrency;
  image?: string;
  metadata: Record<string, unknown>;
  coverages: MimotoVehicleCoverages;
};

export type MimotoRuleForm = {
  id: string;
  viajes: string;
  minHours: string;
  amounts: Record<string, string>;
};

export type MimotoCronogramaForm = {
  name: string;
  moraRate: string;
  active: boolean;
  bonusTime: boolean;
  ruleMode: MimotoRuleMode;
  expenseInstallments: string;
  initialComplete: boolean;
  initialPartial: boolean;
  vehicles: MimotoVehicleForm[];
  rules: MimotoRuleForm[];
};

function formId(prefix: string, index = 0) {
  return `${prefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createMimotoVehicleForm(index = 0): MimotoVehicleForm {
  return {
    id: formId('vehicle', index),
    name: '',
    initial: '',
    installments: '78',
    currency: 'COP',
    metadata: {},
    coverages: createDefaultMimotoCoverages(),
  };
}

export function createMimotoRuleForm(
  index = 0,
  viajes = '',
  vehicleIds: string[] = [],
  minHours = '',
): MimotoRuleForm {
  return {
    id: formId('rule', index),
    viajes,
    minHours,
    amounts: Object.fromEntries(vehicleIds.map((vehicleId) => [vehicleId, ''])),
  };
}

export function createDefaultMimotoRules(vehicleIds: string[]) {
  return [
    { viajes: '0-39', minHours: '0' },
    { viajes: '40-74', minHours: '17' },
    { viajes: '75+', minHours: '30' },
  ].map(({ viajes, minHours }, index) => createMimotoRuleForm(index, viajes, vehicleIds, minHours));
}

export function createEmptyMimotoCronogramaForm(): MimotoCronogramaForm {
  const vehicle = createMimotoVehicleForm();
  return {
    name: '',
    moraRate: '4',
    active: true,
    bonusTime: false,
    ruleMode: 'viajes',
    expenseInstallments: '26',
    initialComplete: true,
    initialPartial: true,
    vehicles: [vehicle],
    rules: createDefaultMimotoRules([vehicle.id]),
  };
}

function ruleAmount(rule: MimotoRule, vehicleId: string) {
  const value = rule.cuotas_por_vehiculo?.find((item) => item.vehiculo_id === vehicleId)?.cuota;
  return Number(value) || 0;
}

export function toMimotoCronogramaForm(cronograma: MimotoCronograma): MimotoCronogramaForm {
  const vehicles = cronograma.vehiculos.map<MimotoVehicleForm>((vehicle) => ({
    id: vehicle.id,
    name: vehicle.name,
    initial: String(vehicle.inicial ?? 0),
    installments: String(vehicle.cuotas_semanales || 1),
    currency: vehicle.moneda || 'COP',
    image: vehicle.metadata?.image,
    metadata: vehicle.metadata || {},
    coverages: mergeMimotoCoverages(vehicle.metadata?.coverages),
  }));
  const rules = cronograma.rules.length > 0
    ? cronograma.rules.map((rule, index) => ({
      id: rule.id || formId('rule', index),
      viajes: rule.viajes,
      minHours: String(rule.horas_minimas ?? [0, 17, 30][index] ?? 0),
      amounts: Object.fromEntries(vehicles.map((vehicle) => [vehicle.id, String(ruleAmount(rule, vehicle.id))])),
    }))
    : createDefaultMimotoRules(vehicles.map((vehicle) => vehicle.id));

  return {
    name: cronograma.name,
    moraRate: String(Number((Number(cronograma.tasa_interes_mora || 0) * 100).toFixed(6))),
    active: cronograma.active,
    bonusTime: Boolean(cronograma.bono_tiempo_activo),
    ruleMode: cronograma.modo_evaluacion || 'viajes',
    expenseInstallments: String(cronograma.cuotas_otros_gastos || 26),
    initialComplete: cronograma.requisitos_vehiculo?.modalidades_pago_inicial?.completo !== false,
    initialPartial: cronograma.requisitos_vehiculo?.modalidades_pago_inicial?.parcial !== false,
    vehicles,
    rules,
  };
}

export function parseMimotoTripsRange(value: string) {
  const text = value.trim();
  const numbers = text.match(/\d+/g)?.map(Number) || [];
  if (numbers.length === 0) return null;
  if (/\+|más|mas|desde|mayor/i.test(text) && numbers.length === 1) {
    return { min: numbers[0], max: Number.POSITIVE_INFINITY };
  }
  if (numbers.length === 1) return { min: numbers[0], max: numbers[0] };
  return { min: Math.min(numbers[0], numbers[1]), max: Math.max(numbers[0], numbers[1]) };
}

export function validateMimotoCronogramaForm(form: MimotoCronogramaForm) {
  if (!form.name.trim()) return 'El nombre del cronograma es obligatorio';
  const moraRate = Number(form.moraRate);
  if (!Number.isFinite(moraRate) || moraRate < 0 || moraRate > 100) {
    return 'La tasa de mora debe estar entre 0 % y 100 %';
  }
  if (!form.initialComplete && !form.initialPartial) return 'Selecciona al menos una modalidad de pago inicial';
  if (form.vehicles.length === 0) return 'Agrega al menos una moto';
  if (form.rules.length === 0) return 'Agrega al menos una fila de viajes';

  for (const [index, vehicle] of form.vehicles.entries()) {
    if (!vehicle.name.trim()) return `Completa el nombre de la moto ${index + 1}`;
    if (Number(vehicle.installments) < 1) return `Las cuotas de ${vehicle.name} no son válidas`;
    const coverageError = validateMimotoCoverages(vehicle.coverages, vehicle.name);
    if (coverageError) return coverageError;
  }

  for (const [index, rule] of form.rules.entries()) {
    if (!rule.viajes.trim() || !parseMimotoTripsRange(rule.viajes)) {
      return `Los viajes de la fila ${index + 1} no son válidos`;
    }
    if (form.ruleMode === 'viajes_horas') {
      const hours = Number(rule.minHours);
      if (!Number.isFinite(hours) || hours < 0) {
        return `Las horas mínimas de la fila ${index + 1} no son válidas`;
      }
    }
    for (const vehicle of form.vehicles) {
      const amount = Number(rule.amounts[vehicle.id]);
      if (!Number.isFinite(amount) || amount <= 0) {
        return `Completa la cuota de ${vehicle.name} para ${rule.viajes}`;
      }
    }
  }

  const ranges = form.rules.map((rule) => parseMimotoTripsRange(rule.viajes)!);
  for (let left = 0; left < ranges.length; left += 1) {
    for (let right = left + 1; right < ranges.length; right += 1) {
      if (ranges[left].min <= ranges[right].max && ranges[right].min <= ranges[left].max) {
        return `Las filas de viajes ${left + 1} y ${right + 1} se superponen`;
      }
    }
  }

  if (form.ruleMode === 'viajes_horas') {
    const ordered = form.rules
      .map((rule) => ({ minTrips: parseMimotoTripsRange(rule.viajes)!.min, minHours: Number(rule.minHours) }))
      .sort((left, right) => left.minTrips - right.minTrips);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].minHours < ordered[index - 1].minHours) {
        return 'Las horas mínimas deben aumentar junto con los viajes';
      }
    }
  }
  return null;
}

function baseAmountForVehicle(form: MimotoCronogramaForm, vehicleId: string) {
  return Math.max(0, ...form.rules.map((rule) => Number(rule.amounts[vehicleId]) || 0));
}

export function buildMimotoCronogramaPayload(
  form: MimotoCronogramaForm,
  existing?: MimotoCronograma,
) {
  return {
    name: form.name.trim(),
    tasa_interes_mora: Math.max(0, Number(form.moraRate) || 0) / 100,
    active: form.active,
    bono_tiempo_activo: form.bonusTime,
    modo_evaluacion: form.ruleMode,
    cuotas_otros_gastos: Math.max(1, Number(form.expenseInstallments) || 26),
    requisitos_vehiculo: {
      ...(existing?.requisitos_vehiculo || {}),
      modalidades_pago_inicial: { completo: form.initialComplete, parcial: form.initialPartial },
    },
    vehiculos: form.vehicles.map((vehicle) => ({
      id: vehicle.id,
      name: vehicle.name.trim(),
      inicial: Math.max(0, Number(vehicle.initial) || 0),
      inicial_moneda: vehicle.currency,
      cuotas_semanales: Math.max(1, Number(vehicle.installments) || 1),
      moneda: vehicle.currency,
      metadata: {
        ...vehicle.metadata,
        cuota_base: baseAmountForVehicle(form, vehicle.id),
        image: vehicle.image || undefined,
        coverages: vehicle.coverages,
      },
    })),
    rules: form.rules.map((rule) => ({
      viajes: rule.viajes.trim(),
      horas_minimas: form.ruleMode === 'viajes_horas' ? Number(rule.minHours) : null,
      cuotas_por_vehiculo: form.vehicles.map((vehicle) => ({
        id: vehicle.id,
        cuota: Number(rule.amounts[vehicle.id]),
      })),
    })),
  };
}

export function mimotoVehicleSummary(vehicles: MimotoVehicle[]) {
  const names = vehicles.map((vehicle) => vehicle.name);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} y ${names.length - 3} más`;
}
