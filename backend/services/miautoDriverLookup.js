/**
 * Resolución de nombre y licencia desde la tabla `drivers` (flota Yango) por teléfono.
 * Usado cuando la solicitud o module_rapidin_drivers no traen esos datos.
 */
import { query } from '../config/database.js';

/** Park_id de Yego Mi Auto en tabla `drivers`. */
export const MIAUTO_PARK_ID = 'fafd623109d740f8a1f15af7c3dd86c6';

/**
 * Normaliza teléfono para match en drivers: con/sin +51, solo dígitos, últimos 9.
 */
export function normalizePhoneForDriversMatch(phone) {
  if (phone == null || String(phone).trim() === '') return { digits: '', last9: '', with51: '' };
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9) return { digits, last9: '', with51: '' };
  const last9 = digits.slice(-9);
  const with51 = digits.length === 9 ? `51${last9}` : digits.startsWith('51') ? digits : `51${last9}`;
  return { digits: digits.length >= 9 ? digits : '', last9, with51 };
}

/**
 * @returns {{ names: Record<string,string>, licenses: Record<string,string> }}
 */
export async function getDriverInfoByPhones(parkId, phones) {
  const empty = { names: {}, licenses: {} };
  if (!parkId || !Array.isArray(phones) || phones.length === 0) return empty;
  const variants = new Set();
  for (const p of phones) {
    const { digits, last9, with51 } = normalizePhoneForDriversMatch(p);
    if (last9) variants.add(last9);
    if (digits) variants.add(digits);
    if (with51) variants.add(with51);
  }
  const arr = [...variants];
  if (arr.length === 0) return empty;
  const last9Arr = arr.filter((s) => s.length === 9);
  const res = await query(
    `SELECT first_name, last_name,
            license_number,
            REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') AS phone_digits
     FROM drivers
     WHERE park_id = $1 AND work_status = 'working'
       AND (
         REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = ANY($2::text[])
         OR RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g'), 9) = ANY($3::text[])
       )`,
    [parkId, arr, last9Arr.length ? last9Arr : ['']]
  );
  const names = {};
  const licenses = {};
  for (const r of res.rows || []) {
    const name = [r.first_name, r.last_name].filter(Boolean).map(String).join(' ').trim();
    const lic =
      r.license_number != null && String(r.license_number).trim() !== ''
        ? String(r.license_number).trim()
        : null;
    const dig = (r.phone_digits || '').replace(/\D/g, '');
    if (!dig) continue;
    if (name) {
      names[dig] = name;
      if (dig.length >= 9) names[dig.slice(-9)] = name;
    }
    if (lic) {
      licenses[dig] = lic;
      if (dig.length >= 9) licenses[dig.slice(-9)] = lic;
    }
  }
  return { names, licenses };
}
