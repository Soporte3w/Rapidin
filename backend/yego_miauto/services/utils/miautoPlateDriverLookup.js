import { query } from '../../../config/database.js';
import { MIAUTO_PARK_ID } from './miautoDriverLookup.js';
import { normalizeMiautoPlate, selectWorkingDriverForPlate } from './miautoPlateIdentity.js';

/**
 * Resuelve la identidad Yango vigente exclusivamente desde la placa del contrato.
 * El driver preferido solo desempata entre candidatos que ya pertenecen a esa placa.
 */
export async function resolveWorkingMiautoDriverForPlate(plate, preferredDriverId = null) {
  const normalizedPlate = normalizeMiautoPlate(plate);
  if (!normalizedPlate) {
    throw new Error('El contrato no tiene una placa asignada');
  }

  const result = await query(
    `SELECT d.driver_id, d.park_id, d.first_name, d.last_name
     FROM drivers d
     WHERE TRIM(COALESCE(d.park_id::text, '')) = $1
       AND d.work_status = 'working'
       AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(d.car_number, '')), '[^A-Z0-9]', '', 'g')) = $2
     ORDER BY d.driver_id::text`,
    [MIAUTO_PARK_ID, normalizedPlate]
  );

  const selected = selectWorkingDriverForPlate(result.rows, preferredDriverId);
  return {
    ...selected,
    driver_id: String(selected.driver_id).trim(),
    park_id: selected.park_id || MIAUTO_PARK_ID,
  };
}
