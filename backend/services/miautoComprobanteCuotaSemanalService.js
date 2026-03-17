/**
 * Comprobantes de pago para cuotas semanales Mi Auto.
 * Conductor sube comprobante por cuota; admin valida o rechaza.
 * Al validar (o pago manual) se aplica el monto a la cuota y se evalúa beneficio 4 cuotas seguidas.
 */
import { query } from '../config/database.js';
import { uploadFileToMedia } from './voucherService.js';
import { getTipoCambioByCountry } from './miautoTipoCambioService.js';

function round2(n) {
  const x = Number(n);
  return Number.isNaN(x) ? 0 : Math.round(x * 100) / 100;
}

/** Convierte monto a PEN usando tipo de cambio del país de la solicitud. */
async function montoEnPEN(solicitudId, monto, moneda) {
  const num = parseFloat(monto);
  if (Number.isNaN(num) || num <= 0) return null;
  const monedaIngreso = (moneda && String(moneda).toUpperCase() === 'PEN') ? 'PEN' : 'USD';
  if (monedaIngreso === 'PEN') return round2(num);
  const sol = await query('SELECT country FROM module_miauto_solicitud WHERE id = $1', [solicitudId]);
  const country = sol.rows[0]?.country;
  if (!country) return round2(num);
  const tc = await getTipoCambioByCountry(country);
  const valor = tc?.valor_usd_a_local ?? 0;
  return round2(num * valor);
}

/** Actualiza cuota con nuevo paid_amount y status; aplica beneficio 4 seguidas si queda pagada. */
async function aplicarPagoACuota(solicitudId, cuotaSemanalId, amountDue, paid, lateFee, montoAplicar) {
  const newPaid = round2(paid + montoAplicar);
  const totalDue = amountDue + lateFee;
  const newStatus = newPaid >= totalDue ? 'paid' : 'partial';
  await query(
    `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [newPaid, newStatus, cuotaSemanalId]
  );
  if (newStatus === 'paid') {
    await tryGrantBenefit4Consecutive(solicitudId);
  }
  return { newPaid, newStatus };
}

/** Lista comprobantes de cuota semanal por solicitud. */
export async function listBySolicitud(solicitudId) {
  const res = await query(
    `SELECT id, solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado,
            validated_at, validated_by, rechazado_at, rechazo_razon, created_at
     FROM module_miauto_comprobante_cuota_semanal
     WHERE solicitud_id = $1 ORDER BY created_at ASC`,
    [solicitudId]
  );
  return res.rows || [];
}

/** Conductor sube comprobante para una cuota semanal (monto y moneda opcionales; el admin puede fijarlos al validar). */
export async function createComprobanteCuotaSemanal(solicitudId, cuotaSemanalId, file, monto, moneda, userId = null) {
  const path = await uploadFileToMedia(file);
  const fileName = file.originalname || `comprobante_cuota_${Date.now()}.pdf`;
  const montoVal = monto != null ? parseFloat(monto) : null;
  const monedaVal = (moneda && String(moneda).toUpperCase() === 'PEN') ? 'PEN' : 'USD';

  const cuota = await query(
    'SELECT id, solicitud_id, amount_due, paid_amount, late_fee, status FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2',
    [cuotaSemanalId, solicitudId]
  );
  if (cuota.rows.length === 0) {
    throw new Error('Cuota semanal no encontrada o no pertenece a esta solicitud');
  }
  const c = cuota.rows[0];
  if (c.status === 'paid' || c.status === 'bonificada') {
    throw new Error('Esta cuota ya está pagada o bonificada');
  }

  await query(
    `INSERT INTO module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [solicitudId, cuotaSemanalId, montoVal, monedaVal, fileName, path]
  );
  return listBySolicitud(solicitudId);
}

/** Rechazar comprobante (solo si está pendiente). */
export async function rejectComprobanteCuotaSemanal(solicitudId, comprobanteId, userId, { motivo } = {}) {
  const comp = await query(
    'SELECT id, estado FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 AND id = $2',
    [solicitudId, comprobanteId]
  );
  if (comp.rows.length === 0) {
    throw new Error('Comprobante no encontrado');
  }
  const estado = (comp.rows[0].estado || '').toLowerCase();
  if (estado === 'validado') throw new Error('No se puede rechazar un comprobante ya validado');
  if (estado === 'rechazado') throw new Error('El comprobante ya está rechazado');

  await query(
    `UPDATE module_miauto_comprobante_cuota_semanal
     SET estado = 'rechazado', rechazado_at = CURRENT_TIMESTAMP, rechazo_razon = $1, rechazado_by = $2
     WHERE id = $3`,
    [motivo ? String(motivo).trim() : null, userId, comprobanteId]
  );
  return listBySolicitud(solicitudId);
}

/**
 * Cuenta la racha actual: cuántas cuotas consecutivas desde la más antigua (due_date ASC)
 * están pagadas o bonificadas y sin mora. Mismo criterio que calcularRacha en miautoCuotaSemanalService.
 */
function contarRachaConsecutiva(rows) {
  const porFechaAsc = [...rows].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  let racha = 0;
  for (const r of porFechaAsc) {
    const ok = (r.status === 'paid' || r.status === 'bonificada') && (parseFloat(r.late_fee) || 0) === 0;
    if (!ok) break;
    racha++;
  }
  return racha;
}

/**
 * Si hay 4+ cuotas consecutivas (desde la más antigua) pagadas/bonificadas sin mora,
 * concede 1 bonificación por cada bloque completo de 4 (4→1, 8→2, etc.).
 * Las bonificaciones se aplican a las ÚLTIMAS cuotas del plan (261 → cuota 261, 260, etc.).
 * Como las cuotas se crean cada lunes, no marcamos ninguna cuota aquí: solo subimos el contador
 * cuotas_semanales_bonificadas. Al crear cada cuota en ensureCuotaSemanalForWeek, si esa semana
 * es una de las últimas N (N = contador), se crea ya con status 'bonificada'.
 */
async function tryGrantBenefit4Consecutive(solicitudId) {
  const cuotas = await query(
    `SELECT id, due_date, amount_due, paid_amount, late_fee, status
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1
     ORDER BY due_date ASC`,
    [solicitudId]
  );
  const rows = cuotas.rows || [];
  const racha = contarRachaConsecutiva(rows);
  if (racha < 4) return;

  const sol = await query(
    'SELECT cuotas_semanales_bonificadas FROM module_miauto_solicitud WHERE id = $1',
    [solicitudId]
  );
  const current = (sol.rows[0] && parseInt(sol.rows[0].cuotas_semanales_bonificadas, 10)) || 0;
  const deservedBonuses = Math.floor(racha / 4);
  const toGrant = Math.max(0, deservedBonuses - current);
  if (toGrant === 0) return;

  await query(
    'UPDATE module_miauto_solicitud SET cuotas_semanales_bonificadas = cuotas_semanales_bonificadas + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [toGrant, solicitudId]
  );
}

/**
 * Solo evalúa si hay 4+ consecutivas pagadas/bonificadas sin mora y otorga bonificación.
 * Para uso en scripts de prueba: tú marcas las 4 cuotas, luego ejecutas esto.
 */
export async function runGrantBenefit4Consecutive(solicitudId) {
  return tryGrantBenefit4Consecutive(solicitudId);
}

/**
 * Valida comprobante: aplica monto a la cuota (convertido a PEN si hace falta), actualiza paid_amount y status.
 * Si con este pago la cuota queda pagada y sin mora, evalúa beneficio 4 seguidas.
 */
export async function validateComprobanteCuotaSemanal(solicitudId, comprobanteId, userId, { monto, moneda } = {}) {
  const comp = await query(
    'SELECT id, cuota_semanal_id, monto, moneda, estado FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 AND id = $2',
    [solicitudId, comprobanteId]
  );
  if (comp.rows.length === 0) throw new Error('Comprobante no encontrado');
  const compRow = comp.rows[0];
  if ((compRow.estado || '').toLowerCase() === 'validado') throw new Error('El comprobante ya está validado');
  if ((compRow.estado || '').toLowerCase() === 'rechazado') throw new Error('No se puede validar un comprobante rechazado');

  const cuota = await query(
    'SELECT id, amount_due, paid_amount, late_fee, status FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2',
    [compRow.cuota_semanal_id, solicitudId]
  );
  if (cuota.rows.length === 0) throw new Error('Cuota semanal no encontrada');
  const c = cuota.rows[0];
  if (c.status === 'paid' || c.status === 'bonificada') throw new Error('Esta cuota ya está pagada o bonificada');

  const montoIngreso = monto != null && moneda ? parseFloat(monto) : parseFloat(compRow.monto);
  if (Number.isNaN(montoIngreso) || montoIngreso <= 0) {
    throw new Error('Debe indicar monto y moneda para validar');
  }
  const monedaIngreso = (moneda || compRow.moneda || 'PEN').toUpperCase() === 'PEN' ? 'PEN' : 'USD';
  const montoAplicar = await montoEnPEN(solicitudId, montoIngreso, monedaIngreso);
  if (montoAplicar == null) throw new Error('No se pudo convertir el monto');

  const amountDue = parseFloat(c.amount_due) || 0;
  const paid = parseFloat(c.paid_amount) || 0;
  const lateFee = parseFloat(c.late_fee) || 0;
  const restanteCuota = Math.max(0, amountDue + lateFee - paid);
  if (montoAplicar > restanteCuota) {
    throw new Error(`El monto a validar (S/. ${montoAplicar.toFixed(2)}) no puede superar lo que falta por pagar en esta cuota (S/. ${restanteCuota.toFixed(2)})`);
  }

  await query(
    `UPDATE module_miauto_comprobante_cuota_semanal SET monto = $1, moneda = $2, estado = 'validado', validated_at = CURRENT_TIMESTAMP, validated_by = $3 WHERE id = $4`,
    [montoAplicar, 'PEN', userId, comprobanteId]
  );

  await aplicarPagoACuota(solicitudId, compRow.cuota_semanal_id, amountDue, paid, lateFee, montoAplicar);

  return listBySolicitud(solicitudId);
}

/**
 * Pago manual por admin: aplica monto a una cuota semanal (sin comprobante del conductor).
 * Registra un comprobante con file_path='manual' para auditoría.
 */
export async function addPagoManualCuotaSemanal(solicitudId, cuotaSemanalId, userId, { monto, moneda } = {}) {
  const num = monto != null ? parseFloat(monto) : NaN;
  if (Number.isNaN(num) || num <= 0) throw new Error('Monto inválido');

  const cuota = await query(
    'SELECT id, amount_due, paid_amount, late_fee, status FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2',
    [cuotaSemanalId, solicitudId]
  );
  if (cuota.rows.length === 0) throw new Error('Cuota semanal no encontrada');
  const c = cuota.rows[0];
  if (c.status === 'paid' || c.status === 'bonificada') throw new Error('Esta cuota ya está pagada o bonificada');

  const montoAplicar = await montoEnPEN(solicitudId, num, moneda);
  if (montoAplicar == null) throw new Error('No se pudo convertir el monto');

  await query(
    `INSERT INTO module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, validated_at, validated_by)
     VALUES ($1, $2, $3, 'PEN', 'Pago manual', 'manual', 'validado', CURRENT_TIMESTAMP, $4)`,
    [solicitudId, cuotaSemanalId, montoAplicar, userId]
  );

  const amountDue = parseFloat(c.amount_due) || 0;
  const paid = parseFloat(c.paid_amount) || 0;
  const lateFee = parseFloat(c.late_fee) || 0;
  await aplicarPagoACuota(solicitudId, cuotaSemanalId, amountDue, paid, lateFee, montoAplicar);

  return listBySolicitud(solicitudId);
}
