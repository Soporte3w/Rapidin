/**
 * Solo actualiza `module_miauto_solicitud`.
 * Busca en `drivers` (Yego Mi Auto, working, teléfono alineado a la solicitud) y guarda
 * `drivers.driver_id` (contractor Yango) en `rapidin_driver_id`. Requiere FK eliminada en BD.
 * Uso:
 *   node scripts/miauto-alinear-rapidin-driver-mi-auto.js <dni>
 *   node scripts/miauto-alinear-rapidin-driver-mi-auto.js <solicitud_uuid>   (solo esa fila: match por teléfono en drivers Mi Auto; DNI opcional)
 *   node scripts/miauto-alinear-rapidin-driver-mi-auto.js <dni> <solicitud_uuid>
 */
import { query } from '../config/database.js';
import { MIAUTO_PARK_ID, normalizePhoneForDriversMatch } from '../services/miautoDriverLookup.js';

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

async function main() {
  const arg1 = process.argv[2] || '08872540';
  const arg2 = process.argv[3];

  let dniTarget;
  let solicitudIdFilter = null;
  /** Solo UUID en argv[2]: se busca conductor en `drivers` por el teléfono de la solicitud (no hace falta DNI). */
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
      console.warn('Aviso: solicitud sin DNI en fila; se usa solo teléfono vs `drivers` (park Yego Mi Auto, working).');
    }
  } else {
    dniTarget = digitsOnly(arg1);
    if (arg2 && isUuidArg(arg2)) solicitudIdFilter = String(arg2).trim();
  }

  if (!dniTarget && !alinearSoloPorTelefonoSolicitud) {
    console.error('DNI vacío');
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

  const phone = solicitudes.map((s) => s.phone).find((p) => p != null && String(p).trim() !== '');
  if (!phone) {
    console.error('Ninguna solicitud con este DNI tiene teléfono; no se puede buscar en drivers.');
    process.exit(1);
  }

  const flota = await findFlotaDriverByPhone(phone);
  if (!flota) {
    console.error(
      'No se encontró conductor en `drivers` con park Yego Mi Auto, work_status=working y teléfono alineado a:',
      phone,
      '| park esperado:',
      MIAUTO_PARK_ID
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

  const updSol = solicitudIdFilter
    ? await query(
        `UPDATE module_miauto_solicitud
         SET rapidin_driver_id = $1::uuid, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2::uuid
         RETURNING id`,
        [uuidText, solicitudIdFilter]
      )
    : await query(
        `UPDATE module_miauto_solicitud
         SET rapidin_driver_id = $1::uuid, updated_at = CURRENT_TIMESTAMP
         WHERE REGEXP_REPLACE(COALESCE(dni, ''), '[^0-9]', '', 'g') = $2
         RETURNING id`,
        [uuidText, dniTarget]
      );
  const ids = (updSol.rows || []).map((r) => r.id);
  if (ids.length === 0) {
    console.error(
      `UPDATE no afectó filas: el DNI normalizado (solo dígitos) "${dniTarget}" no coincide con ninguna solicitud. En SQL compara con REGEXP_REPLACE(COALESCE(dni,''),'[^0-9]','','g') = '${dniTarget}'.`
    );
    process.exit(1);
  }

  console.log(JSON.stringify({
    dni: dniTarget || null,
    yego_drivers_driver_id: uuidText,
    flota_park_id: String(flota.park_id ?? '').trim(),
    solicitudes_actualizadas: ids,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
