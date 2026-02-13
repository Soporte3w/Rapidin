import { startDailyProvisionsJob } from './calculateDailyProvisions.js';
import { startDailyLateFeesJob } from './calculateDailyLateFees.js';
import { startPaymentRemindersJob } from './sendPaymentReminders.js';
import { startDailyAutoChargeJob } from './dailyAutoCharge.js';
import { logger } from '../utils/logger.js';

export const initializeJobs = () => {
  logger.info('Inicializando jobs programados...');
  
  startDailyProvisionsJob();
  startDailyLateFeesJob();
  startPaymentRemindersJob();
  startDailyAutoChargeJob();
  
  logger.info('Jobs programados inicializados');
};







