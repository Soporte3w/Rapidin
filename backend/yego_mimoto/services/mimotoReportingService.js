import { query } from '../../config/database.js';
import { assertMimotoIsolationSql } from './mimotoFinancialEngine.js';
import { positiveNumber } from './mimotoServiceUtils.js';

const q = (sql, params = []) => query(assertMimotoIsolationSql(sql), params);

export async function getAnalysisSummary() {
  const result = await q(
    `SELECT
       (SELECT COUNT(*) FROM module_mimoto_solicitud WHERE deleted_at IS NULL)::int AS solicitudes,
       (SELECT COUNT(*) FROM module_mimoto_solicitud WHERE deleted_at IS NULL AND status='activo')::int AS contratos_activos,
       (SELECT COUNT(*) FROM module_mimoto_cuota_semanal WHERE deleted_at IS NULL)::int AS cuotas,
       (SELECT COUNT(*) FROM module_mimoto_cuota_semanal WHERE deleted_at IS NULL AND status='overdue')::int AS vencidas,
       (SELECT COALESCE(SUM(GREATEST(0,amount_due-capital_paid)+late_fee+mora_extra),0)
          FROM module_mimoto_cuota_semanal
          WHERE deleted_at IS NULL AND status IN ('pending','partial','overdue')) AS saldo_total_cop`
  );
  return result.rows[0];
}

export async function getExchangeRate() {
  const result = await q(
    `SELECT country, moneda_local, valor_usd_a_local, updated_at
     FROM module_mimoto_tipo_cambio WHERE country='CO'`
  );
  return result.rows[0] || null;
}

export async function setExchangeRate(value, actorId) {
  const rate = positiveNumber(value, 'valor_usd_a_local');
  const result = await q(
    `INSERT INTO module_mimoto_tipo_cambio(country,moneda_local,valor_usd_a_local,updated_by)
     VALUES ('CO','COP',$1,$2)
     ON CONFLICT (country) DO UPDATE SET valor_usd_a_local=EXCLUDED.valor_usd_a_local,
       updated_at=CURRENT_TIMESTAMP, updated_by=EXCLUDED.updated_by
     RETURNING country,moneda_local,valor_usd_a_local,updated_at`,
    [rate, actorId || null]
  );
  return result.rows[0];
}
