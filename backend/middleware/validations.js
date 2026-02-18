import { body, param, query, validationResult } from 'express-validator';

export const validateResults = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Error de validación',
      details: errors.array()
    });
  }
  
  next();
};

export const validateLogin = [
  body('email').isEmail().withMessage('Email inválido'),
  body('password').notEmpty().withMessage('Contraseña requerida'),
  validateResults
];

export const validateDNI = [
  body('dni').notEmpty().withMessage('DNI requerido'),
  body('country').isIn(['PE', 'CO']).withMessage('País inválido'),
  validateResults
];

export const validateLoanRequest = [
  body('dni').notEmpty().withMessage('DNI requerido'),
  body('country').isIn(['PE', 'CO']).withMessage('País inválido'),
  body('requested_amount').isFloat({ min: 10 }).withMessage('El monto mínimo a solicitar es S/ 10'),
  body('first_name').notEmpty().withMessage('Nombre requerido'),
  body('last_name').notEmpty().withMessage('Apellido requerido'),
  body('phone').optional().isString(),
  body('email').optional().isEmail().withMessage('Email inválido'),
  validateResults
];

export const validatePayment = [
  body('loan_id').isUUID().withMessage('ID de préstamo inválido'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Monto inválido'),
  body('payment_date').isISO8601().withMessage('Fecha inválida'),
  body('waive_late_fee_installment_ids').optional().isArray().withMessage('Debe ser un arreglo'),
  body('waive_late_fee_installment_ids.*').optional().isUUID().withMessage('ID de cuota inválido'),
  validateResults
];

export const validateUUID = [
  param('id').isUUID().withMessage('ID inválido'),
  validateResults
];







