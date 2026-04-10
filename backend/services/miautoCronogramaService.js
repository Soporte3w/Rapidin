import { query } from '../config/database.js';

const TIPOS_VEHICULO = ['nuevo', 'seminuevo', 'semiusado'];

function defaultRequisitosVehiculo() {
  return { tipo_vehiculo: 'nuevo' };
}

/** @param {any} raw - JSONB u objeto desde DB (cronograma): solo tipo_vehiculo por plan */
export function parseRequisitosVehiculo(raw) {
  let obj = raw;
  if (raw == null) return defaultRequisitosVehiculo();
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return defaultRequisitosVehiculo();
    }
  }
  if (typeof obj !== 'object' || obj === null) return defaultRequisitosVehiculo();
  return mergeRequisitosVehiculo(obj);
}

function mergeRequisitosVehiculo(partial) {
  let tipo = TIPOS_VEHICULO.includes(partial.tipo_vehiculo) ? partial.tipo_vehiculo : null;
  if (!tipo && partial.tipos_condicion && typeof partial.tipos_condicion === 'object') {
    const tc = partial.tipos_condicion;
    if (tc.nuevo) tipo = 'nuevo';
    else if (tc.seminuevo) tipo = 'seminuevo';
    else if (tc.semiusado) tipo = 'semiusado';
  }
  if (!tipo) tipo = 'nuevo';
  return { tipo_vehiculo: tipo };
}

function defaultRequisitosGastosVehiculo() {
  return {
    todo_riesgo_y_gps_modo: 'separado',
    src: {
      monto: 0,
      moneda: 'USD',
      cobro: { tipo: 'mensual_antes_vencimiento', meses_anticipo: 5 },
    },
    gps: {
      monto: 0,
      moneda: 'PEN',
      cobro: { tipo: 'mensual', dia_mes: 28 },
    },
    soat: {
      monto: 0,
      moneda: 'PEN',
      cobro: { tipo: 'mensual_antes_vencimiento', meses_anticipo: 5 },
    },
    impuesto_vehicular: {
      monto: 0,
      moneda: 'PEN',
      cobro: {
        tipo: 'sat_febrero_cuotas',
        mes_inicio: 2,
        cuotas: 4,
        anios_vigencia_tras_modelo: 3,
      },
    },
    todo_riesgo: {
      monto: 0,
      moneda: 'PEN',
      cobro: { tipo: 'semanal', semanas: 26 },
    },
    todo_riesgo_mas_gps_agrupado: {
      monto: 0,
      moneda: 'PEN',
      cobro: { tipo: 'semanal', semanas: 26 },
    },
  };
}

/** @param {any} raw - JSONB por fila module_miauto_cronograma_vehiculo */
export function parseRequisitosGastosVehiculo(raw) {
  let obj = raw;
  if (raw == null) return defaultRequisitosGastosVehiculo();
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return defaultRequisitosGastosVehiculo();
    }
  }
  if (typeof obj !== 'object' || obj === null) return defaultRequisitosGastosVehiculo();
  return mergeRequisitosGastosVehiculo(obj);
}

function mergeRequisitosGastosVehiculo(partial) {
  const d = defaultRequisitosGastosVehiculo();
  d.todo_riesgo_y_gps_modo = partial.todo_riesgo_y_gps_modo === 'agrupado' ? 'agrupado' : 'separado';

  const mergeMonto = (key, defMoneda = 'PEN') => {
    const x = partial[key];
    if (!x || typeof x !== 'object') return;
    const moneda = x.moneda === 'USD' ? 'USD' : x.moneda === 'PEN' ? 'PEN' : defMoneda;
    d[key] = {
      ...d[key],
      monto: Math.max(0, parseFloat(x.monto) || 0),
      moneda,
    };
    if (x.cobro && typeof x.cobro === 'object') {
      const c = x.cobro;
      if (key === 'src' || key === 'soat') {
        d[key].cobro = {
          tipo: c.tipo || 'mensual_antes_vencimiento',
          meses_anticipo: Math.min(12, Math.max(1, parseInt(c.meses_anticipo, 10) || 5)),
        };
      } else if (key === 'gps') {
        d[key].cobro = {
          tipo: c.tipo || 'mensual',
          dia_mes: Math.min(28, Math.max(1, parseInt(c.dia_mes, 10) || 28)),
        };
      } else if (key === 'impuesto_vehicular') {
        d[key].cobro = {
          tipo: c.tipo || 'sat_febrero_cuotas',
          mes_inicio: 2,
          cuotas: Math.min(12, Math.max(1, parseInt(c.cuotas, 10) || 4)),
          anios_vigencia_tras_modelo: Math.min(10, Math.max(1, parseInt(c.anios_vigencia_tras_modelo, 10) || 3)),
        };
      } else if (key === 'todo_riesgo' || key === 'todo_riesgo_mas_gps_agrupado') {
        d[key].cobro = {
          tipo: c.tipo || 'semanal',
          semanas: Math.min(52, Math.max(1, parseInt(c.semanas, 10) || 26)),
        };
      }
    }
  };

  mergeMonto('src', 'USD');
  mergeMonto('gps');
  mergeMonto('soat');
  mergeMonto('impuesto_vehicular');
  mergeMonto('todo_riesgo');
  mergeMonto('todo_riesgo_mas_gps_agrupado');

  return d;
}

/**
 * Parsea el campo "viajes" de una fila del cronograma (ej: "0 - 119", "120-239", "400+").
 * @param {string} viajesStr - Ej: "0 - 119", "0-119", "400+", "400"
 * @returns {{ min: number, max: number } | null} - Intervalo [min, max] inclusive; null si no se puede parsear
 */
export function parseViajesInterval(viajesStr) {
  if (!viajesStr || typeof viajesStr !== 'string') return null;
  const s = viajesStr.trim();
  if (!s) return null;
  // "400+" → min 400, max infinito
  const plusMatch = s.match(/^(\d+)\s*\+$/);
  if (plusMatch) {
    const min = parseInt(plusMatch[1], 10);
    if (Number.isNaN(min) || min < 0) return null;
    return { min, max: Number.POSITIVE_INFINITY };
  }
  // "0 - 119" o "0-119" → dos números
  const parts = s.split(/\s*-\s*/).map((p) => p.trim());
  if (parts.length >= 2) {
    const min = parseInt(parts[0], 10);
    const max = parseInt(parts[1], 10);
    if (!Number.isNaN(min) && !Number.isNaN(max) && min >= 0 && max >= min) {
      return { min, max };
    }
  }
  // Un solo número "400" → intervalo exacto
  const single = parseInt(s, 10);
  if (!Number.isNaN(single) && single >= 0) return { min: single, max: single };
  return null;
}

/**
 * Devuelve el mínimo del intervalo de viajes de una regla (para usar como inicio del rango en contexto).
 * @param {{ viajes: string }} rule
 * @returns {number | null}
 */
function getMinViajesForRule(rule) {
  const interval = parseViajesInterval(rule.viajes);
  return interval ? interval.min : null;
}

/** Umbral suelto ("89", "150"), no rango explícito ("0 - 119", "150+"). */
function isThresholdOnlyViajesLabel(viajesStr) {
  if (!viajesStr || typeof viajesStr !== 'string') return false;
  const s = viajesStr.trim();
  if (!s) return false;
  if (/^\d+\s*\+$/.test(s)) return false;
  if (s.includes('-')) return false;
  const n = parseInt(s, 10);
  return !Number.isNaN(n) && n >= 0;
}

/**
 * Rango colapsado "120-120" o "120 - 120" (mismo min/max): en UI a veces se guarda así en vez de "120".
 * Debe comportarse como umbral [120, siguiente tramo) igual que el número suelto "120".
 */
function isCollapsedPointRange(viajesStr, interval) {
  if (!viajesStr || typeof viajesStr !== 'string' || !interval) return false;
  if (interval.min !== interval.max) return false;
  if (!viajesStr.includes('-')) return false;
  return true;
}

/** Si la regla es un solo punto (120 o 120-120), expandir hasta el inicio del siguiente tramo. */
function shouldExpandPointRuleToNextSegment(viajesStr, interval) {
  if (!interval || interval.min !== interval.max) return false;
  return isThresholdOnlyViajesLabel(viajesStr) || isCollapsedPointRange(viajesStr, interval);
}

/**
 * Menor inicio de intervalo entre las demás reglas con min > currentMin (no depende del orden en el array).
 * Así 132 entra en [120,149] aunque la fila "150" esté antes o después en la lista.
 */
function getNextSegmentMinAfter(rules, excludeIndex, currentMin) {
  let best = null;
  for (let j = 0; j < rules.length; j++) {
    if (j === excludeIndex) continue;
    const m = getMinViajesForRule(rules[j]);
    if (typeof m === 'number' && m > currentMin) {
      if (best == null || m < best) best = m;
    }
  }
  return best;
}

/**
 * Moneda persistida en `module_miauto_cuota_semanal.moneda`.
 * Sale de la regla del cronograma (`cuota_moneda_por_vehiculo` por índice de carro), no del país ni de `inicial_moneda` del vehículo.
 */
export function resolveMonedaCuotaSemanal(_cronograma, rule, vehicleIndex) {
  const arr = rule?.cuota_moneda_por_vehiculo || [];
  return vehicleIndex >= 0 && arr[vehicleIndex] === 'USD' ? 'USD' : 'PEN';
}

/**
 * Moneda de las cuotas semanales para un vehículo en el cronograma (`cuota_moneda_por_vehiculo` en las reglas).
 * Puede diferir de `inicial_moneda` del vehículo (ej. cuota inicial en USD y cuotas semanales en PEN o USD según la regla).
 */
export function getMonedaCuotaSemanalPorVehiculo(cronograma, cronogramaVehiculoId) {
  if (!cronograma?.rules?.length) return 'PEN';
  const vehicles = cronograma.vehicles || [];
  const vehicleIndex = vehicles.findIndex((v) => v.id === cronogramaVehiculoId);
  if (vehicleIndex < 0) return 'PEN';
  for (const rule of cronograma.rules) {
    const arr = rule.cuota_moneda_por_vehiculo || [];
    const m = arr[vehicleIndex];
    if (m === 'USD' || m === 'PEN') return m;
  }
  return 'PEN';
}

/** Intervalo efectivo [min,max] de una regla respecto al resto del cronograma. */
function expandIntervalForRule(rule, rules, ruleIndex) {
  let interval = parseViajesInterval(rule.viajes);
  if (!interval) return null;
  if (shouldExpandPointRuleToNextSegment(rule.viajes, interval)) {
    const nextMin = getNextSegmentMinAfter(rules, ruleIndex, interval.min);
    if (nextMin != null) {
      interval = { min: interval.min, max: nextMin - 1 };
    } else {
      interval = { min: interval.min, max: Number.POSITIVE_INFINITY };
    }
  }
  return interval;
}

export function getRuleForTripCount(rules, numViajes) {
  if (!Array.isArray(rules) || rules.length === 0 || numViajes == null || numViajes < 0) return null;
  const n = Number(numViajes);
  if (Number.isNaN(n)) return null;
  let floorRule = null;
  let floorMinStart = Infinity;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const interval = expandIntervalForRule(rule, rules, i);
    if (!interval) continue;
    if (interval.min < floorMinStart) {
      floorMinStart = interval.min;
      floorRule = rule;
    }
    if (n >= interval.min && n <= interval.max) return rule;
  }
  // Debajo del tramo mínimo del cronograma (ej. menos de 89 viajes): misma cuota que el tramo con menor umbral.
  if (floorRule != null && n < floorMinStart) return floorRule;
  return null;
}

/**
 * Solo id + name + country (combos / filtros). Sin vehículos ni reglas.
 */
export async function listCronogramasLite(filters = {}) {
  const { country, active } = filters;
  const params = [];
  let n = 1;
  let where = ' WHERE 1=1 ';
  if (country) {
    where += ` AND c.country = $${n}`;
    params.push(country);
    n += 1;
  }
  if (active !== undefined && active !== null && active !== '') {
    where += ` AND c.active = $${n}`;
    params.push(!!active);
    n += 1;
  }
  const listRes = await query(
    `SELECT c.id, c.name FROM module_miauto_cronograma c ${where} ORDER BY c.name`,
    params
  );
  return (listRes.rows || []).map((row) => ({
    id: row.id,
    name: row.name,
  }));
}

export async function listCronogramas(filters = {}) {
  const { country, active } = filters;
  const params = [];
  let n = 1;
  let where = ' WHERE 1=1 ';
  if (country) {
    where += ` AND c.country = $${n}`;
    params.push(country);
    n += 1;
  }
  if (active !== undefined && active !== null && active !== '') {
    where += ` AND c.active = $${n}`;
    params.push(!!active);
    n += 1;
  }

  const listRes = await query(
    `SELECT c.id, c.name, c.country, c.active, c.tasa_interes_mora, c.bono_tiempo_activo, c.cuotas_otros_gastos, c.requisitos_vehiculo FROM module_miauto_cronograma c ${where} ORDER BY c.name`,
    params
  );

  const rows = listRes.rows || [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const [vehiclesRes, rulesRes] = await Promise.all([
    query(
      `SELECT id, cronograma_id, name, inicial, inicial_moneda, cuotas_semanales, image, orden, requisitos_gastos
       FROM module_miauto_cronograma_vehiculo WHERE cronograma_id IN (${placeholders}) ORDER BY cronograma_id, orden`,
      ids
    ),
    query(
      `SELECT id, cronograma_id, viajes, bono_auto, bono_auto_moneda, cuotas_por_vehiculo, cuota_moneda_por_vehiculo, orden, pct_comision
       FROM module_miauto_cronograma_rule WHERE cronograma_id IN (${placeholders}) ORDER BY cronograma_id, orden`,
      ids
    ),
  ]);

  const vehiclesByCron = {};
  for (const v of vehiclesRes.rows || []) {
    const cid = v.cronograma_id;
    if (!vehiclesByCron[cid]) vehiclesByCron[cid] = [];
    vehiclesByCron[cid].push({
      id: v.id,
      name: v.name,
      inicial: parseFloat(v.inicial) || 0,
      inicial_moneda: v.inicial_moneda || 'USD',
      cuotas_semanales: parseInt(v.cuotas_semanales, 10) || 0,
      image: v.image || undefined,
      requisitos_gastos: parseRequisitosGastosVehiculo(v.requisitos_gastos),
    });
  }
  const rulesByCron = {};
  for (const r of rulesRes.rows || []) {
    const cid = r.cronograma_id;
    if (!rulesByCron[cid]) rulesByCron[cid] = [];
    rulesByCron[cid].push({
      id: r.id,
      viajes: r.viajes || '',
      bono_auto: parseFloat(r.bono_auto) || 0,
      bono_auto_moneda: r.bono_auto_moneda || 'PEN',
      cuotas_por_vehiculo: Array.isArray(r.cuotas_por_vehiculo) ? r.cuotas_por_vehiculo : [],
      cuota_moneda_por_vehiculo: Array.isArray(r.cuota_moneda_por_vehiculo) ? r.cuota_moneda_por_vehiculo : [],
    });
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    country: row.country,
    active: row.active,
    tasa_interes_mora: parseFloat(row.tasa_interes_mora) || 0,
    bono_tiempo_activo: !!row.bono_tiempo_activo,
    cuotas_otros_gastos: row.cuotas_otros_gastos != null ? parseInt(row.cuotas_otros_gastos, 10) : 26,
    requisitos_vehiculo: parseRequisitosVehiculo(row.requisitos_vehiculo),
    vehicles: vehiclesByCron[row.id] || [],
    rules: rulesByCron[row.id] || [],
  }));
}

export async function getCronogramaById(id) {
  const res = await query(
    'SELECT id, name, country, active, tasa_interes_mora, bono_tiempo_activo, cuotas_otros_gastos, requisitos_vehiculo, created_at, updated_at FROM module_miauto_cronograma WHERE id = $1',
    [id]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  const vehicles = await query(
    'SELECT id, name, inicial, inicial_moneda, cuotas_semanales, image, orden FROM module_miauto_cronograma_vehiculo WHERE cronograma_id = $1 ORDER BY orden, created_at',
    [id]
  );
  const rules = await query(
    'SELECT id, viajes, bono_auto, bono_auto_moneda, cuotas_por_vehiculo, cuota_moneda_por_vehiculo, orden, pct_comision FROM module_miauto_cronograma_rule WHERE cronograma_id = $1 ORDER BY orden, created_at',
    [id]
  );
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    active: row.active,
    tasa_interes_mora: parseFloat(row.tasa_interes_mora) || 0,
    bono_tiempo_activo: !!row.bono_tiempo_activo,
    cuotas_otros_gastos: row.cuotas_otros_gastos != null ? parseInt(row.cuotas_otros_gastos, 10) : 26,
    requisitos_vehiculo: parseRequisitosVehiculo(row.requisitos_vehiculo),
    vehicles: (vehicles.rows || []).map((v) => ({
      id: v.id,
      name: v.name,
      inicial: parseFloat(v.inicial) || 0,
      inicial_moneda: v.inicial_moneda || 'USD',
      cuotas_semanales: parseInt(v.cuotas_semanales, 10) || 0,
      image: v.image || undefined,
      requisitos_gastos: parseRequisitosGastosVehiculo(v.requisitos_gastos),
    })),
    rules: (rules.rows || []).map((r) => ({
      id: r.id,
      viajes: r.viajes || '',
      bono_auto: parseFloat(r.bono_auto) || 0,
      bono_auto_moneda: r.bono_auto_moneda || 'PEN',
      cuotas_por_vehiculo: Array.isArray(r.cuotas_por_vehiculo) ? r.cuotas_por_vehiculo : [],
      cuota_moneda_por_vehiculo: Array.isArray(r.cuota_moneda_por_vehiculo) ? r.cuota_moneda_por_vehiculo : [],
      pct_comision: r.pct_comision != null ? parseFloat(r.pct_comision) : 0,
    })),
  };
}

/**
 * Carga varios cronogramas en batch (3 queries en total: cabecera + vehículos + reglas).
 * Evita N×getCronogramaById en listados (p. ej. Alquiler/Venta).
 * @param {string[]} ids - UUIDs de module_miauto_cronograma
 * @returns {Promise<Map<string, object>>}
 */
export async function getCronogramasByIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (unique.length === 0) return new Map();

  const listRes = await query(
    `SELECT c.id, c.name, c.country, c.active, c.tasa_interes_mora, c.bono_tiempo_activo, c.cuotas_otros_gastos, c.requisitos_vehiculo
     FROM module_miauto_cronograma c WHERE c.id = ANY($1::uuid[])`,
    [unique]
  );
  const rows = listRes.rows || [];
  if (rows.length === 0) return new Map();

  const crIds = rows.map((r) => r.id);
  const placeholders = crIds.map((_, i) => `$${i + 1}`).join(', ');
  const [vehiclesRes, rulesRes] = await Promise.all([
    query(
      `SELECT id, cronograma_id, name, inicial, inicial_moneda, cuotas_semanales, image, orden, requisitos_gastos
       FROM module_miauto_cronograma_vehiculo WHERE cronograma_id IN (${placeholders}) ORDER BY cronograma_id, orden`,
      crIds
    ),
    query(
      `SELECT id, cronograma_id, viajes, bono_auto, bono_auto_moneda, cuotas_por_vehiculo, cuota_moneda_por_vehiculo, orden, pct_comision
       FROM module_miauto_cronograma_rule WHERE cronograma_id IN (${placeholders}) ORDER BY cronograma_id, orden`,
      crIds
    ),
  ]);

  const vehiclesByCron = {};
  for (const v of vehiclesRes.rows || []) {
    const cid = v.cronograma_id;
    if (!vehiclesByCron[cid]) vehiclesByCron[cid] = [];
    vehiclesByCron[cid].push({
      id: v.id,
      name: v.name,
      inicial: parseFloat(v.inicial) || 0,
      inicial_moneda: v.inicial_moneda || 'USD',
      cuotas_semanales: parseInt(v.cuotas_semanales, 10) || 0,
      image: v.image || undefined,
      requisitos_gastos: parseRequisitosGastosVehiculo(v.requisitos_gastos),
    });
  }
  const rulesByCron = {};
  for (const r of rulesRes.rows || []) {
    const cid = r.cronograma_id;
    if (!rulesByCron[cid]) rulesByCron[cid] = [];
    rulesByCron[cid].push({
      id: r.id,
      viajes: r.viajes || '',
      bono_auto: parseFloat(r.bono_auto) || 0,
      bono_auto_moneda: r.bono_auto_moneda || 'PEN',
      cuotas_por_vehiculo: Array.isArray(r.cuotas_por_vehiculo) ? r.cuotas_por_vehiculo : [],
      cuota_moneda_por_vehiculo: Array.isArray(r.cuota_moneda_por_vehiculo) ? r.cuota_moneda_por_vehiculo : [],
      pct_comision: r.pct_comision != null ? parseFloat(r.pct_comision) : 0,
    });
  }

  const map = new Map();
  for (const row of rows) {
    const id = row.id;
    map.set(String(id), {
      id,
      name: row.name,
      country: row.country,
      active: row.active,
      tasa_interes_mora: parseFloat(row.tasa_interes_mora) || 0,
      bono_tiempo_activo: !!row.bono_tiempo_activo,
      cuotas_otros_gastos: row.cuotas_otros_gastos != null ? parseInt(row.cuotas_otros_gastos, 10) : 26,
      requisitos_vehiculo: parseRequisitosVehiculo(row.requisitos_vehiculo),
      vehicles: vehiclesByCron[id] || [],
      rules: rulesByCron[id] || [],
    });
  }
  return map;
}

function normalizeTasaInteresMora(value) {
  if (value == null || value === '') return 0;
  const num = parseFloat(value);
  if (Number.isNaN(num) || num < 0) return 0;
  return num > 1 ? num / 100 : num;
}

function normalizeCuotasOtrosGastos(value) {
  if (value == null || value === '') return 26;
  const num = parseInt(value, 10);
  if (Number.isNaN(num) || num < 1) return 26;
  return Math.min(99, num);
}

export async function createCronograma(data) {
  const {
    name,
    country = 'PE',
    active = true,
    tasa_interes_mora,
    bono_tiempo_activo = false,
    cuotas_otros_gastos,
    requisitos_vehiculo: reqRaw,
    vehicles = [],
    rules = [],
  } = data;
  const tasa = normalizeTasaInteresMora(tasa_interes_mora);
  const nOtros = normalizeCuotasOtrosGastos(cuotas_otros_gastos);
  const reqJson = JSON.stringify(mergeRequisitosVehiculo(reqRaw && typeof reqRaw === 'object' ? reqRaw : {}));
  const ins = await query(
    'INSERT INTO module_miauto_cronograma (name, country, active, tasa_interes_mora, bono_tiempo_activo, cuotas_otros_gastos, requisitos_vehiculo) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id',
    [String(name).trim() || 'Sin nombre', country, !!active, tasa, !!bono_tiempo_activo, nOtros, reqJson]
  );
  const cronogramaId = ins.rows[0].id;

  const insertVehicles =
    vehicles.length > 0
      ? (() => {
          const vParams = [];
          const vPlaceholders = [];
          vehicles.forEach((v, i) => {
            const base = vParams.length + 1;
            vPlaceholders.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb)`);
            const reqG = mergeRequisitosGastosVehiculo(v.requisitos_gastos && typeof v.requisitos_gastos === 'object' ? v.requisitos_gastos : {});
            vParams.push(
              cronogramaId,
              (v.name && String(v.name).trim()) || '',
              parseFloat(v.inicial) || 0,
              v.inicial_moneda === 'PEN' ? 'PEN' : 'USD',
              parseInt(v.cuotas_semanales, 10) || 0,
              v.image || null,
              i,
              JSON.stringify(reqG)
            );
          });
          return query(
            `INSERT INTO module_miauto_cronograma_vehiculo (cronograma_id, name, inicial, inicial_moneda, cuotas_semanales, image, orden, requisitos_gastos) VALUES ${vPlaceholders.join(', ')}`,
            vParams
          );
        })()
      : Promise.resolve();
  const insertRules =
    rules.length > 0
      ? (() => {
          const rParams = [];
          const rPlaceholders = [];
          rules.forEach((r, i) => {
            const cuotas = Array.isArray(r.cuotas_por_vehiculo) ? r.cuotas_por_vehiculo : [];
            const monedas = Array.isArray(r.cuota_moneda_por_vehiculo) ? r.cuota_moneda_por_vehiculo : [];
            const base = rParams.length + 1;
            rPlaceholders.push(
              `($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}::jsonb, $${base + 6}, $${base + 7})`
            );
            rParams.push(
              cronogramaId,
              (r.viajes && String(r.viajes).trim()) || '',
              parseFloat(r.bono_auto) || 0,
              r.bono_auto_moneda === 'USD' ? 'USD' : 'PEN',
              JSON.stringify(cuotas),
              JSON.stringify(monedas),
              i,
              parseFloat(r.pct_comision) || 0
            );
          });
          return query(
            `INSERT INTO module_miauto_cronograma_rule (cronograma_id, viajes, bono_auto, bono_auto_moneda, cuotas_por_vehiculo, cuota_moneda_por_vehiculo, orden, pct_comision) VALUES ${rPlaceholders.join(', ')}`,
            rParams
          );
        })()
      : Promise.resolve();
  await Promise.all([insertVehicles, insertRules]);

  return getCronogramaById(cronogramaId);
}

export async function updateCronograma(id, data) {
  const existing = await query('SELECT id, name, country, active, tasa_interes_mora, bono_tiempo_activo, cuotas_otros_gastos FROM module_miauto_cronograma WHERE id = $1', [id]);
  if (existing.rows.length === 0) return null;
  const row = existing.rows[0];
  const { name, country, active, tasa_interes_mora, bono_tiempo_activo, cuotas_otros_gastos, requisitos_vehiculo: reqRaw, vehicles = [], rules = [] } = data;
  const tasa = tasa_interes_mora !== undefined ? normalizeTasaInteresMora(tasa_interes_mora) : null;
  const updates = ['name = $2', 'country = $3', 'active = $4', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [
    id,
    name != null ? String(name).trim() || 'Sin nombre' : row.name,
    country || row.country || 'PE',
    active !== undefined ? !!active : row.active,
  ];
  let p = 5;
  if (tasa !== null) {
    updates.push(`tasa_interes_mora = $${p++}`);
    params.push(tasa);
  }
  if (bono_tiempo_activo !== undefined) {
    updates.push(`bono_tiempo_activo = $${p++}`);
    params.push(!!bono_tiempo_activo);
  }
  if (cuotas_otros_gastos !== undefined) {
    updates.push(`cuotas_otros_gastos = $${p++}`);
    params.push(normalizeCuotasOtrosGastos(cuotas_otros_gastos));
  }
  if (reqRaw !== undefined) {
    updates.push(`requisitos_vehiculo = $${p++}::jsonb`);
    params.push(JSON.stringify(mergeRequisitosVehiculo(reqRaw && typeof reqRaw === 'object' ? reqRaw : {})));
  }
  await query(`UPDATE module_miauto_cronograma SET ${updates.join(', ')} WHERE id = $1`, params);

  await Promise.all([
    query('DELETE FROM module_miauto_cronograma_vehiculo WHERE cronograma_id = $1', [id]),
    query('DELETE FROM module_miauto_cronograma_rule WHERE cronograma_id = $1', [id]),
  ]);

  const insertVehicles =
    vehicles.length > 0
      ? (() => {
          const vParams = [];
          const vPlaceholders = [];
          vehicles.forEach((v, i) => {
            const base = vParams.length + 1;
            vPlaceholders.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb)`);
            const reqG = mergeRequisitosGastosVehiculo(v.requisitos_gastos && typeof v.requisitos_gastos === 'object' ? v.requisitos_gastos : {});
            vParams.push(
              id,
              (v.name && String(v.name).trim()) || '',
              parseFloat(v.inicial) || 0,
              v.inicial_moneda === 'PEN' ? 'PEN' : 'USD',
              parseInt(v.cuotas_semanales, 10) || 0,
              v.image || null,
              i,
              JSON.stringify(reqG)
            );
          });
          return query(
            `INSERT INTO module_miauto_cronograma_vehiculo (cronograma_id, name, inicial, inicial_moneda, cuotas_semanales, image, orden, requisitos_gastos) VALUES ${vPlaceholders.join(', ')}`,
            vParams
          );
        })()
      : Promise.resolve();
  const insertRules =
    rules.length > 0
      ? (() => {
          const rParams = [];
          const rPlaceholders = [];
          rules.forEach((r, i) => {
            const cuotas = Array.isArray(r.cuotas_por_vehiculo) ? r.cuotas_por_vehiculo : [];
            const monedas = Array.isArray(r.cuota_moneda_por_vehiculo) ? r.cuota_moneda_por_vehiculo : [];
            const base = rParams.length + 1;
            rPlaceholders.push(
              `($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}::jsonb, $${base + 6}, $${base + 7})`
            );
            rParams.push(
              id,
              (r.viajes && String(r.viajes).trim()) || '',
              parseFloat(r.bono_auto) || 0,
              r.bono_auto_moneda === 'USD' ? 'USD' : 'PEN',
              JSON.stringify(cuotas),
              JSON.stringify(monedas),
              i,
              parseFloat(r.pct_comision) || 0
            );
          });
          return query(
            `INSERT INTO module_miauto_cronograma_rule (cronograma_id, viajes, bono_auto, bono_auto_moneda, cuotas_por_vehiculo, cuota_moneda_por_vehiculo, orden, pct_comision) VALUES ${rPlaceholders.join(', ')}`,
            rParams
          );
        })()
      : Promise.resolve();
  await Promise.all([insertVehicles, insertRules]);

  return getCronogramaById(id);
}

export async function deleteCronograma(id) {
  const res = await query('DELETE FROM module_miauto_cronograma WHERE id = $1 RETURNING id', [id]);
  return res.rowCount > 0;
}

export async function toggleCronogramaActive(id) {
  const res = await query('UPDATE module_miauto_cronograma SET active = NOT COALESCE(active, true), updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id', [id]);
  if (res.rowCount === 0) return null;
  return getCronogramaById(id);
}
