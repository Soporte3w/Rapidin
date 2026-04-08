/**
 * Comprobantes de pago para cuotas semanales Mi Auto.
 * Conductor sube comprobante por cuota; admin valida o rechaza.
 * Al validar (o pago manual) se aplica el monto a la cuota y se evalúa beneficio 4 cuotas seguidas.
 */
import { query } from '../config/database.js';
import { uploadFileToMedia } from './voucherService.js';
import { montoComprobanteCuotaALaMonedaFila, normalizePenUsd, round2 } from './miautoMoneyUtils.js';
import { persistPaidAmountCapsForSolicitud, updateMoraDiaria } from './miautoCuotaSemanalService.js';

/** PostgreSQL 42703 = undefined_column; si no hay columna `origen`, inferimos desde file_path. */
function isUndefinedColumnError(err) {
  const code = err?.code;
  const msg = String(err?.message || '');
  return code === '42703' || /column.*origen|origen.*does not exist/i.test(msg);
}

function inferOrigenFromRow(r) {
  if (!r) return 'conductor';
  if (r.file_path === 'manual') return 'pago_manual';
  return 'conductor';
}

const SELECT_CUOTA_COMP_BASE = `SELECT id, solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado,
            validated_at, validated_by, rechazado_at, rechazo_razon, created_at`;

async function refreshMoraTrasPagoValidado(solicitudId) {
  await updateMoraDiaria(solicitudId, { includePartial: true });
  await persistPaidAmountCapsForSolicitud(solicitudId);
}

/** Actualiza cuota con nuevo paid_amount y status; aplica beneficio 4 seguidas si queda pagada. */
async function aplicarPagoACuota(solicitudId, cuotaSemanalId, amountDue, paid, lateFee, montoAplicar) {
  const totalDue = round2(amountDue + lateFee);
  let newPaid = round2(paid + montoAplicar);
  newPaid = round2(Math.min(newPaid, totalDue));
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

function restanteFilaCuota(r) {
  if (!r || r.status === 'paid' || r.status === 'bonificada') return 0;
  const ad = parseFloat(r.amount_due) || 0;
  const pd = parseFloat(r.paid_amount) || 0;
  const lf = parseFloat(r.late_fee) || 0;
  return Math.max(0, round2(ad + lf - pd));
}

/**
 * Reparte `montoAplicar` en PEN: primero la cuota prioritaria (la del comprobante / pago manual),
 * luego el resto en orden due_date ASC. Relee cada fila tras cada aplicación.
 */
function prefijoMontoCuotaMoneda(monedaFila) {
  const m = String(monedaFila || 'PEN').toUpperCase();
  if (m === 'USD') return 'US$';
  return 'S/.';
}

async function aplicarPagoEnCuotasCascada(solicitudId, cuotaPrioritariaId, montoAplicar) {
  const cuotasRes = await query(
    `SELECT id, due_date, amount_due, paid_amount, late_fee, status, moneda
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1
     ORDER BY due_date ASC NULLS LAST, id ASC`,
    [solicitudId]
  );
  const rows = cuotasRes.rows || [];
  const totalPendiente = round2(rows.reduce((s, r) => s + restanteFilaCuota(r), 0));
  const monedaRef =
    rows.find((r) => restanteFilaCuota(r) > 0.005)?.moneda ?? rows[0]?.moneda;
  const pref = prefijoMontoCuotaMoneda(monedaRef);
  if (montoAplicar > totalPendiente) {
    throw new Error(
      `El monto a aplicar (${pref} ${montoAplicar.toFixed(2)}) supera el total pendiente del cronograma (${pref} ${totalPendiente.toFixed(2)}). Si las cuotas están en USD, indica el monto en dólares en el comprobante.`
    );
  }

  const orderedIds = [];
  const seen = new Set();
  if (cuotaPrioritariaId != null) {
    orderedIds.push(cuotaPrioritariaId);
    seen.add(cuotaPrioritariaId);
  }
  for (const r of rows) {
    if (!seen.has(r.id)) {
      orderedIds.push(r.id);
      seen.add(r.id);
    }
  }

  let saldo = round2(montoAplicar);
  for (const cuotaId of orderedIds) {
    if (saldo <= 0) break;
    const cu = await query(
      'SELECT id, amount_due, paid_amount, late_fee, status, moneda FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2',
      [cuotaId, solicitudId]
    );
    if (cu.rows.length === 0) continue;
    const c = cu.rows[0];
    if (c.status === 'paid' || c.status === 'bonificada') continue;
    const amountDue = parseFloat(c.amount_due) || 0;
    const paid = parseFloat(c.paid_amount) || 0;
    const lateFee = parseFloat(c.late_fee) || 0;
    const restante = Math.max(0, round2(amountDue + lateFee - paid));
    if (restante <= 0) continue;
    const chunk = round2(Math.min(saldo, restante));
    if (chunk <= 0) continue;
    await aplicarPagoACuota(solicitudId, cuotaId, amountDue, paid, lateFee, chunk);
    saldo = round2(saldo - chunk);
  }
}

/** Lista comprobantes de cuota semanal por solicitud. `origen`: conductor | admin_confirmacion | pago_manual */
export async function listBySolicitud(solicitudId) {
  try {
    const res = await query(
      `${SELECT_CUOTA_COMP_BASE},
            COALESCE(origen, 'conductor') AS origen
     FROM module_miauto_comprobante_cuota_semanal
     WHERE solicitud_id = $1 ORDER BY created_at ASC`,
      [solicitudId]
    );
    return res.rows || [];
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    const res = await query(
      `${SELECT_CUOTA_COMP_BASE}
     FROM module_miauto_comprobante_cuota_semanal
     WHERE solicitud_id = $1 ORDER BY created_at ASC`,
      [solicitudId]
    );
    const rows = res.rows || [];
    return rows.map((r) => ({ ...r, origen: inferOrigenFromRow(r) }));
  }
}

/** Conductor sube comprobante para una cuota semanal (monto y moneda opcionales; el admin puede fijarlos al validar). */
export async function createComprobanteCuotaSemanal(solicitudId, cuotaSemanalId, file, monto, moneda, userId = null) {
  const path = await uploadFileToMedia(file);
  const fileName = file.originalname || `comprobante_cuota_${Date.now()}.pdf`;
  const montoVal = monto != null ? parseFloat(monto) : null;
  const monedaVal = normalizePenUsd(moneda);

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

  try {
    await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, origen)
       VALUES ($1, $2, $3, $4, $5, $6, 'conductor')`,
      [solicitudId, cuotaSemanalId, montoVal, monedaVal, fileName, path]
    );
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [solicitudId, cuotaSemanalId, montoVal, monedaVal, fileName, path]
    );
  }
  return listBySolicitud(solicitudId);
}

/**
 * Admin sube comprobante de conformidad del pago (documento oficial para el conductor).
 * - Si se envían `monto` y `moneda` (body multipart): se guardan en el comprobante (cualquier estado de cuota).
 * - Si la cuota aún no está pagada/bonificada y hay monto explícito: además se aplica el pago a la cuota (misma lógica que validar comprobante del conductor).
 *   Eso **solo** ocurre aquí (ruta admin `comprobantes-conformidad-admin`); el conductor que sube comprobante por `createComprobanteCuotaSemanal` no acredita hasta que staff valide.
 * - Si no hay monto explícito: solo si la cuota está pagada o bonificada; monto = pagado o total a pagar (solo referencia en el PDF).
 */
export async function createComprobanteConformidadAdmin(solicitudId, cuotaSemanalId, file, userId, options = {}) {
  const cuota = await query(
    `SELECT id, status, paid_amount, amount_due, late_fee, moneda
     FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2`,
    [cuotaSemanalId, solicitudId]
  );
  if (cuota.rows.length === 0) {
    throw new Error('Cuota semanal no encontrada o no pertenece a esta solicitud');
  }
  const c = cuota.rows[0];
  const monedaCuotaFila = c.moneda;
  const st = (c.status || '').toLowerCase();

  const rawMonto = options.monto;
  const rawMoneda = options.moneda;
  const explicitMonto =
    rawMonto != null && String(rawMonto).trim() !== '' && !Number.isNaN(parseFloat(String(rawMonto).replace(',', '.')));
  const explicitMoneda = rawMoneda != null && String(rawMoneda).trim() !== '';

  let montoVal;
  let monedaVal;

  if (explicitMonto) {
    montoVal = round2(parseFloat(String(rawMonto).replace(',', '.')));
    if (!Number.isFinite(montoVal) || montoVal <= 0) {
      throw new Error('Indica un monto válido mayor a cero para el comprobante');
    }
    monedaVal = explicitMoneda ? normalizePenUsd(String(rawMoneda).trim()) : normalizePenUsd(c.moneda || 'PEN');
  } else {
    if (st !== 'paid' && st !== 'bonificada') {
      throw new Error(
        'El comprobante de conformidad solo se puede subir sin monto cuando la cuota está pagada o bonificada. Indica monto y moneda del comprobante.'
      );
    }
    const totalDue = round2(Number(c.amount_due || 0) + Number(c.late_fee || 0));
    const paid = round2(Number(c.paid_amount || 0));
    /** Referencia informativa (la columna es NOT NULL); no aplica un pago nuevo. */
    montoVal = paid > 0 ? paid : totalDue;
    monedaVal = normalizePenUsd(c.moneda || 'PEN');
  }

  const path = await uploadFileToMedia(file);
  const fileName = file.originalname || `conformidad_pago_${Date.now()}.pdf`;

  let insertedId = null;
  try {
    const ins = await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal
       (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, validated_at, validated_by, origen)
       VALUES ($1, $2, $3, $4, $5, $6, 'validado', CURRENT_TIMESTAMP, $7, 'admin_confirmacion')
       RETURNING id`,
      [solicitudId, cuotaSemanalId, montoVal, monedaVal, fileName, path, userId]
    );
    insertedId = ins.rows[0]?.id ?? null;
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    const ins = await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal
       (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, validated_at, validated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'validado', CURRENT_TIMESTAMP, $7)
       RETURNING id`,
      [solicitudId, cuotaSemanalId, montoVal, monedaVal, fileName, path, userId]
    );
    insertedId = ins.rows[0]?.id ?? null;
  }

  /** Solo esta función (conformidad admin) acredita al subir; comprobante del conductor sigue pendiente de validación. */
  const debeAcreditarPago =
    explicitMonto && st !== 'paid' && st !== 'bonificada' && insertedId != null;
  if (debeAcreditarPago) {
    /** Misma moneda que `amount_due`/`paid_amount` en BD (p. ej. USD en cuota USD), no solo soles. */
    const montoAplicar = await montoComprobanteCuotaALaMonedaFila(
      solicitudId,
      montoVal,
      monedaVal,
      monedaCuotaFila
    );
    if (montoAplicar > 0.005) {
      try {
        await aplicarPagoEnCuotasCascada(solicitudId, cuotaSemanalId, montoAplicar);
      } catch (err) {
        await query(`DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2`, [
          insertedId,
          solicitudId,
        ]);
        throw err;
      }
      await refreshMoraTrasPagoValidado(solicitudId);
      const monedaComprobantePersist =
        String(monedaCuotaFila || 'PEN').toUpperCase() === 'USD' ? 'USD' : 'PEN';
      try {
        await query(
          `UPDATE module_miauto_comprobante_cuota_semanal SET monto = $1, moneda = $2 WHERE id = $3`,
          [montoAplicar, monedaComprobantePersist, insertedId]
        );
      } catch (e) {
        if (!isUndefinedColumnError(e)) throw e;
      }
    }
  }

  return listBySolicitud(solicitudId);
}

/**
 * Elimina solo el comprobante de conformidad del administrador (origen admin_confirmacion).
 * Permite volver a subir un archivo nuevo.
 */
export async function deleteComprobanteConformidadAdmin(solicitudId, comprobanteId) {
  let row;
  try {
    const res = await query(
      `SELECT id, COALESCE(origen, 'conductor') AS origen
       FROM module_miauto_comprobante_cuota_semanal
       WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    row = res.rows[0];
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    const res = await query(
      `SELECT id, file_path FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    row = res.rows[0] ? { ...res.rows[0], origen: inferOrigenFromRow(res.rows[0]) } : null;
  }
  if (!row) {
    throw new Error('Comprobante no encontrado');
  }
  if ((row.origen || '').toLowerCase() !== 'admin_confirmacion') {
    throw new Error('Solo se puede eliminar el comprobante de conformidad de pago del administrador');
  }
  await query(`DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2`, [
    comprobanteId,
    solicitudId,
  ]);
  return listBySolicitud(solicitudId);
}

/** Rechazar comprobante (solo si está pendiente). */
export async function rejectComprobanteCuotaSemanal(solicitudId, comprobanteId, userId, { motivo } = {}) {
  let row;
  try {
    const comp = await query(
      `SELECT id, estado, COALESCE(origen, 'conductor') AS origen, file_path
       FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    row = comp.rows[0];
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    const comp = await query(
      `SELECT id, estado, file_path FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    row = comp.rows[0] ? { ...comp.rows[0], origen: inferOrigenFromRow(comp.rows[0]) } : null;
  }
  if (!row) {
    throw new Error('Comprobante no encontrado');
  }
  const origen = (row.origen || 'conductor').toLowerCase();
  if (origen === 'admin_confirmacion') throw new Error('No se puede rechazar el comprobante de conformidad del administrador');
  if (origen === 'pago_manual') throw new Error('No se puede rechazar un registro de pago manual');
  const estado = (row.estado || '').toLowerCase();
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
 * están pagadas o bonificadas (la mora en BD puede ser >0 aunque ya esté saldada). Mismo criterio que calcularRacha.
 */
function contarRachaConsecutiva(rows) {
  const porFechaAsc = [...rows].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  let racha = 0;
  for (const r of porFechaAsc) {
    const st = (r.status || '').toLowerCase();
    const ok = st === 'paid' || st === 'bonificada';
    if (!ok) break;
    racha++;
  }
  return racha;
}

const MIN_VIAJES_BONO_TIEMPO = 120;

/**
 * Solo concede bono por 4 pagos consecutivos a tiempo cuando el cronograma tiene bono_tiempo_activo.
 * En ese caso, las 4 semanas del bloque deben tener >= 120 viajes cada una.
 * Si bono_tiempo_activo es false, esta regla no se aplica (no se otorga bonificación).
 */
async function tryGrantBenefit4Consecutive(solicitudId) {
  const sol = await query(
    'SELECT cuotas_semanales_bonificadas, cronograma_id FROM module_miauto_solicitud WHERE id = $1',
    [solicitudId]
  );
  const cronogramaId = sol.rows[0]?.cronograma_id;
  if (!cronogramaId) return;
  const crono = await query(
    'SELECT bono_tiempo_activo FROM module_miauto_cronograma WHERE id = $1',
    [cronogramaId]
  );
  if (!crono.rows[0] || !crono.rows[0].bono_tiempo_activo) return;

  const cuotas = await query(
    `SELECT id, due_date, amount_due, paid_amount, late_fee, status, num_viajes
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1
     ORDER BY due_date ASC`,
    [solicitudId]
  );
  const rows = cuotas.rows || [];
  const racha = contarRachaConsecutiva(rows);
  if (racha < 4) return;

  const primerasCuatro = rows.slice(0, 4);
  const todasCon120 = primerasCuatro.every((r) => (Number(r.num_viajes) || 0) >= MIN_VIAJES_BONO_TIEMPO);
  if (!todasCon120) return;

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
 * Valida comprobante: aplica monto a la cuota en la **moneda de la fila** (PEN/COP o USD), actualiza paid_amount y status.
 * Si con este pago la cuota queda pagada y sin mora, evalúa beneficio 4 seguidas.
 */
export async function validateComprobanteCuotaSemanal(solicitudId, comprobanteId, userId, { monto, moneda } = {}) {
  let compRow;
  try {
    const comp = await query(
      `SELECT id, cuota_semanal_id, monto, moneda, estado, COALESCE(origen, 'conductor') AS origen
       FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    compRow = comp.rows[0];
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    const comp = await query(
      `SELECT id, cuota_semanal_id, monto, moneda, estado, file_path
       FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    const r = comp.rows[0];
    compRow = r ? { ...r, origen: inferOrigenFromRow(r) } : null;
  }
  if (!compRow) throw new Error('Comprobante no encontrado');
  const origen = (compRow.origen || 'conductor').toLowerCase();
  if (origen === 'admin_confirmacion') throw new Error('No se valida el comprobante de conformidad; ya está registrado');
  if (origen === 'pago_manual') throw new Error('No se valida un registro de pago manual');
  if ((compRow.estado || '').toLowerCase() === 'validado') throw new Error('El comprobante ya está validado');
  if ((compRow.estado || '').toLowerCase() === 'rechazado') throw new Error('No se puede validar un comprobante rechazado');

  const cuota = await query(
    'SELECT id, amount_due, paid_amount, late_fee, status, moneda FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2',
    [compRow.cuota_semanal_id, solicitudId]
  );
  if (cuota.rows.length === 0) throw new Error('Cuota semanal no encontrada');
  const c = cuota.rows[0];
  if (c.status === 'paid' || c.status === 'bonificada') throw new Error('Esta cuota ya está pagada o bonificada');

  const montoIngreso = monto != null && moneda ? parseFloat(monto) : parseFloat(compRow.monto);
  if (Number.isNaN(montoIngreso) || montoIngreso <= 0) {
    throw new Error('Debe indicar monto y moneda para validar');
  }
  const monedaIngreso = normalizePenUsd(moneda || compRow.moneda || 'PEN');
  const montoAplicar = await montoComprobanteCuotaALaMonedaFila(
    solicitudId,
    montoIngreso,
    monedaIngreso,
    c.moneda
  );
  if (montoAplicar <= 0.005) throw new Error('No se pudo convertir el monto');
  const monedaComprobantePersist =
    String(c.moneda || 'PEN').toUpperCase() === 'USD' ? 'USD' : 'PEN';

  await query(
    `UPDATE module_miauto_comprobante_cuota_semanal SET monto = $1, moneda = $2, estado = 'validado', validated_at = CURRENT_TIMESTAMP, validated_by = $3 WHERE id = $4`,
    [montoAplicar, monedaComprobantePersist, userId, comprobanteId]
  );

  await aplicarPagoEnCuotasCascada(solicitudId, compRow.cuota_semanal_id, montoAplicar);
  await refreshMoraTrasPagoValidado(solicitudId);

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
    'SELECT id, amount_due, paid_amount, late_fee, status, moneda FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2',
    [cuotaSemanalId, solicitudId]
  );
  if (cuota.rows.length === 0) throw new Error('Cuota semanal no encontrada');
  const c = cuota.rows[0];
  if (c.status === 'paid' || c.status === 'bonificada') throw new Error('Esta cuota ya está pagada o bonificada');

  const montoAplicar = await montoComprobanteCuotaALaMonedaFila(solicitudId, num, moneda, c.moneda);
  if (montoAplicar <= 0.005) throw new Error('No se pudo convertir el monto');
  const monedaComprobantePersist =
    String(c.moneda || 'PEN').toUpperCase() === 'USD' ? 'USD' : 'PEN';

  try {
    await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, validated_at, validated_by, origen)
       VALUES ($1, $2, $3, $4, 'Pago manual', 'manual', 'validado', CURRENT_TIMESTAMP, $5, 'pago_manual')`,
      [solicitudId, cuotaSemanalId, montoAplicar, monedaComprobantePersist, userId]
    );
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, validated_at, validated_by)
       VALUES ($1, $2, $3, $4, 'Pago manual', 'manual', 'validado', CURRENT_TIMESTAMP, $5)`,
      [solicitudId, cuotaSemanalId, montoAplicar, monedaComprobantePersist, userId]
    );
  }

  await aplicarPagoEnCuotasCascada(solicitudId, cuotaSemanalId, montoAplicar);
  await refreshMoraTrasPagoValidado(solicitudId);

  return listBySolicitud(solicitudId);
}
