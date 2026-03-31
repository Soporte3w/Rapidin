/** Alinea 1.ª cuota con fecha_inicio; opcional --fecha YYYY-MM-DD. Uso: node scripts/miauto-realign-primera-cuota-deposito.js <uuid> [--fecha ...] */
import 'dotenv/config';
import { realignPrimeraCuotaDepositoDesdeFechaInicio } from '../services/miautoCuotaSemanalService.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const id = args.find((a) => !a.startsWith('-'));
  let fecha = null;
  const i = args.indexOf('--fecha');
  if (i >= 0 && args[i + 1]) fecha = String(args[i + 1]).trim().slice(0, 10);
  return { id, fecha };
}

async function main() {
  const { id, fecha } = parseArgs(process.argv);
  if (!id) {
    console.error('Uso: node scripts/miauto-realign-primera-cuota-deposito.js <solicitud_uuid> [--fecha YYYY-MM-DD]');
    process.exit(1);
  }
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    console.error('--fecha debe ser YYYY-MM-DD');
    process.exit(1);
  }
  const opts = fecha ? { fecha_inicio_cobro_semanal: fecha } : {};
  const out = await realignPrimeraCuotaDepositoDesdeFechaInicio(id, opts);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
