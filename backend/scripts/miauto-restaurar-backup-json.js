/**
 * Restaura tablas Mi Auto desde un directorio generado por miauto-backup-json-solicitudes-alquiler-venta.js.
 *
 * Destructivo: borra datos actuales en esas tablas (y comprobantes de cuota semanal) y reinserta desde JSON.
 *
 * Uso:
 *   cd backend && node scripts/miauto-restaurar-backup-json.js [ruta/al/backup] --dry-run
 *   cd backend && node scripts/miauto-restaurar-backup-json.js [ruta/al/backup] --apply
 *
 * Solo cuotas semanales (no toca solicitud, cronograma, comprobantes de pago inicial, etc.):
 *   ... --solo-cuotas-semanales --dry-run
 *   ... --solo-cuotas-semanales --apply
 *
 * Por defecto: backups/miauto-20260406-014838 (relativo a backend/)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getClient } from '../config/database.js';
import { updateMoraDiaria, persistPaidAmountCapsForSolicitud } from '../services/miautoCuotaSemanalService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Mismo orden que el backup (padres antes que hijos por FKs); no incluye alquiler_venta_listado_api.json ni manifest. */
const RESTORE_TABLES = [
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

/** Borrado completo del backup (hijos primero). */
const DELETE_ORDER_FULL = [...RESTORE_TABLES].reverse();

const TABLE_CUOTA = 'module_miauto_cuota_semanal';
const TABLE_COMP_CUOTA = 'module_miauto_comprobante_cuota_semanal';

function coerceCell(columnName, dataType, udtName, raw) {
  if (raw === undefined) return null;
  if (raw === null) return null;
  if (typeof raw === 'object' && raw !== null && raw.__type === 'bytea_base64') {
    return Buffer.from(String(raw.data || ''), 'base64');
  }
  if (dataType === 'jsonb' || udtName === 'jsonb') {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (t === '' || t === 'null') return null;
      return t;
    }
    /** node-pg mapea Array JS a tipo array de Postgres, no a JSON; forzar JSON para jsonb. */
    return JSON.stringify(raw);
  }
  return raw;
}

async function loadColumnMeta(client, table) {
  const r = await client.query(
    `SELECT column_name, data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return r.rows || [];
}

async function insertRowsFromJson(client, table, rows, columnMeta) {
  const metaByName = new Map(columnMeta.map((c) => [c.column_name, c]));
  let n = 0;
  for (const row of rows) {
    const names = [];
    const vals = [];
    for (const [k, v] of Object.entries(row)) {
      const m = metaByName.get(k);
      if (!m) continue;
      names.push(`"${k}"`);
      vals.push(coerceCell(k, m.data_type, m.udt_name, v));
    }
    if (names.length === 0) continue;
    const ph = names
      .map((quoted, i) => {
        const col = quoted.replace(/^"|"$/g, '');
        const m = metaByName.get(col);
        const cast = m && (m.data_type === 'jsonb' || m.udt_name === 'jsonb') ? '::jsonb' : '';
        return `$${i + 1}${cast}`;
      })
      .join(', ');
    await client.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${ph})`, vals);
    n++;
  }
  return n;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const dry = argv.includes('--dry-run');
  const soloCuotas = argv.includes('--solo-cuotas-semanales');
  const pos = argv.filter((a) => !a.startsWith('--'));
  const defaultDir = path.join(__dirname, '..', 'backups', 'miauto-20260406-014838');
  const backupDir = path.resolve(pos[0] || defaultDir);

  if (!apply && !dry) {
    console.error('Indique --dry-run o --apply');
    process.exit(1);
  }
  if (!fs.existsSync(backupDir)) {
    console.error('No existe el directorio:', backupDir);
    process.exit(1);
  }

  if (soloCuotas) {
    const fp = path.join(backupDir, `${TABLE_CUOTA}.json`);
    if (!fs.existsSync(fp)) {
      console.error('Falta archivo:', fp);
      process.exit(1);
    }
    const cuotas = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!Array.isArray(cuotas)) {
      console.error('JSON inválido (no es array):', fp);
      process.exit(1);
    }
    const sids = [...new Set(cuotas.map((r) => r.solicitud_id).filter(Boolean))];

    const report = {
      backupDir,
      alcance: 'solo_cuotas_semanales',
      mode: apply ? 'apply' : 'dry-run',
      solicitudes_afectadas: sids.length,
      filas_cuota_en_json: cuotas.length,
    };

    if (dry) {
      const client = await getClient();
      try {
        const cRes = await client.query(
          `SELECT COUNT(*)::int AS n FROM ${TABLE_CUOTA} WHERE solicitud_id = ANY($1::uuid[])`,
          [sids]
        );
        const compRes = await client.query(
          `SELECT COUNT(*)::int AS n FROM ${TABLE_COMP_CUOTA} WHERE solicitud_id = ANY($1::uuid[])`,
          [sids]
        );
        report.bd_actual = {
          cuotas_semanales: cRes.rows[0]?.n ?? 0,
          comprobantes_cuota_semanal: compRes.rows[0]?.n ?? 0,
        };
      } finally {
        client.release();
      }
      console.log(
        JSON.stringify(
          {
            ...report,
            nota: 'Sin cambios en BD. Use --solo-cuotas-semanales --apply para ejecutar.',
          },
          null,
          2
        )
      );
      process.exit(0);
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const rComp = await client.query(
        `DELETE FROM ${TABLE_COMP_CUOTA} WHERE solicitud_id = ANY($1::uuid[])`,
        [sids]
      );
      const rCuotas = await client.query(`DELETE FROM ${TABLE_CUOTA} WHERE solicitud_id = ANY($1::uuid[])`, [
        sids,
      ]);
      const delComp = rComp.rowCount ?? 0;
      const delCuotas = rCuotas.rowCount ?? 0;
      const meta = await loadColumnMeta(client, TABLE_CUOTA);
      const inserted = await insertRowsFromJson(client, TABLE_CUOTA, cuotas, meta);
      report.borrados = { comprobantes_cuota_semanal: delComp, cuotas_semanales: delCuotas };
      report.insertadas = { [TABLE_CUOTA]: inserted };
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      process.exit(1);
    } finally {
      client.release();
    }

    await updateMoraDiaria(null, { includePartial: true });
    for (const sid of sids) {
      await persistPaidAmountCapsForSolicitud(String(sid));
    }
    report.mora_global = true;
    report.persist_caps_solicitudes = sids.length;
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const loaded = {};
  for (const t of RESTORE_TABLES) {
    const fp = path.join(backupDir, `${t}.json`);
    if (!fs.existsSync(fp)) {
      console.error('Falta archivo:', fp);
      process.exit(1);
    }
    loaded[t] = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!Array.isArray(loaded[t])) {
      console.error('JSON inválido (no es array):', fp);
      process.exit(1);
    }
  }

  const report = {
    backupDir,
    mode: apply ? 'apply' : 'dry-run',
    filas_en_json: Object.fromEntries(RESTORE_TABLES.map((t) => [t, loaded[t].length])),
  };

  if (dry) {
    console.log(JSON.stringify({ ...report, nota: 'Sin cambios en BD. Use --apply para restaurar.' }, null, 2));
    process.exit(0);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    for (const t of DELETE_ORDER_FULL) {
      await client.query(`DELETE FROM ${t}`);
    }
    for (const t of RESTORE_TABLES) {
      const meta = await loadColumnMeta(client, t);
      const inserted = await insertRowsFromJson(client, t, loaded[t], meta);
      report.insertadas = report.insertadas || {};
      report.insertadas[t] = inserted;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
  }

  const sids = new Set(loaded['module_miauto_cuota_semanal'].map((r) => r.solicitud_id).filter(Boolean));
  await updateMoraDiaria(null, { includePartial: true });
  for (const sid of sids) {
    await persistPaidAmountCapsForSolicitud(String(sid));
  }

  report.mora_global = true;
  report.persist_caps_solicitudes = sids.size;
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
