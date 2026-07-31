export type MonedaInicial = 'USD' | 'PEN';
export type BonoAutoMoneda = 'USD' | 'PEN';
export type GastoRequisitoMoneda = 'USD' | 'PEN';
export type TipoVehiculoCronograma = 'nuevo' | 'seminuevo' | 'semiusado';
export type TodoRiesgoGpsModo = 'agrupado' | 'separado';
export type PagoInicialTipo = 'completo' | 'parcial';

export interface ModalidadesPagoInicial {
  completo: boolean;
  parcial: boolean;
}

export interface CronogramaRule {
  viajes: string;
  bono_auto: number;
  bono_auto_moneda?: BonoAutoMoneda;
  cuotas_por_vehiculo: number[];
  cuota_moneda_por_vehiculo?: BonoAutoMoneda[];
  pct_comision?: number;
  cobro_saldo?: number;
}

export interface RequisitosVehiculo {
  tipo_vehiculo: TipoVehiculoCronograma;
  modalidades_pago_inicial: ModalidadesPagoInicial;
}

export interface ItemGastoConCobro {
  monto: number;
  moneda: GastoRequisitoMoneda;
  cobro?: Record<string, unknown>;
}

export interface RequisitosGastosVehiculo {
  todo_riesgo_y_gps_modo: TodoRiesgoGpsModo;
  src: ItemGastoConCobro & { cobro?: { tipo?: string; meses_anticipo?: number } };
  gps: ItemGastoConCobro & { cobro?: { tipo?: string } };
  soat: ItemGastoConCobro & { cobro?: { tipo?: string; meses_anticipo?: number } };
  impuesto_vehicular: ItemGastoConCobro & {
    cobro?: { tipo?: string; mes_inicio?: number; cuotas?: number; anios_vigencia_tras_modelo?: number };
  };
  todo_riesgo_mas_gps_agrupado: ItemGastoConCobro & { cobro?: { tipo?: string; semanas?: number } };
  inicial_parcial: ItemGastoConCobro & { cobro?: { tipo?: string; semanas?: number } };
}

export interface VehiculoCronograma {
  id: string;
  name: string;
  inicial: number;
  inicial_moneda: MonedaInicial;
  cuotas_semanales: number;
  image?: string;
  requisitos_gastos?: RequisitosGastosVehiculo;
}

export interface Cronograma {
  id: string;
  name: string;
  country: string;
  active: boolean;
  tasa_interes_mora?: number;
  bono_tiempo_activo?: boolean;
  requisitos_vehiculo?: RequisitosVehiculo;
  vehicles: VehiculoCronograma[];
  rules: CronogramaRule[];
}

export type GastoConfigurable = Exclude<keyof RequisitosGastosVehiculo, 'todo_riesgo_y_gps_modo'>;

type LegacySoatSchedule = {
  tipo?: string;
  meses_anticipo?: number;
  cuotas?: number;
};

export const MONTH_OPTIONS = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
].map((label, index) => ({ label, value: index + 1 }));

export const TIPO_VEHICULO_OPTIONS: Array<{
  value: TipoVehiculoCronograma;
  label: string;
  hint: string;
}> = [
  { value: 'nuevo', label: 'Nuevo', hint: 'Plan para autos nuevos' },
  { value: 'seminuevo', label: 'Seminuevo', hint: 'Condición intermedia' },
  { value: 'semiusado', label: 'Segundo uso', hint: 'Semi-usado / usado' },
];

export const EXPENSE_LABELS: Record<GastoConfigurable, string> = {
  src: 'Seguro de responsabilidad civil',
  gps: 'GPS',
  soat: 'SOAT',
  impuesto_vehicular: 'Impuesto vehicular',
  todo_riesgo_mas_gps_agrupado: 'Seguro todo riesgo + GPS',
  inicial_parcial: 'Inicial parcial',
};

export function createDefaultRequisitosVehiculo(): RequisitosVehiculo {
  return {
    tipo_vehiculo: 'nuevo',
    modalidades_pago_inicial: { completo: true, parcial: true },
  };
}

export function mergeRequisitosFromApi(
  raw: Partial<RequisitosVehiculo> & {
    tipos_condicion?: { nuevo?: boolean; semiusado?: boolean; seminuevo?: boolean };
  } | undefined | null,
): RequisitosVehiculo {
  const defaults = createDefaultRequisitosVehiculo();
  if (!raw || typeof raw !== 'object') return defaults;

  const vehicleTypes: TipoVehiculoCronograma[] = ['nuevo', 'seminuevo', 'semiusado'];
  let vehicleType = raw.tipo_vehiculo && vehicleTypes.includes(raw.tipo_vehiculo)
    ? raw.tipo_vehiculo
    : defaults.tipo_vehiculo;

  const legacyTypes = raw.tipos_condicion;
  if (!raw.tipo_vehiculo && legacyTypes?.nuevo) vehicleType = 'nuevo';
  if (!raw.tipo_vehiculo && legacyTypes?.seminuevo) vehicleType = 'seminuevo';
  if (!raw.tipo_vehiculo && legacyTypes?.semiusado) vehicleType = 'semiusado';

  const configuredPaymentTypes = raw.modalidades_pago_inicial;
  const paymentTypes = configuredPaymentTypes && typeof configuredPaymentTypes === 'object'
    ? {
        completo: configuredPaymentTypes.completo === true,
        parcial: configuredPaymentTypes.parcial === true,
      }
    : defaults.modalidades_pago_inicial;

  return {
    tipo_vehiculo: vehicleType,
    modalidades_pago_inicial: paymentTypes,
  };
}

export function getPagoInicialTiposPermitidos(
  cronograma: { requisitos_vehiculo?: Partial<RequisitosVehiculo> | null } | null | undefined,
): PagoInicialTipo[] {
  const paymentTypes = mergeRequisitosFromApi(cronograma?.requisitos_vehiculo).modalidades_pago_inicial;
  return (['completo', 'parcial'] as PagoInicialTipo[]).filter((type) => paymentTypes[type]);
}

export function createDefaultRequisitosGastosVehiculo(): RequisitosGastosVehiculo {
  return {
    todo_riesgo_y_gps_modo: 'separado',
    src: { monto: 0, moneda: 'USD', cobro: { tipo: 'mensual_antes_vencimiento', meses_anticipo: 0 } },
    gps: { monto: 0, moneda: 'PEN', cobro: { tipo: 'fin_de_mes' } },
    soat: {
      monto: 0,
      moneda: 'PEN',
      cobro: { tipo: 'mensual_antes_vencimiento', meses_anticipo: 4 },
    },
    impuesto_vehicular: {
      monto: 0,
      moneda: 'PEN',
      cobro: { tipo: 'sat_febrero_cuotas', mes_inicio: 2, cuotas: 4, anios_vigencia_tras_modelo: 3 },
    },
    todo_riesgo_mas_gps_agrupado: {
      monto: 0,
      moneda: 'PEN',
      cobro: { tipo: 'semanal', semanas: 26 },
    },
    inicial_parcial: { monto: 0, moneda: 'USD', cobro: { tipo: 'semanal', semanas: 26 } },
  };
}

export function mergeRequisitosGastosFromApi(
  raw: Partial<RequisitosGastosVehiculo> | undefined | null,
): RequisitosGastosVehiculo {
  const defaults = createDefaultRequisitosGastosVehiculo();
  if (!raw || typeof raw !== 'object') return defaults;
  const legacySoatSchedule = raw.soat?.cobro as LegacySoatSchedule | undefined;
  const soatMonthsBefore = Number(legacySoatSchedule?.meses_anticipo || legacySoatSchedule?.cuotas || 0);
  return {
    ...defaults,
    ...raw,
    todo_riesgo_y_gps_modo: raw.todo_riesgo_y_gps_modo === 'agrupado' ? 'agrupado' : 'separado',
    src: { ...defaults.src, ...raw.src, cobro: { ...defaults.src.cobro, ...raw.src?.cobro } },
    gps: { ...defaults.gps, ...raw.gps, cobro: { ...defaults.gps.cobro, ...raw.gps?.cobro } },
    soat: {
      ...defaults.soat,
      ...raw.soat,
      cobro: {
        tipo: legacySoatSchedule?.tipo || defaults.soat.cobro?.tipo,
        meses_anticipo: soatMonthsBefore,
      },
    },
    impuesto_vehicular: {
      ...defaults.impuesto_vehicular,
      ...raw.impuesto_vehicular,
      cobro: { ...defaults.impuesto_vehicular.cobro, ...raw.impuesto_vehicular?.cobro },
    },
    todo_riesgo_mas_gps_agrupado: {
      ...defaults.todo_riesgo_mas_gps_agrupado,
      ...raw.todo_riesgo_mas_gps_agrupado,
      cobro: {
        ...defaults.todo_riesgo_mas_gps_agrupado.cobro,
        ...raw.todo_riesgo_mas_gps_agrupado?.cobro,
      },
    },
    inicial_parcial: {
      ...defaults.inicial_parcial,
      ...raw.inicial_parcial,
      cobro: { ...defaults.inicial_parcial.cobro, ...raw.inicial_parcial?.cobro },
    },
  };
}

export function configuredExpenseKeys(
  requirements: RequisitosGastosVehiculo,
  vehicleType: TipoVehiculoCronograma,
): GastoConfigurable[] {
  const keys: GastoConfigurable[] = ['soat', 'impuesto_vehicular', 'inicial_parcial'];
  if (requirements.todo_riesgo_y_gps_modo === 'agrupado') {
    keys.push('todo_riesgo_mas_gps_agrupado');
    if (vehicleType !== 'nuevo') keys.push('src');
  } else {
    keys.push('gps', 'src');
  }
  return keys.filter((key) => (
    key === 'impuesto_vehicular' || Number(requirements[key]?.monto) > 0
  ));
}

export function isExpenseScheduleComplete(key: GastoConfigurable, item: ItemGastoConCobro) {
  const schedule = item.cobro || {};
  if (key === 'gps') return true;
  if (key === 'soat') {
    return Number(schedule.meses_anticipo) > 0;
  }
  if (key === 'impuesto_vehicular') {
    const startMonth = Number(schedule.mes_inicio);
    const installments = Number(schedule.cuotas);
    const eligibleYears = Number(schedule.anios_vigencia_tras_modelo);
    return startMonth >= 1
      && startMonth <= 12
      && installments > 0
      && 12 % installments === 0
      && startMonth - 1 + (installments - 1) * (12 / installments) <= 11
      && eligibleYears > 0;
  }
  if (key === 'src') return Number(schedule.meses_anticipo) > 0;
  return Number(schedule.semanas) > 0;
}

export function expenseScheduleLabel(key: GastoConfigurable, item: ItemGastoConCobro) {
  if (!isExpenseScheduleComplete(key, item)) return 'Calendario pendiente';
  const schedule = item.cobro || {};
  if (key === 'gps') return 'Mensual · fin de mes';
  if (key === 'soat') {
    const monthsBefore = Number(schedule.meses_anticipo);
    return `${monthsBefore} cobros mensuales · ${monthsBefore} meses antes`;
  }
  if (key === 'impuesto_vehicular') {
    return `${Number(schedule.cuotas)} cuotas desde mes ${Number(schedule.mes_inicio)} · ${Number(schedule.anios_vigencia_tras_modelo)} años`;
  }
  if (key === 'src') return `Mensual · ${Number(schedule.meses_anticipo)} meses antes`;
  return `${Number(schedule.semanas)} cuotas semanales`;
}

export function formatExpenseAmount(item: ItemGastoConCobro) {
  const symbol = item.moneda === 'USD' ? '$' : 'S/.';
  return `${symbol} ${Number(item.monto || 0).toFixed(2)}`;
}

export function countConfiguredExpenses(
  vehicle: VehiculoCronograma,
  vehicleType: TipoVehiculoCronograma,
) {
  return configuredExpenseKeys(mergeRequisitosGastosFromApi(vehicle.requisitos_gastos), vehicleType).length;
}

export function incompleteExpenseKeys(
  vehicle: VehiculoCronograma,
  vehicleType: TipoVehiculoCronograma,
) {
  const requirements = mergeRequisitosGastosFromApi(vehicle.requisitos_gastos);
  return configuredExpenseKeys(requirements, vehicleType).filter(
    (key) => !isExpenseScheduleComplete(key, requirements[key]),
  );
}

function validateExpenseConfiguration(
  vehicle: VehiculoCronograma,
  index: number,
  vehicleType: TipoVehiculoCronograma,
): string | null {
  const expenses = mergeRequisitosGastosFromApi(vehicle.requisitos_gastos);
  const vehicleLabel = vehicle.name.trim() || `Vehículo ${index + 1}`;
  const configuredKeys = new Set(configuredExpenseKeys(expenses, vehicleType));

  if (configuredKeys.has('soat')) {
    const monthsBefore = Number(expenses.soat.cobro?.meses_anticipo);
    if (!Number.isInteger(monthsBefore) || monthsBefore <= 0) {
      return `${vehicleLabel}: indica cuántos meses antes se cobrará el SOAT.`;
    }
  }

  if (configuredKeys.has('impuesto_vehicular')) {
    const startMonth = Number(expenses.impuesto_vehicular.cobro?.mes_inicio);
    const installments = Number(expenses.impuesto_vehicular.cobro?.cuotas);
    const eligibleYears = Number(expenses.impuesto_vehicular.cobro?.anios_vigencia_tras_modelo);
    if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
      return `${vehicleLabel}: indica el mes inicial del impuesto vehicular.`;
    }
    if (!Number.isInteger(installments) || installments <= 0 || 12 % installments !== 0) {
      return `${vehicleLabel}: las cuotas del impuesto deben distribuirse uniformemente en el año.`;
    }
    if (startMonth - 1 + (installments - 1) * (12 / installments) > 11) {
      return `${vehicleLabel}: el calendario del impuesto excede el año.`;
    }
    if (!Number.isInteger(eligibleYears) || eligibleYears <= 0) {
      return `${vehicleLabel}: indica los años de vigencia del impuesto vehicular.`;
    }
  }

  if (configuredKeys.has('src') && Number(expenses.src.cobro?.meses_anticipo) <= 0) {
    return `${vehicleLabel}: indica la anticipación del SRC.`;
  }
  if (
    configuredKeys.has('todo_riesgo_mas_gps_agrupado')
    && Number(expenses.todo_riesgo_mas_gps_agrupado.cobro?.semanas) <= 0
  ) {
    return `${vehicleLabel}: indica las semanas del seguro todo riesgo + GPS.`;
  }
  if (
    configuredKeys.has('inicial_parcial')
    && Number(expenses.inicial_parcial.cobro?.semanas) <= 0
  ) {
    return `${vehicleLabel}: indica las semanas de la inicial parcial.`;
  }
  return null;
}

function generateId() {
  return Math.random().toString(36).slice(2, 11);
}

export function createEmptyRule(vehicleCount: number): CronogramaRule {
  return {
    viajes: '',
    bono_auto: 0,
    bono_auto_moneda: 'PEN',
    cuotas_por_vehiculo: Array(vehicleCount).fill(0),
    cuota_moneda_por_vehiculo: Array(vehicleCount).fill('PEN'),
  };
}

export function createEmptyVehicle(): VehiculoCronograma {
  return {
    id: generateId(),
    name: '',
    inicial: 0,
    inicial_moneda: 'USD',
    cuotas_semanales: 261,
    requisitos_gastos: createDefaultRequisitosGastosVehiculo(),
  };
}

export function parseViajesInterval(viajesStr: string): { min: number; max: number } | null {
  if (!viajesStr || typeof viajesStr !== 'string') return null;
  const value = viajesStr.trim();
  if (!value) return null;

  const plusMatch = value.match(/^(\d+)\s*\+$/);
  if (plusMatch) {
    const min = Number.parseInt(plusMatch[1], 10);
    return Number.isNaN(min) || min < 0 ? null : { min, max: Number.POSITIVE_INFINITY };
  }

  const range = value.split(/\s*-\s*/).map((part) => part.trim());
  if (range.length >= 2) {
    const min = Number.parseInt(range[0], 10);
    const max = Number.parseInt(range[1], 10);
    if (!Number.isNaN(min) && !Number.isNaN(max) && min >= 0 && max >= min) return { min, max };
  }

  const point = Number.parseInt(value, 10);
  return Number.isNaN(point) || point < 0 ? null : { min: point, max: point };
}

function isPointRule(value: string, interval: { min: number; max: number }) {
  if (interval.min !== interval.max || /^\d+\s*\+$/.test(value.trim())) return false;
  return !value.includes('-') || interval.min === interval.max;
}

function nextRuleMinimum(rules: CronogramaRule[], currentIndex: number, currentMin: number) {
  return rules.reduce<number | null>((best, rule, index) => {
    if (index === currentIndex) return best;
    const candidate = parseViajesInterval(rule.viajes)?.min;
    if (candidate == null || candidate <= currentMin) return best;
    return best == null || candidate < best ? candidate : best;
  }, null);
}

export function getRuleForTripCount(rules: CronogramaRule[], tripCount: number): CronogramaRule | null {
  if (!Array.isArray(rules) || rules.length === 0 || tripCount == null || tripCount < 0) return null;
  const trips = Number(tripCount);
  if (Number.isNaN(trips)) return null;

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    let interval = parseViajesInterval(rule.viajes);
    if (!interval) continue;
    if (isPointRule(rule.viajes, interval)) {
      const nextMin = nextRuleMinimum(rules, index, interval.min);
      interval = { min: interval.min, max: nextMin == null ? Number.POSITIVE_INFINITY : nextMin - 1 };
    }
    if (trips >= interval.min && trips <= interval.max) return rule;
  }
  return null;
}

export function validateCronogramaForm(form: Omit<Cronograma, 'id'>): string | null {
  if (!form.name.trim()) return 'Ingresa el nombre del cronograma.';
  if (form.vehicles.length === 0) return 'Agrega al menos un vehículo.';
  if (form.rules.length === 0) return 'Agrega al menos una regla de cuotas.';

  const requirements = mergeRequisitosFromApi(form.requisitos_vehiculo);
  if (!requirements.modalidades_pago_inicial.completo && !requirements.modalidades_pago_inicial.parcial) {
    return 'Selecciona al menos una modalidad de pago inicial.';
  }
  const vehicleType = requirements.tipo_vehiculo;
  for (let index = 0; index < form.vehicles.length; index += 1) {
    const vehicle = form.vehicles[index];
    if (!vehicle.name.trim()) return `Completa el nombre del vehículo ${index + 1}.`;
    if (!Number.isInteger(Number(vehicle.cuotas_semanales)) || Number(vehicle.cuotas_semanales) <= 0) {
      return `${vehicle.name}: la cantidad de cuotas semanales debe ser mayor a cero.`;
    }
    const expenseError = validateExpenseConfiguration(vehicle, index, vehicleType);
    if (expenseError) return expenseError;
  }

  for (let index = 0; index < form.rules.length; index += 1) {
    const rule = form.rules[index];
    if (!parseViajesInterval(rule.viajes)) {
      return `La regla ${index + 1} tiene un rango de viajes inválido.`;
    }
    if (rule.cuotas_por_vehiculo.length !== form.vehicles.length) {
      return `La regla ${index + 1} no tiene una cuota para cada vehículo.`;
    }
  }
  return null;
}
