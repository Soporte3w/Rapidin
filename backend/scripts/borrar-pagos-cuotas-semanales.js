/**
 * Borra los pagos generados de las cuotas semanales de una solicitud Mi Auto
 * y opcionalmente deja la solicitud en estado "citado" (como si aún no se hubiera aprobado).
 *
 * Uso: node scripts/borrar-pagos-cuotas-semanales.js [solicitudId]
 * Si no pasas solicitudId, se usa SOLICITUD_ID por defecto (editar abajo).
 *
 * Qué hace:
 * 1. Elimina todos los comprobantes de pago de cuota semanal (module_miauto_comprobante_cuota_semanal).
 * 2. Resetea cada cuota semanal: paid_amount=0, late_fee=0, status='pending' o 'overdue' según vencimiento.
 * 3. Pone cuotas_semanales_bonificadas = 0 en la solicitud.
 * 4. Si DEJAR_EN_CITADO = true: además borra comprobantes de otros gastos (module_miauto_comprobante_otros_gastos),
 *    borra las filas de otros gastos, comprobantes de pago subidos (module_miauto_comprobante_pago),
 *    borra las filas de cuotas semanales, pone status='citado', fecha_inicio_cobro_semanal=null,
 *    otros_gastos_saldo_total/otros_gastos_num_cuotas=null, y quita cronograma y pago asignados.
 */

import 'dotenv/config';
import { query } from '../config/database.js';

const DEJAR_EN_CITADO = true; // true = dejar solicitud en "citado" (sin Yego Mi Auto generado); false = solo borrar pagos

const SOLICITUD_ID = process.argv[2] || null; // Pasar por CLI: node scripts/borrar-pagos-cuotas-semanales.js <uuid>

async function main() {
  const id = SOLICITUD_ID?.trim();
  if (!id) {
    console.error('Uso: node scripts/borrar-pagos-cuotas-semanales.js <solicitud_id>');
    console.error('Ejemplo: node scripts/borrar-pagos-cuotas-semanales.js b62e6d8c-1258-45d7-8965-8453f2859287');
    process.exit(1);
  }

  try {
    const sol = await query('SELECT id, status, fecha_inicio_cobro_semanal FROM module_miauto_solicitud WHERE id = $1', [id]);
    if (sol.rows.length === 0) {
      console.error('Solicitud no encontrada:', id);
      process.exit(1);
    }
    const row = sol.rows[0];
    console.log('Solicitud:', id, '| status:', row.status, '| fecha_inicio_cobro:', row.fecha_inicio_cobro_semanal ?? 'null');

    const delComp = await query('DELETE FROM module_miauto_comprobante_cuota_semanal WHERE solicitud_id = $1 RETURNING id', [id]);
    console.log('Comprobantes de cuota semanal eliminados:', delComp.rowCount ?? 0);

    if (DEJAR_EN_CITADO) {
      const delCompOtros = await query('DELETE FROM module_miauto_comprobante_otros_gastos WHERE solicitud_id = $1 RETURNING id', [id]);
      console.log('Comprobantes de otros gastos eliminados:', delCompOtros.rowCount ?? 0);
      const delOtros = await query('DELETE FROM module_miauto_otros_gastos WHERE solicitud_id = $1 RETURNING id', [id]);
      console.log('Otros gastos (cuotas) eliminados:', delOtros.rowCount ?? 0);
      const delCompPago = await query('DELETE FROM module_miauto_comprobante_pago WHERE solicitud_id = $1 RETURNING id', [id]);
      console.log('Comprobantes de pago (subidos por conductor) eliminados:', delCompPago.rowCount ?? 0);
      const delCuotas = await query('DELETE FROM module_miauto_cuota_semanal WHERE solicitud_id = $1 RETURNING id', [id]);
      console.log('Cuotas semanales eliminadas:', delCuotas.rowCount ?? 0);
      await query(
        `UPDATE module_miauto_solicitud SET
          status = 'citado',
          fecha_inicio_cobro_semanal = NULL,
          cuotas_semanales_bonificadas = 0,
          otros_gastos_saldo_total = NULL,
          otros_gastos_num_cuotas = NULL,
          cronograma_id = NULL,
          cronograma_vehiculo_id = NULL,
          pago_tipo = NULL,
          pago_estado = 'pendiente',
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );
      console.log('Solicitud: status = citado, fecha_inicio_cobro_semanal = null, cuotas_semanales_bonificadas = 0, otros_gastos_* = null, cronograma y pago asignados eliminados.');
    } else {
      const cuotas = await query(
        'SELECT id, due_date FROM module_miauto_cuota_semanal WHERE solicitud_id = $1',
        [id]
      );
      const today = new Date().toISOString().slice(0, 10);
      for (const c of cuotas.rows || []) {
        const due = c.due_date ? new Date(c.due_date).toISOString().slice(0, 10) : today;
        const status = due < today ? 'overdue' : 'pending';
        await query(
          `UPDATE module_miauto_cuota_semanal SET paid_amount = 0, late_fee = 0, status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [status, c.id]
        );
      }
      console.log('Cuotas semanales reseteadas (paid_amount=0, late_fee=0, status):', cuotas.rows?.length ?? 0);
      await query(
        'UPDATE module_miauto_solicitud SET cuotas_semanales_bonificadas = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [id]
      );
      console.log('cuotas_semanales_bonificadas = 0');
    }

    console.log('Listo.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
  process.exit(0);
}

main();
