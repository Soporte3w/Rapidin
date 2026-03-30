/**
 * Copia de seguridad en PostgreSQL de registros Mi Auto ligados a una fecha civil (lunes de cuota / vencimiento).
 * No modifica las tablas originales: crea tablas nuevas `…_bak_<YYYYMMDD>_<hhmmss>`.
 *
 * Uso:
 *   cd backend && node scripts/miauto-backup-registros-por-fecha.js [YYYY-MM-DD]
 *
 * Por defecto: 2026-03-30 (semana de cuota con week_start_date ese lunes).
 */
import { query } from '../config/database.js';

const DEFAULT_YMD = '2026-03-30';

function assertYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Fecha inválida: ${s} (use YYYY-MM-DD)`);
  }
  return s;
}

function tableSuffix(ymd) {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${ymd.replace(/-/g, '')}_${hh}${mm}${ss}`;
}

async function main() {
  const ymd = assertYmd((process.argv[2] || DEFAULT_YMD).trim().slice(0, 10));
  const suf = tableSuffix(ymd);

  const tCuotas = `module_miauto_cuota_semanal_bak_${suf}`;
  const tOtros = `module_miauto_otros_gastos_bak_${suf}`;

  await query(`DROP TABLE IF EXISTS ${tCuotas}`);
  await query(
    `CREATE TABLE ${tCuotas} AS
     SELECT *, CURRENT_TIMESTAMP AS _backup_captured_at
     FROM module_miauto_cuota_semanal
     WHERE week_start_date::date = $1::date OR due_date::date = $1::date`,
    [ymd]
  );

  const nCuotas = await query(`SELECT COUNT(*)::int AS n FROM ${tCuotas}`);
  const cuotasCount = nCuotas.rows[0]?.n ?? 0;

  await query(`DROP TABLE IF EXISTS ${tOtros}`);
  await query(
    `CREATE TABLE ${tOtros} AS
     SELECT *, CURRENT_TIMESTAMP AS _backup_captured_at
     FROM module_miauto_otros_gastos
     WHERE due_date::date = $1::date`,
    [ymd]
  );
  const nOtros = await query(`SELECT COUNT(*)::int AS n FROM ${tOtros}`);
  const otrosCount = nOtros.rows[0]?.n ?? 0;

  const out = {
    ok: true,
    fecha: ymd,
    tablas: {
      cuotas_semanales: tCuotas,
      otros_gastos: tOtros,
    },
    filas_copiadas: {
      cuotas_semanales: cuotasCount,
      otros_gastos: otrosCount,
    },
    nota: 'Para restaurar manualmente: INSERT INTO module_miauto_cuota_semanal SELECT <columnas sin _backup_captured_at> FROM ' + tCuotas + '; (revisar PK/conflictos).',
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
