import { query } from '../config/database.js';

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
 * Dado un array de rules (con campo viajes) y un número de viajes, devuelve la regla cuyo intervalo contiene ese número.
 * Las rules se evalúan en orden; la primera cuyo intervalo incluya numViajes es la que aplica (bono auto y cuotas por carro).
 * @param {Array<{ viajes: string, [key: string]: any }>} rules - Filas del cronograma ordenadas por orden
 * @param {number} numViajes - Número de viajes del conductor
 * @returns {object | null} - La regla que aplica o null si ninguna coincide
 */
export function getRuleForTripCount(rules, numViajes) {
  if (!Array.isArray(rules) || rules.length === 0 || numViajes == null || numViajes < 0) return null;
  const n = Number(numViajes);
  if (Number.isNaN(n)) return null;
  for (const rule of rules) {
    const interval = parseViajesInterval(rule.viajes);
    if (!interval) continue;
    if (n >= interval.min && n <= interval.max) return rule;
  }
  return null;
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
    `SELECT c.id, c.name, c.country, c.active, c.tasa_interes_mora FROM module_miauto_cronograma c ${where} ORDER BY c.name`,
    params
  );

  const rows = listRes.rows || [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const [vehiclesRes, rulesRes] = await Promise.all([
    query(
      `SELECT id, cronograma_id, name, inicial, inicial_moneda, cuotas_semanales, image, orden
       FROM module_miauto_cronograma_vehiculo WHERE cronograma_id IN (${placeholders}) ORDER BY cronograma_id, orden`,
      ids
    ),
    query(
      `SELECT id, cronograma_id, viajes, bono_auto, bono_auto_moneda, cuotas_por_vehiculo, cuota_moneda_por_vehiculo, orden
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
    vehicles: vehiclesByCron[row.id] || [],
    rules: rulesByCron[row.id] || [],
  }));
}

export async function getCronogramaById(id) {
  const res = await query('SELECT id, name, country, active, tasa_interes_mora, created_at, updated_at FROM module_miauto_cronograma WHERE id = $1', [id]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  const vehicles = await query(
    'SELECT id, name, inicial, inicial_moneda, cuotas_semanales, image, orden FROM module_miauto_cronograma_vehiculo WHERE cronograma_id = $1 ORDER BY orden, created_at',
    [id]
  );
  const rules = await query(
    'SELECT id, viajes, bono_auto, bono_auto_moneda, cuotas_por_vehiculo, cuota_moneda_por_vehiculo, orden FROM module_miauto_cronograma_rule WHERE cronograma_id = $1 ORDER BY orden, created_at',
    [id]
  );
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    active: row.active,
    tasa_interes_mora: parseFloat(row.tasa_interes_mora) || 0,
    vehicles: (vehicles.rows || []).map((v) => ({
      id: v.id,
      name: v.name,
      inicial: parseFloat(v.inicial) || 0,
      inicial_moneda: v.inicial_moneda || 'USD',
      cuotas_semanales: parseInt(v.cuotas_semanales, 10) || 0,
      image: v.image || undefined,
    })),
    rules: (rules.rows || []).map((r) => ({
      id: r.id,
      viajes: r.viajes || '',
      bono_auto: parseFloat(r.bono_auto) || 0,
      bono_auto_moneda: r.bono_auto_moneda || 'PEN',
      cuotas_por_vehiculo: Array.isArray(r.cuotas_por_vehiculo) ? r.cuotas_por_vehiculo : [],
      cuota_moneda_por_vehiculo: Array.isArray(r.cuota_moneda_por_vehiculo) ? r.cuota_moneda_por_vehiculo : [],
    })),
  };
}

function normalizeTasaInteresMora(value) {
  if (value == null || value === '') return 0;
  const num = parseFloat(value);
  if (Number.isNaN(num) || num < 0) return 0;
  return num > 1 ? num / 100 : num;
}

export async function createCronograma(data) {
  const { name, country = 'PE', active = true, tasa_interes_mora, vehicles = [], rules = [] } = data;
  const tasa = normalizeTasaInteresMora(tasa_interes_mora);
  const ins = await query(
    'INSERT INTO module_miauto_cronograma (name, country, active, tasa_interes_mora) VALUES ($1, $2, $3, $4) RETURNING id',
    [String(name).trim() || 'Sin nombre', country, !!active, tasa]
  );
  const cronogramaId = ins.rows[0].id;

  const insertVehicles =
    vehicles.length > 0
      ? (() => {
          const vParams = [];
          const vPlaceholders = [];
          vehicles.forEach((v, i) => {
            const base = vParams.length + 1;
            vPlaceholders.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
            vParams.push(
              cronogramaId,
              (v.name && String(v.name).trim()) || '',
              parseFloat(v.inicial) || 0,
              v.inicial_moneda === 'PEN' ? 'PEN' : 'USD',
              parseInt(v.cuotas_semanales, 10) || 0,
              v.image || null,
              i
            );
          });
          return query(
            `INSERT INTO module_miauto_cronograma_vehiculo (cronograma_id, name, inicial, inicial_moneda, cuotas_semanales, image, orden) VALUES ${vPlaceholders.join(', ')}`,
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
            rPlaceholders.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}::jsonb, $${base + 6})`);
            rParams.push(
              cronogramaId,
              (r.viajes && String(r.viajes).trim()) || '',
              parseFloat(r.bono_auto) || 0,
              r.bono_auto_moneda === 'USD' ? 'USD' : 'PEN',
              JSON.stringify(cuotas),
              JSON.stringify(monedas),
              i
            );
          });
          return query(
            `INSERT INTO module_miauto_cronograma_rule (cronograma_id, viajes, bono_auto, bono_auto_moneda, cuotas_por_vehiculo, cuota_moneda_por_vehiculo, orden) VALUES ${rPlaceholders.join(', ')}`,
            rParams
          );
        })()
      : Promise.resolve();
  await Promise.all([insertVehicles, insertRules]);

  return getCronogramaById(cronogramaId);
}

export async function updateCronograma(id, data) {
  const existing = await query('SELECT id FROM module_miauto_cronograma WHERE id = $1', [id]);
  if (existing.rows.length === 0) return null;

  const { name, country, active, tasa_interes_mora, vehicles = [], rules = [] } = data;
  const tasa = tasa_interes_mora !== undefined ? normalizeTasaInteresMora(tasa_interes_mora) : null;
  const updates = ['name = $2', 'country = $3', 'active = $4', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [
    id,
    name != null ? String(name).trim() || 'Sin nombre' : existing.rows[0].name,
    country || 'PE',
    active !== undefined ? !!active : true,
  ];
  if (tasa !== null) {
    updates.push('tasa_interes_mora = $5');
    params.push(tasa);
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
            vPlaceholders.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
            vParams.push(
              id,
              (v.name && String(v.name).trim()) || '',
              parseFloat(v.inicial) || 0,
              v.inicial_moneda === 'PEN' ? 'PEN' : 'USD',
              parseInt(v.cuotas_semanales, 10) || 0,
              v.image || null,
              i
            );
          });
          return query(
            `INSERT INTO module_miauto_cronograma_vehiculo (cronograma_id, name, inicial, inicial_moneda, cuotas_semanales, image, orden) VALUES ${vPlaceholders.join(', ')}`,
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
            rPlaceholders.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}::jsonb, $${base + 6})`);
            rParams.push(
              id,
              (r.viajes && String(r.viajes).trim()) || '',
              parseFloat(r.bono_auto) || 0,
              r.bono_auto_moneda === 'USD' ? 'USD' : 'PEN',
              JSON.stringify(cuotas),
              JSON.stringify(monedas),
              i
            );
          });
          return query(
            `INSERT INTO module_miauto_cronograma_rule (cronograma_id, viajes, bono_auto, bono_auto_moneda, cuotas_por_vehiculo, cuota_moneda_por_vehiculo, orden) VALUES ${rPlaceholders.join(', ')}`,
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
