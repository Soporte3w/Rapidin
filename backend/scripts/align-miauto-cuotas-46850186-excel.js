/**
 * Copia a BD los montos/viajes/vencimientos operativos acordados para solicitud Emerson (DNI 46850186).
 * Semana 5 operativa: viajes Lun 16–Dom 22 mar → week_start 2026-03-16, vence 2026-03-23 (no MAX+7 ni fila 2026-03-23).
 * No sustituye la lógica del job; solo pisa esta solicitud. El job Yango puede volver a recalcular si corre sin cuidado.
 *
 *   node scripts/align-miauto-cuotas-46850186-excel.js
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { query } from '../config/database.js';
import { updateMoraDiaria } from '../services/miautoCuotaSemanalService.js';
import { logger } from '../utils/logger.js';

const SOLICITUD_ID = 'b552af8b-9514-4518-89cd-4f21730c05c0';

/** Depósito: sin viajes. Vence = inicio cobro. */
const PATCH_DEPOSITO = {
  week_start: '2026-02-23',
  due_date: '2026-02-23',
  num_viajes: 0,
  cuota_semanal: 520,
  amount_due: 520,
  paid_amount: 520,
  status: 'paid',
};

/** Viajes = Lun–Dom de `week_start`; vence = lunes siguiente (regla Mi Auto). */
const PATCHES = [
  {
    week_start: '2026-03-02',
    due_date: '2026-03-09',
    num_viajes: 101,
    cuota_semanal: 413.4,
    amount_due: 413.4,
    paid_amount: 0,
    status: 'overdue',
  },
  {
    week_start: '2026-03-09',
    due_date: '2026-03-16',
    num_viajes: 47,
    cuota_semanal: 520,
    amount_due: 520,
    paid_amount: 0,
    status: 'overdue',
  },
  /** Semana 5: ingresos 16–22 mar, vence 23 mar */
  {
    week_start: '2026-03-16',
    due_date: '2026-03-23',
    num_viajes: 55,
    cuota_semanal: 520,
    amount_due: 520,
    paid_amount: 0,
    status: 'overdue',
  },
];

async function main() {
  const delExtra = await query(
    `DELETE FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1::uuid AND week_start_date = '2026-03-23'::date`,
    [SOLICITUD_ID]
  );
  if (delExtra.rowCount > 0) logger.info(`Eliminada cuota extra week_start 2026-03-23: ${delExtra.rowCount} fila(s)`);

  for (const p of [PATCH_DEPOSITO, ...PATCHES]) {
    const res = await query(
      `UPDATE module_miauto_cuota_semanal
       SET num_viajes = $1,
           partner_fees_raw = 0,
           partner_fees_83 = 0,
           bono_auto = 0,
           cuota_semanal = $2,
           amount_due = $3,
           paid_amount = $4,
           status = $5,
           due_date = $6::date,
           updated_at = CURRENT_TIMESTAMP
       WHERE solicitud_id = $7::uuid AND week_start_date = $8::date`,
      [p.num_viajes, p.cuota_semanal, p.amount_due, p.paid_amount, p.status, p.due_date, SOLICITUD_ID, p.week_start]
    );
    logger.info(`week ${p.week_start}: ${res.rowCount} fila(s)`);
  }

  await updateMoraDiaria(SOLICITUD_ID);

  const check = await query(
    `SELECT week_start_date::text, due_date::text, num_viajes, cuota_semanal, amount_due, paid_amount, status, late_fee, partner_fees_raw
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1::uuid
     ORDER BY week_start_date`,
    [SOLICITUD_ID]
  );
  console.log(JSON.stringify(check.rows, null, 2));
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
