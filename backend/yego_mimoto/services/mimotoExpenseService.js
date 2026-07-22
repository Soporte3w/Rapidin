import { getClient } from '../../config/database.js';
import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';
import {
  assertMimotoIsolationSql,
  normalizeMimotoCurrency,
  roundMoney,
} from './mimotoFinancialEngine.js';
import { addDays, positiveNumber } from './mimotoServiceUtils.js';

export async function createExpenseCycle(solicitudId, payload, actorId) {
  if (!MIMOTO_CONFIG.enabled) {
    throw new Error('Yego Mi Moto está desactivado; no se pueden generar gastos');
  }
  const type = String(payload.tipo || '').trim().toUpperCase();
  if (!type) throw new Error('El concepto de gasto es requerido');
  const totalInstallments = Math.max(1, Math.trunc(Number(payload.total_cuotas) || 1));
  const installmentAmount = positiveNumber(payload.monto_cuota, 'monto_cuota');
  const currency = normalizeMimotoCurrency(payload.moneda || 'COP');
  const startDate = String(payload.fecha_inicio || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('fecha_inicio no es válida');
  const periodYear = Number(payload.periodo_anio) || Number(startDate.slice(0, 4));
  const origin = payload.origen || 'manual';
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const next = await client.query(
      assertMimotoIsolationSql(
        `SELECT COALESCE(MAX(ciclo_numero),0)+1 AS n FROM module_mimoto_gasto_ciclo
         WHERE solicitud_id=$1 AND tipo=$2 AND periodo_anio=$3`
      ),
      [solicitudId, type, periodYear]
    );
    const cycle = await client.query(
      assertMimotoIsolationSql(
        `INSERT INTO module_mimoto_gasto_ciclo
          (solicitud_id,tipo,periodo_anio,ciclo_numero,fecha_inicio,fecha_fin,total_cuotas,
           monto_total,monto_cuota,moneda,estado,origen,metadata,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'activo',$11,$12::jsonb,$13,$13) RETURNING *`
      ),
      [solicitudId, type, periodYear, next.rows[0].n, startDate,
        addDays(startDate, (totalInstallments - 1) * 7), totalInstallments,
        roundMoney(installmentAmount * totalInstallments), installmentAmount, currency,
        origin, JSON.stringify(payload.metadata || {}), actorId || null]
    );
    for (let index = 0; index < totalInstallments; index += 1) {
      await client.query(
        assertMimotoIsolationSql(
          `INSERT INTO module_mimoto_otros_gastos
            (solicitud_id,ciclo_id,tipo,numero_cuota,total_cuotas,periodo_anio,due_date,
             amount_due,moneda,origen,updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`
        ),
        [solicitudId, cycle.rows[0].id, type, index + 1, totalInstallments,
          periodYear, addDays(startDate, index * 7), installmentAmount, currency,
          origin, actorId || null]
      );
    }
    await client.query('COMMIT');
    return cycle.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
