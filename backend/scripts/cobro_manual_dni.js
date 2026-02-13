import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { runDailyAutoCharge } from '../jobs/dailyAutoCharge.js';

const DNI = '77221246';

async function cobroManualPorDni() {
  try {
    logger.info(`Iniciando cobro manual para conductor con DNI: ${DNI}`);
    
    // Buscar el conductor por DNI
    const driverResult = await query(
      `SELECT id, first_name, last_name, dni FROM module_rapidin_drivers WHERE dni = $1 LIMIT 1`,
      [DNI]
    );
    
    if (driverResult.rows.length === 0) {
      logger.error(`No se encontró conductor con DNI: ${DNI}`);
      process.exit(1);
    }
    
    const driver = driverResult.rows[0];
    logger.info(`Conductor encontrado: ${driver.first_name} ${driver.last_name} (${driver.dni})`);
    
    // Buscar préstamo activo del conductor
    const loanResult = await query(
      `SELECT id FROM module_rapidin_loans WHERE driver_id = $1 AND status = 'active' LIMIT 1`,
      [driver.id]
    );
    
    if (loanResult.rows.length === 0) {
      logger.error(`No se encontró préstamo activo para el conductor`);
      process.exit(1);
    }
    
    const loanId = loanResult.rows[0].id;
    logger.info(`Préstamo activo encontrado: ${loanId}`);
    
    // Modificar la fecha de vencimiento de la primera cuota pendiente a HOY
    const updateResult = await query(
      `UPDATE module_rapidin_installments 
       SET due_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
       WHERE loan_id = $1 AND status = 'pending'
       AND installment_number = (
         SELECT MIN(installment_number) FROM module_rapidin_installments 
         WHERE loan_id = $1 AND status = 'pending'
       )
       RETURNING id, installment_number, due_date`,
      [loanId]
    );
    
    if (updateResult.rows.length > 0) {
      logger.info(`Cuota #${updateResult.rows[0].installment_number} actualizada - nueva fecha de vencimiento: ${updateResult.rows[0].due_date}`);
    } else {
      logger.warn('No se encontró cuota pendiente para actualizar');
    }
    
    // Ejecutar cobro automático solo para este conductor (forzar día 1 = Lunes para pending)
    logger.info('Ejecutando cobro automático...');
    const result = await runDailyAutoCharge(1, driver.id);
    
    logger.info(`Resultado del cobro: exitosos=${result.success}, parciales=${result.partial}, fallidos=${result.failed}`);
    
    process.exit(0);
  } catch (error) {
    logger.error('Error en cobro manual:', error);
    process.exit(1);
  }
}

cobroManualPorDni();
