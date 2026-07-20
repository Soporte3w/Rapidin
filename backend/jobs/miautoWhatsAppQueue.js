import { logger } from '../utils/logger.js';
import {
  MIAUTO_WHATSAPP_QUEUE_POLICY,
  processMiautoWhatsAppQueue,
} from '../yego_miauto/services/miautoWhatsAppService.js';

const POLL_INTERVAL_MS = 10_000;
let queueRunning = false;
let queueStarted = false;

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    await processMiautoWhatsAppQueue();
  } catch (error) {
    logger.error('Mi Auto: error procesando cola WhatsApp', { error: error.message });
  } finally {
    queueRunning = false;
  }
}

export function startMiautoWhatsAppQueueJob() {
  if (queueStarted) return;
  queueStarted = true;

  const initialRun = setTimeout(runQueue, 3_000);
  const interval = setInterval(runQueue, POLL_INTERVAL_MS);
  initialRun.unref?.();
  interval.unref?.();

  logger.info('Mi Auto: cola WhatsApp iniciada', MIAUTO_WHATSAPP_QUEUE_POLICY);
}
