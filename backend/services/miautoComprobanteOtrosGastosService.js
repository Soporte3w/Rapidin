/**
 * Comprobantes de pago para cuotas "otros gastos" Mi Auto.
 * Conductor sube comprobante por cuota; admin valida o rechaza.
 */
import { query } from '../config/database.js';
import { uploadFileToMedia } from './voucherService.js';
import { marcarPagoCompletoSiAplica } from './miautoComprobantePagoService.js';
import { montoEnPEN, montoEnUSD, normalizePenUsd, round2 } from './miautoMoneyUtils.js';

/** Lista comprobantes de otros gastos por solicitud. */
export async function listBySolicitud(solicitudId) {
  const res = await query(
    `SELECT id, solicitud_id, otros_gastos_id, monto, moneda, file_name, file_path, estado,
            validated_at, validated_by, rechazado_at, rechazo_razon, rechazado_by, created_at
     FROM module_miauto_comprobante_otros_gastos
     WHERE solicitud_id = $1 ORDER BY created_at ASC`,
    [solicitudId]
  );
  return res.rows || [];
}

/** Conductor sube comprobante para una cuota de otros gastos. */
export async function createComprobanteOtrosGastos(solicitudId, otrosGastosId, file, monto, moneda, userId = null) {
  const path = await uploadFileToMedia(file);
  const fileName = file.originalname || `comprobante_otros_${Date.now()}.pdf`;
  const montoVal = monto != null ? parseFloat(monto) : null;
  const monedaVal = normalizePenUsd(moneda);

  const og = await query(
    'SELECT id, solicitud_id, amount_due, paid_amount, status FROM module_miauto_otros_gastos WHERE id = $1 AND solicitud_id = $2',
    [otrosGastosId, solicitudId]
  );
  if (og.rows.length === 0) {
    throw new Error('Cuota de otros gastos no encontrada o no pertenece a esta solicitud');
  }
  const c = og.rows[0];
  if (c.status === 'paid') {
    throw new Error('Esta cuota ya está pagada');
  }

  await query(
    `INSERT INTO module_miauto_comprobante_otros_gastos (solicitud_id, otros_gastos_id, monto, moneda, file_name, file_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [solicitudId, otrosGastosId, montoVal, monedaVal, fileName, path]
  );
  return listBySolicitud(solicitudId);
}

/** Rechazar comprobante (solo si está pendiente). */
export async function rejectComprobanteOtrosGastos(solicitudId, comprobanteId, userId, { motivo } = {}) {
  const comp = await query(
    'SELECT id, estado FROM module_miauto_comprobante_otros_gastos WHERE solicitud_id = $1 AND id = $2',
    [solicitudId, comprobanteId]
  );
  if (comp.rows.length === 0) {
    throw new Error('Comprobante no encontrado');
  }
  const estado = (comp.rows[0].estado || '').toLowerCase();
  if (estado === 'validado') throw new Error('No se puede rechazar un comprobante ya validado');
  if (estado === 'rechazado') throw new Error('El comprobante ya está rechazado');

  await query(
    `UPDATE module_miauto_comprobante_otros_gastos
     SET estado = 'rechazado', rechazado_at = CURRENT_TIMESTAMP, rechazo_razon = $1, rechazado_by = $2
     WHERE id = $3`,
    [motivo ? String(motivo).trim() : null, userId, comprobanteId]
  );
  return listBySolicitud(solicitudId);
}

/** Valida comprobante: aplica monto a la cuota otros_gastos (paid_amount y status). */
export async function validateComprobanteOtrosGastos(solicitudId, comprobanteId, userId, { monto, moneda } = {}) {
  const comp = await query(
    'SELECT id, otros_gastos_id, monto, moneda, estado FROM module_miauto_comprobante_otros_gastos WHERE solicitud_id = $1 AND id = $2',
    [solicitudId, comprobanteId]
  );
  if (comp.rows.length === 0) throw new Error('Comprobante no encontrado');
  const compRow = comp.rows[0];
  if ((compRow.estado || '').toLowerCase() === 'validado') throw new Error('El comprobante ya está validado');
  if ((compRow.estado || '').toLowerCase() === 'rechazado') throw new Error('No se puede validar un comprobante rechazado');

  const og = await query(
    'SELECT id, amount_due, paid_amount, status, moneda FROM module_miauto_otros_gastos WHERE id = $1 AND solicitud_id = $2',
    [compRow.otros_gastos_id, solicitudId]
  );
  if (og.rows.length === 0) throw new Error('Cuota de otros gastos no encontrada');
  const c = og.rows[0];
  if (c.status === 'paid') throw new Error('Esta cuota ya está pagada');

  const monedaCuota = normalizePenUsd(c.moneda);
  const symCuota = monedaCuota === 'USD' ? '$' : 'S/.';

  const montoIngreso = monto != null && moneda ? parseFloat(monto) : parseFloat(compRow.monto);
  if (Number.isNaN(montoIngreso) || montoIngreso <= 0) {
    throw new Error('Debe indicar monto y moneda para validar');
  }
  const monedaIngreso = normalizePenUsd(moneda || compRow.moneda || 'PEN');
  const montoAplicar = monedaCuota === 'USD'
    ? await montoEnUSD(solicitudId, montoIngreso, monedaIngreso)
    : await montoEnPEN(solicitudId, montoIngreso, monedaIngreso);
  if (montoAplicar == null) throw new Error('No se pudo convertir el monto');

  const amountDue = parseFloat(c.amount_due) || 0;
  const paid = parseFloat(c.paid_amount) || 0;
  const restante = Math.max(0, amountDue - paid);
  if (montoAplicar > restante) {
    throw new Error(`El monto a validar (${symCuota} ${montoAplicar.toFixed(2)}) no puede superar lo que falta por pagar en esta cuota (${symCuota} ${restante.toFixed(2)})`);
  }

  await query(
    `UPDATE module_miauto_comprobante_otros_gastos SET monto = $1, moneda = $2, estado = 'validado', validated_at = CURRENT_TIMESTAMP, validated_by = $3 WHERE id = $4`,
    [montoAplicar, monedaCuota, userId, comprobanteId]
  );

  const newPaid = round2(paid + montoAplicar);
  const newStatus = newPaid >= amountDue ? 'paid' : 'partial';
  await query(
    `UPDATE module_miauto_otros_gastos SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [newPaid, newStatus, compRow.otros_gastos_id]
  );

  await marcarPagoCompletoSiAplica(solicitudId);

  return listBySolicitud(solicitudId);
}
