import pool from '../database/connection.js';
import { logger } from '../utils/logger.js';
import { normalizePhoneForDb, getCountryCodeForDrivers } from '../utils/helpers.js';
import { getPartnerNameById } from './partnersService.js';

// Helper function para ejecutar queries
const query = (text, params) => pool.query(text, params);

export const getDriverDashboard = async (phone, country, parkId = null) => {
  try {
    const countryCode = getCountryCodeForDrivers(country);
    const phoneForDb = normalizePhoneForDb(phone, country);
    const digitsOnly = (phone || '').toString().replace(/\D/g, '');

    // 1. Intentar info desde tabla drivers (Yego) — búsqueda flexible por formato de teléfono
    const driverQuery = `
      SELECT id, first_name, last_name, phone, document_number, document_type, license_country
      FROM drivers
      WHERE license_country = $1 AND work_status = 'working'
        AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4)
      LIMIT 1
    `;
    const driverResult = await query(driverQuery, [countryCode, phoneForDb, phone, digitsOnly]);

    // 2. Resolver ID en module_rapidin_drivers (por flota si hay park_id) — búsqueda flexible
    const parkNorm = (parkId != null && String(parkId).trim() !== '') ? String(parkId).trim() : null;
    let rapidinDriverQuery;
    let rapidinDriverParams;
    if (parkNorm) {
      rapidinDriverQuery = `
        SELECT id, first_name, last_name, phone, dni FROM module_rapidin_drivers
        WHERE country = $1 AND COALESCE(park_id, '') = $2
          AND (phone = $3 OR phone = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5)
        LIMIT 1
      `;
      rapidinDriverParams = [country, parkNorm, phoneForDb, phone, digitsOnly];
    } else {
      rapidinDriverQuery = `
        SELECT id, first_name, last_name, phone, dni FROM module_rapidin_drivers
        WHERE country = $1
          AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4)
        LIMIT 1
      `;
      rapidinDriverParams = [country, phoneForDb, phone, digitsOnly];
    }
    const rapidinDriverResult = await query(rapidinDriverQuery, rapidinDriverParams);

    let driver;
    if (driverResult.rows.length > 0) {
      const row = driverResult.rows[0];
      driver = {
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        phone: row.phone,
        documentNumber: row.document_number,
        documentType: row.document_type
      };
    } else if (rapidinDriverResult.rows.length > 0) {
      const row = rapidinDriverResult.rows[0];
      driver = {
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        phone: row.phone,
        documentNumber: row.dni,
        documentType: null
      };
    } else {
      // Conductor autenticado pero sin registro en drivers ni module_rapidin_drivers (ej. primera vez, otra flota).
      // Devolver dashboard mínimo para que pueda ver el resumen y navegar (ej. a Solicitar préstamo).
      return {
        driver: {
          id: null,
          firstName: '',
          lastName: '',
          phone: phone || '',
          documentNumber: null,
          documentType: null
        },
        activeLoan: null,
        pendingRequest: null,
        loanHistory: { completedLoans: 0, totalBorrowed: 0 },
        recentPayments: [],
        paymentStats: { onTimePayments: 0, latePayments: 0, totalPayments: 0, onTimeRate: 0 }
      };
    }

    if (rapidinDriverResult.rows.length === 0) {
      return {
        driver,
        activeLoan: null,
        pendingRequest: null,
        loanHistory: { completedLoans: 0, totalBorrowed: 0 },
        recentPayments: [],
        paymentStats: { onTimePayments: 0, latePayments: 0, totalPayments: 0, onTimeRate: 0 }
      };
    }

    const rapidinDriverId = rapidinDriverResult.rows[0].id;

    // 2. Todos los préstamos activos de esta flota (driver_id = flota actual; puede haber más de uno en la misma flota)
    const activeLoansQuery = `
      SELECT 
        l.id,
        l.driver_id,
        l.disbursed_amount as loan_amount,
        l.total_amount,
        l.pending_balance as pending_amount,
        l.status,
        l.disbursed_at as disbursement_date,
        l.payment_frequency,
        l.number_of_installments,
        d.park_id,
        COUNT(i.id) as total_installments,
        COUNT(CASE WHEN i.status = 'paid' THEN 1 END) as paid_installments,
        SUM(CASE WHEN i.status = 'pending' OR i.status = 'overdue' THEN i.installment_amount ELSE 0 END) as total_pending,
        MIN(CASE WHEN i.status = 'pending' OR i.status = 'overdue' THEN i.due_date END) as next_payment_date,
        MIN(CASE 
          WHEN i.status = 'pending' OR i.status = 'overdue' 
          THEN i.installment_amount - COALESCE(i.paid_amount, 0) + COALESCE(i.late_fee, 0)
          ELSE NULL 
        END) as next_payment_amount,
        MAX(i.due_date) as last_schedule_due_date
      FROM module_rapidin_loans l
      INNER JOIN module_rapidin_drivers d ON d.id = l.driver_id
      LEFT JOIN module_rapidin_loan_requests r ON r.id = l.request_id
      LEFT JOIN module_rapidin_installments i ON i.loan_id = l.id
      WHERE l.driver_id = $1
        AND l.country = $2
        AND l.status IN ('active', 'defaulted')
        AND r.status = 'disbursed'
      GROUP BY l.id, l.driver_id, l.disbursed_amount, l.total_amount, l.pending_balance, l.status, l.disbursed_at, l.payment_frequency, l.number_of_installments, d.park_id
      ORDER BY l.disbursed_at DESC
    `;

    const activeLoansResult = await query(activeLoansQuery, [rapidinDriverId, country]);
    const parkIdForName = activeLoansResult.rows[0]?.park_id ?? parkId;
    const flotaNameForCards = await getPartnerNameById(parkIdForName) || parkIdForName || 'Otra flota';

    const activeLoans = activeLoansResult.rows.map((row) => ({
      ...row,
      flotaName: flotaNameForCards
    }));

    // Préstamo "principal" para mensaje de bloqueo (primero de la flota)
    let activeLoan = activeLoansResult.rows[0] || null;

    // 2.4 Si no hay préstamo activo, verificar si tiene un préstamo cancelado cuya última fecha de cronograma aún no ha llegado (pagó adelantado): debe esperar
    if (!activeLoan) {
      const cancelledWithFutureDateQuery = `
        SELECT MAX(i.due_date) as last_schedule_due_date
        FROM module_rapidin_loans l
        JOIN module_rapidin_installments i ON i.loan_id = l.id
        WHERE l.driver_id = $1 AND l.country = $2 AND l.status = 'cancelled'
        GROUP BY l.id
        HAVING MAX(i.due_date) > CURRENT_DATE
      `;
      const cancelledFuture = await query(cancelledWithFutureDateQuery, [rapidinDriverId, country]);
      let maxFutureDate = null;
      for (const row of cancelledFuture.rows) {
        if (row.last_schedule_due_date && (!maxFutureDate || new Date(row.last_schedule_due_date) > new Date(maxFutureDate))) {
          maxFutureDate = row.last_schedule_due_date;
        }
      }
      if (maxFutureDate) {
        activeLoan = {
          id: null,
          last_schedule_due_date: maxFutureDate,
          _scheduleBlockOnly: true
        };
      }
    }

    // 2.5. Obtener solicitud pendiente o en proceso (no desembolsada; si está disbursed, ya se muestra como activeLoan)
    const pendingRequestsQuery = `
      SELECT id, status, requested_amount, created_at
      FROM module_rapidin_loan_requests 
      WHERE driver_id = $1 
      AND status IN ('pending', 'approved', 'signed')
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const pendingRequestsResult = await query(pendingRequestsQuery, [rapidinDriverId]);
    const pendingRequest = pendingRequestsResult.rows[0] || null;

    // 3. Obtener historial de préstamos completados
    const completedLoansQuery = `
      SELECT COUNT(*) as completed_count, SUM(disbursed_amount) as total_borrowed
      FROM module_rapidin_loans
      WHERE driver_id = $1 AND country = $2 AND status = 'cancelled'
    `;

    const completedResult = await query(completedLoansQuery, [rapidinDriverId, country]);
    const loanHistory = completedResult.rows[0];

    // 4. Obtener últimos pagos realizados
    const recentPaymentsQuery = `
      SELECT 
        p.id,
        p.amount,
        p.payment_date,
        p.payment_method,
        l.id as loan_id
      FROM module_rapidin_payments p
      JOIN module_rapidin_loans l ON l.id = p.loan_id
      WHERE l.driver_id = $1 AND l.country = $2
      ORDER BY p.payment_date DESC
      LIMIT 5
    `;

    const paymentsResult = await query(recentPaymentsQuery, [rapidinDriverId, country]);

    // 5. Obtener estadísticas de pagos
    const paymentStatsQuery = `
      SELECT 
        COUNT(CASE WHEN i.status = 'paid' AND (i.paid_date IS NULL OR i.paid_date <= i.due_date) THEN 1 END) as on_time_payments,
        COUNT(CASE WHEN i.status = 'overdue' OR (i.status = 'paid' AND i.paid_date > i.due_date) THEN 1 END) as late_payments,
        AVG(CASE WHEN i.status = 'paid' AND i.paid_date <= i.due_date 
          THEN (i.paid_date - i.due_date) END) as avg_payment_days
      FROM module_rapidin_installments i
      JOIN module_rapidin_loans l ON l.id = i.loan_id
      WHERE l.driver_id = $1 AND l.country = $2
    `;

    const statsResult = await query(paymentStatsQuery, [rapidinDriverId, country]);
    const paymentStats = statsResult.rows[0];

    // 6. Calcular días hasta próximo pago
    let daysUntilPayment = null;
    if (activeLoan && activeLoan.next_payment_date) {
      const today = new Date();
      const nextPayment = new Date(activeLoan.next_payment_date);
      daysUntilPayment = Math.ceil((nextPayment - today) / (1000 * 60 * 60 * 24));
    }

    // 7. Generar mensajes según el estado. Bloquear si: préstamo activo con última fecha no pasada, O préstamo cancelado pero última fecha de cronograma aún no ha llegado (pagó adelantado).
    let activeLoanMessage = null;
    let canRequestFromDate = null;
    if (activeLoan && activeLoan.last_schedule_due_date) {
      const lastScheduleDate = new Date(activeLoan.last_schedule_due_date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      lastScheduleDate.setHours(0, 0, 0, 0);
      if (lastScheduleDate > today) {
        const fechaStr = lastScheduleDate.toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' });
        canRequestFromDate = fechaStr;
        activeLoanMessage = activeLoan._scheduleBlockOnly
          ? `No puedes solicitar un nuevo préstamo hasta cumplir la última fecha de tu cronograma. Podrás solicitar a partir del ${fechaStr}.`
          : `Debes esperar hasta el ${fechaStr} (última fecha de tu cronograma) para solicitar un nuevo préstamo. Podrás solicitar a partir de esa fecha.`;
      }
    }

    let pendingRequestMessage = null;
    if (pendingRequest) {
      const statusMessages = {
        'pending': 'Ya tienes una solicitud de préstamo pendiente. Espera a que sea procesada.',
        'approved': 'Ya tienes una solicitud de préstamo aprobada. Completa el proceso actual antes de solicitar uno nuevo.',
        'signed': 'Ya tienes una solicitud de préstamo firmada. Completa el proceso actual antes de solicitar uno nuevo.',
        'disbursed': 'Ya tienes una solicitud de préstamo desembolsada. Completa el proceso actual antes de solicitar uno nuevo.'
      };
      pendingRequestMessage = statusMessages[pendingRequest.status] || 'Ya tienes una solicitud de préstamo en proceso.';
    }

    const formatLoanItem = (row) => {
      const nextPay = row.next_payment_date ? Math.ceil((new Date(row.next_payment_date) - new Date()) / (1000 * 60 * 60 * 24)) : null;
      return {
        id: row.id,
        loanAmount: parseFloat(row.loan_amount),
        pendingAmount: parseFloat(row.pending_amount || row.total_pending),
        status: row.status,
        disbursementDate: row.disbursement_date || null,
        totalInstallments: parseInt(row.number_of_installments || row.total_installments),
        paidInstallments: parseInt(row.paid_installments),
        nextPaymentDate: row.next_payment_date || null,
        nextPaymentAmount: row.next_payment_amount != null ? parseFloat(row.next_payment_amount) : null,
        daysUntilPayment: nextPay,
        paymentFrequency: row.payment_frequency || null,
        lastScheduleDueDate: row.last_schedule_due_date,
        flotaName: row.flotaName || 'Otra flota'
      };
    };

    const activeLoansFormatted = activeLoans.map(formatLoanItem);

    return {
      driver: {
        id: driver.id,
        firstName: driver.firstName ?? '',
        lastName: driver.lastName ?? '',
        phone: driver.phone ?? '',
        documentNumber: driver.documentNumber ?? null,
        documentType: driver.documentType ?? null
      },
      activeLoan: activeLoan ? {
        id: activeLoan.id,
        loanAmount: activeLoan._scheduleBlockOnly ? null : parseFloat(activeLoan.loan_amount),
        pendingAmount: activeLoan._scheduleBlockOnly ? null : parseFloat(activeLoan.pending_amount || activeLoan.total_pending),
        status: activeLoan._scheduleBlockOnly ? 'cancelled' : activeLoan.status,
        disbursementDate: activeLoan.disbursement_date || null,
        totalInstallments: activeLoan._scheduleBlockOnly ? null : parseInt(activeLoan.number_of_installments || activeLoan.total_installments),
        paidInstallments: activeLoan._scheduleBlockOnly ? null : parseInt(activeLoan.paid_installments),
        nextPaymentDate: activeLoan.next_payment_date || null,
        nextPaymentAmount: activeLoan.next_payment_amount != null ? parseFloat(activeLoan.next_payment_amount) : null,
        daysUntilPayment: activeLoan._scheduleBlockOnly ? null : daysUntilPayment,
        paymentFrequency: activeLoan.payment_frequency || null,
        lastScheduleDueDate: activeLoan.last_schedule_due_date,
        message: activeLoanMessage,
        canRequestFromDate
      } : null,
      activeLoans: activeLoansFormatted,
      pendingRequest: pendingRequest ? {
        id: pendingRequest.id,
        status: pendingRequest.status,
        requestedAmount: parseFloat(pendingRequest.requested_amount),
        createdAt: pendingRequest.created_at,
        message: pendingRequestMessage
      } : null,
      loanHistory: {
        completedLoans: parseInt(loanHistory.completed_count) || 0,
        totalBorrowed: parseFloat(loanHistory.total_borrowed) || 0
      },
      recentPayments: paymentsResult.rows.map(p => ({
        id: p.id,
        amount: parseFloat(p.amount),
        paymentDate: p.payment_date,
        paymentMethod: p.payment_method,
        loanId: p.loan_id
      })),
      paymentStats: (() => {
        const onTime = parseInt(paymentStats.on_time_payments) || 0;
        const late = parseInt(paymentStats.late_payments) || 0;
        const total = onTime + late;
        const rate = total > 0 ? ((onTime / total) * 100).toFixed(1) : 0;
        return {
          onTimePayments: onTime,
          latePayments: late,
          totalPayments: total,
          onTimeRate: typeof rate === 'string' ? parseFloat(rate) : rate
        };
      })()
    };
  } catch (error) {
    logger.error('Error obteniendo dashboard del conductor:', error);
    throw error;
  }
};

export const getDriverLoans = async (phone, country, parkId = null) => {
  try {
    const phoneForDb = normalizePhoneForDb(phone, country);
    const digitsOnly = (phone || '').toString().replace(/\D/g, '');
    const parkNorm = (parkId != null && String(parkId).trim() !== '') ? String(parkId).trim() : null;

    let rapidinDriverQuery;
    let rapidinDriverParams;
    if (parkNorm) {
      rapidinDriverQuery = `
        SELECT id FROM module_rapidin_drivers 
        WHERE country = $1 AND COALESCE(park_id, '') = $2
          AND (phone = $3 OR phone = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5)
        LIMIT 1
      `;
      rapidinDriverParams = [country, parkNorm, phoneForDb, phone, digitsOnly];
    } else {
      rapidinDriverQuery = `
        SELECT id FROM module_rapidin_drivers 
        WHERE country = $1
          AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4)
        LIMIT 1
      `;
      rapidinDriverParams = [country, phoneForDb, phone, digitsOnly];
    }
    const rapidinDriverResult = await query(rapidinDriverQuery, rapidinDriverParams);

    if (rapidinDriverResult.rows.length === 0) {
      return { loans: [], pendingRequest: null, rejectedRequest: null };
    }

    const rapidinDriverId = rapidinDriverResult.rows[0].id;

    // Solicitud pendiente o en proceso (solo si aún NO está desembolsada; si está disbursed, el préstamo aparece en la lista)
    const pendingRequestsResult = await query(
      `SELECT id, status, requested_amount, created_at
       FROM module_rapidin_loan_requests 
       WHERE driver_id = $1 AND status NOT IN ('rejected', 'cancelled', 'disbursed')
       ORDER BY created_at DESC LIMIT 1`,
      [rapidinDriverId]
    );
    const pendingRequestRow = pendingRequestsResult.rows[0] || null;
    const pendingRequest = pendingRequestRow ? {
      id: pendingRequestRow.id,
      status: pendingRequestRow.status,
      requestedAmount: parseFloat(pendingRequestRow.requested_amount),
      createdAt: pendingRequestRow.created_at
    } : null;

    // Última solicitud rechazada (para que el conductor vea el motivo)
    const rejectedResult = await query(
      `SELECT id, status, requested_amount, created_at, rejection_reason
       FROM module_rapidin_loan_requests 
       WHERE driver_id = $1 AND status = 'rejected'
       ORDER BY created_at DESC LIMIT 1`,
      [rapidinDriverId]
    );
    const rejectedRow = rejectedResult.rows[0] || null;
    const rejectedRequest = rejectedRow ? {
      id: rejectedRow.id,
      status: rejectedRow.status,
      requestedAmount: parseFloat(rejectedRow.requested_amount),
      createdAt: rejectedRow.created_at,
      rejectionReason: rejectedRow.rejection_reason || null
    } : null;

    // Todos los préstamos del conductor (incluyendo históricos cancelled/completados)
    const loansQuery = `
      SELECT 
        l.id,
        l.disbursed_amount as loan_amount,
        l.total_amount,
        l.pending_balance as pending_amount,
        l.status,
        l.disbursed_at as disbursement_date,
        l.payment_frequency,
        l.number_of_installments,
        COUNT(i.id) as total_installments,
        COUNT(CASE WHEN i.status = 'paid' THEN 1 END) as paid_installments
      FROM module_rapidin_loans l
      LEFT JOIN module_rapidin_loan_requests r ON r.id = l.request_id
      LEFT JOIN module_rapidin_installments i ON i.loan_id = l.id
      WHERE l.driver_id = $1 AND l.country = $2
      GROUP BY l.id, l.disbursed_amount, l.total_amount, l.pending_balance, l.status, l.disbursed_at, l.payment_frequency, l.number_of_installments
      ORDER BY l.disbursed_at DESC
    `;

    const loansResult = await query(loansQuery, [rapidinDriverId, country]);

    const loans = loansResult.rows.map(loan => {
      let status = 'completed';
      if (loan.status === 'active') {
        status = 'active';
      } else if (loan.status === 'defaulted') {
        status = 'late';
      } else if (loan.status === 'cancelled') {
        status = 'completed';
      }

      return {
        id: loan.id,
        amount: parseFloat(loan.loan_amount),
        date: loan.disbursement_date,
        status: status,
        installments: parseInt(loan.number_of_installments || loan.total_installments),
        paidInstallments: parseInt(loan.paid_installments) || 0,
        pendingAmount: parseFloat(loan.pending_amount || 0),
        totalAmount: parseFloat(loan.total_amount),
        paymentFrequency: loan.payment_frequency
      };
    });

    return { loans, pendingRequest, rejectedRequest };
  } catch (error) {
    logger.error('Error obteniendo préstamos del conductor:', error);
    throw error;
  }
};

