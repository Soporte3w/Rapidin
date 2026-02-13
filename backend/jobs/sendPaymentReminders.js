import cron from 'node-cron';
import { query } from '../config/database.js';
import { sendNotification } from '../services/notificationService.js';
import { getPaymentReminderMessage, getOverdueMessage } from '../services/messageService.js';
import { logger } from '../utils/logger.js';

export const startPaymentRemindersJob = () => {
  cron.schedule('0 8 * * *', async () => {
    logger.info('Iniciando envío de recordatorios de pago...');
    
    try {
      const upcomingInstallments = await query(
        `SELECT i.*, d.first_name, d.last_name, d.phone, d.email, l.country
         FROM module_rapidin_installments i
         JOIN module_rapidin_loans l ON l.id = i.loan_id
         JOIN module_rapidin_drivers d ON d.id = l.driver_id
         WHERE i.status = 'pending'
           AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
           AND l.status = 'active'`
      );

      for (const installment of upcomingInstallments.rows) {
        const message = getPaymentReminderMessage(
          `${installment.first_name} ${installment.last_name}`,
          installment.installment_number,
          installment.installment_amount,
          installment.due_date
        );

        if (installment.phone) {
          await sendNotification({
            driver_id: installment.driver_id,
            loan_id: installment.loan_id,
            type: 'payment_reminder',
            channel: 'whatsapp',
            recipient: installment.phone,
            subject: 'Recordatorio de Pago',
            message: message
          });
        }
      }

      logger.info(`Recordatorios enviados para ${upcomingInstallments.rows.length} cuotas próximas`);
    } catch (error) {
      logger.error('Error enviando recordatorios:', error);
    }

    try {
      const overdueInstallments = await query(
        `SELECT i.*, d.first_name, d.last_name, d.phone, d.email, l.country
         FROM module_rapidin_installments i
         JOIN module_rapidin_loans l ON l.id = i.loan_id
         JOIN module_rapidin_drivers d ON d.id = l.driver_id
         WHERE i.status = 'overdue'
           AND i.due_date < CURRENT_DATE
           AND l.status = 'active'`
      );

      for (const installment of overdueInstallments.rows) {
        const message = getOverdueMessage(
          `${installment.first_name} ${installment.last_name}`,
          installment.installment_number,
          installment.installment_amount,
          installment.days_overdue
        );

        if (installment.phone) {
          await sendNotification({
            driver_id: installment.driver_id,
            loan_id: installment.loan_id,
            type: 'overdue_notification',
            channel: 'whatsapp',
            recipient: installment.phone,
            subject: 'Cuota Vencida',
            message: message
          });
        }
      }

      logger.info(`Notificaciones de atraso enviadas para ${overdueInstallments.rows.length} cuotas`);
    } catch (error) {
      logger.error('Error enviando notificaciones de atraso:', error);
    }

    logger.info('Envío de recordatorios completado');
  }, {
    scheduled: true,
    timezone: 'America/Lima'
  });

  logger.info('Job de recordatorios de pago programado');
};







