/**
 * Respaldo en JSON de solicitudes Mi Auto y tablas ligadas (Alquiler / Venta: status aprobado, cuotas, etc.).
 *
 * Uso:
 *   cd backend && node scripts/miauto-backup-json-solicitudes-alquiler-venta.js
 *
 * Salida: backend/backups/miauto-<timestamp>/
 *
 * Tablas: mismas que restaura miauto-restaurar-backup-json.js (orden de inserción / FKs).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';
import { getCronogramasByIds, getMonedaCuotaSemanalPorVehiculo } from '../services/miautoCronogramaService.js';
import {
  getDriverInfoByPhones,
  MIAUTO_PARK_ID,
  normalizePhoneForDriversMatch,
} from '../services/miautoDriverLookup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Mismo conjunto y orden lógico que RESTORE_TABLES en miauto-restaurar-backup-json.js */
const TABLES = [
  'module_miauto_tipo_cambio',
  'module_miauto_cronograma',
  'module_miauto_cronograma_vehiculo',
  'module_miauto_cronograma_rule',
  'module_miauto_solicitud',
  'module_miauto_cuota_semanal',
  'module_miauto_comprobante_cuota_semanal',
  'module_miauto_comprobante_pago',
  'module_miauto_adjunto',
  'module_miauto_solicitud_cita',
  'module_miauto_otros_gastos',
];

function serializeValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return { __type: 'bytea_base64', data: v.toString('base64') };
  return v;
}

function serializeRow(row) {
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    o[k] = serializeValue(v);
  }
  return o;
}

async function exportTable(table) {
  const r = await query(`SELECT * FROM ${table}`);
  return (r.rows || []).map(serializeRow);
}

async function buildAlquilerVentaSnapshot() {
  const fromBase = `
     FROM module_miauto_solicitud s
     LEFT JOIN module_rapidin_drivers rd ON rd.id = s.rapidin_driver_id
     LEFT JOIN module_miauto_cronograma c ON c.id = s.cronograma_id
     LEFT JOIN module_miauto_cronograma_vehiculo v ON v.id = s.cronograma_vehiculo_id
     WHERE s.status = 'aprobado'`;
  const listSql = `SELECT s.id, s.cronograma_id, s.cronograma_vehiculo_id, s.dni, s.phone, s.email, s.license_number, s.status, s.created_at, s.fecha_inicio_cobro_semanal, s.placa_asignada,
            rd.first_name AS driver_first_name, rd.last_name AS driver_last_name,
            c.name AS cronograma_name, v.name AS vehiculo_name, v.cuotas_semanales AS vehiculo_cuotas_semanales
     ${fromBase}
     ORDER BY s.fecha_inicio_cobro_semanal DESC NULLS LAST, s.created_at DESC`;
  const [countRes, dataRes] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total ${fromBase}`),
    query(listSql),
  ]);
  const total = countRes.rows[0]?.total ?? 0;
  const rows = dataRes.rows || [];
  const solicitudIds = rows.map((r) => r.id);
  const cronogramaIds = [...new Set(rows.map((row) => row.cronograma_id).filter(Boolean))];

  const cuotaSummaryBySolicitud = {};
  if (solicitudIds.length > 0) {
    const summaryRes = await query(
      `SELECT c.solicitud_id,
              COUNT(*)::int AS total_cuotas,
              COUNT(*) FILTER (WHERE c.status IN ('paid', 'bonificada'))::int AS cuotas_pagadas,
              COUNT(*) FILTER (WHERE c.status = 'overdue')::int AS cuotas_vencidas,
              COALESCE(SUM(c.paid_amount), 0)::decimal AS total_pagado
       FROM module_miauto_cuota_semanal c
       WHERE c.solicitud_id = ANY($1::uuid[])
       GROUP BY c.solicitud_id`,
      [solicitudIds]
    );
    for (const r of summaryRes.rows || []) {
      cuotaSummaryBySolicitud[r.solicitud_id] = {
        total_cuotas: r.total_cuotas,
        cuotas_pagadas: r.cuotas_pagadas,
        cuotas_vencidas: r.cuotas_vencidas,
        total_pagado: parseFloat(r.total_pagado) || 0,
      };
    }
  }

  const cronogramaCache = await getCronogramasByIds(cronogramaIds);
  const nameFromRapidin = (r) =>
    [r.driver_first_name, r.driver_last_name].filter(Boolean).map(String).join(' ').trim() || null;
  const licenseFromSolicitud = (r) => {
    const lic = r.license_number;
    return lic != null && String(lic).trim() !== '' ? String(lic).trim() : null;
  };
  const phonesForLookup = rows
    .filter((r) => r.phone && (!nameFromRapidin(r) || !licenseFromSolicitud(r)))
    .map((r) => r.phone);
  const driverInfoAv = await getDriverInfoByPhones(MIAUTO_PARK_ID, phonesForLookup);

  const data = rows.map((r) => {
    let driverName = nameFromRapidin(r);
    if (!driverName && r.phone) {
      const { digits, last9 } = normalizePhoneForDriversMatch(r.phone);
      driverName = driverInfoAv.names[digits] || driverInfoAv.names[last9] || null;
    }
    let licenseNum = licenseFromSolicitud(r);
    if (!licenseNum && r.phone) {
      const { digits, last9 } = normalizePhoneForDriversMatch(r.phone);
      licenseNum = driverInfoAv.licenses[digits] || driverInfoAv.licenses[last9] || null;
    }
    const summary = cuotaSummaryBySolicitud[r.id] || {
      total_cuotas: 0,
      cuotas_pagadas: 0,
      cuotas_vencidas: 0,
      total_pagado: 0,
    };
    const cuotasPlan = r.vehiculo_cuotas_semanales != null ? parseInt(r.vehiculo_cuotas_semanales, 10) || 0 : 0;
    const crono = r.cronograma_id ? cronogramaCache.get(String(r.cronograma_id)) : null;
    const moneda =
      crono && r.cronograma_vehiculo_id
        ? getMonedaCuotaSemanalPorVehiculo(crono, r.cronograma_vehiculo_id)
        : 'PEN';
    return {
      id: r.id,
      dni: r.dni,
      phone: r.phone || undefined,
      email: r.email || undefined,
      license_number: licenseNum || undefined,
      status: r.status,
      created_at: serializeValue(r.created_at),
      fecha_inicio_cobro_semanal: serializeValue(r.fecha_inicio_cobro_semanal),
      placa_asignada:
        r.placa_asignada != null && String(r.placa_asignada).trim() !== ''
          ? String(r.placa_asignada).trim()
          : undefined,
      driver_name: driverName || undefined,
      cronograma_name: r.cronograma_name || undefined,
      vehiculo_name: r.vehiculo_name || undefined,
      cuotas_semanales_plan: cuotasPlan,
      total_cuotas: summary.total_cuotas,
      cuotas_pagadas: summary.cuotas_pagadas,
      cuotas_vencidas: summary.cuotas_vencidas,
      total_pagado: summary.total_pagado,
      moneda,
    };
  });

  return { total, data };
}

async function main() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const outDir = path.join(__dirname, '..', 'backups', `miauto-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const counts = {};
  for (const t of TABLES) {
    const rows = await exportTable(t);
    counts[t] = rows.length;
    fs.writeFileSync(path.join(outDir, `${t}.json`), JSON.stringify(rows, null, 2), 'utf8');
  }

  const alquilerVenta = await buildAlquilerVentaSnapshot();
  fs.writeFileSync(
    path.join(outDir, 'alquiler_venta_listado_api.json'),
    JSON.stringify(alquilerVenta, null, 2),
    'utf8'
  );

  const manifest = {
    created_at: new Date().toISOString(),
    descripcion:
      'Respaldo tablas Mi Auto (tipo cambio, cronograma/reglas/vehículo, solicitud, cuotas, comprobantes cuota/pago, adjuntos, citas, otros gastos) + listado Alquiler/Venta (aprobado).',
    directorio: outDir,
    filas_por_tabla: counts,
    alquiler_venta_contratos_total: alquilerVenta.total,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
