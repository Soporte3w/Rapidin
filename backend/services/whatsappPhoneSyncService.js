import { query } from '../config/database.js';
import { auditService } from './auditService.js';
import { MIAUTO_PARK_ID } from '../yego_miauto/services/utils/miautoDriverLookup.js';

function trimOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

export function normalizeWhatsAppPhoneDigits(phone, country = 'PE') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length >= 10 && (digits.startsWith('51') || digits.startsWith('57'))) return digits;
  if (country === 'PE' && digits.length === 9) return `51${digits}`;
  if (country === 'CO' && digits.length === 10) return `57${digits}`;
  return digits;
}

function phoneForStorage(phone, country = 'PE') {
  const digits = normalizeWhatsAppPhoneDigits(phone, country);
  if (!digits || digits.length < 10) return null;
  return `+${digits}`;
}

function samePhone(a, b, country = 'PE') {
  const da = normalizeWhatsAppPhoneDigits(a, country);
  const db = normalizeWhatsAppPhoneDigits(b, country);
  return !!da && !!db && da === db;
}

function buildBaseResult({ source, phoneBefore, phoneAfter, fleetDriver }) {
  return {
    source,
    phone_before: phoneBefore || null,
    phone_after: phoneAfter || null,
    fleet_driver_id: fleetDriver?.driver_id || null,
    fleet_park_id: fleetDriver?.park_id || null,
    fleet_work_status: fleetDriver?.work_status || null,
    miauto_updated: false,
    rapidin_updated: false,
    rapidin_match_count: 0,
    warnings: [],
  };
}

async function findFleetDriver(driverId, parkId) {
  const driver = trimOrNull(driverId);
  const park = trimOrNull(parkId);
  if (!driver || !park) return null;
  const res = await query(
    `SELECT driver_id::text AS driver_id, park_id::text AS park_id, phone, work_status
     FROM drivers
     WHERE driver_id::text = $1
       AND park_id::text = $2
     ORDER BY CASE WHEN work_status = 'working' THEN 0 ELSE 1 END, driver_id::text
     LIMIT 1`,
    [driver, park]
  );
  return res.rows[0] || null;
}

async function auditPhoneUpdate(tableName, recordId, oldPhone, newPhone, payload, actorId) {
  if (samePhone(oldPhone, newPhone, payload?.country || 'PE')) return;
  await auditService.recordChange(
    tableName,
    recordId,
    'UPDATE',
    { phone: oldPhone || null, ...payload },
    { phone: newPhone || null, ...payload },
    actorId || null
  );
}

export async function resolveMiautoWhatsAppPhone(solicitudId) {
  const solRes = await query(
    `SELECT id, country, phone, driver_id_fleet
     FROM module_miauto_solicitud
     WHERE id = $1::uuid
       AND deleted_at IS NULL
     LIMIT 1`,
    [solicitudId]
  );
  const sol = solRes.rows[0];
  if (!sol) return null;

  const fleetDriver = await findFleetDriver(sol.driver_id_fleet, MIAUTO_PARK_ID);
  const fleetPhone = phoneForStorage(fleetDriver?.phone, sol.country || 'PE');
  return {
    solicitud: sol,
    fleetDriver,
    phone: fleetPhone || phoneForStorage(sol.phone, sol.country || 'PE') || sol.phone || null,
    source: fleetPhone ? 'drivers' : 'module_miauto_solicitud',
  };
}

export async function resolveRapidinWhatsAppPhone(loanId) {
  const loanRes = await query(
    `SELECT l.id AS loan_id,
            l.country,
            d.id AS rapidin_driver_id,
            d.phone,
            d.external_driver_id,
            d.park_id
     FROM module_rapidin_loans l
     INNER JOIN module_rapidin_drivers d ON d.id = l.driver_id
     WHERE l.id = $1::uuid
       AND l.deleted_at IS NULL
       AND d.deleted_at IS NULL
     LIMIT 1`,
    [loanId]
  );
  const loan = loanRes.rows[0];
  if (!loan) return null;

  const fleetDriver = await findFleetDriver(loan.external_driver_id, loan.park_id);
  const fleetPhone = phoneForStorage(fleetDriver?.phone, loan.country || 'PE');
  return {
    loan,
    fleetDriver,
    phone: fleetPhone || phoneForStorage(loan.phone, loan.country || 'PE') || loan.phone || null,
    source: fleetPhone ? 'drivers' : 'module_rapidin_drivers',
  };
}

export async function refreshMiautoWhatsAppPhone(solicitudId, actorId = null) {
  const resolved = await resolveMiautoWhatsAppPhone(solicitudId);
  if (!resolved) {
    const error = new Error('Solicitud no encontrada');
    error.statusCode = 404;
    throw error;
  }

  const { solicitud, fleetDriver } = resolved;
  const phoneAfter = phoneForStorage(fleetDriver?.phone, solicitud.country || 'PE');
  const result = buildBaseResult({
    source: phoneAfter ? 'drivers' : 'module_miauto_solicitud',
    phoneBefore: solicitud.phone,
    phoneAfter,
    fleetDriver,
  });

  if (!solicitud.driver_id_fleet) {
    result.warnings.push('La solicitud no tiene driver_id_fleet.');
    return result;
  }
  if (!fleetDriver) {
    result.warnings.push('No se encontró conductor Fleet para Yego Mi Auto.');
    return result;
  }
  if (!phoneAfter) {
    result.warnings.push('Fleet no tiene un teléfono válido.');
    return result;
  }

  if (!samePhone(solicitud.phone, phoneAfter, solicitud.country || 'PE')) {
    await query(
      `UPDATE module_miauto_solicitud
       SET phone = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid`,
      [phoneAfter, solicitudId]
    );
    result.miauto_updated = true;
    await auditPhoneUpdate(
      'module_miauto_solicitud',
      solicitudId,
      solicitud.phone,
      phoneAfter,
      {
        country: solicitud.country || 'PE',
        source: 'whatsapp_phone_refresh',
        fleet_driver_id: fleetDriver.driver_id,
        fleet_park_id: fleetDriver.park_id,
      },
      actorId
    );
  }

  const rapidinRes = await query(
    `SELECT id, phone, country
     FROM module_rapidin_drivers
     WHERE external_driver_id::text = $1
       AND park_id::text = $2
       AND deleted_at IS NULL`,
    [fleetDriver.driver_id, MIAUTO_PARK_ID]
  );
  result.rapidin_match_count = rapidinRes.rowCount;

  if (rapidinRes.rowCount === 0) {
    result.warnings.push('No hay registro Rapidín para la flota Yego Mi Auto.');
    return result;
  }
  if (rapidinRes.rowCount > 1) {
    result.warnings.push('Hay más de un registro Rapidín para el mismo conductor y flota.');
    return result;
  }

  const rapidinDriver = rapidinRes.rows[0];
  if (!samePhone(rapidinDriver.phone, phoneAfter, rapidinDriver.country || solicitud.country || 'PE')) {
    await query(
      `UPDATE module_rapidin_drivers
       SET phone = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid`,
      [phoneAfter, rapidinDriver.id]
    );
    result.rapidin_updated = true;
    await auditPhoneUpdate(
      'module_rapidin_drivers',
      rapidinDriver.id,
      rapidinDriver.phone,
      phoneAfter,
      {
        country: rapidinDriver.country || solicitud.country || 'PE',
        source: 'whatsapp_phone_refresh_from_miauto',
        fleet_driver_id: fleetDriver.driver_id,
        fleet_park_id: fleetDriver.park_id,
        solicitud_id: solicitudId,
      },
      actorId
    );
  }

  return result;
}

export async function refreshRapidinWhatsAppPhone(loanId, actorId = null) {
  const resolved = await resolveRapidinWhatsAppPhone(loanId);
  if (!resolved) {
    const error = new Error('Préstamo no encontrado');
    error.statusCode = 404;
    throw error;
  }

  const { loan, fleetDriver } = resolved;
  const phoneAfter = phoneForStorage(fleetDriver?.phone, loan.country || 'PE');
  const result = buildBaseResult({
    source: phoneAfter ? 'drivers' : 'module_rapidin_drivers',
    phoneBefore: loan.phone,
    phoneAfter,
    fleetDriver,
  });
  result.rapidin_driver_id = loan.rapidin_driver_id;

  if (!loan.external_driver_id || !loan.park_id) {
    result.warnings.push('El conductor Rapidín no tiene external_driver_id o park_id.');
    return result;
  }
  if (!fleetDriver) {
    result.warnings.push('No se encontró conductor Fleet para Rapidín.');
    return result;
  }
  if (!phoneAfter) {
    result.warnings.push('Fleet no tiene un teléfono válido.');
    return result;
  }

  if (!samePhone(loan.phone, phoneAfter, loan.country || 'PE')) {
    await query(
      `UPDATE module_rapidin_drivers
       SET phone = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid`,
      [phoneAfter, loan.rapidin_driver_id]
    );
    result.rapidin_updated = true;
    await auditPhoneUpdate(
      'module_rapidin_drivers',
      loan.rapidin_driver_id,
      loan.phone,
      phoneAfter,
      {
        country: loan.country || 'PE',
        source: 'whatsapp_phone_refresh',
        fleet_driver_id: fleetDriver.driver_id,
        fleet_park_id: fleetDriver.park_id,
        loan_id: loanId,
      },
      actorId
    );
  }

  if (String(loan.park_id || '') !== MIAUTO_PARK_ID) {
    result.warnings.push('Rapidín no pertenece a la flota Yego Mi Auto; no se sincroniza Mi Auto.');
    return result;
  }

  const miautoRes = await query(
    `SELECT id, phone, country
     FROM module_miauto_solicitud
     WHERE driver_id_fleet = $1
       AND deleted_at IS NULL`,
    [loan.external_driver_id]
  );
  result.miauto_match_count = miautoRes.rowCount;

  for (const sol of miautoRes.rows || []) {
    if (samePhone(sol.phone, phoneAfter, sol.country || loan.country || 'PE')) continue;
    await query(
      `UPDATE module_miauto_solicitud
       SET phone = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2::uuid`,
      [phoneAfter, sol.id]
    );
    result.miauto_updated = true;
    await auditPhoneUpdate(
      'module_miauto_solicitud',
      sol.id,
      sol.phone,
      phoneAfter,
      {
        country: sol.country || loan.country || 'PE',
        source: 'whatsapp_phone_refresh_from_rapidin',
        fleet_driver_id: fleetDriver.driver_id,
        fleet_park_id: fleetDriver.park_id,
        loan_id: loanId,
      },
      actorId
    );
  }

  return result;
}
