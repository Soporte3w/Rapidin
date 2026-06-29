/**
 * Yego Rapidín 4.0 — Servicio de mensajería WhatsApp Mi Auto
 * Construye mensajes, envía en lote, registra trazabilidad.
 */
import { query } from '../../config/database.js';
import { sendWhatsAppMessage } from '../../services/authService.js';
import { logger } from '../../utils/logger.js';

const round2 = (n) => {
  const x = Number(n);
  return Number.isNaN(x) ? 0 : Math.round(x * 100) / 100;
};

const CUENTAS_BANCARIAS = [
  '🏦 Cuentas bancarias para realizar tu pago:',
  '• INTERBANK: 200-3001652892',
  '• BCP: 194-9837740-0-71',
  '• Titular: AJHLA S.A.C.',
].join('\n');

function monedaCuota(cuota) {
  const m = String(cuota?.moneda || 'PEN').toUpperCase();
  return m === 'USD' ? 'US$' : 'S/';
}

function nombreCompleto(sol) {
  const fn = (sol?.first_name || '').trim();
  const ln = (sol?.last_name || '').trim();
  return fn && ln ? `${fn} ${ln}` : (fn || ln || 'Conductor');
}

/** Construye el mensaje de cuotas (mismo formato que el frontend). */
function buildCuotasMessage(sol, cuotas, cuotasPendientes, cuotaReciente) {
  if (!cuotaReciente) {
    return `Hola ${nombreCompleto(sol)},\n\nTe contactamos respecto a tu contrato Yego Mi Auto. Cualquier duda estamos a tu disposición.\n\n${CUENTAS_BANCARIAS}`;
  }

  const sym = monedaCuota(cuotaReciente);
  const viajes = cuotaReciente.num_viajes ?? 0;
  const cuotaSemanal = round2(Number(cuotaReciente.cuota_semanal || 0));
  const semana = semanaOrdinal(cuotas, cuotaReciente);

  let header = `Hola ${nombreCompleto(sol)},\n\nLe compartimos el detalle de su pago:\n`;
  header += `- Semana ${semana}: ${viajes} viajes - ${sym} ${cuotaSemanal.toFixed(2)}\n`;

  // Descuentos
  const pfYangoRaw = Number(cuotaReciente.partner_fees_yango_raw || 0);
  const pf83 = pfYangoRaw > 0.01 ? round2(pfYangoRaw * 0.8333) : 0;
  const cobroSaldoRegla = round2(Number(cuotaReciente.cobro_saldo || 0));
  const cobroDesdeSaldo = round2(Number(cuotaReciente.cobro_desde_saldo_conductor || 0));

  let descuentos = '\nDESCUENTOS:\n';
  let hay = false;
  if (pf83 > 0.01) { descuentos += `🔹 Cobro por ingresos (83.33%): ${sym} ${pf83.toFixed(2)}\n`; hay = true; }
  if (cobroSaldoRegla > 0.01) { descuentos += `🔹 Cobro de saldo: ${sym} ${cobroSaldoRegla.toFixed(2)}\n`; hay = true; }
  if (cobroDesdeSaldo > 0.01) { descuentos += `🔹 Cobro de saldo (Fleet): ${sym} ${cobroDesdeSaldo.toFixed(2)}\n`; hay = true; }
  if (!hay) descuentos += '🔹 Sin descuentos esta semana\n';

  // Cascada
  const cascada = cuotaReciente.partner_fees_cascada_aplicado_a;
  if (Array.isArray(cascada) && cascada.length > 0) {
    descuentos += '\n📌 Cobro aplicado a otras semanas:\n';
    for (const ref of cascada) {
      const sem = semanaOrdinal(cuotas, { due_date: ref.week_start_date, week_start_date: ref.week_start_date });
      descuentos += `   → Semana ${sem}: ${sym} ${round2(Number(ref.monto)).toFixed(2)}\n`;
    }
  }

  const vencidas = (cuotasPendientes || []).filter(c => {
    const pt = round2((Number(c.amount_due) || 0) - (Number(c.paid_amount) || 0)
      + Math.max(Number(c.mora_pendiente ?? 0), Number(c.mora_acumulada ?? c.late_fee ?? 0))
      + round2(Number(c.mora_extra) || 0));
    return pt > 0.01;
  });

  if (vencidas.length > 0) {
    descuentos += '\n------------------------------------------------------------------------\nPENDIENTE:\n';
    const top = vencidas.slice(0, 10);
    for (const v of top) {
      const sm = monedaCuota(v);
      const pt = round2((Number(v.amount_due) || 0) - (Number(v.paid_amount) || 0)
        + Math.max(Number(v.mora_pendiente ?? 0), Number(v.mora_acumulada ?? v.late_fee ?? 0))
        + round2(Number(v.mora_extra) || 0));
      const sem = semanaOrdinal(cuotas, v);
      descuentos += `🔹 Semana ${sem}: ${sm} ${pt.toFixed(2)} 🚨\n`;
    }
    if (vencidas.length > 10) descuentos += `🔹 Y ${vencidas.length - 10} cuota(s) más... 🚨\n`;
    return `${header}${descuentos}\n\nCualquier consulta quedamos atentos 👍\n\n${CUENTAS_BANCARIAS}`;
  }

  // Sin vencidas: pagado al día
  const pagado = round2(Number(cuotaReciente.paid_amount || 0));
  const saldoFavor = round2(Number(cuotaReciente.saldo_favor_conductor || 0));
  let pagadoText = '\n------------------------------------------------------------------------\nPAGADO:\n';
  if (pagado > 0.01) pagadoText += `🔹 Pagado: ${sym} ${pagado.toFixed(2)} ✅\n`;
  pagadoText += '\n🔸 ¡Cuota cubierta! ✅\n';
  if (saldoFavor > 0.01) pagadoText += `\nSaldo a tu favor: ${sym} ${saldoFavor.toFixed(2)} 🎉`;
  return `${header}${descuentos}${pagadoText}\n\nCualquier consulta quedamos atentos 👍`;
}

/** Construye mensaje de métricas (mismo formato que el frontend). */
function buildMetricasMessage(metricasData) {
  if (!metricasData?.active_goals?.length) return '';
  const goal = metricasData.active_goals[0];
  const step = goal.steps?.[0];
  if (!step) return '';
  const name = metricasData.driver_name || 'Conductor';
  const meta = step.nrides || 0;
  const completados = goal.total_rides || 0;
  const pct = meta > 0 ? Math.round((completados / meta) * 100) : 0;
  const restantes = Math.max(0, meta - completados);

  const prevGoal = metricasData.previous_goals?.[0];
  const prevMeta = prevGoal?.steps?.[0]?.nrides || 0;
  const prevTotal = prevGoal?.total_rides || 0;
  const prevPct = prevMeta > 0 ? Math.round((prevTotal / prevMeta) * 100) : 0;

  const prevLine = prevGoal?.steps?.[0]?.is_completed && prevMeta > 0
    ? `La semana pasada completaste ${prevMeta} viajes (${prevPct}%). ¡Seguí así!\n\n`
    : '';

  const partnerFees = metricasData?.currentIncome?.partner_fees || 0;
  const comision = partnerFees > 0 ? round2(partnerFees * 0.8333) : 0;
  const comisionLine = comision > 0 ? `\n• Comisión acumulada: S/ ${comision.toFixed(2)}` : '';

  let title;
  if (pct === 0) title = 'Empecemos esta semana con todo';
  else if (pct <= 25) title = 'Vamos, tu puedes lograrlo';
  else if (pct <= 50) title = 'Buen ritmo, seguí así';
  else if (pct <= 75) title = 'Vas por buen camino';
  else if (pct < 100) title = 'Casi lo logras';
  else title = '¡Felicitaciones, objetivo cumplido!';

  return `${prevLine}Hola ${name}\n\n`
    + `${title} 🚗💨\n\n`
    + `📊 Tu avance semanal:\n`
    + `• Viajes realizados: ${completados} de ${meta} (${pct}% de la meta)\n`
    + `• Viajes restantes: ${restantes}${comisionLine}\n\n`
    + `${pct >= 100 ? '¡Seguí así campeón! 💪' : 'Seguí sumando viajes para acercarte a tu próximo BONO AUTO 💪'}`;
}

function semanaOrdinal(cuotas, cuota) {
  const due = String(cuota?.due_date || cuota?.week_start_date || '').slice(0, 10);
  const sorted = [...cuotas].sort((a, b) => String(a.week_start_date || '').localeCompare(String(b.week_start_date || '')));
  for (let i = 0; i < sorted.length; i++) {
    const d = String(sorted[i].due_date || sorted[i].week_start_date || '').slice(0, 10);
    if (d === due) return i + 1;
  }
  return '?';
}

/**
 * Construye mensaje completo (cuotas + métricas) para una solicitud.
 * @returns {{ message, phone, driverName }}
 */
export async function buildMiAutoMessage(solicitudId) {
  const solRes = await query(
    `SELECT s.id, s.first_name, s.last_name, s.phone, s.cronograma_id, s.cronograma_vehiculo_id
     FROM module_miauto_solicitud s WHERE s.id = $1`, [solicitudId]
  );
  if (solRes.rows.length === 0) throw new Error('Solicitud no encontrada');
  const sol = solRes.rows[0];

  const cuotasRes = await query(
    `SELECT week_start_date, due_date, num_viajes, cuota_semanal, amount_due, paid_amount,
            late_fee, mora_extra, mora_pendiente, mora_acumulada, moneda, status,
            saldo_favor_conductor, cobro_saldo, cobro_desde_saldo_conductor,
            partner_fees_yango_raw, partner_fees_cascada_aplicado_a
     FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 AND deleted_at IS NULL
     ORDER BY week_start_date ASC`, [solicitudId]
  );
  const cuotas = cuotasRes.rows;
  const cuotasPendientes = cuotas.filter(c => c.status !== 'paid' && c.status !== 'bonificada');
  const cuotaReciente = [...cuotas].sort((a, b) => String(b.week_start_date || '').localeCompare(String(a.week_start_date || '')))[0];

  // Mensaje de cuotas
  const cuotasMsg = buildCuotasMessage(sol, cuotas, cuotasPendientes, cuotaReciente);

  // Métricas (opcional, no bloquea)
  let metricasMsg = '';
  try {
    // Import dinámico para evitar circular dependency con el módulo de métricas
    const { default: fetchMetricas } = await import('../../services/yangoService.js');
    const metricas = await fetchMetricas(solicitudId, sol.cronograma_id, sol.cronograma_vehiculo_id);
    metricasMsg = buildMetricasMessage(metricas);
  } catch (e) {
    logger.warn(`Métricas no disponibles para solicitud ${solicitudId}: ${e.message}`);
  }

  const message = metricasMsg ? `${cuotasMsg}\n\n────────────\n${metricasMsg}` : cuotasMsg;

  return {
    message,
    phone: String(sol.phone || '').trim(),
    driverName: nombreCompleto(sol),
  };
}

/**
 * Envía mensajes WhatsApp en lote a las solicitudes indicadas.
 * Secuencial (no Promise.all) para no saturar la API 3W.
 * @returns {{ sent: [], failed: [], total: number }}
 */
export async function sendBulkWhatsApp(solicitudIds, userId, instanceToken = null) {
  const token = instanceToken || process.env.WHATSAPP_MIAUTO_TOKEN || process.env.WHATSAPP_OTP_TOKEN;
  const results = { sent: [], failed: [], total: solicitudIds.length };

  for (const sid of solicitudIds) {
    try {
      const { message, phone, driverName } = await buildMiAutoMessage(sid);

      if (!phone || phone.length < 8) {
        await insertLog(sid, driverName, phone || 'sin-teléfono', message, 'failed', 'Teléfono inválido', userId);
        results.failed.push({ solicitudId: sid, driverName, error: 'Teléfono inválido' });
        continue;
      }

      const result = await sendWhatsAppMessage(phone, message, token);

      if (result.success) {
        await insertLog(sid, driverName, phone, message, 'sent', null, userId);
        results.sent.push({ solicitudId: sid, driverName, phone });
      } else {
        await insertLog(sid, driverName, phone, message, 'failed', result.error, userId);
        results.failed.push({ solicitudId: sid, driverName, error: result.error });
      }
    } catch (error) {
      logger.error(`Error en envío WhatsApp solicitud ${sid}: ${error.message}`);
      await insertLog(sid, 'desconocido', 'desconocido', '', 'failed', error.message?.slice(0, 500), userId);
      results.failed.push({ solicitudId: sid, error: error.message });
    }
  }

  return results;
}

async function insertLog(solicitudId, driverName, phone, message, status, error, userId) {
  try {
    await query(
      `INSERT INTO module_miauto_whatsapp_log (solicitud_id, driver_name, phone, message, status, error, created_by, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
      [solicitudId, driverName, phone, message, status, error || null, userId || null]
    );
  } catch (e) {
    if (e?.code === '42703') return; // columna no existe aún
    logger.error(`Error insertando log WhatsApp: ${e.message}`);
  }
}

/**
 * Obtiene historial de envíos con filtros y paginación.
 */
export async function getWhatsAppLog({ solicitudId, status, page = 1, limit = 50 } = {}) {
  const conditions = [];
  const params = [];
  let p = 0;

  if (solicitudId) {
    p++; conditions.push(`solicitud_id = $${p}`);
    params.push(solicitudId);
  }
  if (status) {
    p++; conditions.push(`status = $${p}`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (Math.max(1, Number(page)) - 1) * Math.min(100, Number(limit));

  p++; params.push(Math.min(100, Number(limit)));
  p++; params.push(offset);

  const { rows } = await query(
    `SELECT id, solicitud_id, driver_name, phone, status, error, created_by, sent_at, created_at
     FROM module_miauto_whatsapp_log ${where}
     ORDER BY created_at DESC LIMIT $${p - 1} OFFSET $${p}`, params
  );

  const countRes = await query(
    `SELECT COUNT(*) as total FROM module_miauto_whatsapp_log ${where}`,
    params.slice(0, conditions.length)
  );

  return {
    data: rows,
    total: parseInt(countRes.rows[0]?.total || 0, 10),
    page: Number(page),
    limit: Number(limit),
  };
}
