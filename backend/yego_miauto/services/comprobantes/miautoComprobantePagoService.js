import { query } from '../../../config/database.js';
import { uploadFileToMedia } from '../../../services/voucherService.js';
import { logger } from '../../../utils/logger.js';
import { round2, normalizePenUsd, convertirMontoEntreMonedas, tipoCambioUsdALocalEfectivo } from '../utils/miautoMoneyUtils.js';

/** Si la suma de comprobantes validados (cuota inicial + otros gastos) >= cuota inicial, marca pago_estado = completo. */
export async function marcarPagoCompletoSiAplica(solicitudId) {
  const sol = await query(
    'SELECT cronograma_vehiculo_id, status FROM module_miauto_solicitud WHERE id = $1',
    [solicitudId]
  );
  const cvId = sol.rows[0]?.cronograma_vehiculo_id;
  if (!cvId) {
    // Si la solicitud está aprobada pero no tiene vehículo asignado, es un problema de integridad
    if (sol.rows[0]?.status === 'aprobado') {
      logger.warn('miauto.pago_inicial.sin_cronograma_vehiculo', { solicitudId });
    }
    return;
  }
  const inicial = await query('SELECT inicial FROM module_miauto_cronograma_vehiculo WHERE id = $1', [cvId]);
  const cuotaInicial = round2(inicial.rows[0] ? parseFloat(inicial.rows[0].inicial) || 0 : 0);
  if (cuotaInicial <= 0) return;
  const { total: totalValidado } = await getTotalValidado(solicitudId);
  if (totalValidado >= cuotaInicial) {
    await query(
      `UPDATE module_miauto_solicitud SET pago_estado = 'completo', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [solicitudId]
    );
  }
}

/** Lanza si el pago de la solicitud ya está completo. */
async function assertPagoNoCompleto(solicitudId) {
  const row = await query(
    'SELECT pago_estado FROM module_miauto_solicitud WHERE id = $1',
    [solicitudId]
  );
  if (row.rows.length > 0 && row.rows[0].pago_estado === 'completo') {
    throw new Error('El pago ya está completo; no se pueden agregar más comprobantes.');
  }
}

export async function listBySolicitud(solicitudId) {
  const res = await query(
    `SELECT id, solicitud_id, monto, file_name, file_path, created_at,
            estado, validated_at, validated_by, rechazado_at, rechazo_razon, rechazado_by
     FROM module_miauto_comprobante_pago WHERE solicitud_id = $1 ORDER BY created_at ASC`,
    [solicitudId]
  );
  return res.rows || [];
}

/** Rechaza un comprobante (ej. foto no legible). Solo si está pendiente. */
export async function rejectComprobante(solicitudId, comprobanteId, userId, { motivo } = {}) {
  const comp = await query(
    'SELECT id, estado FROM module_miauto_comprobante_pago WHERE solicitud_id = $1 AND id = $2',
    [solicitudId, comprobanteId]
  );
  if (comp.rows.length === 0) {
    throw new Error('Comprobante no encontrado');
  }
  const estado = (comp.rows[0].estado || '').toLowerCase();
  if (estado === 'validado') {
    throw new Error('No se puede rechazar un comprobante ya validado');
  }
  if (estado === 'rechazado') {
    throw new Error('El comprobante ya está rechazado');
  }

  await query(
    `UPDATE module_miauto_comprobante_pago SET estado = 'rechazado', rechazado_at = CURRENT_TIMESTAMP, rechazo_razon = $1, rechazado_by = $2 WHERE id = $3`,
    [motivo ? String(motivo).trim() : null, userId, comprobanteId]
  );

  return listBySolicitud(solicitudId);
}

/** País, moneda de cuota inicial y TC para una solicitud (evita queries repetidas). */
async function loadMonedaContextForSolicitud(solicitudId) {
  const sol = await query(
    `SELECT s.country, s.cronograma_vehiculo_id FROM module_miauto_solicitud s WHERE s.id = $1`,
    [solicitudId]
  );
  if (sol.rows.length === 0) {
    return { country: null, cronograma_vehiculo_id: null, inicialMoneda: 'USD', valorUsdALocal: null, monedaLocal: 'PEN' };
  }
  const country = sol.rows[0]?.country;
  const cvId = sol.rows[0]?.cronograma_vehiculo_id;
  const [tcEff, cv] = await Promise.all([
    tipoCambioUsdALocalEfectivo(country),
    cvId
      ? query('SELECT inicial_moneda FROM module_miauto_cronograma_vehiculo WHERE id = $1', [cvId])
      : Promise.resolve({ rows: [] }),
  ]);
  const monedaLocal = tcEff.monedaLocal;
  const inicialMoneda = !cvId || cv.rows[0]?.inicial_moneda === 'USD' ? 'USD' : monedaLocal;
  return { country, cronograma_vehiculo_id: cvId, inicialMoneda, valorUsdALocal: tcEff.valorUsdALocal, monedaLocal };
}

/** Valida un comprobante con monto y moneda; convierte a la moneda de la cuota inicial. Si suma validados >= cuota inicial, marca pago_estado = completo */
export async function validateComprobante(solicitudId, comprobanteId, userId, { monto, moneda } = {}) {
  const comp = await query(
    'SELECT id, monto, estado FROM module_miauto_comprobante_pago WHERE solicitud_id = $1 AND id = $2',
    [solicitudId, comprobanteId]
  );
  if (comp.rows.length === 0) {
    throw new Error('Comprobante no encontrado');
  }
  const estado = (comp.rows[0].estado || 'pendiente').toLowerCase();
  if (estado === 'validado') {
    throw new Error('El comprobante ya está validado');
  }
  if (estado === 'rechazado') {
    throw new Error('No se puede validar un comprobante rechazado');
  }

  const ctx = await loadMonedaContextForSolicitud(solicitudId);
  let montoFinal = comp.rows[0].monto != null ? parseFloat(comp.rows[0].monto) : null;

  if (monto != null && moneda && ctx.cronograma_vehiculo_id) {
    const monedaIngreso = normalizePenUsd(moneda);
    montoFinal = convertirMontoEntreMonedas(monto, monedaIngreso, ctx.inicialMoneda, ctx.valorUsdALocal);
    if (montoFinal == null || montoFinal < 0) {
      throw new Error('Monto inválido');
    }
  }

  if (montoFinal != null) {
    montoFinal = round2(montoFinal);
    await query(
      `UPDATE module_miauto_comprobante_pago SET monto = $1, estado = 'validado', validated_at = CURRENT_TIMESTAMP, validated_by = $2 WHERE id = $3`,
      [montoFinal, userId, comprobanteId]
    );
  } else {
    await query(
      `UPDATE module_miauto_comprobante_pago SET estado = 'validado', validated_at = CURRENT_TIMESTAMP, validated_by = $1 WHERE id = $2`,
      [userId, comprobanteId]
    );
  }

  await marcarPagoCompletoSiAplica(solicitudId);
  return listBySolicitud(solicitudId);
}

async function montoEnMonedaCuotaInicial(solicitudId, monto, moneda) {
  const ctx = await loadMonedaContextForSolicitud(solicitudId);
  if (!ctx.cronograma_vehiculo_id || monto == null || !moneda) return null;
  const monedaIngreso = normalizePenUsd(moneda);
  return convertirMontoEntreMonedas(monto, monedaIngreso, ctx.inicialMoneda, ctx.valorUsdALocal);
}

/** Total validado por solicitud en moneda de la cuota inicial y en USD (para regla de 500 USD en pago parcial).
 * Incluye comprobantes de cuota inicial (comprobante_pago) y comprobantes de otros gastos validados. */
export async function getTotalValidado(solicitudId) {
  const [sumPago, ctx, sumOg] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(COALESCE(monto, 0)), 0) AS total FROM module_miauto_comprobante_pago WHERE solicitud_id = $1 AND estado = 'validado'`,
      [solicitudId]
    ),
    loadMonedaContextForSolicitud(solicitudId),
    query(
      `SELECT monto, moneda FROM module_miauto_comprobante_otros_gastos WHERE solicitud_id = $1 AND estado = 'validado'`,
      [solicitudId]
    ),
  ]);
  let total = round2(parseFloat(sumPago.rows[0]?.total) || 0);

  const { inicialMoneda, valorUsdALocal } = ctx;

  for (const row of sumOg.rows || []) {
    const monto = parseFloat(row.monto) || 0;
    if (monto <= 0) continue;
    const monedaOg = normalizePenUsd(row.moneda);
    const enInicial = convertirMontoEntreMonedas(monto, monedaOg, inicialMoneda, valorUsdALocal);
    if (enInicial != null) total = round2(total + enInicial);
  }

  let totalUsd = total;
  if (inicialMoneda !== 'USD' && valorUsdALocal && valorUsdALocal > 0) {
    totalUsd = round2(total / valorUsdALocal);
  }
  return { total, totalUsd };
}

/**
 * Variante batch para listados. Conserva las mismas reglas monetarias de
 * getTotalValidado(), evitando ejecutar varias consultas por solicitud.
 */
export async function getTotalsValidadosBySolicitudIds(solicitudIds) {
  const ids = [...new Set((solicitudIds || []).filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();

  const [contextsRes, pagosRes, otrosRes, peRate, coRate] = await Promise.all([
    query(
      `SELECT s.id AS solicitud_id, s.country, v.inicial_moneda
       FROM module_miauto_solicitud s
       LEFT JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id
       WHERE s.id = ANY($1::uuid[])`,
      [ids]
    ),
    query(
      `SELECT solicitud_id, COALESCE(SUM(COALESCE(monto, 0)), 0) AS total
       FROM module_miauto_comprobante_pago
       WHERE solicitud_id = ANY($1::uuid[]) AND estado = 'validado'
       GROUP BY solicitud_id`,
      [ids]
    ),
    query(
      `SELECT solicitud_id, monto, moneda
       FROM module_miauto_comprobante_otros_gastos
       WHERE solicitud_id = ANY($1::uuid[]) AND estado = 'validado'`,
      [ids]
    ),
    tipoCambioUsdALocalEfectivo('PE'),
    tipoCambioUsdALocalEfectivo('CO'),
  ]);

  const ratesByCountry = new Map([
    ['PE', peRate],
    ['CO', coRate],
  ]);
  const paymentsBySolicitud = new Map(
    (pagosRes.rows || []).map((row) => [String(row.solicitud_id), round2(parseFloat(row.total) || 0)])
  );
  const expensesBySolicitud = new Map();
  for (const row of otrosRes.rows || []) {
    const key = String(row.solicitud_id);
    if (!expensesBySolicitud.has(key)) expensesBySolicitud.set(key, []);
    expensesBySolicitud.get(key).push(row);
  }

  const totals = new Map();
  for (const context of contextsRes.rows || []) {
    const key = String(context.solicitud_id);
    const country = String(context.country || 'PE').toUpperCase() === 'CO' ? 'CO' : 'PE';
    const rate = ratesByCountry.get(country);
    const monedaLocal = rate?.monedaLocal || (country === 'CO' ? 'COP' : 'PEN');
    const valorUsdALocal = rate?.valorUsdALocal || 0;
    const inicialMoneda = String(context.inicial_moneda || 'USD').toUpperCase() === 'USD'
      ? 'USD'
      : monedaLocal;

    let total = paymentsBySolicitud.get(key) || 0;
    for (const expense of expensesBySolicitud.get(key) || []) {
      const monto = parseFloat(expense.monto) || 0;
      if (monto <= 0) continue;
      const converted = convertirMontoEntreMonedas(
        monto,
        normalizePenUsd(expense.moneda),
        inicialMoneda,
        valorUsdALocal
      );
      if (converted != null) total = round2(total + converted);
    }

    const totalUsd = inicialMoneda !== 'USD' && valorUsdALocal > 0
      ? round2(total / valorUsdALocal)
      : total;
    totals.set(key, { total, totalUsd });
  }
  return totals;
}

/** El admin agrega un pago manual (sin archivo): se registra como comprobante validado y suma a la cuota inicial. */
export async function addPagoManual(solicitudId, userId, { monto, moneda } = {}) {
  await assertPagoNoCompleto(solicitudId);
  const num = monto != null ? parseFloat(monto) : NaN;
  if (Number.isNaN(num) || num <= 0) {
    throw new Error('Monto inválido');
  }
  const monedaVal = normalizePenUsd(moneda);
  const montoFinal = await montoEnMonedaCuotaInicial(solicitudId, num, monedaVal);
  if (montoFinal == null || montoFinal < 0) {
    throw new Error('No se pudo convertir el monto a la moneda de la cuota inicial');
  }

  await query(
    `INSERT INTO module_miauto_comprobante_pago (solicitud_id, file_name, file_path, monto, estado, validated_at, validated_by, created_by)
     VALUES ($1, 'Pago manual', 'manual', $2, 'validado', CURRENT_TIMESTAMP, $3, $3)`,
    [solicitudId, montoFinal, userId]
  );

  await marcarPagoCompletoSiAplica(solicitudId);
  return listBySolicitud(solicitudId);
}

export async function createComprobantePago(solicitudId, file, monto = null, userId = null) {
  await assertPagoNoCompleto(solicitudId);
  const montoVal = monto != null ? round2(parseFloat(monto)) : null;
  if (monto != null && (!Number.isFinite(montoVal) || montoVal <= 0)) {
    throw new Error('Monto inválido');
  }
  const path = await uploadFileToMedia(file);
  const fileName = file.originalname || `comprobante_pago_${Date.now()}.pdf`;
  await query(
    `INSERT INTO module_miauto_comprobante_pago (solicitud_id, file_name, file_path, monto, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [solicitudId, fileName, path, montoVal, userId || null]
  );
  return listBySolicitud(solicitudId);
}
