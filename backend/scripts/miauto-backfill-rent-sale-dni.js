/**
 * Corrige el DNI de las solicitudes que aparecen en Mi Auto > Alquiler/Venta.
 *
 * Regla: una licencia peruana válida tiene una letra inicial y 8 dígitos;
 * el DNI son esos 8 dígitos (X70339164 -> 70339164).
 *
 * Por defecto solo muestra el diagnóstico. Para aplicar:
 *   node scripts/miauto-backfill-rent-sale-dni.js --apply
 */
import { getClient, query } from '../config/database.js';
import { getContractorProfile } from '../services/yangoService.js';
import { getDniFromPeruvianLicense } from '../yego_miauto/services/utils/miautoLicenseDocument.js';

const APPLY = process.argv.includes('--apply');

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

async function forEachWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function buildChanges(rows) {
  const changes = [];
  const stats = {
    total: rows.length,
    alreadyCorrect: 0,
    invalidLicense: 0,
    profileErrors: 0,
    profilesConsulted: 0,
  };

  await forEachWithConcurrency(rows, 4, async (row) => {
    let licenseNumber = clean(row.license_number);
    let dniFromLicense = getDniFromPeruvianLicense(licenseNumber);

    if (!dniFromLicense) {
      licenseNumber = clean(row.driver_license_number);
      dniFromLicense = getDniFromPeruvianLicense(licenseNumber);
    }

    if (!dniFromLicense && clean(row.driver_id_fleet)) {
      stats.profilesConsulted += 1;
      const profile = await getContractorProfile(row.driver_id_fleet);
      if (profile.success) {
        licenseNumber = clean(profile.license_number);
        dniFromLicense = getDniFromPeruvianLicense(licenseNumber);
      } else {
        stats.profileErrors += 1;
      }
    }

    if (!dniFromLicense) {
      stats.invalidLicense += 1;
      return;
    }

    const currentDni = clean(row.dni);
    const currentLicense = clean(row.license_number);
    if (currentDni === dniFromLicense && currentLicense === licenseNumber) {
      stats.alreadyCorrect += 1;
      return;
    }

    changes.push({
      id: row.id,
      oldDni: row.dni,
      oldLicenseNumber: row.license_number,
      dni: dniFromLicense,
      licenseNumber,
    });
  });

  return { changes, stats };
}

async function applyChanges(changes) {
  const client = await getClient();
  let updated = 0;
  let skippedByConcurrentChange = 0;
  try {
    await client.query('BEGIN');
    for (const change of changes) {
      const result = await client.query(
        `UPDATE module_miauto_solicitud
         SET dni = $1, license_number = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
           AND status = 'aprobado'
           AND country = 'PE'
           AND dni IS NOT DISTINCT FROM $4
           AND license_number IS NOT DISTINCT FROM $5`,
        [change.dni, change.licenseNumber, change.id, change.oldDni, change.oldLicenseNumber]
      );
      if (result.rowCount === 1) updated += 1;
      else skippedByConcurrentChange += 1;
    }
    await client.query('COMMIT');
    return { updated, skippedByConcurrentChange };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const result = await query(
    `SELECT s.id, s.dni, s.license_number, s.driver_id_fleet,
            d.license_number AS driver_license_number
     FROM module_miauto_solicitud s
     LEFT JOIN drivers d ON d.driver_id = s.driver_id_fleet
     WHERE s.status = 'aprobado' AND s.country = 'PE'
     ORDER BY s.created_at ASC`
  );
  const { changes, stats } = await buildChanges(result.rows);

  console.log(`Modo: ${APPLY ? 'APLICAR' : 'DIAGNÓSTICO'}`);
  console.log(`Registros de Alquiler/Venta Perú: ${stats.total}`);
  console.log(`Ya correctos: ${stats.alreadyCorrect}`);
  console.log(`Perfiles de Yango consultados: ${stats.profilesConsulted}`);
  console.log(`Errores consultando perfil: ${stats.profileErrors}`);
  console.log(`Sin licencia válida letra + 8 dígitos: ${stats.invalidLicense}`);
  console.log(`Cambios encontrados: ${changes.length}`);

  if (!APPLY) {
    console.log('No se modificó la base de datos. Use --apply para ejecutar el backfill.');
    return;
  }

  const applied = await applyChanges(changes);
  console.log(`Registros actualizados: ${applied.updated}`);
  console.log(`Omitidos por cambio concurrente: ${applied.skippedByConcurrentChange}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Backfill falló: ${error.message}`);
    process.exit(1);
  });
