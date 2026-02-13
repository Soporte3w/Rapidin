import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

export const getWeeklyAnalysis = async (country, startDate, endDate) => {
  const result = await query(
    `SELECT 
      COUNT(*) FILTER (WHERE status = 'pending') as pending_requests,
      COUNT(*) FILTER (WHERE status = 'approved') as approved_requests,
      COUNT(*) FILTER (WHERE status = 'disbursed') as disbursed_loans,
      COUNT(*) FILTER (WHERE status = 'rejected') as rejected_requests,
      SUM(requested_amount) FILTER (WHERE status = 'disbursed') as total_disbursed,
      AVG(requested_amount) FILTER (WHERE status = 'disbursed') as avg_loan_amount
    FROM module_rapidin_loan_requests
    WHERE country = $1 
      AND created_at >= $2 
      AND created_at <= $3`,
    [country, startDate, endDate]
  );

  return result.rows[0];
};

export const getVintageAnalysis = async (country, cohortMonth) => {
  // El front envía "YYYY-MM"; PostgreSQL necesita fecha completa (ej. "2026-02-01")
  const cohortDate =
    cohortMonth && String(cohortMonth).match(/^\d{4}-\d{2}$/)
      ? String(cohortMonth) + '-01'
      : cohortMonth;

  const result = await query(
    `SELECT 
      DATE_TRUNC('month', disbursed_at) as cohort_month,
      COUNT(*) as total_loans,
      SUM(disbursed_amount) as total_amount,
      COUNT(*) FILTER (WHERE status = 'cancelled') as paid_loans,
      COUNT(*) FILTER (WHERE status = 'defaulted') as defaulted_loans,
      SUM(pending_balance) FILTER (WHERE status = 'active') as outstanding_balance
    FROM module_rapidin_loans
    WHERE country = $1 
      AND DATE_TRUNC('month', disbursed_at) = $2::date
    GROUP BY DATE_TRUNC('month', disbursed_at)`,
    [country, cohortDate]
  );

  return result.rows;
};

export const getPaymentBehavior = async (country, startDate, endDate) => {
  const result = await query(
    `SELECT 
      i.installment_number,
      COUNT(*) as total_installments,
      COUNT(*) FILTER (WHERE i.status = 'paid' AND i.paid_date <= i.due_date) as paid_on_time,
      COUNT(*) FILTER (WHERE i.status = 'paid' AND i.paid_date > i.due_date) as paid_late,
      COUNT(*) FILTER (WHERE i.status = 'overdue') as overdue,
      AVG(i.days_overdue) FILTER (WHERE i.days_overdue > 0) as avg_days_overdue,
      SUM(i.late_fee) as total_late_fees
    FROM module_rapidin_installments i
    JOIN module_rapidin_loans l ON l.id = i.loan_id
    WHERE l.country = $1 
      AND i.due_date >= $2 
      AND i.due_date <= $3
    GROUP BY i.installment_number
    ORDER BY i.installment_number`,
    [country, startDate, endDate]
  );

  return result.rows;
};

export const getExecutiveKPIs = async (country) => {
  const result = await query(
    `SELECT 
      (SELECT COUNT(*) FROM module_rapidin_loan_requests WHERE country = $1) as total_requests,
      (SELECT COUNT(*) FROM module_rapidin_loans WHERE country = $1 AND status = 'active') as active_loans,
      (SELECT SUM(pending_balance) FROM module_rapidin_loans WHERE country = $1 AND status = 'active') as total_portfolio,
      (SELECT COUNT(*) FROM module_rapidin_installments i 
       JOIN module_rapidin_loans l ON l.id = i.loan_id 
       WHERE l.country = $1 AND i.status = 'overdue') as overdue_installments,
      (SELECT COALESCE(SUM(p.amount), 0) FROM module_rapidin_payments p 
       JOIN module_rapidin_loans l ON l.id = p.loan_id 
       WHERE l.country = $1 AND p.payment_date >= CURRENT_DATE - INTERVAL '30 days') as payments_last_30_days`,
    [country]
  );

  return result.rows[0];
};

export const getPortfolioAtRisk = async (country, days) => {
  const result = await query(
    `SELECT 
      SUM(l.pending_balance) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM module_rapidin_installments i 
          WHERE i.loan_id = l.id 
            AND i.status = 'overdue' 
            AND i.days_overdue >= $2
        )
      ) as par_amount,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM module_rapidin_installments i 
          WHERE i.loan_id = l.id 
            AND i.status = 'overdue' 
            AND i.days_overdue >= $2
        )
      ) as par_loans,
      SUM(l.pending_balance) as total_portfolio
    FROM module_rapidin_loans l
    WHERE l.country = $1 AND l.status = 'active'`,
    [country, days]
  );

  const data = result.rows[0];
  const parPercentage = data.total_portfolio > 0 
    ? (data.par_amount / data.total_portfolio) * 100 
    : 0;

  return {
    ...data,
    par_percentage: parseFloat(parPercentage.toFixed(2))
  };
};

export const calculateProvisions = async (country) => {
  const loans = await query(
    `SELECT l.*, 
      MAX(i.days_overdue) as max_days_overdue,
      SUM(i.late_fee) as total_late_fees
    FROM module_rapidin_loans l
    LEFT JOIN module_rapidin_installments i ON i.loan_id = l.id AND i.status = 'overdue'
    WHERE l.country = $1 AND l.status = 'active'
    GROUP BY l.id`,
    [country]
  );

  let totalProvision = 0;
  let activeLoans = 0;
  let overdueLoans = 0;

  for (const loan of loans.rows) {
    activeLoans++;
    const daysOverdue = Number(loan.max_days_overdue) || 0;
    const pendingBalance = Number(loan.pending_balance) || 0;

    if (daysOverdue > 0) {
      overdueLoans++;
      let provisionRate = 0;
      if (daysOverdue >= 90) provisionRate = 100;
      else if (daysOverdue >= 60) provisionRate = 75;
      else if (daysOverdue >= 30) provisionRate = 50;
      else if (daysOverdue >= 7) provisionRate = 25;
      totalProvision += (pendingBalance * provisionRate) / 100;
    }
  }

  const totalPortfolio = loans.rows.reduce((sum, loan) => sum + (Number(loan.pending_balance) || 0), 0);
  const provisionPercentage = totalPortfolio > 0 ? (totalProvision / totalPortfolio) * 100 : 0;
  const totalPortfolioNum = Number(totalPortfolio);
  const totalProvisionNum = Number(totalProvision);
  const provisionPctNum = Number(provisionPercentage.toFixed(2));

  await query(
    `INSERT INTO module_rapidin_provisions 
     (country, calculation_date, total_amount, provisioned_amount, provision_percentage, active_loans, overdue_loans)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
     ON CONFLICT (country, calculation_date) 
     DO UPDATE SET 
       total_amount = EXCLUDED.total_amount,
       provisioned_amount = EXCLUDED.provisioned_amount,
       provision_percentage = EXCLUDED.provision_percentage,
       active_loans = EXCLUDED.active_loans,
       overdue_loans = EXCLUDED.overdue_loans`,
    [country, totalPortfolioNum, totalProvisionNum, provisionPctNum, activeLoans, overdueLoans]
  );

  return {
    total_amount: totalPortfolioNum,
    provisioned_amount: totalProvisionNum,
    provision_percentage: provisionPctNum,
    active_loans: activeLoans,
    overdue_loans: overdueLoans
  };
};







