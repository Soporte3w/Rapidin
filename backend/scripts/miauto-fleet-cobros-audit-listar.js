/**
 * Lista o filtra líneas del log JSONL de cobros Fleet (`logs/miauto-fleet-cobros.jsonl`).
 *
 * Uso:
 *   cd backend && node scripts/miauto-fleet-cobros-audit-listar.js
 *   cd backend && node scripts/miauto-fleet-cobros-audit-listar.js --driver <rapidin_driver_uuid>
 *   cd backend && node scripts/miauto-fleet-cobros-audit-listar.js --yango <external_driver_id>
 *   cd backend && node scripts/miauto-fleet-cobros-audit-listar.js --ultimas 50
 */
import { createReadStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { getMiautoFleetCobroAuditLogPath } from '../utils/miautoFleetCobroAuditLog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { driver: null, yango: null, ultimas: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--driver' && a[i + 1]) {
      out.driver = a[++i].trim();
    } else if (a[i] === '--yango' && a[i + 1]) {
      out.yango = a[++i].trim();
    } else if (a[i] === '--ultimas' && a[i + 1]) {
      out.ultimas = Math.max(1, parseInt(a[++i], 10) || 100);
    }
  }
  return out;
}

async function main() {
  const { driver, yango, ultimas } = parseArgs();
  const path = getMiautoFleetCobroAuditLogPath();
  const lines = [];
  try {
    const rl = readline.createInterface({
      input: createReadStream(path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try {
        lines.push(JSON.parse(t));
      } catch {
        /* skip bad line */
      }
    }
  } catch (e) {
    console.error('No se pudo leer el log:', path, e.message || e);
    process.exit(1);
  }

  let filtered = lines;
  if (driver) {
    filtered = filtered.filter((x) => x.rapidin_driver_id && String(x.rapidin_driver_id) === driver);
  }
  if (yango) {
    filtered = filtered.filter(
      (x) => x.external_driver_id_yango && String(x.external_driver_id_yango) === yango
    );
  }
  if (ultimas != null && filtered.length > ultimas) {
    filtered = filtered.slice(-ultimas);
  }

  console.log(JSON.stringify(filtered, null, 2));
  process.exit(0);
}

main();
