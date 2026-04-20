/**
 * Restaura SOLO module_miauto_solicitud desde un backup JSON.
 * No toca cuotas, comprobantes, cronogramas ni nada más.
 * Uso: node scripts/miauto-restaurar-solo-solicitudes.js [ruta/backup] --dry-run
 *      node scripts/miauto-restaurar-solo-solicitudes.js [ruta/backup] --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getClient } from '../config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLE = 'module_miauto_solicitud';

async function loadColumnMeta(client) {
  const r = await client.query(
    `SELECT column_name, data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [TABLE]
  );
  return r.rows;
}

function coerceCell(dataType, udtName, raw) {
  if (raw === null || raw === undefined) return null;
  if (dataType === 'jsonb' || udtName === 'jsonb') {
    if (typeof raw === 'string') return raw.trim() || null;
    return JSON.stringify(raw);
  }
  return raw;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const dry = argv.includes('--dry-run');
  const pos = argv.filter((a) => !a.startsWith('--'));
  const defaultDir = path.join(__dirname, '..', 'backups', 'miauto-20260414-102225');
  const backupDir = path.resolve(pos[0] || defaultDir);
  const jsonFile = path.join(backupDir, `${TABLE}.json`);

  if (!apply && !dry) {
    console.error('Indique --dry-run o --apply');
    process.exit(1);
  }
  if (!fs.existsSync(jsonFile)) {
    console.error('No existe:', jsonFile);
    process.exit(1);
  }

  const rows = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  if (!Array.isArray(rows)) { console.error('JSON inválido'); process.exit(1); }

  console.log(`Backup: ${backupDir}`);
  console.log(`Solicitudes en JSON: ${rows.length}`);

  if (dry) {
    console.log('[DRY-RUN] No se modificará la BD.');
    console.log('IDs de solicitudes en backup:');
    rows.forEach((r) => console.log(' -', r.id, '| placa:', r.placa_asignada, '| dni:', r.dni, '| status:', r.status));
    process.exit(0);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const colMeta = await loadColumnMeta(client);
    const metaByName = new Map(colMeta.map((c) => [c.column_name, c]));

    // Borrar SOLO las solicitudes que están en el backup (por id)
    const ids = rows.map((r) => r.id).filter(Boolean);
    const delDeps = await client.query(
      `DELETE FROM module_miauto_solicitud_cita WHERE solicitud_id = ANY($1::uuid[])`,
      [ids]
    );
    console.log(`Citas borradas: ${delDeps.rowCount}`);

    // Borrar solicitudes existentes con esos IDs para hacer upsert limpio
    const delSol = await client.query(
      `DELETE FROM ${TABLE} WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    console.log(`Solicitudes borradas (para reinsertar): ${delSol.rowCount}`);

    let inserted = 0;
    for (const row of rows) {
      const names = [];
      const vals = [];
      for (const [k, v] of Object.entries(row)) {
        const m = metaByName.get(k);
        if (!m) continue;
        names.push(`"${k}"`);
        vals.push(coerceCell(m.data_type, m.udt_name, v));
      }
      if (names.length === 0) continue;
      const ph = names.map((quoted, i) => {
        const col = quoted.replace(/^"|"$/g, '');
        const m = metaByName.get(col);
        const cast = m && (m.data_type === 'jsonb' || m.udt_name === 'jsonb') ? '::jsonb' : '';
        return `$${i + 1}${cast}`;
      }).join(', ');
      await client.query(`INSERT INTO ${TABLE} (${names.join(', ')}) VALUES (${ph})`, vals);
      inserted++;
    }

    await client.query('COMMIT');
    console.log(`\nSolicitudes insertadas: ${inserted}`);
    console.log('Restauracion completada.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ERROR - ROLLBACK:', e);
    process.exit(1);
  } finally {
    client.release();
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
