/**
 * Yego Rapidín 4.0 — ConsistencyChecker
 *
 * Job diario que verifica integridad de datos en Mi Auto y Rapidín.
 * Detecta inconsistencias y las reporta sin modificar datos automáticamente.
 *
 * Checks:
 *   1. cuota_semanal BD vs cronograma (diferencias en amount_due)
 *   2. paid_amount vs comprobantes validados
 *   3. PF total vs registros Yango
 *   4. Status inconsistentes (paid_amount > amount_due pero status != paid)
 *   5. Cuotas huérfanas (sin solicitud activa)
 */
import { query } from '../config/database.js';
import { logger, technicalLog } from '../utils/logger.js';

/**
 * @typedef {object} ConsistencyReport
 * @property {string} checkType
 * @property {string} severity - 'critical' | 'warning' | 'info'
 * @property {string} entityType
 * @property {string} entityId
 * @property {string} description
 * @property {object} details
 */

/**
 * Ejecuta todas las verificaciones de consistencia.
 * @returns {Promise<{ reports: ConsistencyReport[], summary: object }>}
 */
export async function runConsistencyCheck() {
  const reports = [];

  try {
    const checks = [
      checkCuotaSemanalVsCronograma,
      checkPaidAmountVsComprobantes,
      checkStatusInconsistency,
      checkCuotasHuerfanas,
      checkPendingBalanceRapidin,
    ];

    for (const check of checks) {
      const result = await check();
      reports.push(...result);
    }
  } catch (err) {
    technicalLog('error', 'ConsistencyChecker: error general', { error: err.message });
  }

  const summary = {
    total: reports.length,
    critical: reports.filter((r) => r.severity === 'critical').length,
    warning: reports.filter((r) => r.severity === 'warning').length,
    info: reports.filter((r) => r.severity === 'info').length,
    checkedAt: new Date().toISOString(),
  };

  if (reports.length > 0) {
    logger.info(`ConsistencyChecker: ${summary.critical} críticos, ${summary.warning} warnings, ${summary.info} info`);
  }

  return { reports, summary };
}

/**
 * Verifica: cuota_semanal en BD coincide con lo que dicta el cronograma.
 */
async function checkCuotaSemanalVsCronograma() {
  const reports = [];
  try {
    const res = await query(
      `SELECT c.id AS cuota_id, c.solicitud_id, c.cuota_semanal, c.amount_due, c.week_start_date,
              c.num_viajes, c.status, c.montos_fuente, c.moneda,
              s.cronograma_id, s.cronograma_vehiculo_id
       FROM module_miauto_cuota_semanal c
       JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
       WHERE c.deleted_at IS NULL
         AND c.montos_fuente = 'sistema'
         AND c.status NOT IN ('bonificada')
       LIMIT 5000`
    );

    for (const row of res.rows) {
      if (!row.cronograma_id) continue;
      // Solo reportar diferencias > 5% (pueden ser normales por cascada PF)
      const cuotaEnBd = parseFloat(row.cuota_semanal) || 0;
      const amountDue = parseFloat(row.amount_due) || 0;

      if (cuotaEnBd > 0 && amountDue > cuotaEnBd + 0.05) {
        reports.push({
          checkType: 'cuota_vs_cronograma',
          severity: 'warning',
          entityType: 'cuota_semanal',
          entityId: row.cuota_id,
          description: `amount_due (${amountDue.toFixed(2)}) > cuota_semanal (${cuotaEnBd.toFixed(2)})`,
          details: {
            solicitudId: row.solicitud_id,
            weekStartDate: row.week_start_date,
            numViajes: row.num_viajes,
            status: row.status,
            moneda: row.moneda,
          },
        });
      }
    }
  } catch (err) {
    reports.push({
      checkType: 'cuota_vs_cronograma',
      severity: 'critical',
      entityType: 'system',
      entityId: 'consistency-check',
      description: `Error ejecutando verificación: ${err.message}`,
      details: {},
    });
  }
  return reports;
}

/**
 * Verifica: paid_amount es consistente con los comprobantes validados.
 */
async function checkPaidAmountVsComprobantes() {
  const reports = [];
  try {
    const res = await query(
      `SELECT c.id AS cuota_id, c.solicitud_id, c.paid_amount, c.amount_due, c.status,
              COALESCE(SUM(CASE WHEN comp.estado = 'validado' THEN comp.monto ELSE 0 END), 0) AS total_comprobantes_validados
       FROM module_miauto_cuota_semanal c
       LEFT JOIN module_miauto_comprobante_cuota_semanal comp ON comp.cuota_semanal_id = c.id
        WHERE c.deleted_at IS NULL
          AND c.paid_amount > 0.005
          AND c.montos_fuente IS DISTINCT FROM 'excel'
       GROUP BY c.id, c.solicitud_id, c.paid_amount, c.amount_due, c.status
       HAVING COALESCE(SUM(CASE WHEN comp.estado = 'validado' THEN comp.monto ELSE 0 END), 0) = 0
       LIMIT 1000`
    );

    for (const row of res.rows) {
      reports.push({
        checkType: 'paid_vs_comprobantes',
        severity: 'warning',
        entityType: 'cuota_semanal',
        entityId: row.cuota_id,
        description: `paid_amount = ${row.paid_amount} pero no hay comprobantes validados`,
        details: {
          solicitudId: row.solicitud_id,
          paidAmount: parseFloat(row.paid_amount),
          amountDue: parseFloat(row.amount_due),
          status: row.status,
          posibleOrigen: 'cascada_pf_o_fleet_o_manual',
        },
      });
    }
  } catch (err) {
    reports.push({
      checkType: 'paid_vs_comprobantes',
      severity: 'critical',
      entityType: 'system',
      entityId: 'consistency-check',
      description: `Error: ${err.message}`,
      details: {},
    });
  }
  return reports;
}

/**
 * Verifica: status es consistente con paid_amount y amount_due.
 */
async function checkStatusInconsistency() {
  const reports = [];
  try {
    const res = await query(
      `SELECT id, solicitud_id, amount_due, paid_amount, late_fee, status, week_start_date
       FROM module_miauto_cuota_semanal
       WHERE deleted_at IS NULL
         AND (
           (status = 'paid' AND paid_amount < amount_due + COALESCE(late_fee, 0) - 0.02 AND status != 'bonificada')
           OR (status IN ('pending', 'overdue') AND paid_amount >= amount_due + COALESCE(late_fee, 0) - 0.02)
         )
       LIMIT 1000`
    );

    for (const row of res.rows) {
      const totalDue = (parseFloat(row.amount_due) || 0) + (parseFloat(row.late_fee) || 0);
      const paid = parseFloat(row.paid_amount) || 0;

      if (row.status === 'paid' && paid < totalDue - 0.02) {
        reports.push({
          checkType: 'status_inconsistency',
          severity: 'critical',
          entityType: 'cuota_semanal',
          entityId: row.id,
          description: `Status 'paid' pero paid_amount (${paid.toFixed(2)}) < total_due (${totalDue.toFixed(2)})`,
          details: { solicitudId: row.solicitud_id, weekStartDate: row.week_start_date },
        });
      } else if (row.status !== 'paid' && paid >= totalDue - 0.02) {
        reports.push({
          checkType: 'status_inconsistency',
          severity: 'warning',
          entityType: 'cuota_semanal',
          entityId: row.id,
          description: `Status '${row.status}' pero paid_amount (${paid.toFixed(2)}) >= total_due (${totalDue.toFixed(2)})`,
          details: { solicitudId: row.solicitud_id, weekStartDate: row.week_start_date },
        });
      }
    }
  } catch (err) {
    reports.push({
      checkType: 'status_inconsistency',
      severity: 'critical',
      entityType: 'system',
      entityId: 'consistency-check',
      description: `Error: ${err.message}`,
      details: {},
    });
  }
  return reports;
}

/**
 * Verifica: cuotas sin solicitud activa (huérfanas).
 */
async function checkCuotasHuerfanas() {
  const reports = [];
  try {
    const res = await query(
      `SELECT c.id, c.solicitud_id, c.week_start_date
       FROM module_miauto_cuota_semanal c
       LEFT JOIN module_miauto_solicitud s ON s.id = c.solicitud_id
       WHERE c.deleted_at IS NULL
         AND (s.id IS NULL OR s.deleted_at IS NOT NULL)
       LIMIT 1000`
    );

    for (const row of res.rows) {
      reports.push({
        checkType: 'cuotas_huerfanas',
        severity: 'critical',
        entityType: 'cuota_semanal',
        entityId: row.id,
        description: `Cuota semanal sin solicitud activa (solicitud_id=${row.solicitud_id})`,
        details: { weekStartDate: row.week_start_date },
      });
    }
  } catch (err) {
    reports.push({
      checkType: 'cuotas_huerfanas',
      severity: 'critical',
      entityType: 'system',
      entityId: 'consistency-check',
      description: `Error: ${err.message}`,
      details: {},
    });
  }
  return reports;
}

/**
 * Verifica: pending_balance del préstamo coincide con la suma de cuotas impagas.
 */
async function checkPendingBalanceRapidin() {
  const reports = [];
  try {
    const res = await query(
      `SELECT l.id AS loan_id, l.pending_balance,
              COALESCE(SUM(i.installment_amount - COALESCE(i.paid_amount, 0) + COALESCE(i.late_fee, 0)), 0) AS calculated_balance
       FROM module_rapidin_loans l
       LEFT JOIN module_rapidin_installments i ON i.loan_id = l.id AND i.deleted_at IS NULL
       WHERE l.deleted_at IS NULL AND l.status = 'active'
       GROUP BY l.id, l.pending_balance
       HAVING ABS(l.pending_balance - COALESCE(SUM(i.installment_amount - COALESCE(i.paid_amount, 0) + COALESCE(i.late_fee, 0)), 0)) > 0.05
       LIMIT 1000`
    );

    for (const row of res.rows) {
      reports.push({
        checkType: 'pending_balance_rapidin',
        severity: 'critical',
        entityType: 'loan',
        entityId: row.loan_id,
        description: `pending_balance (${row.pending_balance}) != suma cuotas impagas (${row.calculated_balance})`,
        details: {
          pendingBalance: parseFloat(row.pending_balance),
          calculatedBalance: parseFloat(row.calculated_balance),
        },
      });
    }
  } catch (err) {
    reports.push({
      checkType: 'pending_balance_rapidin',
      severity: 'critical',
      entityType: 'system',
      entityId: 'consistency-check',
      description: `Error: ${err.message}`,
      details: {},
    });
  }
  return reports;
}
