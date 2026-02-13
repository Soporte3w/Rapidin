import twilio from 'twilio';
import nodemailer from 'nodemailer';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  } catch (error) {
    logger.warn('Twilio no configurado, las notificaciones por WhatsApp/SMS no estarán disponibles');
  }
}

let emailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD) {
  try {
    emailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    });
  } catch (error) {
    logger.warn('SMTP no configurado, las notificaciones por email no estarán disponibles');
  }
}

export const sendWhatsApp = async (to, message) => {
  if (!twilioClient) {
    logger.warn('Twilio no configurado, no se puede enviar WhatsApp');
    return { success: false, error: 'Twilio no configurado' };
  }
  
  try {
    const result = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${to}`,
      body: message
    });
    return { success: true, sid: result.sid };
  } catch (error) {
    logger.error('Error enviando WhatsApp:', error);
    return { success: false, error: error.message };
  }
};

export const sendSMS = async (to, message) => {
  if (!twilioClient) {
    logger.warn('Twilio no configurado, no se puede enviar SMS');
    return { success: false, error: 'Twilio no configurado' };
  }
  
  try {
    const result = await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to,
      body: message
    });
    return { success: true, sid: result.sid };
  } catch (error) {
    logger.error('Error enviando SMS:', error);
    return { success: false, error: error.message };
  }
};

export const sendEmail = async (to, subject, html, attachments = []) => {
  if (!emailTransporter) {
    logger.warn('SMTP no configurado, no se puede enviar email');
    return { success: false, error: 'SMTP no configurado' };
  }
  
  try {
    const result = await emailTransporter.sendMail({
      from: process.env.SMTP_FROM,
      to: to,
      subject: subject,
      html: html,
      attachments: attachments
    });
    return { success: true, messageId: result.messageId };
  } catch (error) {
    logger.error('Error enviando email:', error);
    return { success: false, error: error.message };
  }
};

export const sendNotification = async (data) => {
  const { driver_id, loan_id, type, channel, recipient, subject, message } = data;

  let result = { success: false };

  try {
    if (channel === 'whatsapp') {
      result = await sendWhatsApp(recipient, message);
    } else if (channel === 'sms') {
      result = await sendSMS(recipient, message);
    } else if (channel === 'email') {
      result = await sendEmail(recipient, subject, message);
    }

    await query(
      `INSERT INTO module_rapidin_notifications 
       (driver_id, loan_id, type, channel, recipient, subject, message, sent, sent_at, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        driver_id,
        loan_id,
        type,
        channel,
        recipient,
        subject,
        message,
        result.success,
        result.success ? new Date() : null,
        result.success ? null : result.error
      ]
    );

    return result;
  } catch (error) {
    logger.error('Error guardando notificación:', error);
    throw error;
  }
};

export const getNotifications = async (filters = {}) => {
  let sql = `
    SELECT n.*, 
           d.first_name as driver_first_name, d.last_name as driver_last_name
    FROM module_rapidin_notifications n
    LEFT JOIN module_rapidin_drivers d ON d.id = n.driver_id
    WHERE 1=1
  `;
  const params = [];
  let paramCount = 1;

  if (filters.driver_id) {
    sql += ` AND n.driver_id = $${paramCount++}`;
    params.push(filters.driver_id);
  }

  if (filters.loan_id) {
    sql += ` AND n.loan_id = $${paramCount++}`;
    params.push(filters.loan_id);
  }

  if (filters.sent !== undefined) {
    sql += ` AND n.sent = $${paramCount++}`;
    params.push(filters.sent);
  }

  sql += ` ORDER BY n.created_at DESC`;

  const result = await query(sql, params);
  return result.rows;
};

export const retryNotification = async (notificationId) => {
  const notification = await query(
    'SELECT * FROM module_rapidin_notifications WHERE id = $1',
    [notificationId]
  );

  if (notification.rows.length === 0) {
    throw new Error('Notificación no encontrada');
  }

  const notif = notification.rows[0];
  return await sendNotification({
    driver_id: notif.driver_id,
    loan_id: notif.loan_id,
    type: notif.type,
    channel: notif.channel,
    recipient: notif.recipient,
    subject: notif.subject,
    message: notif.message
  });
};

