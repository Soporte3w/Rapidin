/**
 * Respaldo completo de la base PostgreSQL (todas las tablas, esquemas y datos).
 *
 * Uso:
 *   cd backend && node scripts/db-backup-full-pg-dump.js
 *
 * Requiere: pg_dump en PATH (cliente PostgreSQL).
 * Salida: backend/backups/full-db-<timestamp>.dump (formato custom, -Fc).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

function stampLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const outDir = path.join(__dirname, '..', 'backups');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `full-db-${stampLocal()}.dump`);

const url = process.env.DATABASE_URL?.trim();
let args;
if (url) {
  args = ['-Fc', '-f', outFile, '--no-owner', '--no-acl', url];
} else {
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT || '5432';
  const db = process.env.DB_NAME;
  const user = process.env.DB_USER;
  if (!host || !db || !user) {
    console.error('Configuración incompleta: DATABASE_URL o DB_HOST, DB_NAME, DB_USER en .env');
    process.exit(1);
  }
  process.env.PGPASSWORD = process.env.DB_PASSWORD ?? '';
  args = ['-Fc', '-f', outFile, '--no-owner', '--no-acl', '-h', host, '-p', port, '-U', user, db];
}

const r = spawnSync('pg_dump', args, { stdio: 'inherit', env: process.env });
if (r.status !== 0) {
  process.exit(r.status ?? 1);
}
console.log(JSON.stringify({ ok: true, archivo: outFile }, null, 2));
