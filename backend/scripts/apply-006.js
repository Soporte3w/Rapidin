/**
 * Aplica migración 006 (paid_late_fee).
 * Uso: node scripts/apply-006.js
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development') });

const { query } = await import('../config/database.js');

const migration = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '006_paid_late_fee.sql'), 'utf8');
await query(migration);
console.log('Migración 006 aplicada.');
process.exit(0);
