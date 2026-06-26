/**
 * Script para verificar y corregir estado de cuota semanal
 * Asegura que la cuota quede marcada como 'paid' correctamente
 */

import pg from 'pg';
const { Pool } = pg;

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
    await client.query('BEGIN');
    
    const solicitudId = '6f9b805f-d29b-4925-aaee-e7f0152f5407';
    const weekStartDate = '2026-05-18';
    
    console.log('=== VERIFICAR Y CORREGIR CUOTA ===');
    console.log('Solicitud: ' + solicitudId);
    console.log('Semana: ' + weekStartDate);
    console.log('');
    
    // 1. Verificar estado actual
    const cuotaRes = await client.query(
      `SELECT id, week_start_date, amount_due, paid_amount, late_fee, mora_extra, mora_extra_total, mora_extra_desde, status, updated_at 
       FROM module_miauto_cuota_semanal 
       WHERE solicitud_id = $1 AND week_start_date = $2 AND deleted_at IS NULL`,
      [solicitudId, weekStartDate]
    );
    
    if (cuotaRes.rows.length === 0) {
      throw new Error('No se encontró la cuota');
    }
    
    const cuota = cuotaRes.rows[0];
    console.log('📋 ESTADO ACTUAL EN BD:');
    console.log('  id: ' + cuota.id);
    console.log('  amount_due (cuota): ' + cuota.amount_due);
    console.log('  paid_amount: ' + cuota.paid_amount);
    console.log('  late_fee: ' + cuota.late_fee);
    console.log('  mora_extra: ' + cuota.mora_extra);
    console.log('  mora_extra_total: ' + cuota.mora_extra_total);
    console.log('  status: ' + cuota.status);
    console.log('  updated_at: ' + cuota.updated_at);
    console.log('');
    
    // Calcular totales
    const amountDue = round2(cuota.amount_due || 0);
    const paidAmount = round2(cuota.paid_amount || 0);
    const lateFee = round2(cuota.late_fee || 0);
    const moraExtra = round2(cuota.mora_extra || 0);
    const totalObligacion = round2(amountDue + lateFee);
    
    console.log('💰 ANÁLISIS:');
    console.log('  Cuota (amount_due): $' + amountDue.toFixed(2));
    console.log('  Mora (late_fee): $' + lateFee.toFixed(2));
    console.log('  Total obligación: $' + totalObligacion.toFixed(2));
    console.log('  Pagado: $' + paidAmount.toFixed(2));
    console.log('  Diferencia: $' + (totalObligacion - paidAmount).toFixed(2));
    console.log('');
    
    // Si la cuota está marcada como 'paid' pero el paid_amount no cubre el total,
    // forzar paid_amount = totalObligacion para que quede completamente saldada
    if (paidAmount < totalObligacion) {
      console.log('⚠️ El paid_amount no cubre el total. Ajustando...');
      
      const newPaidAmount = totalObligacion;
      const newLateFee = round2(lateFee + moraExtra);
      
      console.log('  paid_amount: ' + paidAmount + ' → ' + newPaidAmount);
      console.log('  late_fee: ' + lateFee + ' → ' + newLateFee);
      console.log('  mora_extra: ' + moraExtra + ' → 0');
      console.log('  status: ' + cuota.status + ' → paid');
      console.log('');
      
      const updateRes = await client.query(
        `UPDATE module_miauto_cuota_semanal 
         SET paid_amount = $1,
             late_fee = $2,
             mora_extra = 0,
             mora_extra_desde = NULL,
             mora_extra_total = $3,
             status = 'paid',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING *`,
        [
          newPaidAmount,
          newLateFee,
          round2((cuota.mora_extra_total || 0) + moraExtra),
          cuota.id
        ]
      );
      
      console.log('✅ CUOTA CORREGIDA:');
      console.log('  id: ' + updateRes.rows[0].id);
      console.log('  paid_amount: ' + updateRes.rows[0].paid_amount);
      console.log('  late_fee: ' + updateRes.rows[0].late_fee);
      console.log('  mora_extra: ' + updateRes.rows[0].mora_extra);
      console.log('  status: ' + updateRes.rows[0].status);
      console.log('');
      
    } else if (cuota.status !== 'paid') {
      console.log('⚠️ Status no es paid. Corrigiendo...');
      
      await client.query(
        `UPDATE module_miauto_cuota_semanal 
         SET status = 'paid',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [cuota.id]
      );
      
      console.log('✅ Status corregido a paid');
      console.log('');
      
    } else {
      console.log('✅ La cuota ya está correctamente marcada como paid');
      console.log('');
    }
    
    // Verificar final
    const finalRes = await client.query(
      `SELECT id, paid_amount, late_fee, mora_extra, status 
       FROM module_miauto_cuota_semanal 
       WHERE id = $1`,
      [cuota.id]
    );
    
    const final = finalRes.rows[0];
    const finalTotal = round2((final.amount_due || 0) + (final.late_fee || 0));
    
    console.log('=== RESULTADO FINAL ===');
    console.log('  Status: ' + final.status);
    console.log('  paid_amount: $' + final.paid_amount);
    console.log('  late_fee: $' + final.late_fee);
    console.log('  mora_extra: $' + final.mora_extra);
    console.log('  Total calculado: $' + finalTotal);
    console.log('  ¿Pagado >= Total?: ' + (final.paid_amount >= finalTotal ? 'SÍ ✅' : 'NO ❌'));
    console.log('');
    
    if (final.status === 'paid' && final.paid_amount >= finalTotal - 0.02) {
      console.log('🎉 CUOTA COMPLETAMENTE PAGADA Y VERIFICADA');
    } else {
      console.log('⚠️ ATENCIÓN: La cuota podría seguir apareciendo como vencida');
    }
    
    await client.query('COMMIT');
    
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
    console.log('✅ Script completado');
    process.exit(0);
  })
  .catch((error) => {
    console.error('');
    console.error('❌ Error:', error);
    process.exit(1);
  });
