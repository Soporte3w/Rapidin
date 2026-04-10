/**
 * Sube un comprobante de cuota semanal para la fila ordinal N (ORDER BY week_start_date ASC).
 *
 * - Por defecto: mismo flujo que el **conductor** (`origen` conductor, pendiente de validar).
 * - Con **`--admin`**: flujo **comprobantes-conformidad-admin** (`origen` admin_confirmacion, validado,
 *   acredita en cronograma si hay saldo), igual que subir desde panel staff.
 *
 * Uso (desde backend/):
 *   node scripts/miauto-subir-comprobante-cuota-ordinal.js [--admin] <solicitud_uuid> <N> <ruta_imagen> <monto> [PEN|USD]
 */
import fs from 'fs';
import { query } from '../config/database.js';
import {
  createComprobanteConformidadAdmin,
  createComprobanteCuotaSemanal,
} from '../services/miautoComprobanteCuotaSemanalService.js';

const rawArgs = process.argv.slice(2);
const adminIdx = rawArgs.indexOf('--admin');
const esAdmin = adminIdx >= 0;
if (adminIdx >= 0) rawArgs.splice(adminIdx, 1);

const solicitudId = rawArgs[0]?.trim();
const nOrdinal = Math.max(1, parseInt(String(rawArgs[1] || ''), 10) || 0);
const imagePath = rawArgs[2]?.trim();
const monto = parseFloat(String(rawArgs[3] || '').replace(',', '.'));
const moneda = (rawArgs[4]?.trim() || 'PEN').toUpperCase();

if (!solicitudId || !nOrdinal || !imagePath || Number.isNaN(monto) || monto <= 0) {
  console.error(
    'Uso: node scripts/miauto-subir-comprobante-cuota-ordinal.js [--admin] <solicitud_uuid> <N> <ruta_imagen> <monto> [PEN|USD]'
  );
  process.exit(1);
}

if (!fs.existsSync(imagePath)) {
  console.error(`No existe el archivo: ${imagePath}`);
  process.exit(1);
}

const cu = await query(
  `SELECT id, week_start_date, due_date, status
   FROM (
     SELECT c.*, ROW_NUMBER() OVER (ORDER BY c.week_start_date ASC NULLS LAST) AS n
     FROM module_miauto_cuota_semanal c
     WHERE c.solicitud_id = $1::uuid
   ) x
   WHERE n = $2`,
  [solicitudId, nOrdinal]
);

const row = cu.rows[0];
if (!row) {
  console.error(`No hay cuota con ordinal ${nOrdinal} para la solicitud`);
  process.exit(1);
}

const buf = fs.readFileSync(imagePath);
const ext = imagePath.toLowerCase().endsWith('.png')
  ? 'png'
  : imagePath.toLowerCase().endsWith('.jpg') || imagePath.toLowerCase().endsWith('.jpeg')
    ? 'jpeg'
    : 'png';
const mime = ext === 'jpeg' ? 'image/jpeg' : 'image/png';
const base = imagePath.split(/[/\\]/).pop() || `comprobante.${ext}`;

const file = { buffer: buf, originalname: base, mimetype: mime };

const list = esAdmin
  ? await createComprobanteConformidadAdmin(solicitudId, row.id, file, null, { monto, moneda })
  : await createComprobanteCuotaSemanal(solicitudId, row.id, file, monto, moneda, null);
console.log(
  JSON.stringify(
    {
      ok: true,
      modo: esAdmin ? 'admin_confirmacion' : 'conductor',
      cuota_semanal_id: row.id,
      ordinal: nOrdinal,
      week_start_date: row.week_start_date,
      due_date: row.due_date,
      status_cuota: row.status,
      monto,
      moneda,
      comprobantes: list.length,
    },
    null,
    2
  )
);
