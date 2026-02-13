import { query } from '../config/database.js';

async function deleteLoans() {
  const dni = '77221246';
  
  try {
    // Buscar el conductor por DNI
    const drivers = await query(`
      SELECT id, first_name, last_name, dni, country, external_driver_id, park_id
      FROM module_rapidin_drivers 
      WHERE dni = $1
    `, [dni]);
    
    console.log('Conductores encontrados:', drivers.rows);
    
    if (drivers.rows.length === 0) {
      console.log('No se encontró el conductor con DNI:', dni);
      process.exit(0);
    }
    
    for (const driver of drivers.rows) {
      console.log(`\nProcesando conductor: ${driver.first_name} ${driver.last_name} (${driver.dni})`);
      console.log(`  external_driver_id actual: ${driver.external_driver_id || 'vacío'}`);
      
      // Si no tiene external_driver_id, buscarlo en la tabla drivers
      if (!driver.external_driver_id) {
        console.log('  Buscando external_driver_id en tabla drivers...');
        const driverLookup = await query(`
          SELECT driver_id, park_id FROM drivers WHERE document_number = $1 LIMIT 1
        `, [dni]);
        
        if (driverLookup.rows.length > 0) {
          const extId = driverLookup.rows[0].driver_id;
          const parkId = driverLookup.rows[0].park_id || null;
          
          await query(`
            UPDATE module_rapidin_drivers 
            SET external_driver_id = $1, park_id = COALESCE($2, park_id), updated_at = CURRENT_TIMESTAMP 
            WHERE id = $3
          `, [extId, parkId, driver.id]);
          
          console.log(`  ✅ external_driver_id actualizado: ${extId}`);
          if (parkId) console.log(`  ✅ park_id actualizado: ${parkId}`);
        } else {
          console.log('  ⚠️ No se encontró en tabla drivers');
        }
      }
      
      // Buscar préstamos del conductor
      const loans = await query(`
        SELECT id FROM module_rapidin_loans WHERE driver_id = $1
      `, [driver.id]);
      
      console.log(`  Préstamos encontrados: ${loans.rows.length}`);
      
      for (const loan of loans.rows) {
        // Eliminar documentos del préstamo
        const deletedDocs = await query(`
          DELETE FROM module_rapidin_documents WHERE loan_id = $1 RETURNING id
        `, [loan.id]);
        console.log(`    Documentos eliminados: ${deletedDocs.rows.length}`);
        
        // Eliminar logs de pagos automáticos
        const deletedLogs = await query(`
          DELETE FROM module_rapidin_auto_payment_log WHERE loan_id = $1 RETURNING id
        `, [loan.id]);
        console.log(`    Logs de pago auto eliminados: ${deletedLogs.rows.length}`);
        
        // Eliminar relación pagos-cuotas
        const deletedPaymentInst = await query(`
          DELETE FROM module_rapidin_payment_installments WHERE installment_id IN (
            SELECT id FROM module_rapidin_installments WHERE loan_id = $1
          ) RETURNING id
        `, [loan.id]);
        console.log(`    Relaciones pago-cuota eliminadas: ${deletedPaymentInst.rows.length}`);
        
        // Eliminar cuotas del préstamo
        const deletedInstallments = await query(`
          DELETE FROM module_rapidin_installments WHERE loan_id = $1 RETURNING id
        `, [loan.id]);
        console.log(`    Cuotas eliminadas: ${deletedInstallments.rows.length}`);
        
        // Eliminar pagos del préstamo
        const deletedPayments = await query(`
          DELETE FROM module_rapidin_payments WHERE loan_id = $1 RETURNING id
        `, [loan.id]);
        console.log(`    Pagos eliminados: ${deletedPayments.rows.length}`);
      }
      
      // Eliminar préstamos
      const deletedLoans = await query(`
        DELETE FROM module_rapidin_loans WHERE driver_id = $1 RETURNING id
      `, [driver.id]);
      console.log(`  Préstamos eliminados: ${deletedLoans.rows.length}`);
      
      // Buscar solicitudes del conductor
      const requests = await query(`
        SELECT id FROM module_rapidin_loan_requests WHERE driver_id = $1
      `, [driver.id]);
      
      console.log(`  Solicitudes encontradas: ${requests.rows.length}`);
      
      // Eliminar documentos asociados a las solicitudes
      for (const req of requests.rows) {
        const deletedReqDocs = await query(`
          DELETE FROM module_rapidin_documents WHERE request_id = $1 RETURNING id
        `, [req.id]);
        console.log(`    Documentos de solicitud eliminados: ${deletedReqDocs.rows.length}`);
      }
      
      // Eliminar solicitudes
      const deletedRequests = await query(`
        DELETE FROM module_rapidin_loan_requests WHERE driver_id = $1 RETURNING id
      `, [driver.id]);
      console.log(`  Solicitudes eliminadas: ${deletedRequests.rows.length}`);
    }
    
    console.log('\n✅ Proceso completado');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

deleteLoans();
