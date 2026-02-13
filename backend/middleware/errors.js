import { logger } from '../utils/logger.js';

export const errorHandler = (err, req, res, next) => {
  logger.error('Error capturado:', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method
  });

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Error de validación',
      details: err.message
    });
  }

  if (err.code === '23505') {
    return res.status(409).json({
      error: 'Registro duplicado',
      details: 'Ya existe un registro con estos datos'
    });
  }

  if (err.code === '23503') {
    return res.status(400).json({
      error: 'Error de referencia',
      details: 'Referencia a registro inexistente'
    });
  }

  if (err.code === '42P01') {
    return res.status(500).json({
      error: 'Error de base de datos',
      details: 'Tabla no encontrada'
    });
  }

  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' 
    ? 'Error interno del servidor' 
    : err.message;

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
};

export const notFound = (req, res) => {
  res.status(404).json({
    error: 'Endpoint no encontrado',
    path: req.path
  });
};







