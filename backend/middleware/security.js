import rateLimit from 'express-rate-limit';

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Demasiadas solicitudes desde esta IP, por favor intenta más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Demasiados intentos de login, por favor intenta más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
});

export const publicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Demasiadas solicitudes públicas, por favor intenta más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
});

