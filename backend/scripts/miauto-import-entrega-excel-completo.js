/**
 * Importa el Excel de Entrega Inmediata en el orden correcto:
 * 1) solicitudes
 * 2) cuotas semanales completas
 *
 * Uso:
 *   npm run miauto:importar-entrega-excel-completo -- /ruta/al.xlsx
 *   npm run miauto:importar-entrega-excel-completo -- --dry-run /ruta/al.xlsx
 */
import { spawnSync } from 'child_process';

const args = process.argv.slice(2);

function runStep(label, script, stepArgs) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(process.execPath, [script, ...stepArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

runStep('Importando solicitudes Mi Auto desde Excel', 'scripts/miauto-import-solicitudes-entrega-excel.js', args);

if (args.includes('--dry-run')) {
  console.log('\n[DRY-RUN] Solicitudes validadas. Para validar cuotas contra solicitudes nuevas, ejecute la importación real primero.');
  process.exit(0);
}

runStep('Importando cuotas semanales completas desde Excel', 'scripts/miauto-cargar-cuotas-excel-entrega-inmediata.js', args);
