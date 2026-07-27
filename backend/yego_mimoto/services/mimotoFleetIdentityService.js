import { findFleetContractorByPlateForFleet } from '../../services/yangoService.js';

export function normalizeMimotoPlate(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function driverPlates(driver) {
  const values = Array.isArray(driver?.plates) ? driver.plates : [driver?.plate];
  return new Set(values.map(normalizeMimotoPlate).filter(Boolean));
}

export function findSupplyDriversByPlate(supply, plate) {
  const expected = normalizeMimotoPlate(plate);
  if (!expected || !supply?.success || !Array.isArray(supply.drivers)) return [];
  return supply.drivers.filter((driver) => driverPlates(driver).has(expected));
}

export async function resolveMimotoFleetIdentity({ plate, parkId, cookie, supply } = {}) {
  const normalizedPlate = normalizeMimotoPlate(plate);
  if (!normalizedPlate) {
    return { success: false, reason: 'sin_placa', error: 'La solicitud no tiene placa asignada' };
  }

  const supplyMatches = findSupplyDriversByPlate(supply, normalizedPlate);
  if (supplyMatches.length > 1) {
    return {
      success: false,
      reason: 'placa_ambigua',
      error: `Supply devolvió más de un conductor para la placa ${normalizedPlate}`,
    };
  }
  if (supplyMatches.length === 1) {
    return {
      success: true,
      driverId: String(supplyMatches[0].driver_id),
      plate: normalizedPlate,
      supplyDriver: supplyMatches[0],
      source: 'fleet_supply',
    };
  }

  const lookup = await findFleetContractorByPlateForFleet({
    plate: normalizedPlate,
    parkId,
    cookie,
  });
  if (!lookup.success) return lookup;
  return {
    success: true,
    driverId: lookup.driver_id,
    plate: normalizedPlate,
    supplyDriver: null,
    source: lookup.source,
  };
}
