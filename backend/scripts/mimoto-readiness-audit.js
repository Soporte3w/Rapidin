/**
 * Auditoria de solo lectura para validar el esquema y los datos de Yego Mi Moto.
 *
 * Uso:
 *   node scripts/mimoto-readiness-audit.js --env .env
 *   node scripts/mimoto-readiness-audit.js --env .env.dev --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const { Client } = pg;
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_TABLES = [
  'module_mimoto_adjunto',
  'module_mimoto_billing_audit_trail',
  'module_mimoto_bono_tiempo',
  'module_mimoto_comprobante_cuota_semanal',
  'module_mimoto_comprobante_otros_gastos',
  'module_mimoto_comprobante_pago',
  'module_mimoto_contrato_documento',
  'module_mimoto_cron_lock',
  'module_mimoto_cronograma',
  'module_mimoto_cronograma_rule',
  'module_mimoto_cronograma_vehiculo',
  'module_mimoto_cuota_semanal',
  'module_mimoto_evidencia_cobro_fleet',
  'module_mimoto_evidencia_fleet_archivo',
  'module_mimoto_fleet',
  'module_mimoto_gasto_ciclo',
  'module_mimoto_gasto_cobro_fleet_intento',
  'module_mimoto_gasto_pago_aplicacion',
  'module_mimoto_import_log',
  'module_mimoto_nota_venta',
  'module_mimoto_nota_venta_cuota',
  'module_mimoto_otros_gastos',
  'module_mimoto_paid_adjustment_log',
  'module_mimoto_solicitud',
  'module_mimoto_solicitud_cita',
  'module_mimoto_tipo_cambio',
  'module_mimoto_whatsapp_log',
];

const REQUIRED_COLUMNS = {
  module_mimoto_cronograma: ['modo_evaluacion', 'tasa_interes_mora'],
  module_mimoto_cronograma_rule: ['viajes', 'horas_minimas', 'cuotas_por_vehiculo'],
  module_mimoto_solicitud: ['cronograma_snapshot', 'driver_id_fleet', 'fleet_id'],
  module_mimoto_cuota_semanal: [
    'horas_conectadas',
    'capital_paid',
    'late_fee_total',
    'late_fee_paid',
    'mora_extra_total',
    'mora_extra_paid',
    'tasa_interes_mora_snapshot',
    'rule_snapshot',
    'mora_calculated_through',
    'mora_extra_calculated_through',
    'recaudo_pool',
    'recaudo_cascada_destino',
    'saldo_favor_conductor',
  ],
  module_mimoto_evidencia_cobro_fleet: [
    'source_key',
    'idempotency_token',
    'status',
    'completed_at',
  ],
  module_mimoto_evidencia_fleet_archivo: [
    'solicitud_id',
    'cuota_semanal_id',
    'file_name',
    'file_path',
    'created_by',
    'deleted_at',
  ],
};

const DATA_CHECKS = [
  {
    name: 'solicitudes_country_co',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_solicitud
          WHERE deleted_at IS NULL AND country <> 'CO'`,
  },
  {
    name: 'solicitudes_documento_valido',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_solicitud
          WHERE deleted_at IS NULL
            AND (document_type NOT IN ('CC','CE','PPT') OR document_number IS NULL OR BTRIM(document_number)='')`,
  },
  {
    name: 'solicitudes_relaciones_validas',
    severity: 'critical',
    sql: `SELECT COUNT(*)
          FROM module_mimoto_solicitud s
          LEFT JOIN module_mimoto_fleet f ON f.id=s.fleet_id
          LEFT JOIN module_mimoto_cronograma c ON c.id=s.cronograma_id
          LEFT JOIN module_mimoto_cronograma_vehiculo v ON v.id=s.cronograma_vehiculo_id
          WHERE s.deleted_at IS NULL
            AND (f.id IS NULL OR c.id IS NULL OR v.id IS NULL OR v.cronograma_id<>s.cronograma_id)`,
  },
  {
    name: 'solicitudes_placa_requerida',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_solicitud
          WHERE deleted_at IS NULL
            AND status NOT IN ('rechazado','retirado','cancelado')
            AND BTRIM(COALESCE(placa_asignada,''))=''`,
  },
  {
    name: 'solicitudes_identidad_placa_activa_unica',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM (
            SELECT fleet_id,
                   UPPER(REGEXP_REPLACE(BTRIM(placa_asignada),'[^A-Za-z0-9]','','g')) AS placa
            FROM module_mimoto_solicitud
            WHERE deleted_at IS NULL
              AND status NOT IN ('rechazado','retirado','cancelado')
              AND BTRIM(COALESCE(placa_asignada,''))<>''
            GROUP BY fleet_id,
                     UPPER(REGEXP_REPLACE(BTRIM(placa_asignada),'[^A-Za-z0-9]','','g'))
            HAVING COUNT(*)>1
          ) duplicated`,
  },
  {
    name: 'solicitudes_snapshot_financiero',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_solicitud
          WHERE deleted_at IS NULL AND COALESCE(cronograma_snapshot,'{}'::jsonb)='{}'::jsonb`,
  },
  {
    name: 'reglas_horas_completas',
    severity: 'critical',
    sql: `SELECT COUNT(*)
          FROM module_mimoto_cronograma_rule r
          JOIN module_mimoto_cronograma c ON c.id=r.cronograma_id
          WHERE c.deleted_at IS NULL AND c.modo_evaluacion='viajes_horas'
            AND r.horas_minimas IS NULL`,
  },
  {
    name: 'cuotas_relacion_solicitud',
    severity: 'critical',
    sql: `SELECT COUNT(*)
          FROM module_mimoto_cuota_semanal q
          LEFT JOIN module_mimoto_solicitud s ON s.id=q.solicitud_id
          WHERE q.deleted_at IS NULL AND (s.id IS NULL OR s.deleted_at IS NOT NULL)`,
  },
  {
    name: 'cuotas_moneda_valida',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_cuota_semanal
          WHERE deleted_at IS NULL AND moneda NOT IN ('COP','USD')`,
  },
  {
    name: 'cuotas_montos_no_negativos',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_cuota_semanal
          WHERE deleted_at IS NULL AND (
            amount_due<0 OR capital_paid<0 OR late_fee_total<0 OR late_fee<0 OR late_fee_paid<0
            OR mora_extra_total<0 OR mora_extra<0 OR mora_extra_paid<0 OR paid_amount<0
            OR recaudo_pool<0 OR saldo_favor_conductor<0
          )`,
  },
  {
    name: 'cuotas_capital_sobrepagado',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_cuota_semanal
          WHERE deleted_at IS NULL AND capital_paid>amount_due+0.01`,
  },
  {
    name: 'cuotas_saldo_mora_consistente',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_cuota_semanal
          WHERE deleted_at IS NULL AND (
            ABS(late_fee-GREATEST(0,late_fee_total-late_fee_paid))>0.01
            OR ABS(mora_extra-GREATEST(0,mora_extra_total-mora_extra_paid))>0.01
          )`,
  },
  {
    name: 'cuotas_pagado_desglosado',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_cuota_semanal
          WHERE deleted_at IS NULL
            AND ABS(paid_amount-(capital_paid+late_fee_paid+mora_extra_paid))>0.01`,
  },
  {
    name: 'cuotas_estado_pagado_consistente',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_cuota_saldo_view
          WHERE (status='paid' AND saldo_total>0.01)
             OR (status<>'paid' AND saldo_total<=0.01)`,
  },
  {
    name: 'cuotas_vencidas_no_partial',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM module_mimoto_cuota_saldo_view
          WHERE status='partial' AND due_date<(CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date
            AND saldo_total>0.01`,
  },
  {
    name: 'evidencias_fleet_idempotentes',
    severity: 'critical',
    sql: `SELECT COUNT(*) FROM (
            SELECT source_key FROM module_mimoto_evidencia_cobro_fleet
            WHERE source_key IS NOT NULL GROUP BY source_key HAVING COUNT(*)>1
          ) duplicated`,
  },
  {
    name: 'locks_vencidos_activos',
    severity: 'warning',
    sql: `SELECT COUNT(*) FROM module_mimoto_cron_lock
          WHERE locked=TRUE AND expires_at<CURRENT_TIMESTAMP`,
  },
];

function parseArgs(argv) {
  const options = { envFile: '.env', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--env') options.envFile = argv[++index];
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Argumento no reconocido: ${arg}`);
  }
  return options;
}

function databaseConfig(env) {
  if (env.DATABASE_URL?.trim()) return { connectionString: env.DATABASE_URL.trim() };
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
  };
}

async function auditSchema(client) {
  const objectResult = await client.query(`
    SELECT c.relname AS name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname LIKE 'module_mimoto_%'
      AND c.relkind IN ('r','p','v','m')
  `);
  const objects = new Map(objectResult.rows.map((row) => [row.name, row.relkind]));
  const missingTables = EXPECTED_TABLES.filter((table) => !['r', 'p'].includes(objects.get(table)));
  const missingViews = objects.get('module_mimoto_cuota_saldo_view') === 'v'
    ? []
    : ['module_mimoto_cuota_saldo_view'];

  const columnResult = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name LIKE 'module_mimoto_%'
  `);
  const columns = new Set(columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`));
  const missingColumns = Object.entries(REQUIRED_COLUMNS).flatMap(([table, names]) =>
    names.filter((name) => !columns.has(`${table}.${name}`)).map((name) => `${table}.${name}`));

  return { missing_tables: missingTables, missing_views: missingViews, missing_columns: missingColumns };
}

async function auditCounts(client) {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM module_mimoto_fleet WHERE deleted_at IS NULL) AS fleets,
      (SELECT COUNT(*)::int FROM module_mimoto_cronograma WHERE deleted_at IS NULL) AS cronogramas,
      (SELECT COUNT(*)::int FROM module_mimoto_cronograma_rule) AS reglas,
      (SELECT COUNT(*)::int FROM module_mimoto_cronograma_vehiculo WHERE deleted_at IS NULL) AS vehiculos,
      (SELECT COUNT(*)::int FROM module_mimoto_solicitud WHERE deleted_at IS NULL) AS solicitudes,
      (SELECT COUNT(*)::int FROM module_mimoto_cuota_semanal WHERE deleted_at IS NULL) AS cuotas,
      (SELECT COUNT(*)::int FROM module_mimoto_comprobante_cuota_semanal WHERE deleted_at IS NULL) AS comprobantes_cuota,
      (SELECT COUNT(*)::int FROM module_mimoto_evidencia_cobro_fleet) AS evidencias_fleet,
      (SELECT COUNT(*)::int FROM module_mimoto_evidencia_cobro_fleet WHERE simulated=FALSE) AS retiros_reales
  `);
  return result.rows[0];
}

async function auditData(client) {
  const results = [];
  for (const check of DATA_CHECKS) {
    const result = await client.query(check.sql);
    const issues = Number(result.rows[0].count);
    results.push({ name: check.name, severity: check.severity, issues, passed: issues === 0 });
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Uso: node scripts/mimoto-readiness-audit.js [--env .env] [--json]');
    return;
  }

  const envPath = path.isAbsolute(options.envFile)
    ? options.envFile
    : path.resolve(backendDir, options.envFile);
  const env = dotenv.parse(fs.readFileSync(envPath));
  const client = new Client(databaseConfig(env));
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const metadata = (await client.query(`
      SELECT current_database() AS database,
             current_user AS database_user,
             (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota') AS audited_at_bogota
    `)).rows[0];
    const schema = await auditSchema(client);
    const counts = await auditCounts(client);
    const checks = await auditData(client);
    await client.query('COMMIT');

    const schemaIssues = schema.missing_tables.length + schema.missing_views.length + schema.missing_columns.length;
    const criticalIssues = checks
      .filter((check) => check.severity === 'critical')
      .reduce((sum, check) => sum + check.issues, schemaIssues);
    const report = {
      ok: criticalIssues === 0,
      metadata,
      schema,
      counts,
      checks,
      summary: {
        critical_issues: criticalIssues,
        warnings: checks.filter((check) => check.severity === 'warning' && !check.passed).length,
      },
    };
    console.log(options.json ? JSON.stringify(report, null, 2) : JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
