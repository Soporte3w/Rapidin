import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './utils/logger.js';
import { validateEnv } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
// import { apiLimiter, authLimiter, publicLimiter } from './middleware/security.js';
import { sanitizeBody, sanitizeQuery } from './middleware/sanitize.js';
import { initializeJobs } from './jobs/index.js';
import { initializeWebSocket } from './realtime/subscriber.js';
import { initializeDatabaseListener } from './realtime/listener.js';
import { loadProxiesFromUrlIfConfigured } from './services/proxyLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'production'
  ? '.env.production'
  : '.env.development';

dotenv.config({ path: path.join(__dirname, envFile) });

try {
  validateEnv();
} catch (error) {
  logger.error(error.message);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// En desarrollo: permitir localhost y IP de la red local (para probar desde móvil/otros dispositivos)
const isDev = process.env.NODE_ENV !== 'production';
const corsOrigin = isDev
  ? (origin, cb) => {
      const allowed = !origin ||
        origin === 'http://localhost:5173' ||
        origin === 'http://127.0.0.1:5173' ||
        /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:5173$/.test(origin) ||
        /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:5173$/.test(origin);
      cb(null, allowed ? origin : false);
    }
  : (() => {
      const raw = process.env.CORS_ORIGIN || 'http://localhost:5173';
      const origins = raw.split(',').map(s => s.trim()).filter(Boolean);
      if (origins.length <= 1) return raw.trim() || 'http://localhost:5173';
      return (origin, cb) => {
        const allowed = !origin || origins.includes(origin);
        cb(null, allowed ? origin : false);
      };
    })();

app.use(cors({
  origin: corsOrigin,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(sanitizeBody);
app.use(sanitizeQuery);
// app.use('/api/', apiLimiter); // Rate limiting deshabilitado temporalmente

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Yego Rapidín API funcionando' });
});

import authRoutes from './routes/auth.js';
import rapidinRoutes from './routes/rapidin.js';
import yangoRoutes from './routes/yango.js';
import driverRoutes from './routes/driver.js';
import loanRequestRoutes from './routes/loanRequests.js';
import loanSimulationRoutes from './routes/loanSimulation.js';
import loanRoutes from './routes/loans.js';
import installmentRoutes from './routes/installments.js';
import paymentRoutes from './routes/payments.js';
import voucherRoutes from './routes/vouchers.js';
import notificationRoutes from './routes/notifications.js';
import documentRoutes from './routes/documents.js';
import weeklyAnalysisRoutes from './routes/weeklyAnalysis.js';
import vintageAnalysisRoutes from './routes/vintageAnalysis.js';
import paymentBehaviorRoutes from './routes/paymentBehavior.js';
import executiveKPIsRoutes from './routes/executiveKPIs.js';
import provisionsRoutes from './routes/provisions.js';
import portfolioRoutes from './routes/portfolio.js';
import usersRoutes from './routes/users.js';
import loanConditionsRoutes from './routes/loanConditions.js';
import cycleConfigRoutes from './routes/cycleConfig.js';
import interestRatesRoutes from './routes/interestRates.js';
import adminLoanRequestRoutes from './routes/adminLoanRequest.js';
import miautoRoutes from './routes/miauto.js';

app.use('/api/auth', authRoutes); // authLimiter deshabilitado temporalmente
app.use('/api/rapidin', rapidinRoutes); // publicLimiter deshabilitado temporalmente
app.use('/api/yango', yangoRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/loan-requests', loanRequestRoutes);
app.use('/api/loan-simulation', loanSimulationRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/installments', installmentRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/analysis/weekly', weeklyAnalysisRoutes);
app.use('/api/analysis/vintage', vintageAnalysisRoutes);
app.use('/api/analysis/payment-behavior', paymentBehaviorRoutes);
app.use('/api/kpis/executive', executiveKPIsRoutes);
app.use('/api/provisions', provisionsRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/loan-conditions', loanConditionsRoutes);
app.use('/api/cycle-config', cycleConfigRoutes);
app.use('/api/interest-rates', interestRatesRoutes);
app.use('/api/admin', adminLoanRequestRoutes);
app.use('/api/miauto', miautoRoutes);

app.use(notFound);
app.use(errorHandler);

const server = app.listen(PORT, () => {
  logger.info(`Servidor escuchando en puerto ${PORT}`);

  initializeJobs();
  initializeWebSocket(server);
  initializeDatabaseListener();

  loadProxiesFromUrlIfConfigured()
    .then((ok) => { if (ok) logger.info('Proxies cargados desde YANGO_PROXIES_URL'); })
    .catch((err) => logger.warn('Proxies: no se pudo cargar desde URL', err?.message));
});

export default app;

