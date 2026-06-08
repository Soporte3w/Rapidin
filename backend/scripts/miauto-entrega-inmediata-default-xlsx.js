import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

/** Nombres probados en orden (el primero que exista en la raíz del repo). */
export const ENTREGA_INMEDIATA_XLSX_CANDIDATES = [
  'ENTREGA INMEDIATA 🚗🔥  (18) - GIOMAR 05-06-26.xlsx',
  'ENTREGA INMEDIATA 🚗🔥  (10) - 14-05-26.xlsx',
  'ENTREGA INMEDIATA 🚗🔥  (9) - 11-05-26 - giomar cobros YMA.xlsx',
  'ENTREGA INMEDIATA 🚗🔥  (7).xlsx',
  'ENTREGA INMEDIATA 🚗🔥  - 27-04-26 giomar.xlsx',
];

export const SHEET_CUOTAS_SEMANALES = 'Cuotas Semanales';

export function defaultEntregaInmediataXlsxPath() {
  for (const name of ENTREGA_INMEDIATA_XLSX_CANDIDATES) {
    const p = path.join(REPO_ROOT, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(REPO_ROOT, ENTREGA_INMEDIATA_XLSX_CANDIDATES[0]);
}
