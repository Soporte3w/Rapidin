/**
 * Solo actualiza `module_miauto_solicitud.rapidin_driver_id`.
 * Busca en `drivers` (Yego Mi Auto park, work_status=working) el `driver_id` Yango y lo guarda como UUID en `rapidin_driver_id`.
 *
 * Uso (una solicitud / DNI — igual que antes):
 *   node scripts/miauto-alinear-rapidin-driver-mi-auto.js <dni>
 *   node scripts/miauto-alinear-rapidin-driver-mi-auto.js <solicitud_uuid>
 *   node scripts/miauto-alinear-rapidin-driver-mi-auto.js <dni> <solicitud_uuid>
 *
 * Uso (lote — todas las solicitudes sin rapidin_driver_id):
 *   node scripts/miauto-alinear-rapidin-driver-mi-auto.js --sin-rapidin --dry-run
 *   node scripts/miauto-alinear-rapidin-driver-mi-auto.js --sin-rapidin
 *
 * Match: primero teléfono (mismo criterio que antes); si no hay match, DNI vs drivers.document_number.
 */
import { query } from '../config/database.js';
import { MIAUTO_PARK_ID, normalizePhoneForDriversMatch } from '../yego_miauto/services/utils/miautoDriverLookup.js';

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function isUuidArg(s) {
  const t = String(s || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);
}

function fleetDriverIdToUuidText(raw) {
  const compact = String(raw ?? '')
    .trim()
    .replace(/-/g, '')
    .toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20, 32)}`;
}

function phoneMatchArrays(phone) {
  const { last9, with51 } = normalizePhoneForDriversMatch(phone);
  const set = new Set();
  const d = digitsOnly(phone);
  if (d) set.add(d);
  if (last9) {
    set.add(last9);
    if (with51) set.add(with51);
  }
  const arr = [...set].filter(Boolean);
  const last9Arr = last9 ? [last9] : [''];
  return { arr, last9Arr };
}

async function findFlotaDriverByPhone(phone) {
  const { arr, last9Arr } = phoneMatchArrays(phone);
  if (arr.length === 0) return null;
  const res = await query(
    `SELECT driver_id, park_id, document_number, first_name, last_name, license_number, phone
     FROM drivers d
     WHERE d.park_id = $1
       AND d.work_status = 'working'
       AND d.park_id IS NOT NULL
       AND (
         REGEXP_REPLACE(COALESCE(d.phone, ''), '[^0-9]', '', 'g') = ANY($2::text[])
         OR RIGHT(REGEXP_REPLACE(COALESCE(d.phone, ''), '[^0-9]', '', 'g'), 9) = ANY($3::text[])
       )
     ORDER BY d.driver_id::text
     LIMIT 1`,
    [MIAUTO_PARK_ID, arr, last9Arr]
  );
  return res.rows[0] || null;
}

async function findFlotaDriverByDni(dniDigits) {
  const d = digitsOnly(dniDigits);
  if (!d || d.length < 4) return null;
  const res = await query(
    `SELECT driver_id, park_id, document_number, first_name, last_name, license_number, phone
     FROM drivers d
     WHERE d.park_id = $1
       AND d.work_status = 'working'
       AND d.park_id IS NOT NULL
       AND REGEXP_REPLACE(COALESCE(d.document_number, ''), '[^0-9]', '', 'g') = $2
     ORDER BY d.driver_id::text
     LIMIT 1`,
    [MIAUTO_PARK_ID, d]
  );
  return res.rows[0] || null;
}

async function resolveFlotaForSolicitud(row) {
  const phone = row.phone != null && String(row.phone).trim() !== '' ? row.phone : null;
  const dniDigits = digitsOnly(row.dni);
  if (phone) {
    const byPhone = await findFlotaDriverByPhone(phone);
    if (byPhone) return { flota: byPhone, via: 'phone' };
  }
  if (dniDigits.length >= 4) {
    const byDni = await findFlotaDriverByDni(dniDigits);
    if (byDni) return { flota: byDni, via: 'dni' };
  }
  return { flota: null, via: null };
}

async function applyRapidinDriverToSolicitudId(solicitudId, uuidText, dryRun) {
  if (dryRun) return true;
  const upd = await query(
    `UPDATE module_miauto_solicitud
     SET rapidin_driver_id = $1::uuid, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2::uuid
     RETURNING id`,
    [uuidText, solicitudId]
  );
  return (upd.rows || []).length > 0;
}

async function mainBatch() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const res = await query(
    `SELECT id, country, dni, phone, rapidin_driver_id
     FROM module_miauto_solicitud
     WHERE rapidin_driver_id IS NULL
       AND (
         (phone IS NOT NULL AND TRIM(phone) <> '')
         OR (REGEXP_REPLACE(COALESCE(dni, ''), '[^0-9]', '', 'g') <> '' AND LENGTH(REGEXP_REPLACE(COALESCE(dni, ''), '[^0-9]', '', 'g')) >= 4)
       )
     ORDER BY created_at ASC NULLS LAST`
  );
  const rows = res.rows || [];
  const stats = {
    total: rows.length,
    actualizadas: 0,
    sin_match: 0,
    driver_id_invalido: 0,
    dryRun,
    park_id: MIAUTO_PARK_ID,
    detalle_sin_match: [],
  };

  for (const row of rows) {
    const { flota, via } = await resolveFlotaForSolicitud(row);
    if (!flota) {
      stats.sin_match++;
      if (stats.detalle_sin_match.length < 80) {
        stats.detalle_sin_match.push({
          id: row.id,
          phone: row.phone || null,
          dni: row.dni || null,
        });
      }
      continue;
    }
    const rawId = flota.driver_id;
    if (rawId == null || String(rawId).trim() === '') {
      stats.driver_id_invalido++;
      continue;
    }
    const uuidText = fleetDriverIdToUuidText(rawId);
    if (!uuidText) {
      stats.driver_id_invalido++;
      if (stats.detalle_sin_match.length < 80) {
        stats.detalle_sin_match.push({
          id: row.id,
          msg: 'driver_id no UUID 32 hex',
          raw: String(rawId),
        });
      }
      continue;
    }
    const ok = await applyRapidinDriverToSolicitudId(row.id, uuidText, dryRun);
    if (ok) {
      stats.actualizadas++;
      console.log(
        `[${dryRun ? 'DRY' : 'OK'}] ${row.id} via=${via} driver=${uuidText} doc_flota=${flota.document_number || ''} phone_flota=${flota.phone || ''}`
      );
    }
  }

  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

async function mainSingle() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const arg1 = argv[0];
  const arg2 = argv[1];

  if (!arg1) {
    console.error(
      'Uso:\n' +
        '  node scripts/miauto-alinear-rapidin-driver-mi-auto.js <dni>\n' +
        '  node scripts/miauto-alinear-rapidin-driver-mi-auto.js <solicitud_uuid>\n' +
        '  node scripts/miauto-alinear-rapidin-driver-mi-auto.js <dni> <solicitud_uuid>\n' +
        '  node scripts/miauto-alinear-rapidin-driver-mi-auto.js --sin-rapidin [--dry-run]'
    );
    process.exit(1);
  }

  let dniTarget;
  let solicitudIdFilter = null;
  let alinearSoloPorTelefonoSolicitud = false;

  if (isUuidArg(arg1) && !arg2) {
    alinearSoloPorTelefonoSolicitud = true;
    solicitudIdFilter = String(arg1).trim();
    const one = await query(
      `SELECT id, country, dni, phone, rapidin_driver_id
       FROM module_miauto_solicitud WHERE id = $1::uuid LIMIT 1`,
      [solicitudIdFilter]
    );
    const row = one.rows[0];
    if (!row) {
      console.error('No existe module_miauto_solicitud con id:', solicitudIdFilter);
      process.exit(1);
    }
    dniTarget = digitsOnly(row.dni);
    if (!dniTarget) {
      console.warn('Aviso: solicitud sin DNI en fila; se usa teléfono y/o DNI vs `drivers`.');
    }
  } else {
    dniTarget = digitsOnly(arg1);
    if (arg2 && isUuidArg(arg2)) solicitudIdFilter = String(arg2).trim();
  }

  if (!dniTarget && !alinearSoloPorTelefonoSolicitud) {
    console.error('DNI vacío (modo por DNI). Usa UUID de solicitud solo para modo por teléfono de esa fila.');
    process.exit(1);
  }

  let solicitudes;
  if (solicitudIdFilter && !isUuidArg(arg1)) {
    const solRes = await query(
      `SELECT id, country, dni, phone, rapidin_driver_id
       FROM module_miauto_solicitud
       WHERE id = $1::uuid
         AND REGEXP_REPLACE(COALESCE(dni, ''), '[^0-9]', '', 'g') = $2`,
      [solicitudIdFilter, dniTarget]
    );
    solicitudes = solRes.rows || [];
    if (solicitudes.length === 0) {
      console.error('No hay solicitud con ese id y DNI:', solicitudIdFilter, dniTarget);
      process.exit(1);
    }
  } else if (solicitudIdFilter && isUuidArg(arg1)) {
    const solRes = await query(
      `SELECT id, country, dni, phone, rapidin_driver_id
       FROM module_miauto_solicitud WHERE id = $1::uuid`,
      [solicitudIdFilter]
    );
    solicitudes = solRes.rows || [];
  } else {
    const solRes = await query(
      `SELECT id, country, dni, phone, rapidin_driver_id
       FROM module_miauto_solicitud
       WHERE REGEXP_REPLACE(COALESCE(dni, ''), '[^0-9]', '', 'g') = $1
       ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST`,
      [dniTarget]
    );
    solicitudes = solRes.rows || [];
  }

  if (solicitudes.length === 0) {
    console.log('Sin filas en module_miauto_solicitud para DNI (solo dígitos):', dniTarget);
    process.exit(0);
  }

  const row0 = solicitudes[0];
  const { flota, via } = await resolveFlotaForSolicitud(row0);
  if (!flota) {
    console.error(
      'No se encontró conductor en `drivers` (park Mi Auto, working) por teléfono ni DNI. Tel:',
      row0.phone,
      'DNI:',
      row0.dni
    );
    process.exit(1);
  }

  const rawId = flota.driver_id;
  if (rawId == null || String(rawId).trim() === '') {
    console.error('Fila en drivers sin driver_id');
    process.exit(1);
  }
  const uuidText = fleetDriverIdToUuidText(rawId);
  if (!uuidText) {
    console.error('drivers.driver_id no es UUID 32 hex:', rawId);
    process.exit(1);
  }

  const idsToUpdate = solicitudIdFilter
    ? [solicitudIdFilter]
    : solicitudes.map((s) => s.id);
  const ids = [];
  for (const sid of idsToUpdate) {
    const updSol = await query(
      `UPDATE module_miauto_solicitud
       SET rapidin_driver_id = $1::uuid, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid
       RETURNING id`,
      [uuidText, sid]
    );
    ids.push(...(updSol.rows || []).map((r) => r.id));
  }

  if (ids.length === 0) {
    console.error('UPDATE no afectó filas.');
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        dni: dniTarget || null,
        match_via: via,
        yego_drivers_driver_id: uuidText,
        flota_park_id: String(flota.park_id ?? '').trim(),
        solicitudes_actualizadas: ids,
      },
      null,
      2
    )
  );
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--sin-rapidin') || argv.includes('--all')) {
    await mainBatch();
    return;
  }
  await mainSingle();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
