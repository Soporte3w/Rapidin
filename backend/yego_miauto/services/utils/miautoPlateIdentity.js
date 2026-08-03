export function normalizeMiautoPlate(value) {
  if (value == null) return '';
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function selectWorkingDriverForPlate(candidates, preferredDriverId = null) {
  const byDriverId = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const driverId = candidate?.driver_id == null ? '' : String(candidate.driver_id).trim();
    if (driverId && !byDriverId.has(driverId)) byDriverId.set(driverId, candidate);
  }
  const preferred = preferredDriverId == null ? '' : String(preferredDriverId).trim();
  if (preferred && byDriverId.has(preferred)) return byDriverId.get(preferred);
  if (byDriverId.size === 1) return [...byDriverId.values()][0];
  if (byDriverId.size === 0) {
    throw new Error('La placa no tiene un conductor activo en la flota Yego Mi Auto');
  }
  throw new Error('La placa está asociada a más de un conductor activo; debe corregirse en Yango');
}
