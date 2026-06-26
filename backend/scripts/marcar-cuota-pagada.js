/**
 * Script para marcar una cuota semanal como PAGADA
 * Solicitud: 6f9b805f-d29b-4925-aaee-e7f0152f5407
 * Semana: 2026-05-18 (Semana 41)
 * Total a pagar: $132.05 (incluye cuota + mora + mora_extra)
 */

import pg from 'pg';
const { Pool } = pg;

// Configuración de BD desde .env
const pool = new Pool({
  host: '168.119.226.236',
  port: 5432,
  database: 'yego_integral',
  user: 'yego_user',
  password: '37>MNA&-35+',
});

function round2(num) {
  return Math.round((parseFloat(num) || 0) * 100) / 100;
}

async function main() {
  const client = await pool.connect();
  
  try {
    // Iniciar transacción
    await client.query('BEGIN');
    
    const solicitudId = '6f9b805f-d29b-4925-aaee-e7f0152f5407';
    const weekStartDate = '2026-05-18';
    const montoTotalPagar = 132.05;
    
    console.log('=== MARCAR CUOTA COMO PAGADA ===');
    console.log('Solicitud: ' + solicitudId);
    console.log('Semana: ' + weekStartDate);
    console.log('Monto total: $' + montoTotalPagar);
    console.log('');
    
    // 1. Buscar la cuenta semanal
    const cuotaRes = await client.query(
      `SELECT * FROM module_miauto_cuota_semanal 
      WHERE solicitud_id = $1 AND week_start_date = $2 AND deleted_at IS NULL`,
      [solicitudId, weekStartDate]
    );
    
    if (cuotaRes.rows.length === 0) {
      throw new Error(`No se encontró la cuota semanal para la solicitud ${solicitudId} y semana ${weekStartDate}`);
    }
    
    const cuota = cuotaRes.rows[0];
    console.log('Cuota encontrada');
    console.log('Estado actual:');
    console.log('  id: ' + cuota.id);
    console.log('  paid_amount: ' + cuota.paid_amount);
    console.log('  amount_due: ' + cuota.amount_due);
    console.log('  late_fee: ' + cuota.late_fee);
    console.log('  mora_extra: ' + cuota.mora_extra);
    console.log('  mora_extra_total: ' + cuota.mora_extra_total);
    console.log('  status: ' + cuota.status);
    console.log('  week_start_date: ' + cuota.week_start_date);
    console.log('');
    
    // 2. Calcular nuevos valores actualizados
    const lateFeeActual = round2(cuota.late_fee || 0);
    const moraExtraActual = round2(cuota.mora_extra || 0);
    const lateFeeNew = round2(lateFeeActual + moraExtraActual); // Cristalizar mora_extra en late_fee
    const moraExtraNew = 0;
    const statusNew = 'paid';
    const paidAmountNew = montoTotalPagar;
    
    console.log('Nuevos valores:');
    console.log('  paid_amount: ' + paidAmountNew);
    console.log('  late_fee (con mora_extra cristalizada): ' + lateFeeNew);
    console.log('  mora_extra: ' + moraExtraNew);
    console.log('  status: ' + statusNew);
    console.log('');
    
    // 3. Actualizar la cuota semanal
    const updateRes = await client.query(
      `UPDATE module_miauto_cuota_semanal 
      SET paid_amount = $1, 
          late_fee = $2,
          mora_extra = $3,
          mora_extra_desde = NULL,
          mora_extra_total = $5,
          status = $6,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *`,
      [
        paidAmountNew,
        lateFeeNew,
        moraExtraNew,
        cuota.id,
        round2((cuota.mora_extra_total || 0) + moraExtraActual), // Acumular mora_extra_total pagada
        statusNew
      ]
    );
    
    console.log('✅ Cuota actualizada correctamente');
    console.log('  id: ' + updateRes.rows[0].id);
    console.log('  paid_amount: ' + updateRes.rows[0].paid_amount);
    console.log('  late_fee: ' + updateRes.rows[0].late_fee);
    console.log('  mora_extra: ' + updateRes.rows[0].mora_extra);
    console.log('  status: ' + updateRes.rows[0].status);
    console.log('');
    
    // 4. Insertar registro en comprobantes (pago manual) para trazabilidad
    const comprobanteRes = await client.query(
      `INSERT INTO module_miauto_comprobante_cuota_semanal 
        (solicitud_id, cuota_semanal_id, monto, moneda, file_name, file_path, estado, validated_at, validated_by, origen)
      VALUES ($1, $2, $3, $4, 'Pago manual total', 'manual', 'validado', CURRENT_TIMESTAMP, NULL, 'pago_manual')
      RETURNING id`,
      [
        solicitudId,
        cuota.id,
        montoTotalPagar,
        (cuota.moneda || 'PEN')
      ]
    );
    
    console.log('✅ Comprobante de pago manual registrado: ' + comprobanteRes.rows[0]?.id);
    console.log('');
    
    // Confirmar transacción
    await client.query('COMMIT');
    
    console.log('✅ CUOTA MARCADA COMO PAGADA EXITOSAMENTE');
    console.log('');
    console.log('Resumen:');
    console.log('  Solicitud: ' + solicitudId);
    console.log('  Semana: ' + weekStartDate);
    console.log('  Total pagado: $' + montoTotalPagar.toFixed(2));
    console.log('  Status: ' + statusNew);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ ERROR:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

main()
  .then(() => {
    console.log('');
    console.log('✅✅✅ Script completado exitosamente ✅✅✅');
    process.exit(0);
  })
  .catch((error) => {
    console.error('');
    console.error('❌ Error en el script:', error);
    process.exit(1);
  });
