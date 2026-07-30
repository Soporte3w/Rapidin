/**
 * Obtiene el DNI peruano codificado en una licencia con formato letra + 8 dígitos.
 * Ejemplo: X70339164 -> 70339164.
 */
export function getDniFromPeruvianLicense(licenseNumber) {
  const normalized = String(licenseNumber ?? '').trim().toUpperCase();
  const match = normalized.match(/^[A-Z](\d{8})$/);
  return match?.[1] ?? null;
}
