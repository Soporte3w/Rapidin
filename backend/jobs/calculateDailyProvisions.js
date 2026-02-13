import cron from 'node-cron';
import { calculateProvisions } from '../services/analysisService.js';
import { logger } from '../utils/logger.js';

export const startDailyProvisionsJob = () => {
  cron.schedule('0 0 * * *', async () => {
    logger.info('Iniciando cálculo diario de provisiones...');
    
    try {
      await calculateProvisions('PE');
      logger.info('Provisiones calculadas para Perú');
    } catch (error) {
      logger.error('Error calculando provisiones para Perú:', error);
    }

    try {
      await calculateProvisions('CO');
      logger.info('Provisiones calculadas para Colombia');
    } catch (error) {
      logger.error('Error calculando provisiones para Colombia:', error);
    }

    logger.info('Cálculo diario de provisiones completado');
  }, {
    scheduled: true,
    timezone: 'America/Lima'
  });

  logger.info('Job de cálculo diario de provisiones programado');
};







