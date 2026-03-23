import { query } from '../config/database.js';
import { uploadFileToMedia } from './voucherService.js';
import { getTipoCambioByCountry } from './miautoTipoCambioService.js';
import { round2 } from './miautoMoneyUtils.js';

/** Si la suma de comprobantes validados (cuota inicial + otros gastos) >= cuota inicial, marca pago_estado = completo. */
export async function marcarPagoCompletoSiAplica(solicitudId) {
  const sol = await query(
    'SELECT cronograma_vehiculo_id FROM module_miauto_solicitud WHERE id = $1',
    [solicitudId]
  );
  const cvId = sol.rows[0]?.cronograma_vehiculo_id;
  if (!cvId) return;
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

/** Convierte monto entre monedas usando tipo de cambio (1 USD = valorUsdALocal en local). */
function convertirMonto(monto, monedaOrigen, monedaDestino, valorUsdALocal) {
  const num = parseFloat(monto);
  if (Number.isNaN(num) || num <= 0) return null;
  if (monedaOrigen === monedaDestino) return num;
  if (monedaOrigen === 'USD' && (monedaDestino === 'PEN' || monedaDestino === 'COP')) {
    return num * (valorUsdALocal || 0);
  }
  if ((monedaOrigen === 'PEN' || monedaOrigen === 'COP') && monedaDestino === 'USD') {
    const rate = valorUsdALocal && valorUsdALocal > 0 ? valorUsdALocal : 1;
    return num / rate;
  }
  return num;
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

  const solicitud = await query(
    `SELECT s.country, s.cronograma_vehiculo_id FROM module_miauto_solicitud s WHERE s.id = $1`,
    [solicitudId]
  );
  let montoFinal = comp.rows[0].monto != null ? parseFloat(comp.rows[0].monto) : null;
  const cvId = solicitud.rows[0]?.cronograma_vehiculo_id;

  if (monto != null && moneda && cvId) {
    const cv = await query(
      'SELECT inicial_moneda FROM module_miauto_cronograma_vehiculo WHERE id = $1',
      [cvId]
    );
    const inicialMoneda = cv.rows[0]?.inicial_moneda || 'USD';
    const monedaIngreso = normalizePenUsd(moneda);
    let valorUsdALocal = null;
    if (solicitud.rows[0]?.country) {
      const tc = await getTipoCambioByCountry(solicitud.rows[0].country);
      valorUsdALocal = tc?.valor_usd_a_local ?? null;
    }
    montoFinal = convertirMonto(monto, monedaIngreso, inicialMoneda, valorUsdALocal);
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

/** Obtiene el monto convertido a la moneda de la cuota inicial de la solicitud. */
async function montoEnMonedaCuotaInicial(solicitudId, monto, moneda) {
  const solicitud = await query(
    `SELECT s.country, s.cronograma_vehiculo_id FROM module_miauto_solicitud s WHERE s.id = $1`,
    [solicitudId]
  );
  const cvId = solicitud.rows[0]?.cronograma_vehiculo_id;
  if (!cvId || monto == null || !moneda) return null;
  const cv = await query(
    'SELECT inicial_moneda FROM module_miauto_cronograma_vehiculo WHERE id = $1',
    [cvId]
  );
  const inicialMoneda = cv.rows[0]?.inicial_moneda || 'USD';
  const monedaIngreso = normalizePenUsd(moneda);
  let valorUsdALocal = null;
  if (solicitud.rows[0]?.country) {
    const tc = await getTipoCambioByCountry(solicitud.rows[0].country);
    valorUsdALocal = tc?.valor_usd_a_local ?? null;
  }
  return convertirMonto(monto, monedaIngreso, inicialMoneda, valorUsdALocal);
}

/** Total validado por solicitud en moneda de la cuota inicial y en USD (para regla de 500 USD en pago parcial).
 * Incluye comprobantes de cuota inicial (comprobante_pago) y comprobantes de otros gastos validados. */
export async function getTotalValidado(solicitudId) {
  const sumPago = await query(
    `SELECT COALESCE(SUM(COALESCE(monto, 0)), 0) AS total FROM module_miauto_comprobante_pago WHERE solicitud_id = $1 AND estado = 'validado'`,
    [solicitudId]
  );
  let total = round2(parseFloat(sumPago.rows[0]?.total) || 0);

  const sol = await query(
    `SELECT s.country, s.cronograma_vehiculo_id FROM module_miauto_solicitud s WHERE s.id = $1`,
    [solicitudId]
  );
  const cvId = sol.rows[0]?.cronograma_vehiculo_id;
  const country = sol.rows[0]?.country;
  let inicialMoneda = 'USD';
  let valorUsdALocal = null;
  if (cvId) {
    const cv = await query('SELECT inicial_moneda FROM module_miauto_cronograma_vehiculo WHERE id = $1', [cvId]);
    inicialMoneda = cv.rows[0]?.inicial_moneda || 'USD';
  }
  if (country) {
    const tc = await getTipoCambioByCountry(country);
    valorUsdALocal = tc?.valor_usd_a_local ?? null;
  }

  const sumOg = await query(
    `SELECT monto, moneda FROM module_miauto_comprobante_otros_gastos WHERE solicitud_id = $1 AND estado = 'validado'`,
    [solicitudId]
  );
  for (const row of sumOg.rows || []) {
    const monto = parseFloat(row.monto) || 0;
    if (monto <= 0) continue;
    const monedaOg = normalizePenUsd(row.moneda);
    const enInicial = convertirMonto(monto, monedaOg, inicialMoneda, valorUsdALocal);
    if (enInicial != null) total = round2(total + enInicial);
  }

  let totalUsd = total;
  if (inicialMoneda !== 'USD' && valorUsdALocal && valorUsdALocal > 0) {
    totalUsd = round2(total / valorUsdALocal);
  }
  return { total, totalUsd };
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
  const path = await uploadFileToMedia(file);
  const fileName = file.originalname || `comprobante_pago_${Date.now()}.pdf`;
  const montoVal = monto != null ? parseFloat(monto) : null;
  await query(
    `INSERT INTO module_miauto_comprobante_pago (solicitud_id, file_name, file_path, monto, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [solicitudId, fileName, path, montoVal, userId || null]
  );
  return listBySolicitud(solicitudId);
}
