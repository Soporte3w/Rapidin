/** Comprobantes de cuota semanal Mi Auto: alta, validación, conformidad admin, pago manual, bono tiempo. */
import { query } from '../../../config/database.js';
import { uploadFileToMedia } from '../../../services/voucherService.js';
import { montoComprobanteCuotaALaMonedaFila, normalizePenUsd, round2, tipoCambioUsdALocalEfectivo } from '../utils/miautoMoneyUtils.js';
import { MIAUTO_PARK_ID } from '../utils/miautoDriverLookup.js';
import {
  isSemanaDepositoMiAuto,
  loadMiautoComprobanteDerivacionContext,
  miautoCuotaFinalDerivada,
  miautoStatusCuotaTrasAbonoDerivado,
  persistPaidAmountCapsForSolicitud,
  touchFechaPrimerComprobanteCuota,
  touchFechaUltimoAbonoCuota,
  updateMoraDiaria,
} from '../cuotas/miautoCuotaSemanalService.js';
import { reconciliarBonosTiempo } from '../bonos/miautoBonoTiempoService.js';

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

async function monedaPersistidaParaCuota(solicitudId, monedaCuota) {
  if (String(monedaCuota || 'PEN').toUpperCase() === 'USD') return 'USD';
  const sol = await query(
    'SELECT country FROM module_miauto_solicitud WHERE id = $1 LIMIT 1',
    [solicitudId]
  );
  const { monedaLocal } = await tipoCambioUsdALocalEfectivo(sol.rows?.[0]?.country || 'PE');
  return monedaLocal;
}

const SELECT_CUOTA_COMP_BASE = `SELECT id, solicitud_id, cuota_semanal_id, monto, monto AS monto_declarado, moneda, file_name, file_path, estado,
            validated_at, validated_by, rechazado_at, rechazo_razon, created_at`;

async function refreshMoraTrasPagoValidado(solicitudId) {
  await updateMoraDiaria(solicitudId, { includePartial: true, includeExcelMora: true });
  await persistPaidAmountCapsForSolicitud(solicitudId);
}

function limaTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function dueYmdFromRow(dueDate) {
  if (!dueDate) return null;
  const s = String(dueDate);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
  return m ? m[1] : null;
}

function normalizeChunksFromRow(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function computeStatusAfterRevert(c, newPaid) {
  const amountDue = parseFloat(c.amount_due) || 0;
  const lateFee = parseFloat(c.late_fee) || 0;
  const moraExtra = parseFloat(c.mora_extra) || 0;
  const totalDue = round2(amountDue + lateFee + moraExtra);
  const st = (c.status || '').toLowerCase();
  if (st === 'bonificada') return 'bonificada';
  if (newPaid >= totalDue - 0.02) return 'paid';
  const dueY = dueYmdFromRow(c.due_date);
  const today = limaTodayYmd();
  if (dueY && dueY < today) return 'overdue';
  if (newPaid > 0.02) return 'partial';
  return 'pending';
}

async function persistAplicacionChunks(comprobanteId, solicitudId, chunks) {
  if (!comprobanteId || !solicitudId || !chunks?.length) return;
  try {
    await query(
      `UPDATE module_miauto_comprobante_cuota_semanal SET aplicacion_chunks = $1::jsonb WHERE id = $2 AND solicitud_id = $3`,
      [JSON.stringify(chunks), comprobanteId, solicitudId]
    );
  } catch (e) {
    if (isUndefinedColumnError(e)) return;
    throw e;
  }
}

async function aplicarComprobanteInmediato(solicitudId, comprobanteId, cuotaSemanalId, montoIngreso, monedaIngreso) {
  const cuota = await query(`SELECT * FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2`, [
    cuotaSemanalId,
    solicitudId,
  ]);
  if (cuota.rows.length === 0) throw new Error('Cuota semanal no encontrada');
  const c = cuota.rows[0];
  const montoAplicar = await montoComprobanteCuotaALaMonedaFila(
    solicitudId,
    montoIngreso,
    monedaIngreso,
    c.moneda
  );
  if (montoAplicar <= 0.005) throw new Error('No se pudo convertir el monto');
  const monedaComprobantePersist = await monedaPersistidaParaCuota(solicitudId, c.moneda);

  const { chunks } = await aplicarPagoEnCuotasCascada(solicitudId, cuotaSemanalId, montoAplicar);
  await persistAplicacionChunks(comprobanteId, solicitudId, chunks);
  await query(
    `UPDATE module_miauto_comprobante_cuota_semanal
     SET monto = $1,
         moneda = $2,
         acredito_en_cronograma = $5
     WHERE id = $3 AND solicitud_id = $4`,
    [montoAplicar, monedaComprobantePersist, comprobanteId, solicitudId, chunks.length > 0]
  );
  await refreshMoraTrasPagoValidado(solicitudId);
  return { montoAplicar, monedaComprobantePersist, chunks };
}

async function aplicarPagoACuota(solicitudId, cuotaSemanalId, montoMaxAplicar, ctx) {
  const cu = await query(`SELECT * FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2`, [
    cuotaSemanalId,
    solicitudId,
  ]);
  const c = cu.rows[0];
  if (!c || (c.status || '').toLowerCase() === 'bonificada') {
    return { newPaid: null, newStatus: null, chunk: 0 };
  }
  // paid en columna pero saldo derivado > 0: aún se puede abonar
  if ((c.status || '').toLowerCase() === 'paid' && miautoCuotaFinalDerivada(c, ctx) <= 0.005) {
    return { newPaid: null, newStatus: null, chunk: 0 };
  }
  const paid = round2(parseFloat(c.paid_amount) || 0);
  const before = {
    cuota_semanal_id: String(cuotaSemanalId),
    paid_amount: paid,
    late_fee: round2(parseFloat(c.late_fee) || 0),
    mora_extra: round2(parseFloat(c.mora_extra) || 0),
    mora_extra_desde: c.mora_extra_desde || null,
    mora_extra_total: round2(parseFloat(c.mora_extra_total) || 0),
    status: c.status || null,
    fecha_ultimo_abono: c.fecha_ultimo_abono || null,
  };
  const pending = miautoCuotaFinalDerivada(c, ctx);
  const chunk = round2(Math.min(montoMaxAplicar, pending));
  if (chunk <= 0) {
    return { newPaid: paid, newStatus: c.status, chunk: 0 };
  }
  const newPaid = round2(paid + chunk);
  const newStatus = miautoStatusCuotaTrasAbonoDerivado(c, newPaid, ctx);
  await query(
    `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [newPaid, newStatus, cuotaSemanalId]
  );
  await touchFechaUltimoAbonoCuota(cuotaSemanalId, paid, newPaid);
  await reconciliarBonosTiempo(solicitudId);
  return { newPaid, newStatus, chunk, before };
}

function prefijoMontoCuotaMoneda(monedaFila) {
  const m = String(monedaFila || 'PEN').toUpperCase();
  if (m === 'USD') return 'US$';
  return 'S/.';
}

async function aplicarPagoEnCuotasCascada(solicitudId, cuotaPrioritariaId, montoAplicar) {
  const ctx = await loadMiautoComprobanteDerivacionContext(solicitudId);
  const chunks = [];
  const cuotasRes = await query(
    `SELECT * FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1
     ORDER BY due_date ASC NULLS LAST, id ASC`,
    [solicitudId]
  );
  const rows = cuotasRes.rows || [];
  const totalPendiente = round2(
    rows.reduce((s, r) => {
      if ((r.status || '').toLowerCase() === 'bonificada') return s;
      return s + Math.max(0, miautoCuotaFinalDerivada(r, ctx));
    }, 0)
  );
  const monedaRef =
    rows.find((r) => {
      if ((r.status || '').toLowerCase() === 'bonificada') return false;
      return miautoCuotaFinalDerivada(r, ctx) > 0.005;
    })?.moneda ?? rows[0]?.moneda;
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
    const cu = await query(`SELECT * FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2`, [
      cuotaId,
      solicitudId,
    ]);
    if (cu.rows.length === 0) continue;
    const c = cu.rows[0];
    if ((c.status || '').toLowerCase() === 'bonificada') continue;
    const pending = miautoCuotaFinalDerivada(c, ctx);
    if (pending <= 0.005) continue;
    const montoEstaCuota = round2(Math.min(saldo, pending));
    if (montoEstaCuota <= 0) continue;
    const { chunk, before } = await aplicarPagoACuota(solicitudId, cuotaId, montoEstaCuota, ctx);
    if (chunk > 0) {
      chunks.push({ cuota_semanal_id: String(cuotaId), monto: chunk, before });
      saldo = round2(saldo - chunk);
    }
  }
  return { chunks };
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

/** Lista centralizada para validación admin: comprobantes del conductor y pagos manuales pendientes/históricos. */
export async function listForAdminValidation({ estado = 'pendiente', country, limit = 300 } = {}) {
  const params = [];
  const where = [
    `LOWER(COALESCE(NULLIF(TRIM(cp.estado::text), ''), 'pendiente')) <> 'anulado'`,
    `LOWER(COALESCE(cp.origen, 'conductor')) IN ('conductor', 'admin_confirmacion', 'pago_manual')`,
    `COALESCE(s.deleted_at IS NULL, true)`,
  ];

  const estadoNorm = String(estado || 'pendiente').trim().toLowerCase();
  if (estadoNorm && estadoNorm !== 'todos') {
    params.push(estadoNorm);
    where.push(`LOWER(COALESCE(NULLIF(TRIM(cp.estado::text), ''), 'pendiente')) = $${params.length}`);
  }

  const countryNorm = String(country || '').trim().toUpperCase();
  if (countryNorm) {
    params.push(countryNorm);
    where.push(`UPPER(COALESCE(s.country, '')) = $${params.length}`);
  }

  params.push(MIAUTO_PARK_ID);
  const parkIdParam = params.length;
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 300));
  params.push(limitNum);

  const res = await query(
    `SELECT
        cp.id,
        cp.solicitud_id,
        cp.cuota_semanal_id,
        cp.monto,
        cp.moneda,
        cp.file_name,
        cp.file_path,
        COALESCE(NULLIF(TRIM(cp.estado::text), ''), 'pendiente') AS estado,
        cp.validated_at,
        cp.validated_by,
        cp.rechazado_at,
        cp.rechazo_razon,
        cp.rechazado_by,
        cp.created_at,
        COALESCE(cp.origen, 'conductor') AS origen,
        s.dni,
        s.phone,
        s.email,
        s.country,
        s.license_number,
        s.placa_asignada,
        COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', rd.first_name, rd.last_name)), ''),
          NULLIF(TRIM(CONCAT_WS(' ', d_fleet.first_name, d_fleet.last_name)), ''),
          NULLIF(TRIM(CONCAT_WS(' ', d_placa.first_name, d_placa.last_name)), '')
        ) AS driver_name,
        rd.first_name AS driver_first_name,
        rd.last_name AS driver_last_name,
        cr.name AS cronograma_name,
        cv.name AS vehiculo_name,
        c.week_start_date,
        c.due_date,
        c.amount_due,
        c.paid_amount,
        c.late_fee,
        c.status AS cuota_status,
        c.moneda AS cuota_moneda
      FROM module_miauto_comprobante_cuota_semanal cp
      INNER JOIN module_miauto_solicitud s ON s.id = cp.solicitud_id
      INNER JOIN module_miauto_cuota_semanal c ON c.id = cp.cuota_semanal_id
      LEFT JOIN module_rapidin_drivers rd ON rd.id::text = s.driver_id_fleet
      LEFT JOIN LATERAL (
        SELECT first_name, last_name
        FROM drivers d
        WHERE d.driver_id = s.driver_id_fleet
        LIMIT 1
      ) d_fleet ON true
      LEFT JOIN LATERAL (
        SELECT first_name, last_name
        FROM drivers d
        WHERE TRIM(COALESCE(d.park_id::text, '')) = $${parkIdParam}
          AND d.work_status = 'working'
          AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(d.car_number, '')), '\\s', '', 'g')) =
              UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '\\s', '', 'g'))
          AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(s.placa_asignada, '')), '\\s', '', 'g')) <> ''
        LIMIT 1
      ) d_placa ON true
      LEFT JOIN module_miauto_cronograma cr ON cr.id = s.cronograma_id
      LEFT JOIN module_miauto_cronograma_vehiculo cv ON cv.id = s.cronograma_vehiculo_id
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE LOWER(COALESCE(NULLIF(TRIM(cp.estado::text), ''), 'pendiente'))
          WHEN 'pendiente' THEN 0
          WHEN 'validado' THEN 1
          WHEN 'rechazado' THEN 2
          ELSE 4
        END,
        cp.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return res.rows || [];
}

/** Conductor sube comprobante para una cuota semanal. El monto declarado congela la mora mientras se valida. */
export async function createComprobanteCuotaSemanal(solicitudId, cuotaSemanalId, file, monto, moneda) {
  const cuota = await query(`SELECT * FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2`, [
    cuotaSemanalId,
    solicitudId,
  ]);
  if (cuota.rows.length === 0) {
    throw new Error('Cuota semanal no encontrada o no pertenece a esta solicitud');
  }
  const c = cuota.rows[0];
  const stC = (c.status || '').toLowerCase();
  if (stC === 'bonificada') {
    throw new Error('Esta cuota ya está pagada o bonificada');
  }
  const ctxCond = await loadMiautoComprobanteDerivacionContext(solicitudId);
  if (stC === 'paid' && miautoCuotaFinalDerivada(c, ctxCond) <= 0.005) {
    throw new Error('Esta cuota ya está pagada o bonificada');
  }

  let pendiente;
  try {
    pendiente = await query(
      `SELECT id
       FROM module_miauto_comprobante_cuota_semanal
       WHERE solicitud_id = $1
         AND cuota_semanal_id = $2
         AND LOWER(COALESCE(NULLIF(TRIM(estado::text), ''), 'pendiente')) = 'pendiente'
         AND COALESCE(origen, 'conductor') = 'conductor'
       LIMIT 1`,
      [solicitudId, cuotaSemanalId]
    );
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    pendiente = await query(
      `SELECT id
       FROM module_miauto_comprobante_cuota_semanal
       WHERE solicitud_id = $1
         AND cuota_semanal_id = $2
         AND LOWER(COALESCE(NULLIF(TRIM(estado::text), ''), 'pendiente')) = 'pendiente'
       LIMIT 1`,
      [solicitudId, cuotaSemanalId]
    );
  }
  if (pendiente.rows.length > 0) {
    throw new Error('Ya tienes un comprobante en revisión para esta cuota');
  }

  const montoVal = round2(parseFloat(String(monto ?? '').replace(',', '.')));
  if (!Number.isFinite(montoVal) || montoVal <= 0) {
    throw new Error('Indica cuánto estás pagando con este comprobante');
  }
  const monedaCuota = normalizePenUsd(c.moneda || 'PEN');
  const monedaVal = moneda ? normalizePenUsd(moneda) : monedaCuota;
  if (monedaVal !== monedaCuota) {
    throw new Error(`La moneda del comprobante debe ser ${monedaCuota}`);
  }
  const pendienteCuota = round2(Math.max(0, miautoCuotaFinalDerivada(c, ctxCond)));
  if (montoVal > pendienteCuota + 0.01) {
    throw new Error(`El monto no puede superar el saldo pendiente de la cuota (${monedaCuota} ${pendienteCuota.toFixed(2)})`);
  }

  const path = await uploadFileToMedia(file);
  const fileName = file.originalname || `comprobante_cuota_${Date.now()}.pdf`;

  try {
    const inserted = await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, origen)
       VALUES ($1, $2, $3, $4, $5, $6, 'conductor')
       RETURNING id`,
      [solicitudId, cuotaSemanalId, montoVal, monedaVal, fileName, path]
    );
    const comprobanteId = inserted.rows[0].id;
    try {
      await aplicarComprobanteInmediato(solicitudId, comprobanteId, cuotaSemanalId, montoVal, monedaVal);
    } catch (applyError) {
      await query('DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2', [comprobanteId, solicitudId]);
      throw applyError;
    }
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    const inserted = await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [solicitudId, cuotaSemanalId, montoVal, monedaVal, fileName, path]
    );
    const comprobanteId = inserted.rows[0].id;
    try {
      await aplicarComprobanteInmediato(solicitudId, comprobanteId, cuotaSemanalId, montoVal, monedaVal);
    } catch (applyError) {
      await query('DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2', [comprobanteId, solicitudId]);
      throw applyError;
    }
  }
  await touchFechaPrimerComprobanteCuota(cuotaSemanalId);
  return listBySolicitud(solicitudId);
}

/** El conductor puede retirar un comprobante propio mientras no haya sido validado. */
export async function deleteComprobanteCuotaSemanalConductor(solicitudId, comprobanteId) {
  let row;
  try {
    const res = await query(
      `SELECT id, COALESCE(origen, 'conductor') AS origen, estado, file_path, aplicacion_chunks
       FROM module_miauto_comprobante_cuota_semanal
       WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    row = res.rows[0];
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    const res = await query(
      `SELECT id, estado, file_path
       FROM module_miauto_comprobante_cuota_semanal
       WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    row = res.rows[0] ? { ...res.rows[0], origen: inferOrigenFromRow(res.rows[0]), aplicacion_chunks: null } : null;
  }

  if (!row) throw new Error('Comprobante no encontrado');
  if ((row.origen || '').toLowerCase() !== 'conductor') {
    throw new Error('Solo puedes eliminar comprobantes enviados por el conductor');
  }
  if ((row.estado || 'pendiente').toLowerCase() === 'validado') {
    throw new Error('No puedes eliminar un comprobante ya validado');
  }
  const chunks = normalizeChunksFromRow(row.aplicacion_chunks);
  const didRevert = chunks.length > 0;
  if (didRevert) {
    await revertirPagoPorChunks(solicitudId, chunks, { excludeComprobanteId: comprobanteId, refresh: false });
  }

  await query(`DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2`, [
    comprobanteId,
    solicitudId,
  ]);
  await refreshMoraTrasPagoValidado(solicitudId);
  return listBySolicitud(solicitudId);
}

/** Conformidad admin: documento oficial pendiente; acredita en cronograma recién al aprobarse. */
export async function createComprobanteConformidadAdmin(solicitudId, cuotaSemanalId, file, options = {}) {
  const cuota = await query(`SELECT * FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2`, [
    cuotaSemanalId,
    solicitudId,
  ]);
  if (cuota.rows.length === 0) {
    throw new Error('Cuota semanal no encontrada o no pertenece a esta solicitud');
  }
  const c = cuota.rows[0];
  const st = (c.status || '').toLowerCase();

  const derivCtx = await loadMiautoComprobanteDerivacionContext(solicitudId);

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
    const fiCobro = derivCtx?.sol?.fecha_inicio_cobro_semanal;
    const isPrimera = c.week_start_date && fiCobro ? isSemanaDepositoMiAuto(c.week_start_date, fiCobro) : false;
    const totalDue = isPrimera
      ? round2(Number(c.amount_due || 0))
      : round2(Number(c.amount_due || 0) + Number(c.late_fee || 0));
    const paid = round2(Number(c.paid_amount || 0));
    montoVal = paid > 0 ? paid : totalDue;
    monedaVal = normalizePenUsd(c.moneda || 'PEN');
  }

  const path = await uploadFileToMedia(file);
  const fileName = file.originalname || `conformidad_pago_${Date.now()}.pdf`;

  try {
    const inserted = await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal
       (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, origen, acredito_en_cronograma)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendiente', 'admin_confirmacion', false)
       RETURNING id`,
      [solicitudId, cuotaSemanalId, montoVal, monedaVal, fileName, path]
    );
    const comprobanteId = inserted.rows[0].id;
    try {
      await aplicarComprobanteInmediato(solicitudId, comprobanteId, cuotaSemanalId, montoVal, monedaVal);
    } catch (applyError) {
      await query('DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2', [comprobanteId, solicitudId]);
      throw applyError;
    }
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    try {
      const inserted = await query(
        `INSERT INTO module_miauto_comprobante_cuota_semanal
         (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, origen)
         VALUES ($1, $2, $3, $4, $5, $6, 'pendiente', 'admin_confirmacion')
         RETURNING id`,
        [solicitudId, cuotaSemanalId, montoVal, monedaVal, fileName, path]
      );
      const comprobanteId = inserted.rows[0].id;
      try {
        await aplicarComprobanteInmediato(solicitudId, comprobanteId, cuotaSemanalId, montoVal, monedaVal);
      } catch (applyError) {
        await query('DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2', [comprobanteId, solicitudId]);
        throw applyError;
      }
    } catch (e2) {
      if (!isUndefinedColumnError(e2)) throw e2;
      const inserted = await query(
        `INSERT INTO module_miauto_comprobante_cuota_semanal
         (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado)
         VALUES ($1, $2, $3, $4, $5, $6, 'pendiente')
         RETURNING id`,
        [solicitudId, cuotaSemanalId, montoVal, monedaVal, fileName, path]
      );
      const comprobanteId = inserted.rows[0].id;
      try {
        await aplicarComprobanteInmediato(solicitudId, comprobanteId, cuotaSemanalId, montoVal, monedaVal);
      } catch (applyError) {
        await query('DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2', [comprobanteId, solicitudId]);
        throw applyError;
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
      `SELECT id, COALESCE(origen, 'conductor') AS origen, aplicacion_chunks, acredito_en_cronograma
       FROM module_miauto_comprobante_cuota_semanal
       WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    row = res.rows[0];
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    try {
      const res = await query(
        `SELECT id, COALESCE(origen, 'conductor') AS origen
         FROM module_miauto_comprobante_cuota_semanal
         WHERE solicitud_id = $1 AND id = $2`,
        [solicitudId, comprobanteId]
      );
      const r = res.rows[0];
      row = r ? { ...r, aplicacion_chunks: null, acredito_en_cronograma: null } : null;
    } catch (e2) {
      if (!isUndefinedColumnError(e2)) throw e2;
      const res = await query(
        `SELECT id, file_path FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 AND id = $2`,
        [solicitudId, comprobanteId]
      );
      row = res.rows[0]
        ? {
            ...res.rows[0],
            origen: inferOrigenFromRow(res.rows[0]),
            aplicacion_chunks: null,
            acredito_en_cronograma: null,
          }
        : null;
    }
  }
  if (!row) {
    throw new Error('Comprobante no encontrado');
  }
  if ((row.origen || '').toLowerCase() !== 'admin_confirmacion') {
    throw new Error('Solo se puede eliminar el comprobante de conformidad de pago del administrador');
  }

  const chunks = normalizeChunksFromRow(row.aplicacion_chunks);
  if (row.acredito_en_cronograma === true && chunks.length === 0) {
    throw new Error(
      'Este comprobante acreditó pagos en el cronograma pero no hay desglose guardado (aplicacion_chunks). Ejecute la migración SQL de aplicacion_chunks o contacte soporte; no se eliminó el registro para evitar datos incoherentes.'
    );
  }
  const didRevert = chunks.length > 0;
  if (didRevert) {
    await revertirPagoPorChunks(solicitudId, chunks, { excludeComprobanteId: comprobanteId, refresh: false });
  }

  await query(`DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2`, [
    comprobanteId,
    solicitudId,
  ]);
  await refreshMoraTrasPagoValidado(solicitudId);
  return listBySolicitud(solicitudId);
}

/** Rechazar comprobante (solo si está pendiente). */
export async function rejectComprobanteCuotaSemanal(solicitudId, comprobanteId, userId, { motivo } = {}) {
  let row;
  try {
    const comp = await query(
      `SELECT id, estado, COALESCE(origen, 'conductor') AS origen, file_path, aplicacion_chunks
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
  const estado = (row.estado || '').toLowerCase();
  if (estado === 'rechazado') throw new Error('El comprobante ya está rechazado');
  const chunks = normalizeChunksFromRow(row.aplicacion_chunks);

  await query(
    `UPDATE module_miauto_comprobante_cuota_semanal
     SET estado = 'rechazado',
         rechazado_at = CURRENT_TIMESTAMP,
         rechazo_razon = $1,
         rechazado_by = $2,
         validated_at = NULL
     WHERE id = $3`,
    [motivo ? String(motivo).trim() : null, userId, comprobanteId]
  );
  if (chunks.length > 0) {
    await revertirPagoPorChunks(solicitudId, chunks, { excludeComprobanteId: comprobanteId });
  } else {
    await refreshMoraTrasPagoValidado(solicitudId);
  }
  return listBySolicitud(solicitudId);
}

/**
 * Confirma que el comprobante existe en banco. La cuota ya fue afectada al registrar el comprobante.
 */
export async function confirmComprobanteCuotaSemanal(solicitudId, comprobanteId, userId) {
  let compRow;
  try {
    const comp = await query(
      `SELECT id, estado, COALESCE(origen, 'conductor') AS origen
       FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    compRow = comp.rows[0];
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    const comp = await query(
      `SELECT id, estado, file_path FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 AND id = $2`,
      [solicitudId, comprobanteId]
    );
    const r = comp.rows[0];
    compRow = r ? { ...r, origen: inferOrigenFromRow(r) } : null;
  }

  if (!compRow) throw new Error('Comprobante no encontrado');
  const estado = String(compRow.estado || 'pendiente').toLowerCase();
  if (estado === 'validado') throw new Error('El comprobante ya fue validado en banco');
  if (estado === 'rechazado') throw new Error('No se puede confirmar un comprobante rechazado');

  await query(
    `UPDATE module_miauto_comprobante_cuota_semanal
     SET estado = 'validado',
         validated_at = CURRENT_TIMESTAMP,
         validated_by = $1,
         rechazado_at = NULL,
         rechazo_razon = NULL,
         rechazado_by = NULL
     WHERE solicitud_id = $2 AND id = $3`,
    [userId, solicitudId, comprobanteId]
  );

  return listBySolicitud(solicitudId);
}

async function revertirPagoPorChunks(solicitudId, chunks, options = {}) {
  const refresh = options.refresh !== false;
  const excludeComprobanteId = options.excludeComprobanteId ? String(options.excludeComprobanteId) : null;
  const byCuota = new Map();
  for (const ch of Array.isArray(chunks) ? chunks : []) {
    if (!ch?.cuota_semanal_id) continue;
    const id = String(ch.cuota_semanal_id);
    const monto = round2(parseFloat(ch.monto) || 0);
    if (monto <= 0) continue;
    const prev = byCuota.get(id) || { cuota_semanal_id: id, monto: 0, before: null };
    prev.monto = round2(prev.monto + monto);
    if (!prev.before && ch.before) prev.before = ch.before;
    byCuota.set(id, prev);
  }
  const merged = [...byCuota.values()];
  if (merged.length === 0) return;
  for (const { cuota_semanal_id, monto, before } of merged) {
    const cu = await query(
      `SELECT id, due_date, amount_due, paid_amount, late_fee, status, moneda, fecha_ultimo_abono
       FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2`,
      [cuota_semanal_id, solicitudId]
    );
    if (cu.rows.length === 0) continue;
    const c = cu.rows[0];
    const paid = round2(parseFloat(c.paid_amount) || 0);
    const sub = round2(parseFloat(monto) || 0);
    const newPaid = round2(Math.max(0, paid - sub));
    const beforePaid = before ? round2(parseFloat(before.paid_amount) || 0) : null;
    const canRestoreSnapshot =
      before &&
      beforePaid != null &&
      Math.abs(newPaid - beforePaid) <= 0.02;
    if (canRestoreSnapshot) {
      await query(
        `UPDATE module_miauto_cuota_semanal
         SET paid_amount = $1,
             late_fee = $2,
             mora_extra = $3,
             mora_extra_desde = $4,
             mora_extra_total = $5,
             status = $6,
             fecha_ultimo_abono = $7,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $8`,
        [
          beforePaid,
          round2(parseFloat(before.late_fee) || 0),
          round2(parseFloat(before.mora_extra) || 0),
          before.mora_extra_desde || null,
          round2(parseFloat(before.mora_extra_total) || 0),
          before.status || computeStatusAfterRevert(c, beforePaid),
          before.fecha_ultimo_abono || null,
          cuota_semanal_id,
        ]
      );
      continue;
    }
    const newStatus = computeStatusAfterRevert(c, newPaid);
    await query(
      `UPDATE module_miauto_cuota_semanal SET paid_amount = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [newPaid, newStatus, cuota_semanal_id]
    );
    await touchFechaUltimoAbonoCuota(cuota_semanal_id, paid, newPaid);
    // Restaurar fecha_ultimo_abono al último comprobante validado que aún queda
    if (newPaid > 0.005) {
      const ultParams = [cuota_semanal_id];
      let excludeClause = '';
      if (excludeComprobanteId) {
        ultParams.push(excludeComprobanteId);
        excludeClause = ` AND id <> $${ultParams.length}`;
      }
      const ult = await query(
        `SELECT MAX(COALESCE(validated_at, created_at::date)) AS fecha
         FROM module_miauto_comprobante_cuota_semanal
         WHERE cuota_semanal_id = $1 AND estado = 'validado'${excludeClause}`,
        ultParams
      );
      await query(
        `UPDATE module_miauto_cuota_semanal SET fecha_ultimo_abono = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [ult.rows[0]?.fecha || null, cuota_semanal_id]
      );
    }
  }
  await reconciliarBonosTiempo(solicitudId);
  if (refresh) {
    await refreshMoraTrasPagoValidado(solicitudId);
  }
}

/**
 * Pago manual por admin: registra un comprobante interno pendiente de validación bancaria y aplica la cuota de inmediato.
 */
export async function addPagoManualCuotaSemanal(solicitudId, cuotaSemanalId, { monto, moneda } = {}) {
  const num = monto != null ? parseFloat(monto) : NaN;
  if (Number.isNaN(num) || num <= 0) throw new Error('Monto inválido');

  const cuota = await query(`SELECT * FROM module_miauto_cuota_semanal WHERE id = $1 AND solicitud_id = $2`, [
    cuotaSemanalId,
    solicitudId,
  ]);
  if (cuota.rows.length === 0) throw new Error('Cuota semanal no encontrada');
  const c = cuota.rows[0];
  const stM = (c.status || '').toLowerCase();
  if (stM === 'bonificada') throw new Error('Esta cuota ya está pagada o bonificada');
  const ctxMan = await loadMiautoComprobanteDerivacionContext(solicitudId);
  if (stM === 'paid' && miautoCuotaFinalDerivada(c, ctxMan) <= 0.005) {
    throw new Error('Esta cuota ya está pagada o bonificada');
  }

  const monedaRegistro = normalizePenUsd(moneda || c.moneda || 'PEN');

  try {
    const inserted = await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, validated_at, validated_by, origen)
       VALUES ($1, $2, $3, $4, 'Pago manual', 'manual', 'pendiente', NULL, NULL, 'pago_manual')
       RETURNING id`,
      [solicitudId, cuotaSemanalId, round2(num), monedaRegistro]
    );
    const comprobanteId = inserted.rows[0].id;
    try {
      await aplicarComprobanteInmediato(solicitudId, comprobanteId, cuotaSemanalId, round2(num), monedaRegistro);
    } catch (applyError) {
      await query('DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2', [comprobanteId, solicitudId]);
      throw applyError;
    }
  } catch (e) {
    if (!isUndefinedColumnError(e)) throw e;
    const inserted = await query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, validated_at, validated_by)
       VALUES ($1, $2, $3, $4, 'Pago manual', 'manual', 'pendiente', NULL, NULL)
       RETURNING id`,
      [solicitudId, cuotaSemanalId, round2(num), monedaRegistro]
    );
    const comprobanteId = inserted.rows[0].id;
    try {
      await aplicarComprobanteInmediato(solicitudId, comprobanteId, cuotaSemanalId, round2(num), monedaRegistro);
    } catch (applyError) {
      await query('DELETE FROM module_miauto_comprobante_cuota_semanal WHERE id = $1 AND solicitud_id = $2', [comprobanteId, solicitudId]);
      throw applyError;
    }
  }

  return listBySolicitud(solicitudId);
}
