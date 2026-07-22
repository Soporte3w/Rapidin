import { getClient, query } from '../../config/database.js';
import {
  assertMimotoIsolationSql,
  normalizeColombianDocument,
  normalizeColombianPhone,
  normalizeMimotoCurrency,
  parseMimotoRuleRange,
} from './mimotoFinancialEngine.js';
import { positiveNumber } from './mimotoServiceUtils.js';

const q = (sql, params = []) => query(assertMimotoIsolationSql(sql), params);
const LIVE_CRONOGRAMA_NAME_SQL = "COALESCE(NULLIF(c.name,''), NULLIF(s.cronograma_snapshot->>'name',''))";
const LIVE_VEHICLE_NAME_SQL = "COALESCE(NULLIF(v.name,''), NULLIF(s.cronograma_snapshot->'vehicle'->>'name',''))";
const LIVE_VEHICLE_IMAGE_SQL = `CASE WHEN v.id IS NOT NULL
  THEN NULLIF(v.metadata->>'image','')
  ELSE NULLIF(s.cronograma_snapshot->'vehicle'->'metadata'->>'image','')
END`;

function optionalUuid(value) {
  const text = String(value || '').trim();
  return text || null;
}

function requiredText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${field} es requerido`);
  return text;
}

function strictBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeWeeklyLateFeeRate(value) {
  if (value == null || value === '') return 0;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error('La tasa semanal de mora debe estar entre 0 y 1');
  }
  return rate;
}

function remapVehicleValues(values, vehicleIds) {
  if (Array.isArray(values)) {
    return values.map((item, index) => {
      if (item == null || typeof item !== 'object') return item;
      const sourceId = String(item.vehiculo_id || item.id || index);
      const targetId = vehicleIds.get(sourceId) || vehicleIds.get(String(index));
      if (!targetId) throw new Error('Una regla referencia una moto inexistente');
      const rest = { ...item };
      delete rest.id;
      delete rest.vehiculo_id;
      return { ...rest, vehiculo_id: targetId };
    });
  }
  if (values && typeof values === 'object') {
    return Object.entries(values).reduce((result, [sourceId, value]) => {
      const targetId = vehicleIds.get(sourceId);
      if (!targetId) throw new Error('Una regla referencia una moto inexistente');
      result[targetId] = value;
      return result;
    }, {});
  }
  return [];
}

function normalizeEvaluationMode(value) {
  const mode = String(value || 'viajes').trim().toLowerCase();
  if (!['viajes', 'viajes_horas'].includes(mode)) throw new Error('El criterio debe ser viajes o viajes y horas');
  return mode;
}

function validateRuleRanges(rules, evaluationMode) {
  const ranges = rules.map((rule, index) => {
    const viajes = requiredText(rule.viajes, `Los viajes de la fila ${index + 1}`);
    if (!/\d/.test(viajes)) throw new Error(`Los viajes de la fila ${index + 1} no son válidos`);
    const hours = evaluationMode === 'viajes_horas' ? Number(rule.horas_minimas) : null;
    if (evaluationMode === 'viajes_horas' && (!Number.isFinite(hours) || hours < 0)) {
      throw new Error(`Las horas mínimas de la fila ${index + 1} no son válidas`);
    }
    return { ...parseMimotoRuleRange(viajes), hours, index };
  });

  for (let left = 0; left < ranges.length; left += 1) {
    for (let right = left + 1; right < ranges.length; right += 1) {
      const a = ranges[left];
      const b = ranges[right];
      if (a.min <= b.max && b.min <= a.max) {
        throw new Error(`Las filas de viajes ${a.index + 1} y ${b.index + 1} se superponen`);
      }
    }
  }
  if (evaluationMode === 'viajes_horas') {
    const ordered = [...ranges].sort((left, right) => left.min - right.min);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].hours < ordered[index - 1].hours) {
        throw new Error('Las horas mínimas deben aumentar junto con los viajes');
      }
    }
  }
}

function normalizeRuleAmounts(values, expectedVehicleCount, ruleIndex) {
  const entries = Array.isArray(values)
    ? values.map((item) => ({
      vehiculo_id: item?.vehiculo_id,
      cuota: item?.cuota ?? item?.monto,
    }))
    : Object.entries(values || {}).map(([vehiculo_id, cuota]) => ({ vehiculo_id, cuota }));

  if (entries.length !== expectedVehicleCount) {
    throw new Error(`La fila ${ruleIndex + 1} debe tener una cuota para cada moto`);
  }
  const vehicleIds = new Set();
  return entries.map((item) => {
    const vehicleId = requiredText(item.vehiculo_id, `La moto de la fila ${ruleIndex + 1}`);
    if (vehicleIds.has(vehicleId)) throw new Error(`La fila ${ruleIndex + 1} repite una moto`);
    vehicleIds.add(vehicleId);
    return {
      vehiculo_id: vehicleId,
      cuota: positiveNumber(item.cuota, `La cuota de la fila ${ruleIndex + 1}`),
    };
  });
}

const MIMOTO_COVERAGE_KEYS = [
  'soat',
  'impuesto_vehicular',
  'gps',
  'src',
  'todo_riesgo_mas_gps',
  'inicial_parcial',
];

function normalizeVehicleMetadata(value) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  const source = metadata.coverages;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return metadata;

  const coverages = {
    mode: source.mode === 'separate' ? 'separate' : 'grouped',
  };
  for (const key of MIMOTO_COVERAGE_KEYS) {
    const item = source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
      ? source[key]
      : {};
    coverages[key] = {
      amount: Math.max(0, Number(item.amount) || 0),
      currency: normalizeMimotoCurrency(item.currency || (key === 'inicial_parcial' ? 'USD' : 'COP')),
      ...(key === 'soat' || key === 'src'
        ? { months_before: Math.max(0, Math.trunc(Number(item.months_before) || 0)) }
        : {}),
      ...(key === 'impuesto_vehicular'
        ? {
          start_month: Math.max(0, Math.min(12, Math.trunc(Number(item.start_month) || 0))),
          installments: Math.max(0, Math.min(12, Math.trunc(Number(item.installments) || 0))),
          years: Math.max(0, Math.min(10, Math.trunc(Number(item.years) || 0))),
        }
        : {}),
      ...(key === 'todo_riesgo_mas_gps' || key === 'inicial_parcial'
        ? { weeks: Math.max(0, Math.min(260, Math.trunc(Number(item.weeks) || 0))) }
        : {}),
      ...(key === 'gps' ? { frequency: 'monthly' } : {}),
    };
  }
  return { ...metadata, coverages };
}

async function loadCronogramaAssignment(cronogramaId, vehicleId, client = null) {
  const sql = assertMimotoIsolationSql(
    `SELECT c.id AS cronograma_id, c.name, c.tasa_interes_mora, c.modo_evaluacion,
            c.bono_tiempo_activo, c.cuotas_otros_gastos, c.requisitos_vehiculo,
            to_jsonb(v) AS vehicle,
            COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.orden)
                      FROM module_mimoto_cronograma_rule r
                      WHERE r.cronograma_id=c.id), '[]'::jsonb) AS rules
     FROM module_mimoto_cronograma c
     JOIN module_mimoto_cronograma_vehiculo v
       ON v.id=$2 AND v.cronograma_id=c.id AND v.active=TRUE AND v.deleted_at IS NULL
     WHERE c.id=$1 AND c.active=TRUE AND c.deleted_at IS NULL`
  );
  const result = client
    ? await client.query(sql, [cronogramaId, vehicleId])
    : await query(sql, [cronogramaId, vehicleId]);
  const assignment = result.rows[0];
  if (!assignment) throw new Error('El cronograma o la moto seleccionada no están disponibles');
  return {
    ...assignment,
    captured_at: new Date().toISOString(),
  };
}

export async function listFleets({ active } = {}) {
  const params = [];
  let where = 'WHERE deleted_at IS NULL';
  if (active != null) {
    params.push(Boolean(active));
    where += ` AND active = $${params.length}`;
  }
  const result = await q(
    `SELECT id, park_id, name, country, timezone, currency, active, created_at, updated_at
     FROM module_mimoto_fleet ${where} ORDER BY active DESC, name`,
    params
  );
  return result.rows;
}

export async function listCronogramas({ active } = {}) {
  const params = [];
  const where = ['c.deleted_at IS NULL'];
  if (active != null) {
    params.push(Boolean(active));
    where.push(`c.active = $${params.length}`);
  }
  const result = await q(
    `SELECT c.*,
       COALESCE((SELECT COUNT(*)::int
                 FROM module_mimoto_solicitud s
                 WHERE s.cronograma_id=c.id AND s.deleted_at IS NULL), 0) AS solicitudes_count,
       COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.orden, v.name)
                 FROM module_mimoto_cronograma_vehiculo v
                 WHERE v.cronograma_id=c.id AND v.deleted_at IS NULL), '[]'::jsonb) AS vehiculos,
       COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.orden)
                 FROM module_mimoto_cronograma_rule r WHERE r.cronograma_id=c.id), '[]'::jsonb) AS rules
     FROM module_mimoto_cronograma c
     WHERE ${where.join(' AND ')} ORDER BY c.active DESC, c.name`,
    params
  );
  return result.rows;
}

export async function createCronograma(payload, actorId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const name = requiredText(payload.name, 'El nombre del cronograma');
    const vehicles = Array.isArray(payload.vehiculos) ? payload.vehiculos : [];
    const rules = Array.isArray(payload.rules) ? payload.rules : [];
    const evaluationMode = normalizeEvaluationMode(payload.modo_evaluacion);
    if (vehicles.length === 0) throw new Error('El cronograma debe tener al menos una moto');
    if (rules.length === 0) throw new Error('El cronograma debe tener al menos una regla');
    validateRuleRanges(rules, evaluationMode);
    const cron = await client.query(
      assertMimotoIsolationSql(
        `INSERT INTO module_mimoto_cronograma
          (fleet_id,name,active,tasa_interes_mora,bono_tiempo_activo,cuotas_otros_gastos,
           requisitos_vehiculo,modo_evaluacion,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`
      ),
      [null, name, payload.active !== false,
        normalizeWeeklyLateFeeRate(payload.tasa_interes_mora), strictBoolean(payload.bono_tiempo_activo),
        Math.max(1, Number(payload.cuotas_otros_gastos) || 26),
        JSON.stringify(payload.requisitos_vehiculo || {}), evaluationMode, actorId || null]
    );
    const cronogramaId = cron.rows[0].id;
    const vehicleIds = new Map();
    for (const [index, vehicle] of vehicles.entries()) {
      const vehicleName = requiredText(vehicle.name, `El nombre de la moto ${index + 1}`);
      const insertedVehicle = await client.query(
        assertMimotoIsolationSql(
          `INSERT INTO module_mimoto_cronograma_vehiculo
            (cronograma_id,name,inicial,inicial_moneda,cuotas_semanales,precio_total,moneda,metadata,orden,updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id`
        ),
        [cronogramaId, vehicleName, Math.max(0, Number(vehicle.inicial) || 0),
          normalizeMimotoCurrency(vehicle.inicial_moneda || 'COP'), Math.max(1, Number(vehicle.cuotas_semanales) || 1),
          vehicle.precio_total == null ? null : Math.max(0, Number(vehicle.precio_total) || 0),
          normalizeMimotoCurrency(vehicle.moneda || 'COP'), JSON.stringify(normalizeVehicleMetadata(vehicle.metadata)), index, actorId || null]
      );
      const realId = insertedVehicle.rows[0].id;
      vehicleIds.set(String(index), realId);
      vehicleIds.set(String(vehicle.id || index), realId);
    }
    for (const [index, rule] of rules.entries()) {
      const amounts = normalizeRuleAmounts(
        remapVehicleValues(rule.cuotas_por_vehiculo, vehicleIds),
        vehicles.length,
        index
      );
      const currencies = remapVehicleValues(rule.cuota_moneda_por_vehiculo, vehicleIds);
      await client.query(
        assertMimotoIsolationSql(
          `INSERT INTO module_mimoto_cronograma_rule
            (cronograma_id,viajes,horas_minimas,bono_moto,bono_moto_moneda,cuotas_por_vehiculo,
             cuota_moneda_por_vehiculo,pct_recaudo,cobro_saldo,orden)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`
        ),
        [cronogramaId, String(rule.viajes || ''),
          evaluationMode === 'viajes_horas' ? Math.max(0, Number(rule.horas_minimas) || 0) : null,
          Math.max(0, Number(rule.bono_moto) || 0),
          normalizeMimotoCurrency(rule.bono_moto_moneda || 'COP'), JSON.stringify(amounts),
          JSON.stringify(currencies), Math.max(0, Math.min(100, Number(rule.pct_recaudo) || 0)),
          Math.max(0, Number(rule.cobro_saldo) || 0), index]
      );
    }
    await client.query('COMMIT');
    return (await listCronogramas({})).find((item) => item.id === cronogramaId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateCronograma(id, payload, actorId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const name = requiredText(payload.name, 'El nombre del cronograma');
    const vehicles = Array.isArray(payload.vehiculos) ? payload.vehiculos : [];
    const rules = Array.isArray(payload.rules) ? payload.rules : [];
    const evaluationMode = normalizeEvaluationMode(payload.modo_evaluacion);
    if (vehicles.length === 0) throw new Error('El cronograma debe tener al menos una moto');
    if (rules.length === 0) throw new Error('El cronograma debe tener al menos una regla');
    validateRuleRanges(rules, evaluationMode);

    const updatedCronograma = await client.query(
      assertMimotoIsolationSql(
        `UPDATE module_mimoto_cronograma
         SET fleet_id=$2, name=$3, active=$4, tasa_interes_mora=$5, bono_tiempo_activo=$6,
             cuotas_otros_gastos=$7, requisitos_vehiculo=$8::jsonb, modo_evaluacion=$9,
             updated_at=CURRENT_TIMESTAMP, updated_by=$10
         WHERE id=$1 AND deleted_at IS NULL
         RETURNING id`
      ),
      [id, null, name, payload.active !== false,
        normalizeWeeklyLateFeeRate(payload.tasa_interes_mora), strictBoolean(payload.bono_tiempo_activo),
        Math.max(1, Number(payload.cuotas_otros_gastos) || 26),
        JSON.stringify(payload.requisitos_vehiculo || {}), evaluationMode, actorId || null]
    );
    if (!updatedCronograma.rows[0]) throw new Error('Cronograma Mi Moto no encontrado');

    const currentVehicles = await client.query(
      assertMimotoIsolationSql(
        `SELECT id FROM module_mimoto_cronograma_vehiculo
         WHERE cronograma_id=$1 AND deleted_at IS NULL
         FOR UPDATE`
      ),
      [id]
    );
    const currentIds = new Set(currentVehicles.rows.map((vehicle) => String(vehicle.id)));
    const retainedIds = new Set();
    const vehicleIds = new Map();

    for (const [index, vehicle] of vehicles.entries()) {
      const vehicleName = requiredText(vehicle.name, `El nombre de la moto ${index + 1}`);
      const sourceId = String(vehicle.id || index);
      let realId;
      if (currentIds.has(sourceId)) {
        await client.query(
          assertMimotoIsolationSql(
            `UPDATE module_mimoto_cronograma_vehiculo
             SET name=$3, inicial=$4, inicial_moneda=$5, cuotas_semanales=$6,
                 precio_total=$7, moneda=$8, metadata=$9::jsonb, orden=$10,
                 active=TRUE, updated_at=CURRENT_TIMESTAMP, updated_by=$11
             WHERE id=$1 AND cronograma_id=$2 AND deleted_at IS NULL`
          ),
          [sourceId, id, vehicleName, Math.max(0, Number(vehicle.inicial) || 0),
            normalizeMimotoCurrency(vehicle.inicial_moneda || 'COP'),
            Math.max(1, Number(vehicle.cuotas_semanales) || 1),
            vehicle.precio_total == null ? null : Math.max(0, Number(vehicle.precio_total) || 0),
            normalizeMimotoCurrency(vehicle.moneda || 'COP'), JSON.stringify(normalizeVehicleMetadata(vehicle.metadata)),
            index, actorId || null]
        );
        realId = sourceId;
        retainedIds.add(sourceId);
      } else {
        const inserted = await client.query(
          assertMimotoIsolationSql(
            `INSERT INTO module_mimoto_cronograma_vehiculo
              (cronograma_id,name,inicial,inicial_moneda,cuotas_semanales,precio_total,moneda,metadata,orden,updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id`
          ),
          [id, vehicleName, Math.max(0, Number(vehicle.inicial) || 0),
            normalizeMimotoCurrency(vehicle.inicial_moneda || 'COP'),
            Math.max(1, Number(vehicle.cuotas_semanales) || 1),
            vehicle.precio_total == null ? null : Math.max(0, Number(vehicle.precio_total) || 0),
            normalizeMimotoCurrency(vehicle.moneda || 'COP'), JSON.stringify(normalizeVehicleMetadata(vehicle.metadata)),
            index, actorId || null]
        );
        realId = inserted.rows[0].id;
      }
      vehicleIds.set(sourceId, realId);
      vehicleIds.set(String(index), realId);
    }

    const removedIds = [...currentIds].filter((vehicleId) => !retainedIds.has(vehicleId));
    if (removedIds.length > 0) {
      const linked = await client.query(
        assertMimotoIsolationSql(
          `SELECT cronograma_vehiculo_id, COUNT(*)::int AS total
           FROM module_mimoto_solicitud
           WHERE cronograma_vehiculo_id = ANY($1::uuid[]) AND deleted_at IS NULL
           GROUP BY cronograma_vehiculo_id`
        ),
        [removedIds]
      );
      if (linked.rows.length > 0) {
        throw new Error('No se puede eliminar una moto vinculada a solicitudes');
      }
      await client.query(
        assertMimotoIsolationSql(
          `UPDATE module_mimoto_cronograma_vehiculo
           SET active=FALSE, deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, updated_by=$2
           WHERE id = ANY($1::uuid[])`
        ),
        [removedIds, actorId || null]
      );
    }

    await client.query(
      assertMimotoIsolationSql('DELETE FROM module_mimoto_cronograma_rule WHERE cronograma_id=$1'),
      [id]
    );
    for (const [index, rule] of rules.entries()) {
      const amounts = normalizeRuleAmounts(
        remapVehicleValues(rule.cuotas_por_vehiculo, vehicleIds),
        vehicles.length,
        index
      );
      const currencies = remapVehicleValues(rule.cuota_moneda_por_vehiculo, vehicleIds);
      await client.query(
        assertMimotoIsolationSql(
          `INSERT INTO module_mimoto_cronograma_rule
            (cronograma_id,viajes,horas_minimas,bono_moto,bono_moto_moneda,cuotas_por_vehiculo,
             cuota_moneda_por_vehiculo,pct_recaudo,cobro_saldo,orden)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`
        ),
        [id, String(rule.viajes || ''),
          evaluationMode === 'viajes_horas' ? Math.max(0, Number(rule.horas_minimas) || 0) : null,
          Math.max(0, Number(rule.bono_moto) || 0),
          normalizeMimotoCurrency(rule.bono_moto_moneda || 'COP'), JSON.stringify(amounts),
          JSON.stringify(currencies), Math.max(0, Math.min(100, Number(rule.pct_recaudo) || 0)),
          Math.max(0, Number(rule.cobro_saldo) || 0), index]
      );
    }

    await client.query('COMMIT');
    return (await listCronogramas({})).find((item) => item.id === id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function toggleCronogramaActive(id, actorId) {
  const result = await q(
    `UPDATE module_mimoto_cronograma
     SET active = NOT active, updated_at = CURRENT_TIMESTAMP, updated_by = $2
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id, active, updated_at`,
    [id, actorId || null]
  );
  if (!result.rows[0]) throw new Error('Cronograma Mi Moto no encontrado');
  return result.rows[0];
}

export async function deleteCronograma(id, actorId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      assertMimotoIsolationSql(
        `SELECT c.id, c.name,
                (SELECT COUNT(*)::int
                 FROM module_mimoto_solicitud s
                 WHERE s.cronograma_id=c.id AND s.deleted_at IS NULL) AS solicitudes_count
         FROM module_mimoto_cronograma c
         WHERE c.id=$1 AND c.deleted_at IS NULL
         FOR UPDATE OF c`
      ),
      [id]
    );
    const cronograma = current.rows[0];
    if (!cronograma) throw new Error('Cronograma Mi Moto no encontrado');
    if (Number(cronograma.solicitudes_count) > 0) {
      throw new Error('No se puede eliminar un cronograma vinculado a solicitudes; desactívalo para impedir nuevas asignaciones');
    }

    await client.query(
      assertMimotoIsolationSql(
        `UPDATE module_mimoto_cronograma_vehiculo
         SET active=FALSE, deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, updated_by=$2
         WHERE cronograma_id=$1 AND deleted_at IS NULL`
      ),
      [id, actorId || null]
    );
    await client.query(
      assertMimotoIsolationSql(
        `UPDATE module_mimoto_cronograma
         SET active=FALSE, deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, updated_by=$2
         WHERE id=$1`
      ),
      [id, actorId || null]
    );
    await client.query('COMMIT');
    return { id: cronograma.id, name: cronograma.name };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listSolicitudes({
  status,
  fleetId,
  cronogramaId,
  cuotaEstado,
  dateFrom,
  dateTo,
  q: search,
  driverPhone,
  page = 1,
  limit = 20,
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const params = [];
  const where = ['s.deleted_at IS NULL'];
  if (status) {
    const statuses = String(status).split(',').map((value) => value.trim()).filter(Boolean);
    params.push(statuses);
    where.push(`s.status = ANY($${params.length}::text[])`);
  }
  if (fleetId) {
    params.push(fleetId);
    where.push(`s.fleet_id = $${params.length}`);
  }
  if (cronogramaId) {
    params.push(cronogramaId);
    where.push(`s.cronograma_id = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`s.created_at::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`s.created_at::date <= $${params.length}::date`);
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    where.push(`(s.first_name ILIKE $${params.length} OR s.last_name ILIKE $${params.length}
      OR CONCAT_WS(' ',s.first_name,s.last_name) ILIKE $${params.length}
      OR s.document_number ILIKE $${params.length} OR s.phone ILIKE $${params.length}
      OR s.placa_asignada ILIKE $${params.length} OR s.license_number ILIKE $${params.length})`);
  }
  if (driverPhone) {
    params.push(normalizeColombianPhone(driverPhone));
    where.push(`s.phone = $${params.length}`);
  }
  const quotaExists = (condition = 'TRUE') => `EXISTS (
    SELECT 1 FROM module_mimoto_cuota_semanal cq
    WHERE cq.solicitud_id=s.id AND cq.deleted_at IS NULL AND ${condition}
  )`;
  if (cuotaEstado === 'vencido') where.push(quotaExists("cq.status='overdue'"));
  if (cuotaEstado === 'pendiente') where.push(quotaExists("cq.status IN ('pending','partial')"));
  if (cuotaEstado === 'al_dia') {
    where.push(quotaExists());
    where.push(`NOT ${quotaExists("cq.status='overdue'")}`);
  }
  if (cuotaEstado === 'sin_cuotas') where.push(`NOT ${quotaExists()}`);
  const count = await q(`SELECT COUNT(*)::int AS total FROM module_mimoto_solicitud s WHERE ${where.join(' AND ')}`, params);
  params.push(safeLimit, (safePage - 1) * safeLimit);
  const result = await q(
    `SELECT s.*, f.name AS fleet_name, f.park_id,
       ${LIVE_CRONOGRAMA_NAME_SQL} AS cronograma_name,
       ${LIVE_VEHICLE_NAME_SQL} AS vehiculo_name,
       ${LIVE_VEHICLE_IMAGE_SQL} AS vehiculo_image,
       COALESCE(NULLIF(s.cronograma_snapshot->'vehicle'->>'inicial','')::numeric, v.inicial) AS vehiculo_inicial,
       COALESCE(NULLIF(s.cronograma_snapshot->'vehicle'->>'inicial_moneda',''), v.inicial_moneda) AS vehiculo_inicial_moneda,
       COALESCE(NULLIF(s.cronograma_snapshot->'vehicle'->>'cuotas_semanales','')::int, v.cuotas_semanales) AS cuotas_semanales_plan,
       COALESCE(NULLIF(s.cronograma_snapshot->'vehicle'->>'moneda',''), v.moneda) AS vehiculo_moneda,
       COALESCE(x.total_cuotas,0)::int AS total_cuotas,
       COALESCE(x.cuotas_pagadas,0)::int AS cuotas_pagadas,
       COALESCE(x.cuotas_vencidas,0)::int AS cuotas_vencidas,
       COALESCE(x.total_pagado,0)::numeric AS total_pagado,
       COALESCE(x.saldo_total,0)::numeric AS saldo_total
     FROM module_mimoto_solicitud s
     JOIN module_mimoto_fleet f ON f.id=s.fleet_id
     LEFT JOIN module_mimoto_cronograma c ON c.id=s.cronograma_id
     LEFT JOIN module_mimoto_cronograma_vehiculo v ON v.id=s.cronograma_vehiculo_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS total_cuotas,
         COUNT(*) FILTER (WHERE q.status IN ('paid','bonificada')) AS cuotas_pagadas,
         COUNT(*) FILTER (WHERE q.status='overdue') AS cuotas_vencidas,
         SUM(q.paid_amount) AS total_pagado,
         SUM(GREATEST(0,q.amount_due-q.capital_paid)+q.late_fee+q.mora_extra) AS saldo_total
       FROM module_mimoto_cuota_semanal q WHERE q.solicitud_id=s.id AND q.deleted_at IS NULL
     ) x ON TRUE
     WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { data: result.rows, pagination: { page: safePage, limit: safeLimit, total: count.rows[0].total } };
}

export async function isSolicitudOwnedByDriver(solicitudId, phone) {
  let normalized;
  try {
    normalized = normalizeColombianPhone(phone);
  } catch {
    return false;
  }
  const result = await q(
    `SELECT 1 FROM module_mimoto_solicitud
     WHERE id=$1 AND phone=$2 AND country='CO' AND deleted_at IS NULL`,
    [solicitudId, normalized]
  );
  return Boolean(result.rows[0]);
}

export async function createSolicitud(payload, actorId) {
  const { documentType, documentNumber } = normalizeColombianDocument(payload.document_type, payload.document_number);
  const firstName = requiredText(payload.first_name, 'El nombre');
  const lastName = requiredText(payload.last_name, 'El apellido');
  const phone = normalizeColombianPhone(payload.phone);
  const fleetId = optionalUuid(payload.fleet_id);
  if (!fleetId) throw new Error('La flota es requerida');
  const cronogramaId = optionalUuid(payload.cronograma_id);
  const vehicleId = optionalUuid(payload.cronograma_vehiculo_id);
  if (!cronogramaId || !vehicleId) throw new Error('El cronograma y la moto son requeridos');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const fleet = await client.query(
      assertMimotoIsolationSql(
        'SELECT id FROM module_mimoto_fleet WHERE id=$1 AND active=TRUE AND deleted_at IS NULL'
      ),
      [fleetId]
    );
    if (!fleet.rows[0]) throw new Error('La flota seleccionada no está activa');
    const snapshot = await loadCronogramaAssignment(cronogramaId, vehicleId, client);
    const result = await client.query(
      assertMimotoIsolationSql(
        `INSERT INTO module_mimoto_solicitud
          (fleet_id,document_type,document_number,first_name,last_name,phone,email,license_number,description,apps_trabajadas,
           driver_id_fleet,recaudo_driver_id,cronograma_id,cronograma_vehiculo_id,cronograma_snapshot,pago_tipo,pago_estado,
           fecha_inicio_cobro_semanal,fecha_entrega_vehiculo,placa_asignada,status,observations,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING *`
      ),
      [fleetId, documentType, documentNumber, firstName, lastName, phone,
        String(payload.email || '').trim() || null, String(payload.license_number || '').trim() || null,
        String(payload.description || '').trim() || null, JSON.stringify(payload.apps_trabajadas || []),
        String(payload.driver_id_fleet || '').trim() || null,
        String(payload.recaudo_driver_id || '').trim() || null, cronogramaId, vehicleId,
        JSON.stringify(snapshot), payload.pago_tipo || null, payload.pago_estado || 'pendiente',
        payload.fecha_inicio_cobro_semanal || null, payload.fecha_entrega_vehiculo || null,
        String(payload.placa_asignada || '').trim().toUpperCase() || null, payload.status || 'pendiente',
        String(payload.observations || '').trim() || null, actorId || null]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSolicitud(id, payload, actorId) {
  const allowed = new Map([
    ['first_name', (value) => requiredText(value, 'El nombre')],
    ['last_name', (value) => requiredText(value, 'El apellido')],
    ['license_number', (value) => String(value || '').trim() || null],
    ['description', (value) => String(value || '').trim() || null],
    ['driver_id_fleet', (value) => String(value || '').trim() || null],
    ['recaudo_driver_id', (value) => String(value || '').trim() || null],
    ['pago_tipo', (value) => value || null],
    ['pago_estado', (value) => value],
    ['fecha_inicio_cobro_semanal', (value) => value || null],
    ['fecha_entrega_vehiculo', (value) => value || null],
    ['placa_asignada', (value) => String(value || '').trim().toUpperCase() || null],
    ['status', (value) => value],
    ['observations', (value) => String(value || '').trim() || null],
    ['withdrawal_reason', (value) => String(value || '').trim() || null],
    ['gastos_automaticos_activos', strictBoolean],
  ]);
  const sets = [];
  const params = [];
  for (const [field, transform] of allowed) {
    if (!Object.hasOwn(payload, field)) continue;
    params.push(transform(payload[field]));
    sets.push(`${field}=$${params.length}`);
  }
  if (Object.hasOwn(payload, 'cronograma_id') || Object.hasOwn(payload, 'cronograma_vehiculo_id')) {
    const current = await q(
      'SELECT cronograma_id, cronograma_vehiculo_id FROM module_mimoto_solicitud WHERE id=$1 AND deleted_at IS NULL',
      [id]
    );
    if (!current.rows[0]) throw new Error('Solicitud Mi Moto no encontrada');
    const cronogramaId = optionalUuid(payload.cronograma_id ?? current.rows[0].cronograma_id);
    const vehicleId = optionalUuid(payload.cronograma_vehiculo_id ?? current.rows[0].cronograma_vehiculo_id);
    if (!cronogramaId || !vehicleId) throw new Error('El cronograma y la moto son requeridos');
    const snapshot = await loadCronogramaAssignment(cronogramaId, vehicleId);
    params.push(cronogramaId, vehicleId, JSON.stringify(snapshot));
    sets.push(
      `cronograma_id=$${params.length - 2}`,
      `cronograma_vehiculo_id=$${params.length - 1}`,
      `cronograma_snapshot=$${params.length}::jsonb`,
    );
  }
  if (Object.hasOwn(payload, 'phone')) {
    params.push(normalizeColombianPhone(payload.phone));
    sets.push(`phone=$${params.length}`);
  }
  if (sets.length === 0) throw new Error('No hay campos válidos para actualizar');
  params.push(actorId || null, id);
  const result = await q(
    `UPDATE module_mimoto_solicitud SET ${sets.join(', ')}, updated_at=CURRENT_TIMESTAMP,
       updated_by=$${params.length - 1}
     WHERE id=$${params.length} AND deleted_at IS NULL RETURNING *`,
    params
  );
  if (!result.rows[0]) throw new Error('Solicitud Mi Moto no encontrada');
  return result.rows[0];
}

export async function getSolicitudDetail(id) {
  const solicitud = await q(
    `SELECT s.*, f.name AS fleet_name, f.park_id, f.timezone,
            ${LIVE_CRONOGRAMA_NAME_SQL} AS cronograma_name,
            COALESCE(NULLIF(s.cronograma_snapshot->>'tasa_interes_mora','')::numeric, c.tasa_interes_mora) AS tasa_interes_mora,
            COALESCE(NULLIF(s.cronograma_snapshot->>'modo_evaluacion',''), c.modo_evaluacion) AS modo_evaluacion,
            ${LIVE_VEHICLE_NAME_SQL} AS vehiculo_name,
            ${LIVE_VEHICLE_IMAGE_SQL} AS vehiculo_image,
            COALESCE(NULLIF(s.cronograma_snapshot->'vehicle'->>'cuotas_semanales','')::int, v.cuotas_semanales) AS cuotas_semanales,
            COALESCE(NULLIF(s.cronograma_snapshot->'vehicle'->>'moneda',''), v.moneda) AS vehiculo_moneda
     FROM module_mimoto_solicitud s
     JOIN module_mimoto_fleet f ON f.id=s.fleet_id
     LEFT JOIN module_mimoto_cronograma c ON c.id=s.cronograma_id
     LEFT JOIN module_mimoto_cronograma_vehiculo v ON v.id=s.cronograma_vehiculo_id
     WHERE s.id=$1 AND s.deleted_at IS NULL`,
    [id]
  );
  if (!solicitud.rows[0]) return null;
  const [cuotas, gastos, contratos, comprobantesCuota, evidenciasFleet] = await Promise.all([
    q('SELECT * FROM module_mimoto_cuota_saldo_view WHERE solicitud_id=$1 ORDER BY week_start_date', [id]),
    q(`SELECT * FROM module_mimoto_otros_gastos WHERE solicitud_id=$1 AND deleted_at IS NULL ORDER BY due_date`, [id]),
    q(`SELECT * FROM module_mimoto_contrato_documento WHERE solicitud_id=$1 AND deleted_at IS NULL ORDER BY version DESC`, [id]),
    q(`SELECT id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, origen,
              rechazo_razon, created_at
       FROM module_mimoto_comprobante_cuota_semanal
       WHERE solicitud_id=$1 AND deleted_at IS NULL
       ORDER BY created_at DESC`, [id]),
    q(`SELECT id, cuota_semanal_id, monto, moneda, external_reference, simulated, created_at
       FROM module_mimoto_evidencia_cobro_fleet
       WHERE solicitud_id=$1
       ORDER BY created_at DESC`, [id]),
  ]);
  return {
    ...solicitud.rows[0],
    cuotas: cuotas.rows,
    otros_gastos: gastos.rows,
    contratos: contratos.rows,
    comprobantes_cuota: comprobantesCuota.rows,
    evidencias_fleet: evidenciasFleet.rows,
  };
}
