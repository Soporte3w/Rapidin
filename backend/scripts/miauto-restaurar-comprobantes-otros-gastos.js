/**
 * Restaura module_miauto_comprobante_pago y module_miauto_otros_gastos
 * desde un backup JSON. No toca solicitudes, cuotas ni cronogramas.
 * Uso: node scripts/miauto-restaurar-comprobantes-otros-gastos.js [ruta/backup] --apply
 *      node scripts/miauto-restaurar-comprobantes-otros-gastos.js [ruta/backup] --dry-run
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getClient } from '../config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLES = ['module_miauto_comprobante_pago', 'module_miauto_otros_gastos'];
const DEFAULT_DIR = path.join(__dirname, '..', 'backups', 'miauto-20260414-102225');

async function loadColumnMeta(client, table) {
  const r = await client.query(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table]
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

async function restoreTable(client, table, rows) {
  const meta = await loadColumnMeta(client, table);
  const metaByName = new Map(meta.map((c) => [c.column_name, c]));
  let inserted = 0;
  for (const row of rows) {
    const names = [], vals = [];
    for (const [k, v] of Object.entries(row)) {
      const m = metaByName.get(k);
      if (!m) continue;
      names.push(`"${k}"`);
      vals.push(coerceCell(m.data_type, m.udt_name, v));
    }
    if (!names.length) continue;
    const ph = names.map((quoted, i) => {
      const col = quoted.replace(/^"|"$/g, '');
      const m = metaByName.get(col);
      const cast = m && (m.data_type === 'jsonb' || m.udt_name === 'jsonb') ? '::jsonb' : '';
      return `$${i + 1}${cast}`;
    }).join(', ');
    await client.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`, vals);
    inserted++;
  }
  return inserted;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const dry   = argv.includes('--dry-run');
  const pos   = argv.filter((a) => !a.startsWith('--'));
  const backupDir = path.resolve(pos[0] || DEFAULT_DIR);

  if (!apply && !dry) { console.error('Indique --dry-run o --apply'); process.exit(1); }
  if (!fs.existsSync(backupDir)) { console.error('No existe:', backupDir); process.exit(1); }

  const loaded = {};
  for (const t of TABLES) {
    const fp = path.join(backupDir, `${t}.json`);
    if (!fs.existsSync(fp)) { console.error('Falta archivo:', fp); process.exit(1); }
    loaded[t] = JSON.parse(fs.readFileSync(fp, 'utf8'));
    console.log(`${t}: ${loaded[t].length} filas en backup`);
  }

  if (dry) {
    console.log('[DRY-RUN] Sin cambios en BD.');
    process.exit(0);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const report = {};
    for (const t of TABLES) {
      const n = await restoreTable(client, t, loaded[t]);
      report[t] = n;
      console.log(`${t}: ${n} insertados`);
    }
    await client.query('COMMIT');
    console.log('\nRestauración completada.', report);
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
